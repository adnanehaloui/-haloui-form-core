import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initApp, packApp } from "@aix/cli";
import { setup, signIn, type Ctx } from "./helpers.js";
import { exportMarketplace } from "../src/services/marketplace.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());

describe("Claude Code plugin marketplace export", () => {
  it("exports published prompt apps with their skills", async () => {
    const dev = await signIn(ctx, "writer@acme.test");
    await ctx.app.inject({ method: "POST", url: "/developer", headers: { cookie: dev }, payload: { displayName: "Acme Writers" } });
    const dir = join(await mkdtemp(join(tmpdir(), "aix-p-")), "launch");
    await initApp(dir, "prompt", { name: "Launch Copy", id: "com.acme.launchcopy" });
    const { pkg } = await packApp(dir);
    const pub = (await ctx.app.inject({ method: "POST", url: "/developer/publish", headers: { cookie: dev }, payload: { packageBase64: pkg.toString("base64") } })).json();
    const admin = await signIn(ctx, "admin@aix.test");
    await ctx.app.inject({ method: "POST", url: `/admin/versions/${pub.versionId}/approve`, headers: { cookie: admin } });

    const out = await mkdtemp(join(tmpdir(), "aix-mkt-"));
    expect((await exportMarketplace(ctx.deps, out)).plugins).toBe(1);
    const m = JSON.parse(await readFile(join(out, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(m.plugins[0]).toMatchObject({ name: "launch-copy", source: "./plugins/launch-copy", author: { name: "Acme Writers" } });
    const skill = await readFile(join(out, "plugins", "launch-copy", "skills", "launch-announcement", "SKILL.md"), "utf8");
    expect(skill).toContain("name: launch-announcement");
    const api = (await ctx.app.inject({ method: "GET", url: "/marketplace/claude-code.json" })).json();
    expect(api.plugins).toHaveLength(1);
  });
});
