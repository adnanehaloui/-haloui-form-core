import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { developers, payouts } from "@aix/db";
import { dev, fixtureApp, installFixture, me, setup, signIn, topUp, type Ctx } from "./helpers.js";
import { balance } from "../src/services/ledger.js";
import { runPayouts } from "../src/services/payouts.js";
import { computeInvoice, runInvoices } from "../src/services/invoices.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());

const thisPeriod = () => new Date().toISOString().slice(0, 7);

describe("M5 — developers get paid", () => {
  it("Connect onboarding + payout with the correct 80/20 split, idempotent", async () => {
    const devCookie = await signIn(ctx, "payee@acme.test");
    const devId = (await ctx.app.inject({ method: "POST", url: "/developer", headers: { cookie: devCookie }, payload: { displayName: "Payee" } })).json().id;
    const fx = await fixtureApp(ctx, { unitAmountCents: 1000 });
    await ctx.db.update(developers).set({ userId: null }).where(eq(developers.id, fx.developerId));
    // Use the fixture developer but onboard through the API as that developer's key.
    const onboard = await ctx.app.inject({ method: "POST", url: "/developer/connect/onboard", headers: dev(fx.secret) });
    expect(onboard.json().url).toContain("connect.stripe.test");
    const acct = onboard.json().accountId;

    const user = await signIn(ctx, "buyer@x.test");
    const userId = (await me(ctx, user)).user.id;
    await topUp(ctx, user, 5000);
    await installFixture(ctx, userId, fx.appId, fx.versionId);
    await ctx.app.inject({ method: "PUT", url: "/wallet/limits", headers: { cookie: user }, payload: { period: "monthly", capCents: null, autoApproveThresholdCents: 10_000 } });
    for (const k of ["a", "b", "c"]) {
      const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId, priceId: "render", idempotencyKey: k } });
      await ctx.app.inject({ method: "POST", url: `/v1/holds/${h.json().id}/capture`, headers: dev(fx.secret) });
    }
    // €30 gross → developer €24, platform €6.
    expect(await balance(ctx.db, `acct_${fx.developerId}_payable`)).toBe(2400);
    expect(await balance(ctx.db, "acct_platform_revenue_eur")).toBe(600);

    // Not onboarded yet → skipped.
    let r = await runPayouts(ctx.deps, thisPeriod());
    expect(r.find((x) => x.developerId === fx.developerId)!.status).toBe("skipped");
    ctx.payments.connectStatus.set(acct, "enabled");
    r = await runPayouts(ctx.deps, thisPeriod());
    const mine = r.find((x) => x.developerId === fx.developerId)!;
    expect(mine).toMatchObject({ status: "paid", amountCents: 2400 });
    expect(ctx.payments.transfers).toEqual([expect.objectContaining({ accountId: acct, amountCents: 2400 })]);
    expect(await balance(ctx.db, `acct_${fx.developerId}_payable`)).toBe(0);
    // Re-running never pays twice.
    r = await runPayouts(ctx.deps, thisPeriod());
    expect(r.find((x) => x.developerId === fx.developerId)!.status).toBe("already_paid");
    expect(ctx.payments.transfers).toHaveLength(1);
    const [po] = await ctx.db.select().from(payouts).where(eq(payouts.developerId, fx.developerId));
    expect((po!.statement as any).apps[0]).toMatchObject({ charges: 3, grossCents: 3000, developerCents: 2400, platformCents: 600 });
    // The other developer (no earnings) is skipped, not paid.
    expect(r.find((x) => x.developerId === devId)!.status).toBe("skipped");

    // A refund after the payout makes payable negative → netted next month.
    const admin = await signIn(ctx, "admin@aix.test");
    const chg = (await ctx.app.inject({ method: "GET", url: "/admin/charges?email=buyer@x.test", headers: { cookie: admin } })).json().data[0];
    const ref = await ctx.app.inject({ method: "POST", url: `/admin/charges/${chg.id}/refund`, headers: { cookie: admin }, payload: { reason: "customer complaint" } });
    expect(ref.json().status).toBe("refunded");
    expect(await balance(ctx.db, `acct_${fx.developerId}_payable`)).toBe(-800);
    expect((await me(ctx, user)).wallet.availableCents).toBe(5000 - 3000 + 1000);
  });

  it("monthly invoice lists each app, PDF renders", async () => {
    const user = await signIn(ctx, "buyer@x.test");
    const w = await me(ctx, user);
    const inv = await computeInvoice(ctx.deps, w.wallet.id, thisPeriod());
    expect(inv.lines[0]).toMatchObject({ appName: "VideoStudio", charges: 3, amountCents: 3000, refundedCents: 1000 });
    expect(inv.totalCents).toBe(2000);
    expect(await runInvoices(ctx.deps, thisPeriod())).toBeGreaterThanOrEqual(1);
    const pdf = await ctx.app.inject({ method: "GET", url: `/wallet/invoices/${thisPeriod()}.pdf`, headers: { cookie: user } });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("M6 — enterprise", () => {
  let owner: string, member: string, outsider: string;
  let orgA: string, orgB: string, memberId: string;
  let fx: Awaited<ReturnType<typeof fixtureApp>>;

  beforeAll(async () => {
    owner = await signIn(ctx, "owner@corp.test");
    member = await signIn(ctx, "member@corp.test");
    outsider = await signIn(ctx, "owner@other.test");
    orgA = (await ctx.app.inject({ method: "POST", url: "/orgs", headers: { cookie: owner }, payload: { name: "Corp A", slug: "corp-a" } })).json().id;
    orgB = (await ctx.app.inject({ method: "POST", url: "/orgs", headers: { cookie: outsider }, payload: { name: "Corp B", slug: "corp-b" } })).json().id;
    await ctx.app.inject({ method: "POST", url: `/orgs/${orgA}/invites`, headers: { cookie: owner }, payload: { email: "member@corp.test", role: "member" } });
    const inviteLink = /(https?:\/\/\S+)/.exec(ctx.deps.mailer.outbox!.filter((m) => m.to === "member@corp.test").at(-1)!.text)![1]!;
    await ctx.app.inject({ method: "POST", url: `/invites/${inviteLink.split("/invites/")[1]}/accept`, headers: { cookie: member } });
    memberId = (await me(ctx, member)).user.id;
    fx = await fixtureApp(ctx, { slug: "videostudio" });
  });

  it("org wallet: owner tops up; member installs paid by the org within a per-member budget", async () => {
    await topUp(ctx, owner, 10_000, orgA);
    expect((await ctx.app.inject({ method: "GET", url: `/wallet?orgId=${orgA}`, headers: { cookie: owner } })).json().availableCents).toBe(10_000);
    // Members can't see org finances or top up.
    expect((await ctx.app.inject({ method: "GET", url: `/wallet/transactions?orgId=${orgA}`, headers: { cookie: member } })).statusCode).toBe(403);
    // Default role rule: members can't install on the org account unless the policy allows it.
    const no = await ctx.app.inject({ method: "POST", url: `/store/apps/${fx.slug}/install`, headers: { cookie: member }, payload: { acceptPermissions: true, orgId: orgA } });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.message).toContain("role (member)");
    // Admin allows the app for every role → the member can install it on the org account.
    await ctx.app.inject({ method: "PUT", url: `/orgs/${orgA}/policies/${fx.appId}`, headers: { cookie: owner }, payload: { allowed: true } });
    const ok = await ctx.app.inject({ method: "POST", url: `/store/apps/${fx.slug}/install`, headers: { cookie: member }, payload: { acceptPermissions: true, orgId: orgA } });
    expect(ok.json()).toMatchObject({ orgId: orgA });
    // Max permissions: an org that forbids network access blocks this app at install time.
    await ctx.app.inject({ method: "PUT", url: `/orgs/${orgA}/policies/${fx.appId}`, headers: { cookie: owner }, payload: { allowed: true, maxPermissions: { network: false, files: false, userData: [] } } });
    const capped = await ctx.app.inject({ method: "POST", url: `/store/apps/${fx.slug}/install`, headers: { cookie: owner }, payload: { acceptPermissions: true } });
    expect(capped.json().error.message).toContain("more permissions");
    await ctx.app.inject({ method: "DELETE", url: `/orgs/${orgA}/policies/${fx.appId}`, headers: { cookie: owner } });
  });

  it("per-member budget caps spending on the org wallet", async () => {
    await ctx.app.inject({ method: "PUT", url: `/orgs/${orgA}/budgets`, headers: { cookie: owner }, payload: { userId: memberId, period: "monthly", capCents: 100, autoApproveThresholdCents: 100 } });
    const h1 = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId: memberId, priceId: "render", quantity: 2, idempotencyKey: "m1" } });
    expect(h1.json()).toMatchObject({ status: "held", amountCents: 100, orgId: orgA });
    expect((await ctx.app.inject({ method: "GET", url: `/wallet?orgId=${orgA}`, headers: { cookie: owner } })).json().heldCents).toBe(100);
    const h2 = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId: memberId, priceId: "render", idempotencyKey: "m2" } });
    expect(h2.json().error.code).toBe("spend_limit_exceeded");
    // Personal wallet untouched.
    expect((await me(ctx, member)).wallet.heldCents).toBe(0);
  });

  it("an org admin blocks the app → the member can no longer install or call it", async () => {
    const block = await ctx.app.inject({ method: "PUT", url: `/orgs/${orgA}/policies/${fx.appId}`, headers: { cookie: owner }, payload: { allowed: false } });
    expect(block.statusCode).toBe(200);
    const hold = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId: memberId, priceId: "render", idempotencyKey: "m3" } });
    expect(hold.json().error.code).toBe("blocked_by_org_policy");
    const call = await ctx.app.inject({ method: "POST", url: "/gateway/calls", headers: { cookie: member }, payload: { appSlug: fx.slug, tool: "render" } });
    expect(call.statusCode).toBe(403);
    expect(call.json().error.code).toBe("blocked_by_org_policy");
    // Approved-only catalog: unblocked but unlisted apps are also refused.
    await ctx.app.inject({ method: "DELETE", url: `/orgs/${orgA}/policies/${fx.appId}`, headers: { cookie: owner } });
    await ctx.app.inject({ method: "PUT", url: `/orgs/${orgA}/catalog`, headers: { cookie: owner }, payload: { mode: "approved_only" } });
    expect((await ctx.app.inject({ method: "POST", url: "/gateway/calls", headers: { cookie: member }, payload: { appSlug: fx.slug, tool: "render" } })).json().error.code).toBe("blocked_by_org_policy");
    // Role rule: allowed for admins only.
    await ctx.app.inject({ method: "PUT", url: `/orgs/${orgA}/policies/${fx.appId}`, headers: { cookie: owner }, payload: { allowed: true, allowedRoles: ["owner", "admin"] } });
    expect((await ctx.app.inject({ method: "POST", url: "/gateway/calls", headers: { cookie: member }, payload: { appSlug: fx.slug, tool: "render" } })).json().error.message).toContain("role");
    // Members can't change policies.
    expect((await ctx.app.inject({ method: "PUT", url: `/orgs/${orgA}/policies/${fx.appId}`, headers: { cookie: member }, payload: { allowed: true } })).statusCode).toBe(403);
  });

  it("audit log export (CSV) contains policy changes, with formula-injection protection", async () => {
    const csv = await ctx.app.inject({ method: "GET", url: `/orgs/${orgA}/audit.csv`, headers: { cookie: owner } });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain('"org.app_blocked"');
    expect(csv.body).toContain('"org.budget_set"');
    expect(csv.body.split("\n")[0]).toBe("time,actor_email,actor_type,action,target_type,target_id,metadata");
    expect((await ctx.app.inject({ method: "GET", url: `/orgs/${orgA}/audit.csv`, headers: { cookie: member } })).statusCode).toBe(403);
  });

  it("tenant isolation: a member of org B can never read org A data", async () => {
    const urls = [`/orgs/${orgA}`, `/orgs/${orgA}/members`, `/wallet?orgId=${orgA}`, `/wallet/transactions?orgId=${orgA}`, `/wallet/charges?orgId=${orgA}`, `/orgs/${orgA}/policies`, `/orgs/${orgA}/budgets`, `/orgs/${orgA}/audit`, `/orgs/${orgA}/audit.csv`, `/wallet/invoices?orgId=${orgA}`];
    for (const url of urls) {
      const r = await ctx.app.inject({ method: "GET", url, headers: { cookie: outsider } });
      expect(r.statusCode, url).toBe(404);
      expect(r.body).not.toContain("Corp A");
    }
    const writes = [
      { method: "POST" as const, url: `/orgs/${orgA}/invites`, payload: { email: "x@x.test", role: "owner" } },
      { method: "PUT" as const, url: `/orgs/${orgA}/catalog`, payload: { mode: "open" } },
      { method: "PUT" as const, url: `/orgs/${orgA}/budgets`, payload: { userId: null, period: "monthly", capCents: 0, autoApproveThresholdCents: 0 } },
      { method: "POST" as const, url: "/wallet/topup", payload: { amountCents: 1000, orgId: orgA } },
    ];
    for (const w of writes) expect((await ctx.app.inject({ ...w, headers: { cookie: outsider } })).statusCode, w.url).toBe(404);
    // And the reverse.
    expect((await ctx.app.inject({ method: "GET", url: `/orgs/${orgB}/members`, headers: { cookie: owner } })).statusCode).toBe(404);
  });
});
