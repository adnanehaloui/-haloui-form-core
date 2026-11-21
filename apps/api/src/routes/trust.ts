/**
 * Accounts & trust: org invitations, moderation (reports, hidden reviews), admin bans,
 * GDPR data export and account deletion.
 */
import { z } from "zod";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  apiKeys,
  apps,
  authIdentities,
  auditLog,
  charges,
  developers,
  installs,
  magicLinkTokens,
  oauthGrants,
  orgInvites,
  orgMembers,
  organizations,
  reports,
  reviews,
  sessions,
  spendLimits,
  subscriptions,
  users,
  workflows,
} from "@aix/db";
import { newId, randomToken, sha256Hex } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireAdmin, requireOrgRole, requireSessionUser, SESSION_COOKIE } from "../lib/auth.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { sendSafe } from "../services/emails.js";
import { normalizeEmail } from "../services/users.js";
import { getOrCreateUserWallet, walletBalance } from "../services/wallets.js";
import { walletTransactions } from "./wallet.js";

const INVITE_TTL_DAYS = 7;
const role = z.enum(["owner", "admin", "billing", "member"]);

export async function trustRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------- Org invitations
  app.post(
    "/orgs/:orgId/invites",
    { schema: { tags: ["orgs"], params: z.object({ orgId: z.string() }), body: z.object({ email: z.email(), role }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const myRole = await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
      if (req.body.role === "owner" && myRole !== "owner") throw badRequest("only owners can invite owners");
      const [org] = await deps.db.select().from(organizations).where(eq(organizations.id, req.params.orgId));
      const token = `aixinv_${randomToken(24)}`;
      const email = normalizeEmail(req.body.email);
      const id = newId("inv");
      await deps.db.insert(orgInvites).values({ id, orgId: req.params.orgId, email, role: req.body.role, tokenHash: sha256Hex(token), invitedBy: u.userId, expiresAt: new Date(deps.now().getTime() + INVITE_TTL_DAYS * 86400_000) });
      const link = `${deps.config.AIX_WEB_URL}/invites/${token}`;
      await sendSafe(deps, {
        to: email,
        subject: `${u.email} invited you to ${org!.name} on AIX`,
        text: `You've been invited to join ${org!.name} on AIX as ${req.body.role}.\n\nAccept: ${link}\n\nThe link expires in ${INVITE_TTL_DAYS} days.`,
      });
      await audit(deps.db, { actorUserId: u.userId, actorType: "user", orgId: req.params.orgId, action: "org.invite_sent", targetType: "invite", targetId: id, metadata: { email, role: req.body.role } });
      return { id, email, role: req.body.role, expiresAt: new Date(deps.now().getTime() + INVITE_TTL_DAYS * 86400_000) };
    },
  );

  app.get("/orgs/:orgId/invites", { schema: { tags: ["orgs"], params: z.object({ orgId: z.string() }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
    const rows = await deps.db
      .select({ id: orgInvites.id, email: orgInvites.email, role: orgInvites.role, expiresAt: orgInvites.expiresAt, createdAt: orgInvites.createdAt })
      .from(orgInvites)
      .where(and(eq(orgInvites.orgId, req.params.orgId), isNull(orgInvites.acceptedAt), isNull(orgInvites.revokedAt), gt(orgInvites.expiresAt, deps.now())))
      .orderBy(desc(orgInvites.createdAt));
    return { data: rows };
  });

  app.delete("/orgs/:orgId/invites/:id", { schema: { tags: ["orgs"], params: z.object({ orgId: z.string(), id: z.string() }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
    await deps.db.update(orgInvites).set({ revokedAt: deps.now() }).where(and(eq(orgInvites.id, req.params.id), eq(orgInvites.orgId, req.params.orgId)));
    return { ok: true };
  });

  const loadInvite = async (token: string) => {
    const [row] = await deps.db
      .select({ invite: orgInvites, orgName: organizations.name })
      .from(orgInvites)
      .innerJoin(organizations, eq(organizations.id, orgInvites.orgId))
      .where(eq(orgInvites.tokenHash, sha256Hex(token)));
    if (!row || row.invite.revokedAt || row.invite.acceptedAt || row.invite.expiresAt < deps.now()) throw notFound("this invitation is invalid, used or expired");
    return row;
  };

  app.get("/invites/:token", { schema: { tags: ["orgs"], params: z.object({ token: z.string() }) } }, async (req) => {
    const r = await loadInvite(req.params.token);
    return { orgName: r.orgName, role: r.invite.role, email: r.invite.email, expiresAt: r.invite.expiresAt };
  });

  app.post("/invites/:token/accept", { schema: { tags: ["orgs"], params: z.object({ token: z.string() }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    const r = await loadInvite(req.params.token);
    if (normalizeEmail(u.email) !== r.invite.email) throw forbidden(`this invitation is for ${r.invite.email} — sign in with that email`);
    await deps.db.transaction(async (tx) => {
      await tx.insert(orgMembers).values({ orgId: r.invite.orgId, userId: u.userId, role: r.invite.role }).onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.userId], set: { role: r.invite.role } });
      await tx.update(orgInvites).set({ acceptedAt: deps.now() }).where(eq(orgInvites.id, r.invite.id));
      await audit(tx, { actorUserId: u.userId, actorType: "user", orgId: r.invite.orgId, action: "org.invite_accepted", targetType: "invite", targetId: r.invite.id, metadata: { role: r.invite.role } });
    });
    return { orgId: r.invite.orgId, orgName: r.orgName, role: r.invite.role };
  });

  // ---------------------------------------------------------------- Reports & moderation
  app.post(
    "/reports",
    {
      config: { rateLimit: { max: deps.config.NODE_ENV === "test" ? 1000 : 10, timeWindow: "1 hour" } },
      schema: { tags: ["store"], body: z.object({ targetType: z.enum(["app", "review"]), targetId: z.string().max(100), reason: z.string().min(5).max(1000) }) },
    },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const exists =
        req.body.targetType === "app"
          ? (await deps.db.select({ id: apps.id }).from(apps).where(eq(apps.id, req.body.targetId))).length
          : (await deps.db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, req.body.targetId))).length;
      if (!exists) throw notFound("nothing to report");
      const id = newId("rep");
      await deps.db.insert(reports).values({ id, reporterUserId: u.userId, ...req.body });
      return { id, status: "open" };
    },
  );

  app.get("/admin/reports", { schema: { tags: ["admin"], querystring: z.object({ status: z.enum(["open", "resolved", "dismissed"]).default("open") }) } }, async (req) => {
    await requireAdmin(deps, req);
    const rows = await deps.db.select({ r: reports, reporter: users.email }).from(reports).innerJoin(users, eq(users.id, reports.reporterUserId)).where(eq(reports.status, req.query.status)).orderBy(desc(reports.createdAt)).limit(200);
    const out = [];
    for (const row of rows) {
      let target: Record<string, unknown> | null = null;
      if (row.r.targetType === "review") {
        const [rv] = await deps.db.select({ body: reviews.body, rating: reviews.rating, hiddenAt: reviews.hiddenAt, appName: apps.name }).from(reviews).innerJoin(apps, eq(apps.id, reviews.appId)).where(eq(reviews.id, row.r.targetId));
        target = rv ?? null;
      } else {
        const [a] = await deps.db.select({ name: apps.name, slug: apps.slug, status: apps.status }).from(apps).where(eq(apps.id, row.r.targetId));
        target = a ?? null;
      }
      out.push({ ...row.r, reporterEmail: row.reporter, target });
    }
    return { data: out };
  });

  app.post(
    "/admin/reports/:id/:action",
    { schema: { tags: ["admin"], params: z.object({ id: z.string(), action: z.enum(["resolve", "dismiss"]) }) } },
    async (req) => {
      const admin = await requireAdmin(deps, req);
      const [r] = await deps.db.update(reports).set({ status: req.params.action === "resolve" ? "resolved" : "dismissed", resolvedBy: admin.userId }).where(eq(reports.id, req.params.id)).returning();
      if (!r) throw notFound("report not found");
      await audit(deps.db, { actorUserId: admin.userId, actorType: "admin", action: `report.${r.status}`, targetType: r.targetType, targetId: r.targetId });
      return { ok: true, status: r.status };
    },
  );

  app.post("/admin/reviews/:id/:action", { schema: { tags: ["admin"], params: z.object({ id: z.string(), action: z.enum(["hide", "unhide"]) }) } }, async (req) => {
    const admin = await requireAdmin(deps, req);
    const [r] = await deps.db.update(reviews).set({ hiddenAt: req.params.action === "hide" ? deps.now() : null }).where(eq(reviews.id, req.params.id)).returning();
    if (!r) throw notFound("review not found");
    await audit(deps.db, { actorUserId: admin.userId, actorType: "admin", action: `review.${req.params.action}`, targetType: "review", targetId: r.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Bans
  app.get("/admin/users", { schema: { tags: ["admin"], querystring: z.object({ email: z.string().optional() }) } }, async (req) => {
    await requireAdmin(deps, req);
    const rows = await deps.db
      .select({ id: users.id, email: users.email, name: users.name, disabledAt: users.disabledAt, disabledReason: users.disabledReason, deletedAt: users.deletedAt, createdAt: users.createdAt })
      .from(users)
      .where(req.query.email ? eq(users.email, normalizeEmail(req.query.email)) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(100);
    return { data: rows };
  });

  app.post(
    "/admin/users/:id/:action",
    { schema: { tags: ["admin"], params: z.object({ id: z.string(), action: z.enum(["ban", "unban"]) }), body: z.object({ reason: z.string().min(3).max(300) }).nullish() } },
    async (req) => {
      const admin = await requireAdmin(deps, req);
      if (req.params.id === admin.userId) throw badRequest("you can't ban yourself");
      const ban = req.params.action === "ban";
      if (ban && !req.body?.reason) throw badRequest("a reason is required");
      await deps.db.transaction(async (tx) => {
        const [u] = await tx.update(users).set({ disabledAt: ban ? deps.now() : null, disabledReason: ban ? req.body!.reason : null }).where(eq(users.id, req.params.id)).returning();
        if (!u) throw notFound("user not found");
        if (ban) {
          await tx.delete(sessions).where(eq(sessions.userId, u.id));
          await tx.update(oauthGrants).set({ revokedAt: deps.now() }).where(and(eq(oauthGrants.userId, u.id), isNull(oauthGrants.revokedAt)));
        }
        await audit(tx, { actorUserId: admin.userId, actorType: "admin", action: ban ? "user.banned" : "user.unbanned", targetType: "user", targetId: u.id, metadata: { reason: req.body?.reason ?? null } });
      });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------- GDPR: export & delete
  app.get("/me/export", { schema: { tags: ["account"] } }, async (req, reply) => {
    const u = await requireSessionUser(deps, req);
    const [user] = await deps.db.select().from(users).where(eq(users.id, u.userId));
    const wallet = await getOrCreateUserWallet(deps.db, u.userId);
    const data = {
      exportedAt: deps.now().toISOString(),
      profile: { id: user!.id, email: user!.email, name: user!.name, createdAt: user!.createdAt },
      wallet: { id: wallet.id, ...(await walletBalance(deps.db, wallet.id)), transactions: await walletTransactions(deps, wallet.id, 10_000) },
      charges: await deps.db.select().from(charges).where(eq(charges.userId, u.userId)),
      installs: await deps.db.select({ appId: installs.appId, orgId: installs.orgId, grantedPermissions: installs.grantedPermissions, createdAt: installs.createdAt, uninstalledAt: installs.uninstalledAt }).from(installs).where(eq(installs.userId, u.userId)),
      subscriptions: await deps.db.select().from(subscriptions).where(eq(subscriptions.userId, u.userId)),
      reviews: await deps.db.select({ appId: reviews.appId, rating: reviews.rating, body: reviews.body, createdAt: reviews.createdAt }).from(reviews).where(eq(reviews.userId, u.userId)),
      organizations: await deps.db.select({ orgId: orgMembers.orgId, role: orgMembers.role }).from(orgMembers).where(eq(orgMembers.userId, u.userId)),
      spendLimits: await deps.db.select().from(spendLimits).where(eq(spendLimits.userId, u.userId)),
      workflows: await deps.db.select().from(workflows).where(eq(workflows.userId, u.userId)),
      connectedApps: await deps.db.select({ clientId: oauthGrants.clientId, scopes: oauthGrants.scopes, createdAt: oauthGrants.createdAt }).from(oauthGrants).where(and(eq(oauthGrants.userId, u.userId), eq(oauthGrants.kind, "refresh"))),
      activity: await deps.db.select({ action: auditLog.action, targetType: auditLog.targetType, targetId: auditLog.targetId, createdAt: auditLog.createdAt }).from(auditLog).where(eq(auditLog.actorUserId, u.userId)).orderBy(desc(auditLog.createdAt)).limit(5000),
    };
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", action: "account.exported" });
    return reply.header("content-type", "application/json").header("content-disposition", `attachment; filename="aix-data-${u.userId}.json"`).send(JSON.stringify(data, null, 2));
  });

  /**
   * Delete my account: personal data is erased or anonymized; financial records (ledger, charges,
   * invoices, audit) are kept as required for accounting, linked only to the anonymized id.
   */
  app.post("/me/delete", { schema: { tags: ["account"], body: z.object({ confirm: z.literal("DELETE") }) } }, async (req, reply) => {
    const u = await requireSessionUser(deps, req);
    const wallet = await getOrCreateUserWallet(deps.db, u.userId);
    const b = await walletBalance(deps.db, wallet.id);
    if (b.heldCents !== 0) throw conflict("some money is reserved for running work — try again in a few minutes");
    if (b.availableCents > 0) throw new ApiError(409, "conflict", "your wallet still holds money — spend it or ask support for a refund to your card first", { availableCents: b.availableCents });
    const owned = await deps.db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(and(eq(orgMembers.userId, u.userId), eq(orgMembers.role, "owner")));
    for (const o of owned) {
      const owners = await deps.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, o.orgId), eq(orgMembers.role, "owner")));
      const members = await deps.db.select().from(orgMembers).where(eq(orgMembers.orgId, o.orgId));
      if (owners.length === 1 && members.length > 1) throw conflict("you're the only owner of an organization with other members — make someone else owner first");
    }
    const [user] = await deps.db.select().from(users).where(eq(users.id, u.userId));
    await deps.db.transaction(async (tx) => {
      const now = deps.now();
      await tx.update(users).set({ email: `deleted+${u.userId}@users.aix.invalid`, name: null, stripeCustomerId: null, deletedAt: now, disabledAt: now, disabledReason: "deleted by user" }).where(eq(users.id, u.userId));
      await tx.delete(sessions).where(eq(sessions.userId, u.userId));
      await tx.delete(authIdentities).where(eq(authIdentities.userId, u.userId));
      await tx.delete(magicLinkTokens).where(eq(magicLinkTokens.email, user!.email));
      await tx.update(oauthGrants).set({ revokedAt: now }).where(and(eq(oauthGrants.userId, u.userId), isNull(oauthGrants.revokedAt)));
      await tx.update(installs).set({ uninstalledAt: now }).where(and(eq(installs.userId, u.userId), isNull(installs.uninstalledAt)));
      await tx.delete(reviews).where(eq(reviews.userId, u.userId));
      await tx.delete(workflows).where(eq(workflows.userId, u.userId));
      await tx.delete(orgMembers).where(eq(orgMembers.userId, u.userId));
      await tx.update(orgInvites).set({ revokedAt: now }).where(or(eq(orgInvites.invitedBy, u.userId), eq(orgInvites.email, user!.email)));
      const [d] = await tx.select().from(developers).where(eq(developers.userId, u.userId));
      if (d) {
        await tx.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.developerId, d.id), isNull(apiKeys.revokedAt)));
        await tx.update(apps).set({ status: "suspended" }).where(eq(apps.developerId, d.id));
      }
      await audit(tx, { actorUserId: u.userId, actorType: "user", action: "account.deleted" });
    });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
