/** Regression tests for the security review findings. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { dev, fixtureApp, installFixture, me, setup, signIn, topUp, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());

describe("security regressions", () => {
  it("#2 an approval from one user can't pre-approve another user's charge", async () => {
    const fx = await fixtureApp(ctx);
    const devUser = await signIn(ctx, "devtest@evil.test");
    const devUserId = (await me(ctx, devUser)).user.id;
    const victim = await signIn(ctx, "victim@x.test");
    const victimId = (await me(ctx, victim)).user.id;
    for (const [c, id] of [[devUser, devUserId], [victim, victimId]] as const) {
      await installFixture(ctx, id, fx.appId, fx.versionId);
      await topUp(ctx, c, 2000);
    }
    const body = { priceId: "render", quantity: 10, idempotencyKey: "K" }; // €5 > €1 threshold
    const h = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { ...body, userId: devUserId } });
    await ctx.app.inject({ method: "POST", url: `/approvals/${h.json().error.details.approvalId}/decision`, headers: { cookie: devUser }, payload: { decision: "approve" } });
    const attack = await ctx.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { ...body, userId: victimId } });
    expect(attack.json().error.code).toBe("needs_user_approval");
    expect((await me(ctx, victim)).wallet.heldCents).toBe(0);
  });

  it("#3 with a service secret configured, gateway tokens only work through the gateway, and need the panel nonce", async () => {
    const c2 = await setup({ AIX_GATEWAY_SERVICE_SECRET: "s".repeat(40), AIX_GATEWAY_URL: "https://gw.test" });
    try {
      const cookie = await signIn(c2, "host@x.test");
      const reg = (await c2.app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: ["http://localhost:9/cb"] } })).json();
      const verifier = randomBytes(32).toString("base64url");
      const params = { response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9/cb", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "aix:gateway", resource: "https://gw.test/mcp" };
      const code = new URL((await c2.app.inject({ method: "POST", url: "/oauth/authorize/decision", headers: { cookie }, payload: { ...params, decision: "allow" } })).json().redirectTo).searchParams.get("code")!;
      const tok = (await c2.app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "authorization_code", code, redirect_uri: params.redirect_uri, client_id: reg.client_id, code_verifier: verifier } })).json();
      const bearer = { authorization: `Bearer ${tok.access_token}` };
      expect((await c2.app.inject({ method: "GET", url: "/me", headers: bearer })).statusCode).toBe(401); // host calling the API directly
      const viaGateway = { ...bearer, "x-aix-gateway-secret": "s".repeat(40) };
      expect((await c2.app.inject({ method: "GET", url: "/me", headers: viaGateway })).statusCode).toBe(200);
      // Even through the gateway, deciding an approval needs the panel's nonce.
      const fx = await fixtureApp(c2);
      const uid = (await me(c2, cookie)).user.id;
      await installFixture(c2, uid, fx.appId, fx.versionId);
      await topUp(c2, cookie, 2000);
      const h = await c2.app.inject({ method: "POST", url: "/v1/holds", headers: dev(fx.secret), payload: { userId: uid, priceId: "render", quantity: 5, idempotencyKey: "n1" } });
      const id = h.json().error.details.approvalId;
      expect((await c2.app.inject({ method: "POST", url: `/approvals/${id}/decision`, headers: viaGateway, payload: { decision: "approve" } })).statusCode).toBe(403);
      expect((await c2.app.inject({ method: "POST", url: `/approvals/${id}/decision`, headers: viaGateway, payload: { decision: "approve", nonce: "guess" } })).statusCode).toBe(403);
      expect((await c2.app.inject({ method: "POST", url: "/store/apps/x/install", headers: viaGateway, payload: { acceptPermissions: true } })).statusCode).toBe(403);
      // Refresh-token reuse revokes the whole family.
      const r1 = (await c2.app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id } })).json();
      expect((await c2.app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id } })).statusCode).toBe(400);
      expect((await c2.app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: reg.client_id } })).statusCode).toBe(400);
    } finally {
      await c2.close();
    }
  });

  it("#4 members only join by invitation; admins can't demote or remove owners", async () => {
    const owner = await signIn(ctx, "own@co.test");
    const orgId = (await ctx.app.inject({ method: "POST", url: "/orgs", headers: { cookie: owner }, payload: { name: "Co", slug: "co" } })).json().id;
    expect((await ctx.app.inject({ method: "POST", url: `/orgs/${orgId}/members`, headers: { cookie: owner }, payload: { email: "victim@x.test", role: "member" } })).statusCode).toBe(404);
    const adm = await signIn(ctx, "adm@co.test");
    await ctx.app.inject({ method: "POST", url: `/orgs/${orgId}/invites`, headers: { cookie: owner }, payload: { email: "adm@co.test", role: "admin" } });
    const token = /invites\/(\S+)/.exec(ctx.deps.mailer.outbox!.filter((m) => m.to === "adm@co.test").at(-1)!.text)![1]!;
    await ctx.app.inject({ method: "POST", url: `/invites/${token}/accept`, headers: { cookie: adm } });
    const ownerId = (await me(ctx, owner)).user.id;
    expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${orgId}/members/${ownerId}`, headers: { cookie: adm }, payload: { role: "member" } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "DELETE", url: `/orgs/${orgId}/members/${ownerId}`, headers: { cookie: adm } })).statusCode).toBe(403);
  });

  it("#5 client-ID metadata documents can't point at private addresses", async () => {
    const r = await ctx.app.inject({ method: "GET", url: `/oauth/authorize/info?${new URLSearchParams({ response_type: "code", client_id: "https://169.254.169.254/latest/meta-data", redirect_uri: "https://x/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.error).toBe("invalid_client");
  });

  it("#6 magic links are throttled per email", async () => {
    for (let i = 0; i < 5; i++) await ctx.app.inject({ method: "POST", url: "/auth/magic-link", payload: { email: "bomb@x.test" } });
    expect(ctx.deps.mailer.outbox!.filter((m) => m.to === "bomb@x.test")).toHaveLength(3);
  });

  it("#7 developer webhooks can't target private networks over https", async () => {
    const fx = await fixtureApp(ctx);
    const r = await ctx.app.inject({ method: "PUT", url: "/developer/webhook", headers: dev(fx.secret), payload: { url: "https://10.0.0.5/hook" } });
    expect(r.statusCode).toBe(400);
  });
});
