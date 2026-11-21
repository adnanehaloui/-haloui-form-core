import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { apps, developers, invoices, payouts, prices, subscriptions, topups, users, wallets } from "@aix/db";
import { formatMoney } from "@aix/core";
import { requireAdmin, requireSessionUser } from "../lib/auth.js";
import { listTopUps, refundTopUp } from "../services/card-refunds.js";
import { audit } from "../services/audit.js";
import type { App, Deps } from "../context.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { PaymentsUnavailableError } from "../lib/payments.js";
import { computeInvoice, renderInvoicePdf } from "../services/invoices.js";
import { developerStatement, previousPeriod } from "../services/payouts.js";
import { requireDeveloper } from "./developer.js";
import { resolveWallet } from "./wallet.js";

const period = z.string().regex(/^\d{4}-\d{2}$/);

export async function billingRoutes(app: App, deps: Deps) {
  // ---- Stripe Connect (developer payouts) ----
  app.post("/developer/connect/onboard", { schema: { tags: ["developer"] } }, async (req) => {
    const { developer, userId } = await requireDeveloper(deps, req);
    if (!deps.payments) throw new PaymentsUnavailableError();
    let accountId = developer.stripeConnectAccountId;
    if (!accountId) {
      const [u] = userId ? await deps.db.select().from(users).where(eq(users.id, userId)) : [];
      accountId = await deps.payments.createConnectAccount({ developerId: developer.id, email: u?.email ?? "" });
      await deps.db.update(developers).set({ stripeConnectAccountId: accountId, payoutStatus: "pending" }).where(eq(developers.id, developer.id));
    }
    const url = await deps.payments.createConnectOnboardingLink({
      accountId,
      refreshUrl: `${deps.config.AIX_WEB_URL}/developer/payouts?connect=refresh`,
      returnUrl: `${deps.config.AIX_WEB_URL}/developer/payouts?connect=done`,
    });
    return { url, accountId };
  });

  app.get("/developer/connect/status", { schema: { tags: ["developer"] } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    if (!developer.stripeConnectAccountId || !deps.payments) return { status: developer.payoutStatus, connected: false };
    const status = await deps.payments.getConnectAccountStatus(developer.stripeConnectAccountId);
    await deps.db.update(developers).set({ payoutStatus: status }).where(eq(developers.id, developer.id));
    return { status, connected: true };
  });

  app.get("/developer/statements/:period", { schema: { tags: ["developer"], params: z.object({ period }) } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    const [p] = await deps.db.select().from(payouts).where(and(eq(payouts.developerId, developer.id), eq(payouts.period, req.params.period)));
    return { statement: await developerStatement(deps, developer.id, req.params.period), payout: p ?? null };
  });

  // ---- Subscriptions (self-service) ----
  app.get("/me/subscriptions", { schema: { tags: ["account"] } }, async (req) => {
    const u = await requireUser(deps, req);
    const rows = await deps.db
      .select({ sub: subscriptions, price: prices, appName: apps.name, appSlug: apps.slug })
      .from(subscriptions)
      .innerJoin(prices, eq(prices.id, subscriptions.priceId))
      .innerJoin(apps, eq(apps.id, prices.appId))
      .where(eq(subscriptions.userId, u.userId))
      .orderBy(desc(subscriptions.createdAt));
    return {
      data: rows.map((r) => ({
        id: r.sub.id,
        status: r.sub.status,
        currentPeriodEnd: r.sub.currentPeriodEnd,
        app: { name: r.appName, slug: r.appSlug },
        price: `${formatMoney(r.price.unitAmountCents)} / ${r.price.interval}`,
      })),
    };
  });

  app.post("/me/subscriptions/:id/cancel", { schema: { tags: ["account"], params: z.object({ id: z.string() }), body: z.object({ immediately: z.boolean().default(false) }).nullish() } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    const [s] = await deps.db.select().from(subscriptions).where(and(eq(subscriptions.id, req.params.id), eq(subscriptions.userId, u.userId)));
    if (!s) throw notFound("subscription not found");
    if (["canceled", "canceling"].includes(s.status)) return { ok: true, status: s.status };
    if (!deps.payments) throw new PaymentsUnavailableError();
    if (!s.stripeSubscriptionId) throw badRequest("subscription is not linked to Stripe");
    const immediately = !!req.body?.immediately;
    const r = await deps.payments.cancelSubscription({ subscriptionId: s.stripeSubscriptionId, atPeriodEnd: !immediately });
    const status = immediately ? "canceled" : "canceling";
    await deps.db.update(subscriptions).set({ status }).where(eq(subscriptions.id, s.id));
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", action: "subscription.canceled", targetType: "subscription", targetId: s.id, metadata: { immediately, stripeStatus: r.status } });
    return { ok: true, status, currentPeriodEnd: s.currentPeriodEnd };
  });

  /** Stripe Customer Portal: update card, download Stripe receipts, manage subscriptions. */
  app.post("/me/billing-portal", { schema: { tags: ["account"] } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    if (!deps.payments) throw new PaymentsUnavailableError();
    const [user] = await deps.db.select().from(users).where(eq(users.id, u.userId));
    if (!user?.stripeCustomerId) throw badRequest("no card on file yet — top up or subscribe first");
    return { url: await deps.payments.createPortalSession({ customerId: user.stripeCustomerId, returnUrl: `${deps.config.AIX_WEB_URL}/wallet` }) };
  });

  app.get("/wallet/topups", { schema: { tags: ["wallet"], querystring: z.object({ orgId: z.string().optional() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    const w = await resolveWallet(deps, u, req.query.orgId, true);
    return { data: (await listTopUps(deps, w.id)).map((t) => ({ id: t.id, amountCents: t.amountCents, refundedCents: t.refundedCents, createdAt: t.createdAt, display: formatMoney(t.amountCents) })) };
  });

  // ---- Admin: refund unused wallet money to the card ----
  app.get("/admin/topups", { schema: { tags: ["admin"], querystring: z.object({ email: z.string().optional() }) } }, async (req) => {
    await requireAdmin(deps, req);
    const rows = await deps.db
      .select({ t: topups, email: users.email })
      .from(topups)
      .innerJoin(wallets, eq(wallets.id, topups.walletId))
      .leftJoin(users, eq(users.id, wallets.ownerUserId))
      .where(req.query.email ? eq(users.email, req.query.email.toLowerCase()) : undefined)
      .orderBy(desc(topups.createdAt))
      .limit(100);
    return { data: rows.map((r) => ({ ...r.t, email: r.email, refundableCents: r.t.amountCents - r.t.refundedCents })) };
  });

  app.post(
    "/admin/topups/:id/refund",
    { schema: { tags: ["admin"], params: z.object({ id: z.string() }), body: z.object({ amountCents: z.number().int().positive(), reason: z.string().min(3).max(300) }) } },
    async (req) => {
      const admin = await requireAdmin(deps, req);
      return refundTopUp(deps, req.params.id, req.body.amountCents, admin.userId, req.body.reason);
    },
  );

  // ---- Monthly invoices (user or org wallet) ----
  app.get("/wallet/invoices", { schema: { tags: ["wallet"], querystring: z.object({ orgId: z.string().optional() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    const w = await resolveWallet(deps, u, req.query.orgId, true);
    const stored = await deps.db.select().from(invoices).where(eq(invoices.walletId, w.id)).orderBy(desc(invoices.period));
    const now = deps.now();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const live = await computeInvoice(deps, w.id, current);
    return { current: { ...live, draft: true }, data: stored, lastClosedPeriod: previousPeriod(now) };
  });

  app.get("/wallet/invoices/:period.pdf", { schema: { tags: ["wallet"], params: z.object({ period }), querystring: z.object({ orgId: z.string().optional() }) } }, async (req, reply) => {
    const u = await requireUser(deps, req);
    const w = await resolveWallet(deps, u, req.query.orgId, true);
    if (!w) throw notFound();
    const pdf = await renderInvoicePdf(deps, w.id, req.params.period);
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="aix-invoice-${req.params.period}.pdf"`).send(pdf);
  });
}
