/**
 * Developer server API — authenticated ONLY with a developer secret key (aixsk_…).
 * This is the only surface that can charge a wallet (hard rule 3).
 */
import { z } from "zod";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { apps, charges, installs, prices, subscriptions, usageRecords } from "@aix/db";
import { newId } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireDeveloperKey } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { capture, hold, publicCharge, release, resolvePrice } from "../services/charges.js";
import { verifyUserToken } from "../services/user-tokens.js";

const holdBody = z.object({
  userId: z.string(),
  priceId: z.string().describe("price_… id or your lookup key"),
  appId: z.string().optional(),
  quantity: z.number().int().positive().default(1),
  idempotencyKey: z.string().min(1).max(200),
  runId: z.string().max(200).optional(),
  holdTtlSeconds: z.number().int().positive().max(86400).optional(),
});

export async function v1Routes(app: App, deps: Deps) {
  const sec = [{ secretKey: [] }];

  app.post("/v1/auth/verify", { schema: { tags: ["developer-api"], security: sec, body: z.object({ token: z.string() }) } }, async (req) => {
    const dev = await requireDeveloperKey(deps, req, "auth:verify");
    return { user: await verifyUserToken(deps, dev.developerId, req.body.token) };
  });

  app.post("/v1/holds", { schema: { tags: ["developer-api"], security: sec, body: holdBody } }, async (req) => {
    const dev = await requireDeveloperKey(deps, req, "charges:write");
    return publicCharge(await hold(deps, dev.developerId, req.body));
  });

  app.post("/v1/holds/:id/capture", { schema: { tags: ["developer-api"], security: sec, params: z.object({ id: z.string() }) } }, async (req) => {
    const dev = await requireDeveloperKey(deps, req, "charges:write");
    return publicCharge(await capture(deps, dev.developerId, req.params.id));
  });

  app.post(
    "/v1/holds/:id/release",
    { schema: { tags: ["developer-api"], security: sec, params: z.object({ id: z.string() }), body: z.object({ reason: z.string().max(200).optional() }).nullish() } },
    async (req) => {
      const dev = await requireDeveloperKey(deps, req, "charges:write");
      return publicCharge(await release(deps, dev.developerId, req.params.id, req.body?.reason ?? undefined));
    },
  );

  app.get("/v1/charges/:id", { schema: { tags: ["developer-api"], security: sec, params: z.object({ id: z.string() }) } }, async (req) => {
    const dev = await requireDeveloperKey(deps, req, "charges:write");
    const [row] = await deps.db.select({ charge: charges }).from(charges).innerJoin(apps, eq(apps.id, charges.appId)).where(and(eq(charges.id, req.params.id), eq(apps.developerId, dev.developerId)));
    if (!row) throw notFound("charge not found");
    return publicCharge(row.charge);
  });

  /** Batched metered usage: each report becomes an immediately captured charge (same limits & approvals). */
  app.post(
    "/v1/usage",
    {
      schema: {
        tags: ["developer-api"],
        security: sec,
        body: z.object({ records: z.array(holdBody.omit({ holdTtlSeconds: true })).min(1).max(100) }),
      },
    },
    async (req) => {
      const dev = await requireDeveloperKey(deps, req, "charges:write");
      const results = [];
      for (const r of req.body.records) {
        try {
          const { price, app: a } = await resolvePrice(deps.db, dev.developerId, r.priceId, r.appId);
          await deps.db.insert(usageRecords).values({ id: newId("use"), appId: a.id, userId: r.userId, priceId: price.id, quantity: r.quantity, idempotencyKey: r.idempotencyKey }).onConflictDoNothing();
          const h = await hold(deps, dev.developerId, { ...r, idempotencyKey: `usage:${r.idempotencyKey}` });
          const c = h.status === "held" ? await capture(deps, dev.developerId, h.id) : h;
          await deps.db.update(usageRecords).set({ chargeId: c.id }).where(and(eq(usageRecords.appId, a.id), eq(usageRecords.idempotencyKey, r.idempotencyKey)));
          results.push({ idempotencyKey: r.idempotencyKey, ok: true, charge: publicCharge(c) });
        } catch (err: any) {
          results.push({ idempotencyKey: r.idempotencyKey, ok: false, error: { code: err.code ?? "internal", message: err.message, details: err.details } });
        }
      }
      return { results };
    },
  );

  /** Has the user an active subscription for `key`, or free units left / a free price? */
  app.post(
    "/v1/entitlements/check",
    { schema: { tags: ["developer-api"], security: sec, body: z.object({ userId: z.string(), key: z.string(), appId: z.string().optional() }) } },
    async (req) => {
      const dev = await requireDeveloperKey(deps, req, "auth:verify");
      const { price, app: a } = await resolvePrice(deps.db, dev.developerId, req.body.key, req.body.appId);
      const [install] = await deps.db.select().from(installs).where(and(eq(installs.userId, req.body.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
      if (!install) return { entitled: false, reason: "not_installed" };
      if (price.kind === "subscription") {
        const [s] = await deps.db
          .select()
          .from(subscriptions)
          .where(and(eq(subscriptions.userId, req.body.userId), eq(subscriptions.priceId, price.id), inArray(subscriptions.status, ["active", "trialing", "canceling"]), gt(subscriptions.currentPeriodEnd, deps.now())));
        return s ? { entitled: true, kind: "subscription", currentPeriodEnd: s.currentPeriodEnd } : { entitled: false, reason: "no_active_subscription" };
      }
      if (price.kind === "free") return { entitled: true, kind: "free" };
      const [u] = await deps.db
        .select({ used: sql<string>`coalesce(sum(${charges.freeUnits}), 0)` })
        .from(charges)
        .where(and(eq(charges.userId, req.body.userId), eq(charges.priceId, price.id), inArray(charges.status, ["held", "captured"])));
      const freeUnitsRemaining = Math.max(0, price.includedUnits - Number(u?.used ?? 0));
      return { entitled: true, kind: price.kind, freeUnitsRemaining, unitAmountCents: price.unitAmountCents, unit: price.unit };
    },
  );

  app.get("/v1/prices", { schema: { tags: ["developer-api"], security: sec } }, async (req) => {
    const dev = await requireDeveloperKey(deps, req, "auth:verify");
    const rows = await deps.db.select({ price: prices, appSlug: apps.slug }).from(prices).innerJoin(apps, eq(apps.id, prices.appId)).where(eq(apps.developerId, dev.developerId));
    return { data: rows.map((r) => ({ ...r.price, appSlug: r.appSlug })) };
  });
}
