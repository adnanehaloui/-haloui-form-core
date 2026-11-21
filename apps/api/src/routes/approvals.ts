import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { apps, approvalRequests, prices } from "@aix/db";
import { formatMoney, type Currency } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireUser } from "../lib/auth.js";
import { conflict, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";

/**
 * "This costs €0.50 — approve?" Decisions can come from the AIX website (session) or from the
 * MCP gateway's approval panel (OAuth token), always for the approval's own user.
 */
export async function approvalRoutes(app: App, deps: Deps) {
  const load = async (id: string, userId: string) => {
    const [row] = await deps.db
      .select({ a: approvalRequests, appName: apps.name, appSlug: apps.slug, unit: prices.unit })
      .from(approvalRequests)
      .innerJoin(apps, eq(apps.id, approvalRequests.appId))
      .innerJoin(prices, eq(prices.id, approvalRequests.priceId))
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));
    if (!row) throw notFound("approval not found");
    const expired = row.a.status === "pending" && row.a.expiresAt < deps.now();
    return {
      id: row.a.id,
      status: expired ? ("expired" as const) : row.a.status,
      app: { id: row.a.appId, name: row.appName, slug: row.appSlug },
      quantity: row.a.quantity,
      unit: row.unit,
      amountCents: row.a.amountCents,
      currency: row.a.currency,
      display: formatMoney(row.a.amountCents, row.a.currency as Currency),
      expiresAt: row.a.expiresAt,
    };
  };

  app.get("/approvals/:id", { schema: { tags: ["approvals"], params: z.object({ id: z.string() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    return load(req.params.id, u.userId);
  });

  app.post(
    "/approvals/:id/decision",
    { schema: { tags: ["approvals"], params: z.object({ id: z.string() }), body: z.object({ decision: z.enum(["approve", "deny"]) }) } },
    async (req) => {
      const u = await requireUser(deps, req);
      const a = await load(req.params.id, u.userId);
      if (a.status !== "pending") throw conflict(`approval is ${a.status}`);
      const status = req.body.decision === "approve" ? "approved" : "denied";
      await deps.db.update(approvalRequests).set({ status, decidedAt: deps.now() }).where(and(eq(approvalRequests.id, a.id), eq(approvalRequests.status, "pending")));
      await audit(deps.db, { actorUserId: u.userId, actorType: u.via === "token" ? "gateway" : "user", action: `approval.${status}`, targetType: "approval", targetId: a.id, metadata: { amountCents: a.amountCents, appId: a.app.id } });
      return { ...a, status };
    },
  );
}
