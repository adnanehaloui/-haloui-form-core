import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dev, fixtureApp, installFixture, me, setup, signIn, topUp, type Ctx } from "./helpers.js";
import { balance, PLATFORM, trialBalance } from "../src/services/ledger.js";
import { expireHolds } from "../src/services/charges.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());

describe("M1 — sign up and see an empty wallet", () => {
  it("magic link sign-up creates a user with a €0.00 wallet", async () => {
    const cookie = await signIn(ctx, "new@user.test");
    const m = await me(ctx, cookie);
    expect(m.user.email).toBe("new@user.test");
    expect(m.wallet).toMatchObject({ availableCents: 0, heldCents: 0, currency: "EUR" });
    const w = await ctx.app.inject({ method: "GET", url: "/wallet", headers: { cookie } });
    expect(w.json().display.available).toBe("€0.00");
  });

  it("rejects reused / bogus magic links and unauthenticated calls", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    const r = await ctx.app.inject({ method: "GET", url: "/auth/magic-link/verify?token=not-a-real-token-123" });
    expect(r.headers.location).toContain("error=link_expired");
  });
});

describe("M2 — wallet & payments", () => {
  let cookie: string;
  let userId: string;
  let fx: Awaited<ReturnType<typeof fixtureApp>>;

  beforeAll(async () => {
    cookie = await signIn(ctx, "alice@user.test");
    userId = (await me(ctx, cookie)).user.id;
    fx = await fixtureApp(ctx);
    await installFixture(ctx, userId, fx.appId, fx.versionId);
  });

  it("tops up €20 via Stripe Checkout webhook, idempotently", async () => {
    const r = await topUp(ctx, cookie, 2000);
    expect(r.statusCode).toBe(200);
    expect((await me(ctx, cookie)).wallet.availableCents).toBe(2000);
    // Stripe redelivers the same event → no double credit.
    const c = ctx.payments.checkouts.at(-1)!;
    const replay = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "fake-valid", "content-type": "application/json" },
      payload: JSON.stringify({ id: `evt_${c.id}`, type: "checkout.session.completed", data: { object: { id: c.id, payment_status: "paid", amount_total: 2000, currency: "eur", metadata: { aix_kind: "topup", aix_wallet_id: c.input.walletId } } } }),
    });
    expect(replay.json().duplicate).toBe(true);
    expect((await me(ctx, cookie)).wallet.availableCents).toBe(2000);
  });

  it("rejects webhooks with a bad signature", async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "stripe-signature": "nope", "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(400);
  });

  it("enforces the minimum top-up", async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/wallet/topup", headers: { cookie }, payload: { amountCents: 100 } });
    expect(r.statusCode).toBe(400);
  });

  it("charges €0.50 via hold → capture with 80/20 split; history shows it", async () => {
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId, priceId: "render", quantity: 1, idempotencyKey: "run-1", runId: "run-1" } });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toMatchObject({ status: "held", amountCents: 50, display: "€0.50" });
    expect((await me(ctx, cookie)).wallet).toMatchObject({ availableCents: 1950, heldCents: 50 });

    const c = await ctx.app.inject({ method: "POST", url: `/v1/holds/${h.json().id}/capture`, headers: dev(fx.secret) });
    expect(c.json().status).toBe("captured");
    expect((await me(ctx, cookie)).wallet).toMatchObject({ availableCents: 1950, heldCents: 0 });
    expect(await balance(ctx.db, `acct_${fx.developerId}_payable`)).toBe(40);

    const hist = (await ctx.app.inject({ method: "GET", url: "/wallet/transactions", headers: { cookie } })).json().data;
    expect(hist.map((t: any) => t.kind)).toEqual(["capture", "hold", "topup"]);
    expect(hist[0]).toMatchObject({ app: { name: "VideoStudio" }, heldDeltaCents: -50, availableDeltaCents: 0 });
    expect(hist[2].availableDeltaCents).toBe(2000);
  });

  it("is idempotent: same key returns the same charge, different params → 409", async () => {
    const body = { userId, priceId: fx.priceId, quantity: 1, idempotencyKey: "run-1" };
    const again = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: body });
    expect(again.json().status).toBe("captured");
    const mismatch = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { ...body, quantity: 2 } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("idempotency_mismatch");
    // Capture twice = still one capture.
    const id = again.json().id;
    await ctx.app.inject({ method: "POST", url: `/v1/holds/${id}/capture`, headers: dev(fx.secret) });
    expect(await balance(ctx.db, `acct_${fx.developerId}_payable`)).toBe(40);
  });

  it("release returns money to the wallet", async () => {
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId, priceId: "render", idempotencyKey: "run-2" } });
    const r = await ctx.app.inject({ method: "POST", url: `/v1/holds/${h.json().id}/release`, headers: dev(fx.secret), payload: { reason: "render_failed" } });
    expect(r.json().status).toBe("released");
    expect((await me(ctx, cookie)).wallet).toMatchObject({ availableCents: 1950, heldCents: 0 });
    const cap = await ctx.app.inject({ method: "POST", url: `/v1/holds/${h.json().id}/capture`, headers: dev(fx.secret) });
    expect(cap.statusCode).toBe(409);
  });

  it("asks for approval above the €1 threshold, then proceeds after approval", async () => {
    const body = { userId, priceId: "render", quantity: 3, idempotencyKey: "run-3" }; // €1.50
    const h1 = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: body });
    expect(h1.statusCode).toBe(402);
    const err = h1.json().error;
    expect(err.code).toBe("needs_user_approval");
    expect(err.details).toMatchObject({ amountCents: 150, display: "€1.50" });
    expect(err.details.approvalUrl).toContain(`/approve/${err.details.approvalId}`);

    // Another user can't see or approve it.
    const bob = await signIn(ctx, "bob@user.test");
    expect((await ctx.app.inject({ method: "POST", url: `/approvals/${err.details.approvalId}/decision`, headers: { cookie: bob }, payload: { decision: "approve" } })).statusCode).toBe(404);

    const ok = await ctx.app.inject({ method: "POST", url: `/approvals/${err.details.approvalId}/decision`, headers: { cookie }, payload: { decision: "approve" } });
    expect(ok.json().status).toBe("approved");
    const h2 = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: body });
    expect(h2.statusCode).toBe(200);
    expect(h2.json().amountCents).toBe(150);
    const rel = await ctx.app.inject({ method: "POST", url: `/v1/holds/${h2.json().id}/release`, headers: dev(fx.secret) });
    expect(rel.json()).toMatchObject({ status: "released" });
  });

  it("denied approvals stay denied", async () => {
    const body = { userId, priceId: "render", quantity: 4, idempotencyKey: "run-4" };
    const h1 = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: body });
    const id = h1.json().error.details.approvalId;
    await ctx.app.inject({ method: "POST", url: `/approvals/${id}/decision`, headers: { cookie }, payload: { decision: "deny" } });
    const h2 = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: body });
    expect(h2.statusCode).toBe(402);
    expect(h2.json().error.details.status).toBe("denied");
  });

  it("blocks charges over the monthly cap, even if approved", async () => {
    await ctx.app.inject({ method: "PUT", url: "/wallet/limits", headers: { cookie }, payload: { period: "monthly", capCents: 100, autoApproveThresholdCents: 1000 } });
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId, priceId: "render", quantity: 2, idempotencyKey: "run-5" } });
    expect(h.statusCode).toBe(402);
    expect(h.json().error.code).toBe("spend_limit_exceeded");
    await ctx.app.inject({ method: "PUT", url: "/wallet/limits", headers: { cookie }, payload: { period: "monthly", capCents: 100_000, autoApproveThresholdCents: 100_000 } });
  });

  it("returns insufficient_funds when the wallet is short", async () => {
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId, priceId: "render", quantity: 1000, idempotencyKey: "run-6" } });
    expect(h.statusCode).toBe(402);
    expect(h.json().error.code).toBe("insufficient_funds");
  });

  it("only server-side secret keys can charge: sessions, bad keys, and non-installers are refused", async () => {
    const body = { userId, priceId: "render", idempotencyKey: "run-7" };
    expect((await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: { cookie }, payload: body })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev("aixsk_test_nope"), payload: body })).statusCode).toBe(401);
    const bobId = (await me(ctx, await signIn(ctx, "bob@user.test"))).user.id;
    const r = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { ...body, userId: bobId } });
    expect(r.json().error.code).toBe("not_installed");
    // Another developer cannot charge against this app's price.
    const other = await fixtureApp(ctx);
    expect((await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(other.secret), payload: { ...body, priceId: fx.priceId } })).statusCode).toBe(404);
  });

  it("free included units are not charged", async () => {
    const free = await fixtureApp(ctx, { includedUnits: 3 });
    await installFixture(ctx, userId, free.appId, free.versionId);
    const amounts = [];
    for (let i = 0; i < 4; i++) {
      const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(free.secret), payload: { userId, priceId: "render", idempotencyKey: `free-${i}` } });
      amounts.push(h.json().amountCents);
      await ctx.app.inject({ method: "POST", url: `/v1/holds/${h.json().id}/capture`, headers: dev(free.secret) });
    }
    expect(amounts).toEqual([0, 0, 0, 50]);
  });

  it("concurrent holds can never overspend the wallet", async () => {
    const carol = await signIn(ctx, "carol@user.test");
    const carolId = (await me(ctx, carol)).user.id;
    await topUp(ctx, carol, 500);
    const c = await fixtureApp(ctx, { unitAmountCents: 100 });
    await installFixture(ctx, carolId, c.appId, c.versionId);
    await ctx.app.inject({ method: "PUT", url: "/wallet/limits", headers: { cookie: carol }, payload: { period: "monthly", capCents: null, autoApproveThresholdCents: 1000 } });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(c.secret), payload: { userId: carolId, priceId: "render", idempotencyKey: `par-${i}` } })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect((await me(ctx, carol)).wallet).toMatchObject({ availableCents: 0, heldCents: 500 });
  });

  it("expired holds are released by the job", async () => {
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId, priceId: "render", idempotencyKey: "run-exp", holdTtlSeconds: 1 } });
    expect(h.json().status).toBe("held");
    const later = { ...ctx.deps, now: () => new Date(Date.now() + 5000) };
    expect(await expireHolds(later)).toBeGreaterThanOrEqual(1);
    expect((await me(ctx, cookie)).wallet.heldCents).toBe(0);
  });

  it("the whole ledger always balances", async () => {
    const tb = await trialBalance(ctx.db);
    expect(tb.debitCents).toBe(tb.creditCents);
    // Accounting equation: Stripe clearing = all wallets + payables + revenue.
    expect(await balance(ctx.db, PLATFORM.clearing)).toBeGreaterThan(0);
  });
});
