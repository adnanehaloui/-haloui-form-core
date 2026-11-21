/**
 * Endpoints used by the AIX MCP gateway on behalf of a signed-in user (OAuth token, scope aix:gateway).
 * The gateway never sees developer secrets and can't charge; it authorizes calls and records receipts.
 */
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { apps, appVersions, charges, installs } from "@aix/db";
import { newId } from "@aix/core";
import type { Manifest } from "@aix/manifest";
import type { App, Deps } from "../context.js";
import { requireUser } from "../lib/auth.js";
import { ApiError, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { collectSpendRules, publicCharge } from "../services/charges.js";
import { assertAppAllowedForUser } from "../services/policies.js";
import { issueUserToken } from "../services/user-tokens.js";

export async function gatewayRoutes(app: App, deps: Deps) {
  /** Server apps the user can call, with their MCP endpoints. */
  app.get("/gateway/apps", { schema: { tags: ["gateway"] } }, async (req) => {
    const u = await requireUser(deps, req);
    const rows = await deps.db
      .select({ app: apps, manifest: appVersions.manifest, orgId: installs.orgId })
      .from(installs)
      .innerJoin(apps, eq(apps.id, installs.appId))
      .innerJoin(appVersions, eq(appVersions.id, installs.appVersionId))
      .where(and(eq(installs.userId, u.userId), isNull(installs.uninstalledAt), eq(apps.status, "published"), eq(apps.type, "server")));
    return { data: rows.map((r) => ({ appId: r.app.id, slug: r.app.slug, name: r.app.name, orgId: r.orgId, mcpUrl: (r.manifest as Manifest).entry.mcp ?? null })) };
  });

  /** Authorize one tool call BEFORE it is forwarded: install, app status, org policy, spend caps. */
  app.post(
    "/gateway/calls",
    { schema: { tags: ["gateway"], body: z.object({ appSlug: z.string(), tool: z.string().max(100), runId: z.string().regex(/^run_[a-f0-9]{32}$/).optional() }) } },
    async (req) => {
      const u = await requireUser(deps, req);
      const [row] = await deps.db
        .select({ app: apps, install: installs, manifest: appVersions.manifest })
        .from(apps)
        .innerJoin(installs, and(eq(installs.appId, apps.id), eq(installs.userId, u.userId), isNull(installs.uninstalledAt)))
        .innerJoin(appVersions, eq(appVersions.id, installs.appVersionId))
        .where(eq(apps.slug, req.body.appSlug));
      if (!row) throw new ApiError(403, "not_installed", "app is not installed");
      if (row.app.status !== "published") throw new ApiError(403, "forbidden", `app is ${row.app.status}`);
      await assertAppAllowedForUser(deps, u.userId, row.app.id, row.install.orgId);
      // Refuse early if a cap is already exhausted (the hold would fail anyway).
      const rules = await collectSpendRules(deps.db, { userId: u.userId, appId: row.app.id, orgId: row.install.orgId, now: deps.now() });
      const full = rules.find((r) => r.capCents !== null && r.spentCents >= r.capCents);
      if (full) throw new ApiError(402, "spend_limit_exceeded", `${full.label} limit reached`, { rule: full.label, capCents: full.capCents });
      const runId = req.body.runId ?? newId("run");
      const userToken = await issueUserToken(deps, u.userId, row.app.id, runId);
      return { runId, userToken, appId: row.app.id, mcpUrl: (row.manifest as Manifest).entry.mcp };
    },
  );

  /** Record the call (app, tool, user, charge ids — never conversation content) and return receipts. */
  app.post(
    "/gateway/calls/:runId/complete",
    { schema: { tags: ["gateway"], params: z.object({ runId: z.string() }), body: z.object({ appSlug: z.string(), tool: z.string().max(100), isError: z.boolean().default(false) }) } },
    async (req) => {
      const u = await requireUser(deps, req);
      const [a] = await deps.db.select().from(apps).where(eq(apps.slug, req.body.appSlug));
      if (!a) throw notFound("app not found");
      const rows = await deps.db.select().from(charges).where(and(eq(charges.runId, req.params.runId), eq(charges.userId, u.userId), eq(charges.appId, a.id)));
      await audit(deps.db, {
        actorUserId: u.userId,
        actorType: "gateway",
        orgId: rows[0]?.orgId ?? null,
        action: "gateway.tool_call",
        targetType: "app",
        targetId: a.id,
        metadata: { tool: req.body.tool, runId: req.params.runId, chargeIds: rows.map((c) => c.id), isError: req.body.isError },
      });
      return { charges: rows.map((c) => publicCharge(c, a.name)) };
    },
  );
}
