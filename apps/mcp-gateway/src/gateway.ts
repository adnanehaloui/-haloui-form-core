/**
 * The AIX marketplace MCP server. One per request (stateless Streamable HTTP), bound to the
 * calling user's AIX access token.
 *
 * Built-in tools: store_search, app_install, wallet_balance, aix_approve
 * App-only tools (called from MCP Apps panels, hidden from the model): approval_decide, app_install_confirm
 * Plus every installed server app's tools, namespaced `<slug>__<tool>` and proxied to the developer.
 */
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { AixApi, AixApiError } from "./api-client.js";
import type { GatewayConfig } from "./config.js";
import { approvalPanel, installPanel, PANELS, walletPanel } from "./panels.js";

const SEP = "__";
const APP_UI_PREFIX = "ui://aix-app/";

// ---- Shared in-memory state (single instance MVP; see docs/decisions.md) -------------------

interface PendingCall { userId: string; slug: string; tool: string; args: Record<string, unknown>; runId: string; nonce: string; expires: number }
const pendingApprovals = new Map<string, PendingCall>();
const installNonces = new Map<string, { userId: string; slug: string; expires: number }>();
const toolCache = new Map<string, { tools: Tool[]; expires: number }>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of pendingApprovals) if (v.expires < now) pendingApprovals.delete(k);
  for (const [k, v] of installNonces) if (v.expires < now) installNonces.delete(k);
}

export function resetGatewayState() {
  pendingApprovals.clear();
  installNonces.clear();
  toolCache.clear();
}

// ---- Downstream MCP ---------------------------------------------------------------------------

async function withDownstream<T>(url: string, headers: Record<string, string>, fn: (c: Client) => Promise<T>): Promise<T> {
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
    _meta: { ui: { resourceUri: PANELS.install } },
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
    _meta: { ui: { resourceUri: PANELS.approval } },
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
  const api = new AixApi(cfg.apiUrl, user.accessToken);
  const webUrl = cfg.apiUrl; // fallback only; /me returns the real web URL
  const server = new Server(
    { name: "aix", title: "AIX — AI app store", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions:
        "AIX gives the user one wallet for AI apps. Use store_search to find apps and app_install to install them. " +
        "Installed apps' tools are named <app>__<tool>. If a tool reports that a charge needs approval, call aix_approve with the approvalId so the user can decide — never approve on the user's behalf.",
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
      sweep();
      pendingApprovals.set(sc.aix.approvalId, { userId: user.userId, slug, tool, args, runId: auth.runId, nonce: randomBytes(16).toString("hex"), expires: Date.now() + 10 * 60_000 });
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...BUILTIN_TOOLS, ...(await listAppTools())] }));

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
        case "store_search": {
          const q = new URLSearchParams({ ...(args.query ? { q: String(args.query) } : {}), ...(args.category ? { category: String(args.category) } : {}) });
          const { data } = await api.get<{ data: any[] }>(`/store/apps?${q}`);
          const lines = data.map((a) => `• ${a.name} (slug: ${a.slug}, ${a.type}) — ${a.description} [${a.priceLabels.join(", ") || "free"}]`);
          return { content: [text(lines.length ? `Found ${data.length} app(s):\n${lines.join("\n")}\nUse app_install with a slug to install.` : "No apps found.")], structuredContent: { apps: data } };
        }
        case "app_install": {
          const a = await api.get<any>(`/store/apps/${encodeURIComponent(String(args.slug))}`);
          const me = await api.get<any>("/me");
          sweep();
          const nonce = randomBytes(16).toString("hex");
          installNonces.set(nonce, { userId: user.userId, slug: a.slug, expires: Date.now() + 10 * 60_000 });
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
          const n = installNonces.get(String(args.nonce));
          if (!n || n.userId !== user.userId || n.slug !== args.slug) return errorResult("This install request expired — run app_install again.");
          installNonces.delete(String(args.nonce));
          await api.post(`/store/apps/${encodeURIComponent(String(args.slug))}/install`, { acceptPermissions: true });
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
          const p = pendingApprovals.get(a.id);
          const me = await api.get<any>("/me");
          const approvalUrl = `${me.webUrl ?? webUrl}/approve/${a.id}`;
          return {
            content: [text(`${a.app.name} wants to charge ${a.display} (${a.quantity} × ${a.unit}). Waiting for the user to approve or deny in the panel, or at ${approvalUrl}.`)],
            structuredContent: { approval: { ...a, approvalUrl } },
            ...(p && p.userId === user.userId ? { _meta: { "aix/nonce": p.nonce } } : {}),
          };
        }
        case "approval_decide": {
          const p = pendingApprovals.get(String(args.approvalId));
          if (!p || p.userId !== user.userId || p.nonce !== args.nonce) return errorResult("This approval can only be decided from its approval panel, or on the AIX website.");
          const decision = args.decision === "approve" ? "approve" : "deny";
          await api.post(`/approvals/${encodeURIComponent(String(args.approvalId))}/decision`, { decision });
          pendingApprovals.delete(String(args.approvalId));
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
