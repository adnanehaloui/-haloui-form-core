import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { addSkills, initApp, packApp } from "@aix/cli";
import { setup, signIn, type Ctx } from "./helpers.js";

let ctx: Ctx;
let apiUrl: string;
let user: string;
let slug: string;
beforeAll(async () => {
  ctx = await setup({ AIX_GATEWAY_URL: "https://gw.aix.test" });
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${(ctx.app.server.address() as any).port}`;
  const dev = await signIn(ctx, "skills@acme.test");
  await ctx.app.inject({ method: "POST", url: "/developer", headers: { cookie: dev }, payload: { displayName: "Skill Co" } });
  const dir = join(await mkdtemp(join(tmpdir(), "aix-ie-")), "launch");
  await initApp(dir, "prompt", { name: "Launch Copy", id: "com.acme.launchcopy" });
  const { pkg } = await packApp(dir);
  const pub = (await ctx.app.inject({ method: "POST", url: "/developer/publish", headers: { cookie: dev }, payload: { packageBase64: pkg.toString("base64") } })).json();
  slug = pub.slug;
  const admin = await signIn(ctx, "admin@aix.test");
  await ctx.app.inject({ method: "POST", url: `/admin/versions/${pub.versionId}/approve`, headers: { cookie: admin } });
  user = await signIn(ctx, "writer@example.test");
});
afterAll(() => ctx.close());

/** Read the first file out of a ZIP produced by createZip. */
function unzipFirst(buf: Buffer) {
  const nameLen = buf.readUInt16LE(26);
  const compSize = buf.readUInt32LE(18);
  const name = buf.subarray(30, 30 + nameLen).toString();
  return { name, content: inflateRawSync(buf.subarray(30 + nameLen, 30 + nameLen + compSize)).toString() };
}

describe("install everywhere", () => {
  it("connect info has the connector URL and host install links", async () => {
    const info = (await ctx.app.inject({ method: "GET", url: "/store/connect-info" })).json();
    expect(info.mcpUrl).toBe("https://gw.aix.test/mcp");
    expect(info.hosts["claude-code"].command).toBe("claude mcp add --transport http aix https://gw.aix.test/mcp");
    const cursor = new URL(info.hosts.cursor.deeplink);
    expect(cursor.protocol).toBe("cursor:");
    expect(JSON.parse(Buffer.from(cursor.searchParams.get("config")!, "base64").toString())).toEqual({ url: "https://gw.aix.test/mcp" });
    expect(info.hosts.vscode.deeplink.startsWith("vscode:mcp/install?")).toBe(true);
  });

  it("skills are only available after install", async () => {
    expect((await ctx.app.inject({ method: "GET", url: `/store/apps/${slug}/skills`, headers: { cookie: user } })).json().error.code).toBe("not_installed");
    await ctx.app.inject({ method: "POST", url: `/store/apps/${slug}/install`, headers: { cookie: user }, payload: { acceptPermissions: true } });
    const r = (await ctx.app.inject({ method: "GET", url: `/store/apps/${slug}/skills`, headers: { cookie: user } })).json();
    expect(r.skills.map((s: any) => s.name)).toEqual(["launch-announcement", "changelog"]);
  });

  it("downloads a Claude.ai-ready skill ZIP (folder/SKILL.md)", async () => {
    const z = await ctx.app.inject({ method: "GET", url: `/store/apps/${slug}/skills/launch-announcement.zip`, headers: { cookie: user } });
    expect(z.headers["content-type"]).toBe("application/zip");
    const f = unzipFirst(z.rawPayload);
    expect(f.name).toBe("launch-announcement/SKILL.md");
    expect(f.content).toContain("name: launch-announcement");
  });

  it("aix add installs skills into Claude Code / Cursor with a short-lived token", async () => {
    const t = (await ctx.app.inject({ method: "POST", url: `/store/apps/${slug}/install-token`, headers: { cookie: user } })).json();
    expect(t.commands["claude-code"]).toContain(`aix add ${slug} --token aixit_`);
    const cwd = await mkdtemp(join(tmpdir(), "proj-"));
    const r = await addSkills({ slug, token: t.token, apiUrl, agent: "claude-code", cwd });
    expect(r.written).toEqual([join(cwd, ".claude/skills/launch-announcement/SKILL.md"), join(cwd, ".claude/skills/changelog/SKILL.md")]);
    expect(await readFile(r.written[0]!, "utf8")).toContain("# Launch announcement");
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const g = await addSkills({ slug, token: t.token, apiUrl, agent: "cursor", global: true, home });
    expect(g.written[0]).toBe(join(home, ".cursor/skills/launch-announcement/SKILL.md"));
    // Token is scoped to this app, and expires.
    await expect(addSkills({ slug: "other-app", token: t.token, apiUrl, agent: "claude-code", cwd })).rejects.toThrow(/invalid or expired/);
    const later = { ...ctx.deps, now: () => new Date(Date.now() + 16 * 60_000) };
    const app2 = (await import("../src/app.js")).buildApp;
    const expiredApp = await app2(later);
    expect((await expiredApp.inject({ method: "GET", url: `/store/apps/${slug}/skills?token=${t.token}` })).statusCode).toBe(401);
    await expiredApp.close();
  });

  it("gateway sees installed skills (for prompts + skill_load)", async () => {
    const r = (await ctx.app.inject({ method: "GET", url: "/gateway/skills", headers: { cookie: user } })).json();
    expect(r.data.map((s: any) => s.name)).toEqual([`${slug}__launch-announcement`, `${slug}__changelog`]);
    expect(r.data[0].content).toContain("Launch announcement");
  });
});
