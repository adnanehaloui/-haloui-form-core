/**
 * The AIX marketplace MCP server. One per request (stateless Streamable HTTP), bound to the
 * calling user's AIX access token.
 *
 * Built-in tools: store_search, app_install, wallet_balance, aix_approve
 * App-only tools (called from MCP Apps panels, hidden from the model): approval_decide, app_install_confirm
 * Plus every installed server app's tools, namespaced `<slug>__<tool>` and proxied to the developer.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { assertPublicUrl } from "@aix/core";
import { AixApi, AixApiError } from "./api-client.js";
import type { GatewayConfig } from "./config.js";
import { approvalPanel, installPanel, PANELS, walletPanel } from "./panels.js";

const SEP = "__";
const APP_UI_PREFIX = "ui://aix-app/";

// Pending approvals / install nonces live in the AIX API (Postgres), so any number of gateway
// instances can serve the same user. Only the downstream tool-list cache is per instance.
interface PendingCall { slug: string; tool: string; args: Record<string, unknown>; runId: string }
const toolCache = new Map<string, { tools: Tool[]; expires: number }>();

export function resetGatewayState() {
  toolCache.clear();
}

// ---- Downstream MCP ---------------------------------------------------------------------------

let blockPrivate = false;
export function setBlockPrivateUrls(v: boolean) {
  blockPrivate = v;
}

async function withDownstream<T>(url: string, headers: Record<string, string>, fn: (c: Client) => Promise<T>): Promise<T> {
  // In production, never let an app's manifest point the gateway at internal services (SSRF).
  if (blockPrivate) await assertPublicUrl(url);
  const client = new Client({ name: "aix-gateway", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function downstreamTools(url: string): Promise<Tool[]> {
  const hit = toolCache.get(url);
  if (hit && hit.expires > Date.now()) return hit.tools;
  const tools = await withDownstream(url, {}, async (c) => (await c.listTools()).tools);
  toolCache.set(url, { tools, expires: Date.now() + 60_000 });
  return tools;
}

function rewriteUi(meta: Record<string, any> | undefined, slug: string) {
  if (!meta) return meta;
  const uri = meta.ui?.resourceUri ?? meta["ui/resourceUri"];
  if (!uri) return meta;
  const mapped = `${APP_UI_PREFIX}${slug}/${encodeURIComponent(uri)}`;
  return { ...meta, ui: { ...(meta.ui ?? {}), resourceUri: mapped }, "ui/resourceUri": mapped };
}

const text = (t: string): CallToolResult["content"][number] => ({ type: "text", text: t });
const errorResult = (t: string, structured?: Record<string, unknown>): CallToolResult => ({ isError: true, content: [text(t)], ...(structured ? { structuredContent: structured } : {}) });

// ---- Built-in tools ---------------------------------------------------------------------------

const BUILTIN_TOOLS: Tool[] = [
  {
    name: "store_search",
    title: "Search the AIX store",
    description: "Find AI apps on the AIX store by outcome (e.g. 'make a product video', 'clean a CSV').",
    inputSchema: { type: "object", properties: { query: { type: "string" }, category: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "app_install",
    title: "Install an app",
    description: "Show an app's permissions and price so the user can install it. Installation needs the user's click.",
    inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    // Model-only: an app's own panel must never be able to obtain an install nonce.
    _meta: { ui: { resourceUri: PANELS.install, visibility: ["model"] } },
  },
  {
    name: "wallet_balance",
    title: "AIX wallet balance",
    description: "Show the user's AIX wallet balance and recent charges (receipts).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: PANELS.wallet } },
  },
  {
    name: "aix_approve",
    title: "Ask the user to approve a charge",
    description: "When an app says a charge needs approval, call this with the approvalId to show the approval panel to the user. This does NOT approve anything by itself.",
    inputSchema: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
    // Model-only: a (malicious) app panel can't fetch the approval nonce and approve its own charge.
    _meta: { ui: { resourceUri: PANELS.approval, visibility: ["model"] } },
  },
  {
    name: "approval_decide",
    title: "Approve or deny (panel only)",
    description: "Called by the approval panel when the user clicks Approve/Deny.",
    inputSchema: { type: "object", properties: { approvalId: { type: "string" }, decision: { type: "string", enum: ["approve", "deny"] }, nonce: { type: "string" } }, required: ["approvalId", "decision", "nonce"] },
    _meta: { ui: { resourceUri: PANELS.approval, visibility: ["app"] } },
  },
  {
    name: "app_install_confirm",
    title: "Confirm install (panel only)",
    description: "Called by the install panel when the user clicks Install.",
    inputSchema: { type: "object", properties: { slug: { type: "string" }, nonce: { type: "string" } }, required: ["slug", "nonce"] },
    _meta: { ui: { resourceUri: PANELS.install, visibility: ["app"] } },
  },
];

export interface UserContext { userId: string; accessToken: string }

export function buildGatewayServer(cfg: GatewayConfig, user: UserContext) {
  setBlockPrivateUrls(!!cfg.blockPrivateUrls);
  const api = new AixApi(cfg.apiUrl, user.accessToken, cfg.serviceSecret);
  const webUrl = cfg.apiUrl; // fallback only; /me returns the real web URL
  const server = new Server(
    { name: "aix", title: "AIX — AI app store", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      instructions:
        "AIX gives the user one wallet for AI apps. Use store_search to find apps and app_install to install them. " +
        "Installed apps' tools are named <app>__<tool>. Installed skills can be loaded with skill_load (or used as prompts).  If a tool reports that a charge needs approval, call aix_approve with the approvalId so the user can decide — never approve on the user's behalf.",
    },
  );

  async function listAppTools(): Promise<Tool[]> {
    const { data } = await api.get<{ data: { slug: string; name: string; mcpUrl: string | null }[] }>("/gateway/apps");
    const out: Tool[] = [];
    await Promise.all(
      data.map(async (a) => {
        if (!a.mcpUrl) return;
        try {
          for (const t of await downstreamTools(a.mcpUrl)) {
            out.push({ ...t, name: `${a.slug}${SEP}${t.name}`, title: `${a.name}: ${t.title ?? t.name}`, description: `[${a.name}] ${t.description ?? ""}`.trim(), _meta: rewriteUi(t._meta as any, a.slug) as any });
          }
        } catch {
          // An unreachable app shouldn't break the whole tool list.
        }
      }),
    );
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }

  async function callAppTool(slug: string, tool: string, args: Record<string, unknown>, runId?: string): Promise<CallToolResult> {
    let auth;
    try {
      auth = await api.post<{ runId: string; userToken: string; mcpUrl: string }>("/gateway/calls", { appSlug: slug, tool, ...(runId ? { runId } : {}) });
    } catch (e) {
      if (e instanceof AixApiError) return errorResult(`AIX: ${e.message}`, { aix: { type: e.code } });
      throw e;
    }
    let result: CallToolResult;
    try {
      result = (await withDownstream(auth.mcpUrl, { "x-aix-user-token": auth.userToken, "x-aix-run-id": auth.runId }, (c) => c.callTool({ name: tool, arguments: args }))) as CallToolResult;
    } catch (e: any) {
      result = errorResult(`The app could not be reached: ${e.message}`);
    }
    const done = await api.post<{ charges: any[] }>(`/gateway/calls/${auth.runId}/complete`, { appSlug: slug, tool, isError: !!result.isError }).catch(() => ({ charges: [] }));

    const sc = result.structuredContent as any;
    if (sc?.aix?.type === "needs_user_approval" && sc.aix.approvalId) {
      const pending: PendingCall = { slug, tool, args, runId: auth.runId };
      await api.post("/gateway/pending", { kind: "approval", ref: sc.aix.approvalId, payload: pending });
      result = { ...result, content: [...result.content, text(`To continue, call aix_approve with approvalId "${sc.aix.approvalId}" so the user can approve ${sc.aix.display ?? "the charge"}.`)] };
    }
    const paid = done.charges.filter((c) => c.status === "captured" && c.amountCents > 0);
    if (paid.length) {
      result = {
        ...result,
        content: [...result.content, text(`AIX receipt: ${paid.map((c) => `${c.display} charged by ${c.appName} (${c.id})`).join("; ")}.`)],
        _meta: { ...(result._meta ?? {}), "aix/receipts": paid },
      };
    }
    return result;
  }

  type SkillRow = { app: string; appName: string; name: string; description: string; content: string };
  const listSkills = async () => (await api.get<{ data: SkillRow[] }>("/gateway/skills")).data;
  type WorkflowRow = { slug: string; name: string; description: string; promptName: string; rendered: string };
  const listWorkflows = async () => (await api.get<{ data: WorkflowRow[] }>("/me/workflows")).data;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const [skills, flows] = await Promise.all([listSkills().catch(() => [] as SkillRow[]), listWorkflows().catch(() => [] as WorkflowRow[])]);
    const flowTool: Tool[] = flows.length
      ? [{
          name: "workflow_run",
          title: "Run one of my AIX workflows",
          description: `Get the step-by-step plan of a workflow the user built on AIX, then carry it out with their installed apps. Available: ${flows.map((f) => `${f.slug} — ${f.name}`).join("; ")}`,
          inputSchema: { type: "object", properties: { name: { type: "string", enum: flows.map((f) => f.slug) } }, required: ["name"] },
          annotations: { readOnlyHint: true },
        }]
      : [];
    const skillTool: Tool[] = skills.length
      ? [{
          name: "skill_load",
          title: "Load an installed AIX skill",
          description: `Load the full instructions of a skill the user installed from AIX, then follow them. Available: ${skills.map((s) => `${s.name} — ${s.description || s.appName}`).join("; ")}`,
          inputSchema: { type: "object", properties: { name: { type: "string", enum: skills.map((s) => s.name) } }, required: ["name"] },
          annotations: { readOnlyHint: true },
        }]
      : [];
    return { tools: [...BUILTIN_TOOLS, ...skillTool, ...flowTool, ...(await listAppTools())] };
  });

  // Skills (prompt apps) are also exposed as MCP prompts, for hosts that surface prompts as slash-commands.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      ...(await listSkills()).map((s) => ({ name: s.name, title: `${s.appName}: ${s.name.split("__")[1]}`, description: s.description })),
      ...(await listWorkflows().catch(() => [])).map((f) => ({ name: f.promptName, title: `Workflow: ${f.name}`, description: f.description })),
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
    if (params.name.startsWith("workflow__")) {
      const f = (await listWorkflows()).find((x) => x.promptName === params.name);
      if (!f) throw new Error(`workflow ${params.name} not found`);
      return { description: f.description, messages: [{ role: "user", content: { type: "text", text: f.rendered } }] };
    }
    const s = (await listSkills()).find((x) => x.name === params.name);
    if (!s) throw new Error(`skill ${params.name} is not installed`);
    return { description: s.description, messages: [{ role: "user", content: { type: "text", text: s.content } }] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: PANELS.approval, name: "AIX approval", mimeType: RESOURCE_MIME_TYPE },
      { uri: PANELS.wallet, name: "AIX wallet", mimeType: RESOURCE_MIME_TYPE },
      { uri: PANELS.install, name: "AIX install", mimeType: RESOURCE_MIME_TYPE },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    const builtin = { [PANELS.approval]: approvalPanel, [PANELS.wallet]: walletPanel, [PANELS.install]: installPanel }[params.uri];
    if (builtin) return { contents: [{ uri: params.uri, mimeType: RESOURCE_MIME_TYPE, text: builtin() }] };
    if (params.uri.startsWith(APP_UI_PREFIX)) {
      const [slug, enc] = params.uri.slice(APP_UI_PREFIX.length).split("/", 2);
      const { data } = await api.get<{ data: { slug: string; mcpUrl: string | null }[] }>("/gateway/apps");
      const a = data.find((x) => x.slug === slug);
      if (!a?.mcpUrl || !enc) throw new Error("app not installed");
      const r = await withDownstream(a.mcpUrl, {}, (c) => c.readResource({ uri: decodeURIComponent(enc) }));
      return { contents: r.contents.map((c) => ({ ...c, uri: params.uri })) };
    }
    throw new Error(`unknown resource ${params.uri}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const args = (params.arguments ?? {}) as Record<string, any>;
    try {
      switch (params.name) {
        case "workflow_run": {
          const f = (await listWorkflows()).find((x) => x.slug === args.name);
          if (!f) return errorResult(`Workflow ${args.name} not found. The user can build workflows at AIX → Workflows.`);
          return { content: [text(f.rendered)] };
        }
        case "skill_load": {
          const s = (await listSkills()).find((x) => x.name === args.name);
          if (!s) return errorResult(`Skill ${args.name} is not installed. Use store_search / app_install to add skills.`);
          return { content: [text(`Skill "${s.name}" from ${s.appName}. Follow these instructions:\n\n${s.content}`)] };
        }
        case "store_search": {
          const q = new URLSearchParams({ ...(args.query ? { q: String(args.query) } : {}), ...(args.category ? { category: String(args.category) } : {}) });
          const { data } = await api.get<{ data: any[] }>(`/store/apps?${q}`);
          const lines = data.map((a) => `• ${a.name} (slug: ${a.slug}, ${a.type}) — ${a.description} [${a.priceLabels.join(", ") || "free"}]`);
          return { content: [text(lines.length ? `Found ${data.length} app(s):\n${lines.join("\n")}\nUse app_install with a slug to install.` : "No apps found.")], structuredContent: { apps: data } };
        }
        case "app_install": {
          const a = await api.get<any>(`/store/apps/${encodeURIComponent(String(args.slug))}`);
          const me = await api.get<any>("/me");
          const { nonce } = await api.post<{ nonce: string }>("/gateway/pending", { kind: "install", ref: a.slug, payload: {} });
          const storeUrl = `${me.webUrl ?? webUrl}/apps/${a.slug}`;
          const app = {
            slug: a.slug,
            name: a.name,
            description: a.description,
            developer: a.developer,
            permissionLines: a.permissionLines,
            prices: a.prices.map((p: any) => p.label),
            installed: !!a.me?.installed,
            allowed: a.me?.allowed ?? true,
            blockedReason: a.me?.blockedReason ?? null,
            storeUrl,
          };
          return {
            content: [text(`${a.name} by ${a.developer}. Permissions: ${a.permissionLines.join("; ")}. Price: ${app.prices.join(", ") || "free"}. ${app.installed ? "Already installed." : `The user can click Install in the panel, or install at ${storeUrl}.`}`)],
            structuredContent: { app },
            _meta: { "aix/nonce": nonce },
          };
        }
        case "app_install_confirm": {
          try {
            // The API checks and consumes the panel nonce in the same request.
            await api.post(`/store/apps/${encodeURIComponent(String(args.slug))}/install`, { acceptPermissions: true, nonce: String(args.nonce ?? "") });
          } catch (e) {
            if (e instanceof AixApiError && e.status === 403) return errorResult("This install request expired or can only be confirmed from its panel — run app_install again.");
            throw e;
          }
          toolCache.clear();
          return { content: [text(`Installed ${args.slug}. Its tools are now available as ${args.slug}${SEP}<tool>.`)] };
        }
        case "wallet_balance": {
          const w = await api.get<any>("/wallet");
          const c = await api.get<{ data: any[] }>("/wallet/charges?limit=10");
          const me = await api.get<any>("/me");
          return {
            content: [text(`Wallet: ${w.display.available} available${w.heldCents ? `, ${w.display.held} reserved` : ""}.`)],
            structuredContent: { available: w.display.available, held: w.display.held, heldCents: w.heldCents, availableCents: w.availableCents, receipts: c.data, walletUrl: `${me.webUrl ?? webUrl}/wallet` },
          };
        }
        case "aix_approve": {
          const a = await api.get<any>(`/approvals/${encodeURIComponent(String(args.approvalId))}`);
          const issued = await api.post<{ nonce: string }>("/gateway/pending", { kind: "approval", ref: a.id }).catch(() => null);
          const me = await api.get<any>("/me");
          const approvalUrl = `${me.webUrl ?? webUrl}/approve/${a.id}`;
          return {
            content: [text(`${a.app.name} wants to charge ${a.display} (${a.quantity} × ${a.unit}). Waiting for the user to approve or deny in the panel, or at ${approvalUrl}.`)],
            structuredContent: { approval: { ...a, approvalUrl } },
            ...(issued && a.status === "pending" ? { _meta: { "aix/nonce": issued.nonce } } : {}),
          };
        }
        case "approval_decide": {
          const decision = args.decision === "approve" ? "approve" : "deny";
          let p: PendingCall | null;
          try {
            // The API verifies + consumes the nonce atomically and returns the original call to re-run.
            p = (await api.post<{ gatewayCall: PendingCall | null }>(`/approvals/${encodeURIComponent(String(args.approvalId))}/decision`, { decision, nonce: String(args.nonce ?? "") })).gatewayCall;
          } catch (e) {
            if (e instanceof AixApiError && e.status === 403) return errorResult("This approval can only be decided from its approval panel, or on the AIX website.");
            throw e;
          }
          if (!p) return errorResult("This approval has no pending call to resume — run the tool again.");
          if (decision === "deny") return { content: [text("Charge declined. Nothing was charged.")], structuredContent: { status: "denied" } };
          // Re-run the original call with the SAME run id → same idempotency key → the approved charge.
          const r = await callAppTool(p.slug, p.tool, p.args, p.runId);
          const receipts = ((r._meta as any)?.["aix/receipts"] ?? []) as any[];
          return { ...r, structuredContent: { ...(r.structuredContent ?? {}), status: r.isError ? "failed" : "approved", receipt: receipts.map((c) => `${c.display} · ${c.id}`).join(", ") || null } };
        }
      }
      const i = params.name.indexOf(SEP);
      if (i > 0) return await callAppTool(params.name.slice(0, i), params.name.slice(i + SEP.length), args);
      return errorResult(`Unknown tool ${params.name}`);
    } catch (e) {
      if (e instanceof AixApiError) return errorResult(`AIX: ${e.message}`, { aix: { type: e.code } });
      throw e;
    }
  });

  return server;
}
