/** Enterprise: approved catalog, role-based install rules, per-member budgets, audit export. */
import { z } from "zod";
import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { apps, auditLog, orgAppPolicies, organizations, spendLimits, users } from "@aix/db";
import { newId } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireOrgRole, requireSessionUser, requireUser } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";

const orgParams = z.object({ orgId: z.string() });
const role = z.enum(["owner", "admin", "billing", "member"]);

function csvCell(v: unknown) {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // Quote everything; neutralize spreadsheet formula injection.
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}

export async function orgAdminRoutes(app: App, deps: Deps) {
  app.put("/orgs/:orgId/catalog", { schema: { tags: ["orgs"], params: orgParams, body: z.object({ mode: z.enum(["open", "approved_only"]) }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
    await deps.db.update(organizations).set({ catalogMode: req.body.mode }).where(eq(organizations.id, req.params.orgId));
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", orgId: req.params.orgId, action: "org.catalog_mode_changed", metadata: { mode: req.body.mode } });
    return { ok: true, mode: req.body.mode };
  });

  app.get("/orgs/:orgId/policies", { schema: { tags: ["orgs"], params: orgParams } }, async (req) => {
    const u = await requireUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin", "billing", "member"]);
    const rows = await deps.db.select({ policy: orgAppPolicies, appName: apps.name, appSlug: apps.slug }).from(orgAppPolicies).innerJoin(apps, eq(apps.id, orgAppPolicies.appId)).where(eq(orgAppPolicies.orgId, req.params.orgId));
    return { data: rows.map((r) => ({ ...r.policy, appName: r.appName, appSlug: r.appSlug })) };
  });

  app.put(
    "/orgs/:orgId/policies/:appId",
    {
      schema: {
        tags: ["orgs"],
        params: orgParams.extend({ appId: z.string() }),
        body: z.object({ allowed: z.boolean(), allowedRoles: z.array(role).min(1).default(["owner", "admin", "billing", "member"]), maxPermissions: z.object({ network: z.boolean(), files: z.boolean(), userData: z.array(z.string()) }).nullable().optional() }),
      },
    },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
      const [a] = await deps.db.select().from(apps).where(eq(apps.id, req.params.appId));
      if (!a) throw notFound("app not found");
      const values = { allowed: req.body.allowed, allowedRoles: req.body.allowedRoles, maxPermissions: req.body.maxPermissions ?? null };
      await deps.db
        .insert(orgAppPolicies)
        .values({ id: newId("pol"), orgId: req.params.orgId, appId: a.id, ...values })
        .onConflictDoUpdate({ target: [orgAppPolicies.orgId, orgAppPolicies.appId], set: values });
      await audit(deps.db, { actorUserId: u.userId, actorType: "user", orgId: req.params.orgId, action: req.body.allowed ? "org.app_allowed" : "org.app_blocked", targetType: "app", targetId: a.id, metadata: values });
      return { ok: true, ...values };
    },
  );

  app.delete("/orgs/:orgId/policies/:appId", { schema: { tags: ["orgs"], params: orgParams.extend({ appId: z.string() }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
    await deps.db.delete(orgAppPolicies).where(and(eq(orgAppPolicies.orgId, req.params.orgId), eq(orgAppPolicies.appId, req.params.appId)));
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", orgId: req.params.orgId, action: "org.policy_removed", targetType: "app", targetId: req.params.appId });
    return { ok: true };
  });

  // ---- Per-member budgets (userId null = default for every member) ----
  app.get("/orgs/:orgId/budgets", { schema: { tags: ["orgs"], params: orgParams } }, async (req) => {
    const u = await requireUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin", "billing"]);
    const rows = await deps.db.select({ limit: spendLimits, email: users.email }).from(spendLimits).leftJoin(users, eq(users.id, spendLimits.userId)).where(and(eq(spendLimits.scope, "org_member"), eq(spendLimits.orgId, req.params.orgId)));
    return { data: rows.map((r) => ({ ...r.limit, email: r.email })) };
  });

  app.put(
    "/orgs/:orgId/budgets",
    {
      schema: {
        tags: ["orgs"],
        params: orgParams,
        body: z.object({ userId: z.string().nullable(), period: z.enum(["daily", "monthly"]), capCents: z.number().int().nonnegative().nullable(), autoApproveThresholdCents: z.number().int().nonnegative().nullable() }),
      },
    },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin", "billing"]);
      if (req.body.userId) await requireOrgRole(deps, req.body.userId, req.params.orgId, ["owner", "admin", "billing", "member"]);
      const where = and(eq(spendLimits.scope, "org_member"), eq(spendLimits.orgId, req.params.orgId), eq(spendLimits.period, req.body.period), req.body.userId ? eq(spendLimits.userId, req.body.userId) : isNull(spendLimits.userId));
      const [existing] = await deps.db.select().from(spendLimits).where(where);
      const values = { capCents: req.body.capCents, autoApproveThresholdCents: req.body.autoApproveThresholdCents };
      if (existing) await deps.db.update(spendLimits).set(values).where(eq(spendLimits.id, existing.id));
      else await deps.db.insert(spendLimits).values({ id: newId("lim"), scope: "org_member", orgId: req.params.orgId, userId: req.body.userId, period: req.body.period, ...values });
      await audit(deps.db, { actorUserId: u.userId, actorType: "user", orgId: req.params.orgId, action: "org.budget_set", metadata: req.body });
      return { ok: true };
    },
  );

  // ---- Audit log ----
  const auditQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(10_000).default(500) });
  const loadAudit = async (orgId: string, q: z.infer<typeof auditQuery>) =>
    deps.db
      .select({ entry: auditLog, actorEmail: users.email })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(and(eq(auditLog.orgId, orgId), q.from ? gte(auditLog.createdAt, q.from) : undefined, q.to ? lt(auditLog.createdAt, q.to) : undefined))
      .orderBy(desc(auditLog.createdAt))
      .limit(q.limit);

  app.get("/orgs/:orgId/audit", { schema: { tags: ["orgs"], params: orgParams, querystring: auditQuery } }, async (req) => {
    const u = await requireUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
    return { data: (await loadAudit(req.params.orgId, req.query)).map((r) => ({ ...r.entry, actorEmail: r.actorEmail })) };
  });

  app.get("/orgs/:orgId/audit.csv", { schema: { tags: ["orgs"], params: orgParams, querystring: auditQuery } }, async (req, reply) => {
    const u = await requireUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
    const rows = await loadAudit(req.params.orgId, req.query);
    const header = ["time", "actor_email", "actor_type", "action", "target_type", "target_id", "metadata"];
    const lines = rows.map((r) => [r.entry.createdAt.toISOString(), r.actorEmail, r.entry.actorType, r.entry.action, r.entry.targetType, r.entry.targetId, r.entry.metadata].map(csvCell).join(","));
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="aix-audit-${req.params.orgId}.csv"`)
      .send([header.join(","), ...lines].join("\n") + "\n");
  });
}
