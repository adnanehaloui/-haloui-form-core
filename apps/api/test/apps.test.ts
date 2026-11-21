import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { appVersions } from "@aix/db";
import { api, initApp, packApp, readManifest } from "@aix/cli";
import { me, setup, signIn, type Ctx } from "./helpers.js";

let ctx: Ctx;
let apiUrl: string;
beforeAll(async () => {
  ctx = await setup();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = ctx.app.server.address() as { port: number };
  apiUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => ctx.close());

describe("M3 — create with the CLI, publish, approve, install", () => {
  let devCookie: string;
  let secret: string;
  let slug: string;

  it("developer signs up and creates a secret key", async () => {
    devCookie = await signIn(ctx, "dev@acme.test");
    const d = await ctx.app.inject({ method: "POST", url: "/developer", headers: { cookie: devCookie }, payload: { displayName: "Acme Labs" } });
    expect(d.statusCode).toBe(200);
    const k = await ctx.app.inject({ method: "POST", url: "/developer/keys", headers: { cookie: devCookie }, payload: { name: "cli" } });
    secret = k.json().secret;
    expect(secret).toMatch(/^aixsk_test_/);
    const list = await ctx.app.inject({ method: "GET", url: "/developer/keys", headers: { cookie: devCookie } });
    expect(JSON.stringify(list.json())).not.toContain(secret); // shown once, stored hashed
  });

  it("aix app init + validate + publish (sample server app)", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "aix-")), "render-studio");
    await initApp(dir, "server", { name: "Render Studio", id: "com.acme.renderstudio" });
    const v = await readManifest(dir);
    expect(v.errors).toEqual([]);
    expect(v.manifest!.name).toBe("Render Studio");
    const { pkg, sha256 } = await packApp(dir);
    const res = await api({ apiUrl, secretKey: secret }, "POST", "/developer/publish", { packageBase64: pkg.toString("base64") });
    expect(res).toMatchObject({ status: "submitted", version: "0.1.0", sha256 });
    slug = res.slug;
    // Same version twice → conflict.
    await expect(api({ apiUrl, secretKey: secret }, "POST", "/developer/publish", { packageBase64: pkg.toString("base64") })).rejects.toMatchObject({ status: 409 });
    // Prices come from the catalog, created by the developer.
    const p = await api({ apiUrl, secretKey: secret }, "POST", `/developer/apps/${slug}/prices`, { kind: "metered", unit: "render", unitAmountCents: 50, lookupKey: "render", includedUnits: 3 });
    expect(p.unitAmountCents).toBe(50);
  });

  it("is not in the store before review; non-admins can't review", async () => {
    expect((await ctx.app.inject({ method: "GET", url: `/store/apps/${slug}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/admin/reviews", headers: { cookie: devCookie } })).statusCode).toBe(403);
  });

  it("admin approves from the review queue → published and signed", async () => {
    const admin = await signIn(ctx, "admin@aix.test");
    const q = (await ctx.app.inject({ method: "GET", url: "/admin/reviews", headers: { cookie: admin } })).json().data;
    const item = q.find((x: any) => x.app.slug === slug);
    expect(item.manifest.type).toBe("server");
    const r = await ctx.app.inject({ method: "POST", url: `/admin/versions/${item.versionId}/approve`, headers: { cookie: admin }, payload: { notes: "LGTM" } });
    expect(r.json().status).toBe("approved");
    const [v] = await ctx.db.select().from(appVersions).where(eq(appVersions.id, item.versionId));
    expect(v!.signature).toBeTruthy();
  });

  it("user finds it in the store, sees permissions, installs it", async () => {
    const user = await signIn(ctx, "user@example.test");
    const search = (await ctx.app.inject({ method: "GET", url: "/store/apps?q=render" })).json().data;
    expect(search.map((a: any) => a.slug)).toContain(slug);
    const page = (await ctx.app.inject({ method: "GET", url: `/store/apps/${slug}`, headers: { cookie: user } })).json();
    expect(page.permissionLines).toEqual(["Connect to http://localhost:4200", "Read your email"]);
    expect(page.prices[0].label).toBe("€0.50 / render (first 3 free)");
    expect(page.me.installed).toBe(false);
    // Must accept permissions explicitly.
    expect((await ctx.app.inject({ method: "POST", url: `/store/apps/${slug}/install`, headers: { cookie: user }, payload: {} })).statusCode).toBe(400);
    const ins = await ctx.app.inject({ method: "POST", url: `/store/apps/${slug}/install`, headers: { cookie: user }, payload: { acceptPermissions: true } });
    expect(ins.statusCode).toBe(200);
    const mine = (await ctx.app.inject({ method: "GET", url: "/me/installs", headers: { cookie: user } })).json().data;
    expect(mine[0].app.slug).toBe(slug);
    expect((await me(ctx, user)).user.email).toBe("user@example.test");
  });

  it("refuses to install a tampered package (hash check on install)", async () => {
    const [v] = await ctx.db.select().from(appVersions);
    await ctx.deps.storage.put(v!.packagePath, Buffer.from("evil"));
    const user2 = await signIn(ctx, "user2@example.test");
    const ins = await ctx.app.inject({ method: "POST", url: `/store/apps/${slug}/install`, headers: { cookie: user2 }, payload: { acceptPermissions: true } });
    expect(ins.statusCode).toBe(409);
    expect(ins.json().error.message).toContain("integrity");
  });

  it("admin can suspend an app (it disappears from the store)", async () => {
    const admin = await signIn(ctx, "admin@aix.test");
    const appId = (await ctx.app.inject({ method: "GET", url: "/admin/apps", headers: { cookie: admin } })).json().data.find((a: any) => a.slug === slug).id;
    await ctx.app.inject({ method: "POST", url: `/admin/apps/${appId}/suspend`, headers: { cookie: admin }, payload: { reason: "test" } });
    expect((await ctx.app.inject({ method: "GET", url: `/store/apps/${slug}` })).statusCode).toBe(404);
  });
});
