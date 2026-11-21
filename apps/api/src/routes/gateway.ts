/**
 * Endpoints used by the AIX MCP gateway on behalf of a signed-in user (OAuth token, scope aix:gateway).
 * The gateway never sees developer secrets and can't charge; it authorizes calls and records receipts.
 */
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { apps, appVersions, charges, gatewayPending, installs } from "@aix/db";
import { decryptSecret, encryptSecret, newId, randomToken, safeEqual, sha256Hex } from "@aix/core";
import { lt } from "drizzle-orm";
import type { Manifest } from "@aix/manifest";
import type { App, Deps } from "../context.js";
import { requireUser } from "../lib/auth.js";
import { ApiError, notFound } from "../lib/errors.js";
import type { Deps as D } from "../context.js";
import { audit } from "../services/audit.js";
import { collectSpendRules, publicCharge } from "../services/charges.js";
import { assertAppAllowedForUser } from "../services/policies.js";
import { issueUserToken } from "../services/user-tokens.js";

const PENDING_TTL_MS = 10 * 60_000;
const seal = (deps: D, v: unknown) => {
  const json = JSON.stringify(v);
  return deps.config.AIX_ENCRYPTION_KEY ? encryptSecret(json, deps.config.AIX_ENCRYPTION_KEY) : json;
};
const unseal = (deps: D, v: string | null) => {
  if (v === null) return null;
  return JSON.parse(v.startsWith("v1.") && deps.config.AIX_ENCRYPTION_KEY ? decryptSecret(v, deps.config.AIX_ENCRYPTION_KEY) : v);
};

/** Job helper: drop expired pending gateway actions. */
export async function purgeGatewayPending(deps: D) {
  const r = await deps.db.delete(gatewayPending).where(lt(gatewayPending.expiresAt, deps.now())).returning({ id: gatewayPending.id });
  return r.length;
}

export async function gatewayRoutes(app: App, deps: Deps) {
  /**
   * Issue a nonce for a panel-only action (approval decision / install confirm). Shared by all
   * gateway instances. Without `payload`, re-issues a nonce for an existing pending action.
   */
  app.post(
    "/gateway/pending",
    { schema: { tags: ["gateway"], body: z.object({ kind: z.enum(["approval", "install"]), ref: z.string().max(200), payload: z.record(z.string(), z.unknown()).optional() }) } },
    async (req) => {
      const u = await requireUser(deps, req);
      const nonce = randomToken(16);
      const where = and(eq(gatewayPending.userId, u.userId), eq(gatewayPending.kind, req.body.kind), eq(gatewayPending.ref, req.body.ref));
      const expiresAt = new Date(deps.now().getTime() + PENDING_TTL_MS);
      if (req.body.payload === undefined) {
        const [row] = await deps.db.update(gatewayPending).set({ nonceHash: sha256Hex(nonce), expiresAt }).where(and(where, sql`${gatewayPending.expiresAt} > now()`)).returning();
        if (!row) throw notFound("no pending action");
        return { nonce, expiresAt };
      }
      await deps.db
        .insert(gatewayPending)
        .values({ id: newId("gwp"), userId: u.userId, kind: req.body.kind, ref: req.body.ref, payload: seal(deps, req.body.payload), nonceHash: sha256Hex(nonce), expiresAt })
        .onConflictDoUpdate({ target: [gatewayPending.userId, gatewayPending.kind, gatewayPending.ref], set: { payload: seal(deps, req.body.payload), nonceHash: sha256Hex(nonce), expiresAt } });
      return { nonce, expiresAt };
    },
  );

  /** Consume a nonce exactly once; returns the stored payload and deletes the row. */
  app.post(
    "/gateway/pending/consume",
    { schema: { tags: ["gateway"], body: z.object({ kind: z.enum(["approval", "install"]), ref: z.string().max(200), nonce: z.string().max(200) }) } },
    async (req) => {
      const u = await requireUser(deps, req);
      const [row] = await deps.db
        .select()
        .from(gatewayPending)
        .where(and(eq(gatewayPending.userId, u.userId), eq(gatewayPending.kind, req.body.kind), eq(gatewayPending.ref, req.body.ref)));
      if (!row || row.expiresAt < deps.now() || !safeEqual(row.nonceHash, sha256Hex(req.body.nonce))) throw new ApiError(403, "forbidden", "invalid or expired panel action");
      const del = await deps.db.delete(gatewayPending).where(and(eq(gatewayPending.id, row.id), eq(gatewayPending.nonceHash, row.nonceHash))).returning();
      if (!del.length) throw new ApiError(403, "forbidden", "already used");
      return { payload: unseal(deps, row.payload) };
    },
  );

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
