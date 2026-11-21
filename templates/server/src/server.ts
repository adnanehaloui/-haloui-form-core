/**
 * Render Studio — sample AIX server app.
 *
 * An MCP server (Streamable HTTP, stateless) with:
 *  - one paid tool, `render`, billed per render through the user's AIX wallet (@aix/sdk)
 *  - one MCP Apps UI panel (ui://render-studio/preview.html) that shows the storyboard
 *
 * The AIX gateway calls this server with two headers:
 *   X-AIX-User-Token  short-lived signed token → aix.auth.verify() tells us who the user is
 *   X-AIX-Run-Id      unique id for this tool call → our idempotency key (safe retries)
 * No login or billing code of our own.
 */
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { AIX, AIXError, AIX_RUN_ID_HEADER, AIX_USER_TOKEN_HEADER, InsufficientFunds, NeedsUserApproval, SpendLimitExceeded } from "@aix/sdk";
import { previewPanelHtml } from "./panel.js";

const PORT = Number(process.env.PORT ?? 4200);
const PANEL_URI = "ui://render-studio/preview.html";
const aix = new AIX(); // reads AIX_SECRET_KEY and AIX_API_URL from the environment

/** The "expensive work". A real app would call a video model here. */
async function renderStoryboard(script: string) {
  const sentences = script.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  return { title: sentences[0]?.slice(0, 60) ?? "Untitled", frames: sentences.length ? sentences : [script], durationSec: Math.max(5, sentences.length * 3) };
}

function header(req: IncomingMessage, name: string) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function buildServer(req: IncomingMessage) {
  const server = new McpServer({ name: "render-studio", version: "1.0.0" });

  registerAppResource(server, "Render preview", PANEL_URI, { description: "Storyboard preview" }, async () => ({
    contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: previewPanelHtml() }],
  }));

  registerAppTool(
    server,
    "render",
    {
      title: "Render video",
      description: "Render a short product video storyboard from a script. Costs €0.50 per render after 3 free renders.",
      inputSchema: { script: z.string().min(3).max(4000).describe("The video script") },
      _meta: { ui: { resourceUri: PANEL_URI } },
    },
    async ({ script }) => {
      const token = header(req, AIX_USER_TOKEN_HEADER) ?? (process.env.AIX_DEV ? "aix_dev_user_token" : undefined);
      if (!token) return { isError: true, content: [{ type: "text", text: "Missing AIX user token — call this app through the AIX gateway." }] };
      const runId = header(req, AIX_RUN_ID_HEADER) ?? randomUUID();
      try {
        const user = await aix.auth.verify(token);
        // Hold → work → capture (or release automatically if the work throws).
        const { result, charge } = await aix.wallet.run({ userId: user.id, priceId: "render", appId: user.appId, quantity: 1, idempotencyKey: runId, runId }, () => renderStoryboard(script));
        const chargeText = charge.amountCents === 0 ? "free render" : `charged ${charge.display}`;
        return {
          content: [{ type: "text", text: `Rendered "${result.title}" — ${result.frames.length} shots, ${result.durationSec}s (${chargeText}).` }],
          structuredContent: { ...result, charge: chargeText, chargeId: charge.id },
        };
      } catch (e) {
        if (e instanceof NeedsUserApproval) {
          return {
            isError: true,
            content: [{ type: "text", text: `This render costs ${e.display}. The user must approve it first: ${e.approvalUrl}` }],
            structuredContent: { aix: { type: "needs_user_approval", approvalId: e.approvalId, approvalUrl: e.approvalUrl, display: e.display } },
          };
        }
        if (e instanceof InsufficientFunds || e instanceof SpendLimitExceeded) {
          return { isError: true, content: [{ type: "text", text: `${e.message}${e instanceof InsufficientFunds && e.topUpUrl ? ` — top up at ${e.topUpUrl}` : ""}` }], structuredContent: { aix: { type: e.code } } };
        }
        if (e instanceof AIXError) return { isError: true, content: [{ type: "text", text: `AIX: ${e.message}` }], structuredContent: { aix: { type: e.code } } };
        throw e;
      }
    },
  );
  return server;
}

const http = createServer(async (req, res) => {
  if (req.url === "/health") return void res.writeHead(200).end("ok");
  if (!req.url?.startsWith("/mcp")) return void res.writeHead(404).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  const server = buildServer(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

http.listen(PORT, () => console.log(`Render Studio MCP server on http://localhost:${PORT}/mcp`));
