import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initApp, packApp } from "@aix/cli";
import { setup, signIn, type Ctx } from "./helpers.js";

let ctx: Ctx;
let slug: string;
beforeAll(async () => {
  ctx = await setup({ AIX_WEB_URL: "http://web.test" });
  const dev = await signIn(ctx, "maker@acme.test");
  await ctx.app.inject({ method: "POST", url: "/developer", headers: { cookie: dev }, payload: { displayName: "Makers" } });
  const dir = join(await mkdtemp(join(tmpdir(), "aix-sf-")), "app");
  await initApp(dir, "prompt", { name: "Pitch Writer", id: "com.acme.pitchwriter" });
  const m = JSON.parse(await readFile(join(dir, "aix.json"), "utf8"));
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#6d28d9"/></svg>');
  await writeFile(join(dir, "assets", "secret.png"), "not listed");
  Object.assign(m, {
    tagline: "Pitches that land",
    icon: "assets/icon.svg",
    color: "#6d28d9",
    showcase: [{ title: "Investor email", input: "Write a 3-line pitch for a coffee app", kind: "text", output: "Brew is Uber for baristas…" }, { title: "Cover", input: "logo", kind: "image", output: "assets/icon.svg" }],
  });
  await writeFile(join(dir, "aix.json"), JSON.stringify(m));
  const { pkg } = await packApp(dir);
  const pub = (await ctx.app.inject({ method: "POST", url: "/developer/publish", headers: { cookie: dev }, payload: { packageBase64: pkg.toString("base64") } })).json();
  slug = pub.slug;
  const admin = await signIn(ctx, "admin@aix.test");
  await ctx.app.inject({ method: "POST", url: `/admin/versions/${pub.versionId}/approve`, headers: { cookie: admin } });
});
afterAll(() => ctx.close());

describe("storefront", () => {
  it("home has featured apps with showcase results and curated rows", async () => {
    const home = (await ctx.app.inject({ method: "GET", url: "/store/home" })).json();
    expect(home.featured[0]).toMatchObject({ slug, tagline: "Pitches that land", color: "#6d28d9" });
    expect(home.featured[0].iconUrl).toMatch(/^http:\/\/web\.test\/api\/store\/apps\/pitch-writer\/assets\/ver_[a-f0-9]+\/assets\/icon\.svg$/);
    expect(home.sections.map((s: any) => s.id)).toEqual(expect.arrayContaining(["top", "new", "free"]));
  });

  it("app page includes showcase with resolved image URLs", async () => {
    const a = (await ctx.app.inject({ method: "GET", url: `/store/apps/${slug}` })).json();
    expect(a.showcase[0]).toMatchObject({ kind: "text", input: expect.stringContaining("coffee") });
    expect(a.showcase[1].output).toContain("/assets/");
    expect(a.installs).toBe(0);
  });

  it("serves only declared listing assets, sandboxed", async () => {
    const a = (await ctx.app.inject({ method: "GET", url: `/store/apps/${slug}` })).json();
    const path = new URL(a.iconUrl).pathname.replace(/^\/api/, "");
    const r = await ctx.app.inject({ method: "GET", url: path });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/svg+xml");
    expect(r.headers["content-security-policy"]).toContain("sandbox");
    expect((await ctx.app.inject({ method: "GET", url: path.replace("icon.svg", "secret.png") })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: path.replace("assets/icon.svg", "aix.json") })).statusCode).toBe(404);
  });
});

describe("search", () => {
  it("prefix, any-word, typo-tolerant and injection-safe", async () => {
    const names = async (q: string) => (await ctx.app.inject({ method: "GET", url: `/store/apps?q=${encodeURIComponent(q)}` })).json().data.map((a: any) => a.name);
    expect(await names("pitc")).toEqual(["Pitch Writer"]);
    expect(await names("write a pitch")).toEqual(["Pitch Writer"]);
    expect(await names("ptich writer")).toEqual(["Pitch Writer"]);
    expect(await names("'; drop table apps; --")).toEqual([]);
    expect(await names("zzzzqqq")).toEqual([]);
  });
});
