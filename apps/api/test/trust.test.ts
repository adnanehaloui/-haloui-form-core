import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ledgerEntries, reviews, users } from "@aix/db";
import { newId } from "@aix/core";
import { dev, fixtureApp, installFixture, me, setup, signIn, topUp, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());
const link = (email: string) => /(https?:\/\/\S+)/.exec(ctx.deps.mailer.outbox!.filter((m) => m.to === email).at(-1)!.text)![1]!;

describe("org invitations", () => {
  it("invite by email → accept with the matching account only, once", async () => {
    const owner = await signIn(ctx, "boss@corp.test");
    const orgId = (await ctx.app.inject({ method: "POST", url: "/orgs", headers: { cookie: owner }, payload: { name: "Corp", slug: "corp" } })).json().id;
    const inv = await ctx.app.inject({ method: "POST", url: `/orgs/${orgId}/invites`, headers: { cookie: owner }, payload: { email: "New.Hire@corp.test", role: "member" } });
    expect(inv.json()).toMatchObject({ email: "new.hire@corp.test", role: "member" });
    const token = link("new.hire@corp.test").split("/invites/")[1]!;
    expect((await ctx.app.inject({ method: "GET", url: `/invites/${token}` })).json()).toMatchObject({ orgName: "Corp", role: "member" });
    const stranger = await signIn(ctx, "stranger@x.test");
    expect((await ctx.app.inject({ method: "POST", url: `/invites/${token}/accept`, headers: { cookie: stranger } })).statusCode).toBe(403);
    const hire = await signIn(ctx, "new.hire@corp.test");
    expect((await ctx.app.inject({ method: "POST", url: `/invites/${token}/accept`, headers: { cookie: hire } })).json()).toMatchObject({ orgId, role: "member" });
    expect((await me(ctx, hire)).orgs[0]).toMatchObject({ id: orgId, role: "member" });
    expect((await ctx.app.inject({ method: "POST", url: `/invites/${token}/accept`, headers: { cookie: hire } })).statusCode).toBe(404);
    // Members can't invite.
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${orgId}/invites`, headers: { cookie: hire }, payload: { email: "x@y.test", role: "admin" } })).statusCode).toBe(403);
  });
});

describe("moderation and bans", () => {
  let fx: Awaited<ReturnType<typeof fixtureApp>>;
  let troll: string;
  let trollId: string;
  const admin = () => signIn(ctx, "admin@aix.test");

  beforeAll(async () => {
    fx = await fixtureApp(ctx, { slug: "modapp" });
    troll = await signIn(ctx, "troll@x.test");
    trollId = (await me(ctx, troll)).user.id;
    await installFixture(ctx, trollId, fx.appId, fx.versionId);
  });

  it("reports + hidden reviews disappear from the store and ratings", async () => {
    await ctx.app.inject({ method: "POST", url: `/store/apps/modapp/reviews`, headers: { cookie: troll }, payload: { rating: 1, body: "spam spam" } });
    const page = (await ctx.app.inject({ method: "GET", url: "/store/apps/modapp" })).json();
    const reviewId = page.reviews[0].id;
    expect(page.rating).toMatchObject({ average: 1, count: 1 });
    const reporter = await signIn(ctx, "reporter@x.test");
    const rep = await ctx.app.inject({ method: "POST", url: "/reports", headers: { cookie: reporter }, payload: { targetType: "review", targetId: reviewId, reason: "this is spam" } });
    expect(rep.json().status).toBe("open");
    const a = await admin();
    const q = (await ctx.app.inject({ method: "GET", url: "/admin/reports", headers: { cookie: a } })).json().data;
    expect(q[0]).toMatchObject({ targetType: "review", target: { body: "spam spam" } });
    await ctx.app.inject({ method: "POST", url: `/admin/reviews/${reviewId}/hide`, headers: { cookie: a } });
    await ctx.app.inject({ method: "POST", url: `/admin/reports/${q[0].id}/resolve`, headers: { cookie: a } });
    const after = (await ctx.app.inject({ method: "GET", url: "/store/apps/modapp" })).json();
    expect(after.reviews).toHaveLength(0);
    expect(after.rating).toBeNull();
    expect((await ctx.app.inject({ method: "GET", url: "/admin/reports", headers: { cookie: a } })).json().data).toHaveLength(0);
  });

  it("a banned user loses sessions, can't sign in, and can't be charged", async () => {
    await topUp(ctx, troll, 1000);
    const a = await admin();
    expect((await ctx.app.inject({ method: "POST", url: `/admin/users/${trollId}/ban`, headers: { cookie: a }, payload: {} })).statusCode).toBe(400); // reason required
    await ctx.app.inject({ method: "POST", url: `/admin/users/${trollId}/ban`, headers: { cookie: a }, payload: { reason: "abuse" } });
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: troll } })).statusCode).toBe(401);
    await ctx.app.inject({ method: "POST", url: "/auth/magic-link", payload: { email: "troll@x.test" } });
    const token = new URL(link("troll@x.test")).searchParams.get("token")!;
    const r = await ctx.app.inject({ method: "GET", url: `/auth/magic-link/verify?token=${token}` });
    expect(r.headers.location).toContain("error=account_disabled");
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId: trollId, priceId: "render", idempotencyKey: "ban" } });
    expect(h.statusCode).toBe(403);
    await ctx.app.inject({ method: "POST", url: `/admin/users/${trollId}/unban`, headers: { cookie: a } });
    expect((await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId: trollId, priceId: "render", idempotencyKey: "ban2" } })).statusCode).toBe(200);
  });
});

describe("top-up velocity limits", () => {
  it("new accounts are capped at €100/day; attempts are rate limited", async () => {
    const c = await signIn(ctx, "fresh@x.test");
    expect((await ctx.app.inject({ method: "POST", url: "/wallet/topup", headers: { cookie: c }, payload: { amountCents: 15_000 } })).json().error.message).toContain("€100.00 for new accounts");
    await topUp(ctx, c, 9_000);
    expect((await ctx.app.inject({ method: "POST", url: "/wallet/topup", headers: { cookie: c }, payload: { amountCents: 2_000 } })).statusCode).toBe(400);
    for (let i = 0; i < 4; i++) await ctx.app.inject({ method: "POST", url: "/wallet/topup", headers: { cookie: c }, payload: { amountCents: 500 } });
    expect((await ctx.app.inject({ method: "POST", url: "/wallet/topup", headers: { cookie: c }, payload: { amountCents: 500 } })).statusCode).toBe(429);
  });
});

describe("GDPR export and delete", () => {
  it("exports my data and deletes the account (financial records kept, anonymized)", async () => {
    const c = await signIn(ctx, "leaver@x.test");
    const id = (await me(ctx, c)).user.id;
    const fx = await fixtureApp(ctx);
    await installFixture(ctx, id, fx.appId, fx.versionId);
    await topUp(ctx, c, 500);
    const exp = await ctx.app.inject({ method: "GET", url: "/me/export", headers: { cookie: c } });
    expect(exp.headers["content-disposition"]).toContain("attachment");
    const data = exp.json();
    expect(data.profile.email).toBe("leaver@x.test");
    expect(data.wallet.availableCents).toBe(500);
    expect(data.installs).toHaveLength(1);
    // Money left → must be spent or refunded first.
    expect((await ctx.app.inject({ method: "POST", url: "/me/delete", headers: { cookie: c }, payload: { confirm: "DELETE" } })).statusCode).toBe(409);
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId: id, priceId: "render", quantity: 10, idempotencyKey: "spend-all" } });
    await ctx.app.inject({ method: "POST", url: `/approvals/${h.json().error?.details?.approvalId}/decision`, headers: { cookie: c }, payload: { decision: "approve" } });
    const h2 = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId: id, priceId: "render", quantity: 10, idempotencyKey: "spend-all" } });
    await ctx.app.inject({ method: "POST", url: `/v1/holds/${h2.json().id}/capture`, headers: dev(fx.secret) });
    expect((await ctx.app.inject({ method: "POST", url: "/me/delete", headers: { cookie: c }, payload: { confirm: "nope" } })).statusCode).toBe(400);
    const del = await ctx.app.inject({ method: "POST", url: "/me/delete", headers: { cookie: c }, payload: { confirm: "DELETE" } });
    expect(del.json()).toEqual({ ok: true });
    const [u] = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(u!.email).toBe(`deleted+${id}@users.aix.invalid`);
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: c } })).statusCode).toBe(401);
    // Ledger rows remain (append-only, accounting retention).
    expect((await ctx.db.select().from(ledgerEntries)).length).toBeGreaterThan(0);
    // The same email can sign up fresh afterwards.
    const again = await signIn(ctx, "leaver@x.test");
    expect((await me(ctx, again)).user.id).not.toBe(id);
    void reviews;
    void newId;
  });
});
