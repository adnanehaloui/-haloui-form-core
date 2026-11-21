/**
 * "Use it in…": everything needed to install an app into Claude, Claude Code, ChatGPT, Cursor, VS Code, Codex.
 *  - one AIX connector (MCP gateway) for server apps — and for skills, via MCP prompts + skill_load
 *  - skill ZIPs for Claude.ai "Upload a skill"
 *  - short-lived install tokens for `aix add <app> --agent …` (like `npx skills add`)
 */
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { apps, appVersions, gatewayPending, installs } from "@aix/db";
import { createZip, newId, randomToken, sha256Hex } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireSessionUser, requireUser } from "../lib/auth.js";
import { ApiError, notFound } from "../lib/errors.js";
import { appSkills } from "../services/skills.js";
import { audit } from "../services/audit.js";

const TOKEN_TTL_MS = 15 * 60_000;

export function connectInfo(deps: Deps) {
  const mcpUrl = `${deps.config.AIX_GATEWAY_URL.replace(/\/$/, "")}/mcp`;
  const cursorConfig = Buffer.from(JSON.stringify({ url: mcpUrl })).toString("base64");
  const vscodeConfig = encodeURIComponent(JSON.stringify({ name: "aix", type: "http", url: mcpUrl }));
  return {
    mcpUrl,
    webUrl: deps.config.AIX_WEB_URL,
    apiUrl: deps.config.AIX_API_URL,
    pluginMarketplace: deps.config.AIX_PLUGIN_MARKETPLACE_URL ?? null,
    hosts: {
      claude: { steps: ["Open Claude → Settings → Connectors", "Click “Add custom connector”", `Paste ${mcpUrl}`, "Sign in to AIX and click Allow"] },
      "claude-code": { command: `claude mcp add --transport http aix ${mcpUrl}`, steps: ["Run the command", "Type /mcp in Claude Code and sign in to AIX"] },
      chatgpt: { steps: ["ChatGPT → Settings → Apps & Connectors → Advanced → turn on Developer mode", "Create a new app/connector", `Server URL: ${mcpUrl} · Authentication: OAuth`, "Sign in to AIX and click Allow"] },
      cursor: { deeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=aix&config=${encodeURIComponent(cursorConfig)}`, steps: ["Click “Add to Cursor”", "Confirm, then sign in to AIX when Cursor asks"] },
      vscode: { deeplink: `vscode:mcp/install?${vscodeConfig}`, steps: ["Click “Add to VS Code”", "Confirm, then sign in to AIX"] },
    },
  };
}

async function installedVersion(deps: Deps, userId: string, slug: string) {
  const [row] = await deps.db
    .select({ app: apps, version: appVersions })
    .from(installs)
    .innerJoin(apps, eq(apps.id, installs.appId))
    .innerJoin(appVersions, eq(appVersions.id, installs.appVersionId))
    .where(and(eq(installs.userId, userId), eq(apps.slug, slug), isNull(installs.uninstalledAt), eq(apps.status, "published")));
  if (!row) throw new ApiError(403, "not_installed", "install the app on AIX first");
  return row;
}

/** User from a session/OAuth token, or from a short-lived install token (CLI). */
async function userFromTokenOrSession(deps: Deps, req: FastifyRequest, slug: string, token?: string) {
  if (token) {
    const [row] = await deps.db
      .select()
      .from(gatewayPending)
      .where(and(eq(gatewayPending.kind, "download"), eq(gatewayPending.ref, slug), eq(gatewayPending.nonceHash, sha256Hex(token)), gt(gatewayPending.expiresAt, deps.now())));
    if (!row) throw new ApiError(401, "unauthorized", "install token is invalid or expired — get a new command on the app page");
    return row.userId;
  }
  return (await requireUser(deps, req)).userId;
}

export async function installRoutes(app: App, deps: Deps) {
  app.get("/store/connect-info", { schema: { tags: ["store"] } }, async () => connectInfo(deps));

  app.get("/store/apps/:slug/skills", { schema: { tags: ["store"], params: z.object({ slug: z.string() }), querystring: z.object({ token: z.string().optional() }) } }, async (req) => {
    const userId = await userFromTokenOrSession(deps, req, req.params.slug, req.query.token);
    const { app: a, version } = await installedVersion(deps, userId, req.params.slug);
    const skills = await appSkills(deps, version);
    return { app: { slug: a.slug, name: a.name, version: version.version }, skills: skills.map((s) => ({ name: s.name, description: s.description, ...(req.query.token ? { content: s.content } : {}) })) };
  });

  /** ZIP for Claude.ai → Customize → Skills → Upload a skill (folder with SKILL.md at its root). */
  app.get("/store/apps/:slug/skills/:name.zip", { schema: { tags: ["store"], params: z.object({ slug: z.string(), name: z.string() }) } }, async (req, reply) => {
    const u = await requireUser(deps, req);
    const { version } = await installedVersion(deps, u.userId, req.params.slug);
    const skill = (await appSkills(deps, version)).find((s) => s.name === req.params.name);
    if (!skill) throw notFound("skill not found");
    const zip = createZip([{ path: `${skill.name}/SKILL.md`, content: skill.content }]);
    return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${skill.name}.zip"`).send(zip);
  });

  /** A 15-minute token so `aix add <slug> --token …` can fetch skills without a password or API key. */
  app.post("/store/apps/:slug/install-token", { schema: { tags: ["store"], params: z.object({ slug: z.string() }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    await installedVersion(deps, u.userId, req.params.slug);
    const token = `aixit_${randomToken(18)}`;
    const expiresAt = new Date(deps.now().getTime() + TOKEN_TTL_MS);
    await deps.db
      .insert(gatewayPending)
      .values({ id: newId("gwp"), userId: u.userId, kind: "download", ref: req.params.slug, payload: null, nonceHash: sha256Hex(token), expiresAt })
      .onConflictDoUpdate({ target: [gatewayPending.userId, gatewayPending.kind, gatewayPending.ref], set: { nonceHash: sha256Hex(token), expiresAt } });
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", action: "skills.install_token_created", targetType: "app", targetId: req.params.slug });
    const base = `aix add ${req.params.slug} --token ${token}${deps.config.AIX_API_URL.includes("localhost") ? ` --api-url ${deps.config.AIX_API_URL}` : ""}`;
    return {
      token,
      expiresAt,
      commands: {
        "claude-code": `${base} --agent claude-code`,
        cursor: `${base} --agent cursor`,
        codex: `${base} --agent codex`,
        agents: `${base} --agent agents`,
      },
    };
  });

  /** Installed prompt apps' skills, for the MCP gateway (prompts + skill_load). */
  app.get("/gateway/skills", { schema: { tags: ["gateway"] } }, async (req) => {
    const u = await requireUser(deps, req);
    const rows = await deps.db
      .select({ app: apps, version: appVersions })
      .from(installs)
      .innerJoin(apps, eq(apps.id, installs.appId))
      .innerJoin(appVersions, eq(appVersions.id, installs.appVersionId))
      .where(and(eq(installs.userId, u.userId), isNull(installs.uninstalledAt), eq(apps.status, "published"), eq(apps.type, "prompt")));
    const out = [];
    for (const r of rows) {
      for (const s of await appSkills(deps, r.version).catch(() => [])) out.push({ app: r.app.slug, appName: r.app.name, name: `${r.app.slug}__${s.name}`, description: s.description, content: s.content });
    }
    return { data: out };
  });

}
