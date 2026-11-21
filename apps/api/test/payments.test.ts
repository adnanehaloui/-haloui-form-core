import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { subscriptions, topups, users } from "@aix/db";
import { newId } from "@aix/core";
import { dev, fixtureApp, installFixture, me, setup, signIn, type Ctx } from "./helpers.js";
import { balance, PLATFORM, trialBalance } from "../src/services/ledger.js";
import { runInvoices } from "../src/services/invoices.js";
import { prices } from "@aix/db";

let ctx: Ctx;
let cookie: string;
let userId: string;
let admin: string;
const webhook = (event: any) => ctx.app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "stripe-signature": "fake-valid", "content-type": "application/json" }, payload: JSON.stringify(event) });

async function topUpCard(amount: number, pi: string) {
  const r = await ctx.app.inject({ method: "POST", url: "/wallet/topup", headers: { cookie }, payload: { amountCents: amount } });
  const id = r.json().checkoutSessionId;
  const c = ctx.payments.checkouts.find((x) => x.id === id)!;
  await webhook({ id: `evt_${id}`, type: "checkout.session.completed", data: { object: { id, payment_status: "paid", amount_total: amount, currency: "eur", customer: "cus_test", payment_intent: pi, metadata: { aix_kind: "topup", aix_wallet_id: c.input.walletId } } } });
  return (await ctx.db.select().from(topups).where(eq(topups.paymentIntentId, pi)))[0]!;
}

beforeAll(async () => {
  ctx = await setup();
  cookie = await signIn(ctx, "payer@example.test");
  userId = (await me(ctx, cookie)).user.id;
  admin = await signIn(ctx, "admin@aix.test");
});
afterAll(() => ctx.close());

