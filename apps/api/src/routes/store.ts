import { z } from "zod";
import { and, avg, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { apps, appVersions, developers, installs, orgAppPolicies, orgMembers, prices, reviews, users } from "@aix/db";
import { formatMoney, newId } from "@aix/core";
import { CATEGORIES, describePermissions, sha256, signingPayload, type Manifest } from "@aix/manifest";
import type { App, Deps } from "../context.js";
import { getUser, requireOrgRole, requireSessionUser, requireUser } from "../lib/auth.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { PaymentsUnavailableError } from "../lib/payments.js";
import { audit } from "../services/audit.js";
import { checkAppAllowedForUser } from "../services/policies.js";
import { getOrCreateUserWallet } from "../services/wallets.js";

type PriceRow = typeof prices.$inferSelect;

export function priceLabel(p: PriceRow): string {
  switch (p.kind) {
    case "free":
      return p.includedUnits ? `${p.includedUnits} free ${p.unit}s` : "Free";
    case "metered":
      return `${formatMoney(p.unitAmountCents)} / ${p.unit}${p.includedUnits ? ` (first ${p.includedUnits} free)` : ""}`;
    case "one_time":
      return `${formatMoney(p.unitAmountCents)} per ${p.unit}`;
    case "subscription":
      return `${formatMoney(p.unitAmountCents)} / ${p.interval}`;
  }
}

async function loadPublishedApp(deps: Deps, slug: string) {
  const [row] = await deps.db
    .select({ app: apps, version: appVersions, developer: developers.displayName })
    .from(apps)
    .innerJoin(appVersions, eq(appVersions.id, apps.currentVersionId))
    .innerJoin(developers, eq(developers.id, apps.developerId))
    .where(and(eq(apps.slug, slug), eq(apps.status, "published")));
  if (!row) throw notFound("app not found");
  return row;
}

/** Re-verify a package before installing it: bytes match the hash, and the hash carries our signature. */
export async function verifyPackage(deps: Deps, v: typeof appVersions.$inferSelect) {
  if (v.status !== "approved" || !v.signature) throw new ApiError(409, "conflict", "app version is not approved");
  const bytes = await deps.storage.get(v.packagePath);
  if (sha256(bytes) !== v.packageSha256) throw new ApiError(409, "conflict", "package integrity check failed (hash mismatch)");
  if (!deps.signer.verifyBytes(signingPayload(v.appId, v.version, v.packageSha256), v.signature)) throw new ApiError(409, "conflict", "package signature is invalid");
  return bytes;
}

/** Install an app for a user (optionally paid by an org). Used by the web store and the MCP gateway. */
export async function installApp(deps: Deps, userId: string, slug: string, opts: { orgId?: string | undefined; via: "web" | "gateway" }) {
  const { app: a, version: v } = await loadPublishedApp(deps, slug);
  await verifyPackage(deps, v);
  const verdict = await checkAppAllowedForUser(deps.db, userId, a.id);
  if (!verdict.allowed) throw new ApiError(403, "blocked_by_org_policy", verdict.reason ?? "blocked by organization policy", { orgId: verdict.orgId });
  if (opts.orgId) {
    const role = await requireOrgRole(deps, userId, opts.orgId, ["owner", "admin", "billing", "member"]);
    const [p] = await deps.db.select().from(orgAppPolicies).where(and(eq(orgAppPolicies.orgId, opts.orgId), eq(orgAppPolicies.appId, a.id)));
    const allowedRoles = p?.allowed ? p.allowedRoles : ["owner", "admin"];
    if (!allowedRoles.includes(role)) throw new ApiError(403, "blocked_by_org_policy", `your role (${role}) can't install this app on the organization's account`);
  }
  const manifest = v.manifest as Manifest;
  await getOrCreateUserWallet(deps.db, userId);
  return deps.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(installs).where(and(eq(installs.userId, userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
    if (existing) {
      const [u] = await tx.update(installs).set({ appVersionId: v.id, grantedPermissions: manifest.permissions, orgId: opts.orgId ?? existing.orgId }).where(eq(installs.id, existing.id)).returning();
      return { install: u!, app: a, upgraded: existing.appVersionId !== v.id };
    }
    const [i] = await tx
      .insert(installs)
      .values({ id: newId("ins"), userId, appId: a.id, appVersionId: v.id, orgId: opts.orgId ?? null, grantedPermissions: manifest.permissions })
      .returning();
    await audit(tx, { actorUserId: userId, actorType: opts.via === "gateway" ? "gateway" : "user", orgId: opts.orgId ?? null, action: "app.installed", targetType: "app", targetId: a.id, metadata: { version: v.version, permissions: manifest.permissions } });
    return { install: i!, app: a, upgraded: false };
  });
}

export async function storeSearch(deps: Deps, q: { q?: string | undefined; category?: string | undefined; type?: string | undefined; host?: string | undefined; limit?: number }) {
  const rows = await deps.db
    .select({ app: apps, version: appVersions, developer: developers.displayName })
    .from(apps)
    .innerJoin(appVersions, eq(appVersions.id, apps.currentVersionId))
    .innerJoin(developers, eq(developers.id, apps.developerId))
    .where(
      and(
        eq(apps.status, "published"),
        q.q ? or(ilike(apps.name, `%${q.q}%`), ilike(apps.description, `%${q.q}%`), ilike(apps.category, `%${q.q}%`)) : undefined,
        q.category ? eq(apps.category, q.category) : undefined,
        q.type ? eq(apps.type, q.type as any) : undefined,
        q.host ? sql`${appVersions.manifest}->'compatibility'->'hosts' ? ${q.host}` : undefined,
      ),
    )
    .orderBy(desc(apps.createdAt))
    .limit(q.limit ?? 50);
  const out = [];
  for (const r of rows) {
    const ps = await deps.db.select().from(prices).where(and(eq(prices.appId, r.app.id), eq(prices.active, true)));
    const [rv] = await deps.db.select({ avg: avg(reviews.rating), n: count() }).from(reviews).where(eq(reviews.appId, r.app.id));
    const m = r.version.manifest as Manifest;
    out.push({
      id: r.app.id,
      slug: r.app.slug,
      name: r.app.name,
      description: r.app.description,
      category: r.app.category,
      type: r.app.type,
      developer: r.developer,
      hosts: m.compatibility.hosts,
      priceLabels: ps.map(priceLabel),
      rating: rv?.n ? { average: Number(Number(rv.avg).toFixed(1)), count: rv.n } : null,
    });
  }
  return out;
}

export async function storeRoutes(app: App, deps: Deps) {
  app.get("/store/categories", { schema: { tags: ["store"] } }, async () => ({ data: CATEGORIES }));

  app.get(
    "/store/apps",
    { schema: { tags: ["store"], querystring: z.object({ q: z.string().max(100).optional(), category: z.string().optional(), type: z.enum(["prompt", "server", "local", "web"]).optional(), host: z.string().optional() }) } },
    async (req) => ({ data: await storeSearch(deps, req.query) }),
  );

  app.get("/store/apps/:slug", { schema: { tags: ["store"], params: z.object({ slug: z.string() }) } }, async (req) => {
    const { app: a, version: v, developer } = await loadPublishedApp(deps, req.params.slug);
    const m = v.manifest as Manifest;
    const ps = await deps.db.select().from(prices).where(and(eq(prices.appId, a.id), eq(prices.active, true)));
    const rv = await deps.db
      .select({ rating: reviews.rating, body: reviews.body, createdAt: reviews.createdAt, name: users.name })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.userId))
      .where(eq(reviews.appId, a.id))
      .orderBy(desc(reviews.createdAt))
      .limit(20);
    const user = await getUser(deps, req);
    let mine = null;
    if (user) {
      const [i] = await deps.db.select().from(installs).where(and(eq(installs.userId, user.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
      const verdict = await checkAppAllowedForUser(deps.db, user.userId, a.id);
      const orgs = await deps.db.select({ orgId: orgMembers.orgId, role: orgMembers.role }).from(orgMembers).where(eq(orgMembers.userId, user.userId));
      mine = { installed: !!i, installId: i?.id ?? null, installedOrgId: i?.orgId ?? null, allowed: verdict.allowed, blockedReason: verdict.reason ?? null, orgs };
    }
    return {
      id: a.id,
      slug: a.slug,
      manifestId: a.manifestId,
      name: a.name,
      description: a.description,
      category: a.category,
      type: a.type,
      developer,
      version: v.version,
      sha256: v.packageSha256,
      hosts: m.compatibility.hosts,
      entry: m.entry,
      permissions: m.permissions,
      permissionLines: describePermissions(m),
      prices: ps.map((p) => ({ id: p.id, lookupKey: p.lookupKey, kind: p.kind, unit: p.unit, unitAmountCents: p.unitAmountCents, interval: p.interval, includedUnits: p.includedUnits, label: priceLabel(p) })),
      reviews: rv.map((r) => ({ ...r, name: r.name ?? "AIX user" })),
      me: mine,
    };
  });

  app.post(
    "/store/apps/:slug/install",
    { schema: { tags: ["store"], params: z.object({ slug: z.string() }), body: z.object({ acceptPermissions: z.literal(true), orgId: z.string().optional() }) } },
    async (req) => {
      const u = await requireUser(deps, req);
      const r = await installApp(deps, u.userId, req.params.slug, { orgId: req.body.orgId, via: u.via === "token" ? "gateway" : "web" });
      return { installId: r.install.id, appId: r.app.id, slug: r.app.slug, orgId: r.install.orgId, upgraded: r.upgraded };
    },
  );

  app.delete("/store/apps/:slug/install", { schema: { tags: ["store"], params: z.object({ slug: z.string() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    const [a] = await deps.db.select().from(apps).where(eq(apps.slug, req.params.slug));
    if (!a) throw notFound("app not found");
    const r = await deps.db.update(installs).set({ uninstalledAt: deps.now() }).where(and(eq(installs.userId, u.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt))).returning();
    if (!r.length) throw notFound("not installed");
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", action: "app.uninstalled", targetType: "app", targetId: a.id });
    return { ok: true };
  });

  /** Download the signed package (prompt / local apps), for installed users only. */
  app.get("/store/apps/:slug/package", { schema: { tags: ["store"], params: z.object({ slug: z.string() }) } }, async (req, reply) => {
    const u = await requireUser(deps, req);
    const { app: a, version: v } = await loadPublishedApp(deps, req.params.slug);
    const [i] = await deps.db.select().from(installs).where(and(eq(installs.userId, u.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
    if (!i) throw forbidden("install the app first");
    const bytes = await verifyPackage(deps, v);
    reply.header("content-type", "application/octet-stream").header("x-aix-sha256", v.packageSha256).header("x-aix-signature", v.signature!);
    return reply.send(bytes);
  });

  app.get("/me/installs", { schema: { tags: ["store"] } }, async (req) => {
    const u = await requireUser(deps, req);
    const rows = await deps.db
      .select({ install: installs, app: apps, version: appVersions.version, manifest: appVersions.manifest })
      .from(installs)
      .innerJoin(apps, eq(apps.id, installs.appId))
      .innerJoin(appVersions, eq(appVersions.id, installs.appVersionId))
      .where(and(eq(installs.userId, u.userId), isNull(installs.uninstalledAt)));
    return {
      data: rows.map((r) => ({
        installId: r.install.id,
        orgId: r.install.orgId,
        installedAt: r.install.createdAt,
        app: { id: r.app.id, slug: r.app.slug, name: r.app.name, type: r.app.type, status: r.app.status, manifestId: r.app.manifestId },
        version: r.version,
        entry: (r.manifest as Manifest).entry,
      })),
    };
  });

  app.post(
    "/store/apps/:slug/reviews",
    { schema: { tags: ["store"], params: z.object({ slug: z.string() }), body: z.object({ rating: z.number().int().min(1).max(5), body: z.string().max(2000).default("") }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const { app: a } = await loadPublishedApp(deps, req.params.slug);
      const [i] = await deps.db.select().from(installs).where(and(eq(installs.userId, u.userId), eq(installs.appId, a.id)));
      if (!i) throw forbidden("only users who installed the app can review it");
      await deps.db
        .insert(reviews)
        .values({ id: newId("rev"), appId: a.id, userId: u.userId, rating: req.body.rating, body: req.body.body })
        .onConflictDoUpdate({ target: [reviews.appId, reviews.userId], set: { rating: req.body.rating, body: req.body.body } });
      return { ok: true };
    },
  );

  app.post(
    "/store/apps/:slug/subscribe",
    { schema: { tags: ["store"], params: z.object({ slug: z.string() }), body: z.object({ priceId: z.string() }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const { app: a } = await loadPublishedApp(deps, req.params.slug);
      const [p] = await deps.db.select().from(prices).where(and(eq(prices.id, req.body.priceId), eq(prices.appId, a.id), eq(prices.active, true)));
      if (!p || p.kind !== "subscription") throw badRequest("not an active subscription price");
      if (!deps.payments) throw new PaymentsUnavailableError();
      const [i] = await deps.db.select().from(installs).where(and(eq(installs.userId, u.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
      if (!i) throw conflict("install the app before subscribing");
      let stripePriceId = p.stripePriceId;
      if (!stripePriceId) {
        stripePriceId = await deps.payments.ensureRecurringPrice({ aixPriceId: p.id, appName: a.name, unitAmountCents: p.unitAmountCents, currency: p.currency, interval: p.interval! });
        await deps.db.update(prices).set({ stripePriceId }).where(eq(prices.id, p.id));
      }
      const wallet = await getOrCreateUserWallet(deps.db, u.userId);
      const [user] = await deps.db.select().from(users).where(eq(users.id, u.userId));
      const s = await deps.payments.createSubscriptionCheckout({
        walletId: wallet.id,
        userId: u.userId,
        priceId: p.id,
        stripePriceId,
        unitAmountCents: p.unitAmountCents,
        customerId: user!.stripeCustomerId,
        email: user!.email,
        successUrl: `${deps.config.AIX_WEB_URL}/apps/${a.slug}?subscribed=1`,
        cancelUrl: `${deps.config.AIX_WEB_URL}/apps/${a.slug}`,
      });
      return { checkoutUrl: s.url, checkoutSessionId: s.id };
    },
  );
}

export async function marketplaceRoutes(app: App, deps: Deps) {
  const { buildMarketplace } = await import("../services/marketplace.js");
  /** The Claude Code marketplace manifest (the file export is what `/plugin marketplace add` reads). */
  app.get("/marketplace/claude-code.json", { schema: { tags: ["store"] } }, async () => (await buildMarketplace(deps)).marketplace);
}
