/**
 * M4 done-criterion, end to end with real processes:
 * API + gateway + the sample server app (Render Studio). An MCP client signs in with OAuth 2.1
 * (DCR + PKCE), installs the app from the panel flow, runs the paid tool, approves €0.50,
 * and the charge appears in the wallet with an 80/20 split.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer as netServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { auditLog } from "@aix/db";
import { api as cliApi, initApp, packApp } from "@aix/cli";
import { me, setup, signIn, topUp, type Ctx } from "../../api/test/helpers.js";
import { balance } from "../../api/src/services/ledger.js";
import { createGatewayHttpServer, resetGatewayState } from "../src/index.js";

const freePort = () =>
  new Promise<number>((ok) => {
    const s = netServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });

let ctx: Ctx;
let apiUrl: string;
let gatewayUrl: string;
let gateway: ReturnType<typeof createGatewayHttpServer>;
let gateway2: ReturnType<typeof createGatewayHttpServer>;
let gateway2Url: string;
let appProc: ChildProcess;
let userCookie: string;
let accessToken: string;
let slug: string;
let developerId: string;

beforeAll(async () => {
  const [apiPort, gwPort, appPort] = [await freePort(), await freePort(), await freePort()];
  apiUrl = `http://127.0.0.1:${apiPort}`;
  gatewayUrl = `http://127.0.0.1:${gwPort}`;
  ctx = await setup({ AIX_API_URL: apiUrl, AIX_GATEWAY_URL: gatewayUrl, AIX_WEB_URL: "http://web.test" });
  await ctx.app.listen({ port: apiPort, host: "127.0.0.1" });
  gateway = createGatewayHttpServer({ port: gwPort, gatewayUrl, apiUrl, rateLimitPerMinute: 1000 });
  await new Promise<void>((ok) => gateway.listen(gwPort, "127.0.0.1", ok));
  // A second, independent gateway instance (same resource URL) to prove state is shared via the API.
  const gw2Port = await freePort();
  gateway2Url = `http://127.0.0.1:${gw2Port}`;
  gateway2 = createGatewayHttpServer({ port: gw2Port, gatewayUrl, apiUrl, rateLimitPerMinute: 1000 });
  await new Promise<void>((ok) => gateway2.listen(gw2Port, "127.0.0.1", ok));
  resetGatewayState();

  // Developer: create the sample server app with the CLI code path and publish it.
  const devCookie = await signIn(ctx, "dev@acme.test");
  developerId = (await ctx.app.inject({ method: "POST", url: "/developer", headers: { cookie: devCookie }, payload: { displayName: "Acme Labs" } })).json().id;
  const secret = (await ctx.app.inject({ method: "POST", url: "/developer/keys", headers: { cookie: devCookie }, payload: { name: "server" } })).json().secret;
  const dir = join(await mkdtemp(join(tmpdir(), "aix-gw-")), "render-studio");
  await initApp(dir, "server", { name: "Render Studio", id: "com.acme.renderstudio" });
  const mPath = join(dir, "aix.json");
  const m = JSON.parse(await readFile(mPath, "utf8"));
  m.entry.mcp = `http://localhost:${appPort}/mcp`;
  m.permissions.network = [`http://localhost:${appPort}`];
  await writeFile(mPath, JSON.stringify(m));
  const { pkg } = await packApp(dir);
  const pub = await cliApi({ apiUrl, secretKey: secret }, "POST", "/developer/publish", { packageBase64: pkg.toString("base64") });
  slug = pub.slug;
  await cliApi({ apiUrl, secretKey: secret }, "POST", `/developer/apps/${slug}/prices`, { kind: "metered", unit: "render", unitAmountCents: 50, lookupKey: "render" });
  const admin = await signIn(ctx, "admin@aix.test");
  await ctx.app.inject({ method: "POST", url: `/admin/versions/${pub.versionId}/approve`, headers: { cookie: admin } });
  // A prompt app (skills) too.
  const pdir = join(await mkdtemp(join(tmpdir(), "aix-gw-")), "launch");
  await initApp(pdir, "prompt", { name: "Launch Copy", id: "com.acme.launchcopy" });
  const ppub = await cliApi({ apiUrl, secretKey: secret }, "POST", "/developer/publish", { packageBase64: (await packApp(pdir)).pkg.toString("base64") });
  await ctx.app.inject({ method: "POST", url: `/admin/versions/${ppub.versionId}/approve`, headers: { cookie: admin } });

  // Run the developer's MCP server (the real template code) as its own process.
  const templateServer = resolve(__dirname, "../../../templates/server/src/server.ts");
  appProc = spawn(process.execPath, ["--import", "tsx", templateServer], {
    cwd: resolve(__dirname, "../../../templates/server"),
    env: { ...process.env, PORT: String(appPort), AIX_API_URL: apiUrl, AIX_SECRET_KEY: secret, AIX_DEV: "" },
    stdio: "pipe",
  });
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error("app server did not start")), 20_000);
    appProc.stdout!.on("data", (d) => String(d).includes("MCP server on") && (clearTimeout(t), ok()));
    appProc.stderr!.on("data", (d) => process.stderr.write(d));
  });

  // User with €20, auto-approve threshold €0.10 so a €0.50 render needs approval.
  userCookie = await signIn(ctx, "user@example.test");
  await topUp(ctx, userCookie, 2000);
  await ctx.app.inject({ method: "PUT", url: "/wallet/limits", headers: { cookie: userCookie }, payload: { period: "monthly", capCents: 2000, autoApproveThresholdCents: 10 } });
}, 60_000);

afterAll(async () => {
  appProc?.kill();
  await new Promise((ok) => gateway?.close(ok));
  await new Promise((ok) => gateway2?.close(ok));
  await ctx?.close();
});

async function mcp(token = accessToken, base = gatewayUrl) {
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

describe("M4 — gateway with OAuth, proxied tools, approval and receipt", () => {
  // (skills test is at the end, after sign-in)
  it("unauthenticated MCP requests get 401 + resource metadata", async () => {
    const r = await fetch(`${gatewayUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate")!;
    expect(h).toContain("resource_metadata=");
    const meta = await (await fetch(`${gatewayUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(meta).toMatchObject({ resource: `${gatewayUrl}/mcp`, authorization_servers: [apiUrl] });
    const as = await (await fetch(`${apiUrl}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("signs in with OAuth 2.1: dynamic registration + PKCE + consent", async () => {
    const reg = await (await fetch(`${apiUrl}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["http://localhost:9999/callback"] }) })).json();
    const verifier = randomBytes(32).toString("base64url");
    const params = {
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: "http://localhost:9999/callback",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "xyz",
      scope: "aix:gateway",
      resource: `${gatewayUrl}/mcp`,
    };
    const auth = await fetch(`${apiUrl}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: "manual" });
    expect(auth.headers.get("location")).toContain("http://web.test/oauth/consent?");
    // Without PKCE → rejected.
    const { code_challenge: _c, ...noPkce } = params;
    expect((await fetch(`${apiUrl}/oauth/authorize?${new URLSearchParams(noPkce)}`, { redirect: "manual" })).status).toBe(400);

    const decision = await ctx.app.inject({ method: "POST", url: "/oauth/authorize/decision", headers: { cookie: userCookie }, payload: { ...params, decision: "allow" } });
    const redirect = new URL(decision.json().redirectTo);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const code = redirect.searchParams.get("code")!;

    const bad = await fetch(`${apiUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: params.redirect_uri, client_id: reg.client_id, code_verifier: "wrong".repeat(10) }) });
    expect(bad.status).toBe(400);
    // The failed attempt burned the code (single use) → get a fresh one.
    const d2 = await ctx.app.inject({ method: "POST", url: "/oauth/authorize/decision", headers: { cookie: userCookie }, payload: { ...params, decision: "allow" } });
    const code2 = new URL(d2.json().redirectTo).searchParams.get("code")!;
    const tok = await (await fetch(`${apiUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: params.redirect_uri, client_id: reg.client_id, code_verifier: verifier }) })).json();
    expect(tok.token_type).toBe("Bearer");
    accessToken = tok.access_token;

    const refreshed = await (await fetch(`${apiUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }) })).json();
    expect(refreshed.access_token).toBeTruthy();
    // Refresh tokens rotate: the old one is now dead.
    const reuse = await fetch(`${apiUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }) });
    expect(reuse.status).toBe(400);
  });

  it("the access token can't be used to charge (only secret keys can)", async () => {
    const r = await fetch(`${apiUrl}/v1/holds`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ userId: "x", priceId: "render", idempotencyKey: "k" }) });
    expect(r.status).toBe(401);
  });

  it("store_search + install through the panel flow (nonce in _meta)", async () => {
    const c = await mcp();
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["store_search", "app_install", "wallet_balance", "aix_approve"]));
    expect(tools).not.toContain(`${slug}__render`);
    const found: any = await c.callTool({ name: "store_search", arguments: { query: "render" } });
    expect(found.structuredContent.apps[0].slug).toBe(slug);
    const ins: any = await c.callTool({ name: "app_install", arguments: { slug } });
    expect(ins.structuredContent.app.permissionLines[0]).toContain("Connect to http://localhost:");
    // A model guessing the nonce can't install.
    expect(((await c.callTool({ name: "app_install_confirm", arguments: { slug, nonce: "guess" } })) as any).isError).toBe(true);
    const ok: any = await c.callTool({ name: "app_install_confirm", arguments: { slug, nonce: ins._meta["aix/nonce"] } });
    expect(ok.isError).toBeFalsy();
    const after = await c.listTools();
    const render = after.tools.find((t) => t.name === `${slug}__render`)!;
    expect(render).toBeTruthy();
    expect((render._meta as any).ui.resourceUri).toMatch(/^ui:\/\/aix-app\//);
    const panel = await c.readResource({ uri: (render._meta as any).ui.resourceUri });
    expect((panel.contents[0] as any).mimeType).toBe("text/html;profile=mcp-app");
    await c.close();
  });

  it("runs the paid tool, the user approves €0.50 in the panel, the charge lands in the wallet", async () => {
    const c = await mcp();
    const first: any = await c.callTool({ name: `${slug}__render`, arguments: { script: "A launch. A demo. A smile." } });
    expect(first.isError).toBe(true);
    const approvalId = first.structuredContent.aix.approvalId;
    expect(first.structuredContent.aix.display).toBe("€0.50");
    expect((await me(ctx, userCookie)).wallet.availableCents).toBe(2000); // nothing charged yet

    const panel: any = await c.callTool({ name: "aix_approve", arguments: { approvalId } });
    expect(panel.structuredContent.approval).toMatchObject({ status: "pending", display: "€0.50" });
    const nonce = panel._meta["aix/nonce"];
    expect(nonce).toBeTruthy();
    // Without the panel's nonce the model can't approve.
    expect(((await c.callTool({ name: "approval_decide", arguments: { approvalId, decision: "approve", nonce: "nope" } })) as any).isError).toBe(true);

    // Decided on a DIFFERENT gateway instance: pending state lives in Postgres, not in memory.
    const c2 = await mcp(accessToken, gateway2Url);
    const done: any = await c2.callTool({ name: "approval_decide", arguments: { approvalId, decision: "approve", nonce } });
    // A nonce works once.
    expect(((await c2.callTool({ name: "approval_decide", arguments: { approvalId, decision: "approve", nonce } })) as any).isError).toBe(true);
    await c2.close();
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent.status).toBe("approved");
    expect(done.structuredContent.frames).toHaveLength(3);
    expect(done.content.map((x: any) => x.text).join(" ")).toContain("AIX receipt: €0.50");

    expect((await me(ctx, userCookie)).wallet).toMatchObject({ availableCents: 1950, heldCents: 0 });
    expect(await balance(ctx.db, `acct_${developerId}_payable`)).toBe(40);
    const w: any = await c.callTool({ name: "wallet_balance", arguments: {} });
    expect(w.structuredContent.available).toBe("€19.50");
    expect(w.structuredContent.receipts[0]).toMatchObject({ display: "€0.50", status: "captured" });

    // Audit: one entry per call, with charge ids — never the conversation content.
    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.action, "gateway.tool_call"));
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const last = entries.find((e) => (e.metadata as any).chargeIds.length > 0)!;
    expect(last.metadata).toMatchObject({ tool: "render" });
    expect(JSON.stringify(entries)).not.toContain("A launch");
    await c.close();
  });

  it("installed skills work in any MCP host: skill_load tool + MCP prompts", async () => {
    await ctx.app.inject({ method: "POST", url: "/store/apps/launch-copy/install", headers: { cookie: userCookie }, payload: { acceptPermissions: true } });
    const c = await mcp();
    const tools = (await c.listTools()).tools;
    const load = tools.find((t) => t.name === "skill_load")!;
    expect(load.description).toContain("launch-copy__launch-announcement");
    const r: any = await c.callTool({ name: "skill_load", arguments: { name: "launch-copy__launch-announcement" } });
    expect(r.content[0].text).toContain("# Launch announcement");
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["launch-copy__launch-announcement", "launch-copy__changelog"]);
    const p = await c.getPrompt({ name: "launch-copy__changelog" });
    expect((p.messages[0]!.content as any).text).toContain("Changelog entry");
    await c.close();
  });
});