describe("payments pack", () => {
  it("top-up records the card payment and emails a receipt", async () => {
    const t = await topUpCard(2000, "pi_1");
    expect(t).toMatchObject({ amountCents: 2000, refundedCents: 0 });
    const mail = ctx.deps.mailer.outbox!.filter((m) => m.to === "payer@example.test").at(-1)!;
    expect(mail.subject).toBe("Receipt: €20.00 added to your AIX wallet");
    const list = (await ctx.app.inject({ method: "GET", url: "/wallet/topups", headers: { cookie } })).json().data;
    expect(list[0]).toMatchObject({ amountCents: 2000, display: "€20.00" });
  });

  it("admin refunds unused money to the card (ledger stays balanced)", async () => {
    const [t] = await ctx.db.select().from(topups).where(eq(topups.paymentIntentId, "pi_1"));
    const clearingBefore = await balance(ctx.db, PLATFORM.clearing);
    const r = await ctx.app.inject({ method: "POST", url: `/admin/topups/${t!.id}/refund`, headers: { cookie: admin }, payload: { amountCents: 500, reason: "customer asked" } });
    expect(r.json()).toMatchObject({ status: "succeeded", amountCents: 500 });
    expect(ctx.payments.refunds).toEqual([expect.objectContaining({ paymentIntentId: "pi_1", amountCents: 500 })]);
    expect((await me(ctx, cookie)).wallet.availableCents).toBe(1500);
    expect(await balance(ctx.db, PLATFORM.refunds)).toBe(0);
    expect(await balance(ctx.db, PLATFORM.clearing)).toBe(clearingBefore - 500);
    expect(ctx.deps.mailer.outbox!.at(-1)!.subject).toBe("Refund of €5.00 on its way");
    // Can't refund more than what's left of that payment, and only admins can refund.
    expect((await ctx.app.inject({ method: "POST", url: `/admin/topups/${t!.id}/refund`, headers: { cookie: admin }, payload: { amountCents: 1600, reason: "too much" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: `/admin/topups/${t!.id}/refund`, headers: { cookie }, payload: { amountCents: 100, reason: "mine" } })).statusCode).toBe(403);
  });

  it("only unused money can be refunded, and a Stripe failure rolls back", async () => {
    const fx = await fixtureApp(ctx, { unitAmountCents: 1000 });
    await installFixture(ctx, userId, fx.appId, fx.versionId);
    await ctx.app.inject({ method: "PUT", url: "/wallet/limits", headers: { cookie }, payload: { period: "monthly", capCents: null, autoApproveThresholdCents: 100_000 } });
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId, priceId: "render", idempotencyKey: "spend" } });
    await ctx.app.inject({ method: "POST", url: `/v1/holds/${h.json().id}/capture`, headers: dev(fx.secret) });
    const [t] = await ctx.db.select().from(topups).where(eq(topups.paymentIntentId, "pi_1"));
    const r = await ctx.app.inject({ method: "POST", url: `/admin/topups/${t!.id}/refund`, headers: { cookie: admin }, payload: { amountCents: 1000, reason: "test refund" } });
    expect(r.json().error.code).toBe("insufficient_funds"); // only €5 unused left
    ctx.payments.failRefunds = true;
    const f = await ctx.app.inject({ method: "POST", url: `/admin/topups/${t!.id}/refund`, headers: { cookie: admin }, payload: { amountCents: 300, reason: "test refund" } });
    expect(f.statusCode).toBe(502);
    ctx.payments.failRefunds = false;
    expect((await me(ctx, cookie)).wallet.availableCents).toBe(500);
    expect((await ctx.db.select().from(topups).where(eq(topups.id, t!.id)))[0]!.refundedCents).toBe(500);
  });

  it("chargebacks take money from the wallet; won disputes return it", async () => {
    await topUpCard(1000, "pi_2");
    await webhook({ id: "evt_dp1", type: "charge.dispute.created", data: { object: { id: "dp_1", amount: 1000, payment_intent: "pi_2", status: "needs_response" } } });
    expect((await me(ctx, cookie)).wallet.availableCents).toBe(500);
    expect(ctx.deps.mailer.outbox!.at(-1)!.subject).toBe("About a payment dispute");
    await webhook({ id: "evt_dp2", type: "charge.dispute.closed", data: { object: { id: "dp_1", status: "won" } } });
    expect((await me(ctx, cookie)).wallet.availableCents).toBe(1500);
    // A lost dispute bigger than the balance leaves the wallet in debt → it can't spend.
    await topUpCard(500, "pi_3");
    await webhook({ id: "evt_dp3", type: "charge.dispute.created", data: { object: { id: "dp_2", amount: 2500, payment_intent: "pi_3", status: "needs_response" } } });
    expect((await me(ctx, cookie)).wallet.availableCents).toBe(-500);
    const tb = await trialBalance(ctx.db);
    expect(tb.debitCents).toBe(tb.creditCents);
  });

  it("subscriptions: list, cancel at period end (still entitled), billing portal", async () => {
    const fx = await fixtureApp(ctx);
    const priceId = newId("price");
    await ctx.db.insert(prices).values({ id: priceId, appId: fx.appId, lookupKey: "pro", kind: "subscription", unit: "month", unitAmountCents: 499, interval: "month" });
    await installFixture(ctx, userId, fx.appId, fx.versionId);
    const w = await me(ctx, cookie);
    await ctx.db.insert(subscriptions).values({ id: "sub_local", walletId: w.wallet.id, userId, priceId, stripeSubscriptionId: "sub_stripe_1", status: "active", currentPeriodEnd: new Date(Date.now() + 20 * 86400_000) });
    const list = (await ctx.app.inject({ method: "GET", url: "/me/subscriptions", headers: { cookie } })).json().data;
    expect(list[0]).toMatchObject({ status: "active", price: "€4.99 / month", app: { name: "VideoStudio" } });
    const c = await ctx.app.inject({ method: "POST", url: "/me/subscriptions/sub_local/cancel", headers: { cookie } });
    expect(c.json().status).toBe("canceling");
    expect(ctx.payments.canceled).toEqual([{ subscriptionId: "sub_stripe_1", atPeriodEnd: true }]);
    const ent = await ctx.app.inject({ method: "POST", url: "/v1/entitlements/check", headers: dev(fx.secret), payload: { userId, key: "pro" } });
    expect(ent.json().entitled).toBe(true);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(u!.stripeCustomerId).toBe("cus_test");
    const portal = await ctx.app.inject({ method: "POST", url: "/me/billing-portal", headers: { cookie } });
    expect(portal.json().url).toContain("/portal/cus_test");
    // Another user can't cancel it.
    const other = await signIn(ctx, "other@example.test");
    expect((await ctx.app.inject({ method: "POST", url: "/me/subscriptions/sub_local/cancel", headers: { cookie: other } })).statusCode).toBe(404);
  });

  it("monthly statements are emailed once with the PDF attached", async () => {
    const period = new Date().toISOString().slice(0, 7);
    const before = ctx.deps.mailer.outbox!.length;
    await runInvoices(ctx.deps, period);
    const sent = ctx.deps.mailer.outbox!.slice(before).filter((m) => m.subject.startsWith("Your AIX statement"));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]!.attachments![0]!.content.subarray(0, 5).toString()).toBe("%PDF-");
    await runInvoices(ctx.deps, period);
    expect(ctx.deps.mailer.outbox!.slice(before).filter((m) => m.subject.startsWith("Your AIX statement")).length).toBe(sent.length);
  });
});
