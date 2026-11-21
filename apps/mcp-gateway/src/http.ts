import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { GatewayConfig } from "./config.js";
import { buildGatewayServer } from "./gateway.js";

/**
 * HTTP front of the gateway: OAuth 2.1 resource server (RFC 9728 metadata, Bearer validation),
 * per-user rate limiting, and the stateless Streamable HTTP MCP endpoint at /mcp.
 */
export function createGatewayHttpServer(cfg: GatewayConfig, opts: { jwks?: JWTVerifyGetKey } = {}) {
  const resource = `${cfg.gatewayUrl}/mcp`;
  const metadataUrl = `${cfg.gatewayUrl}/.well-known/oauth-protected-resource/mcp`;
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(`${cfg.apiUrl}/.well-known/jwks.json`));
  const buckets = new Map<string, { n: number; reset: number }>();

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...headers }).end(JSON.stringify(body));

  const unauthorized = (res: ServerResponse, error = "invalid_token") =>
    json(res, 401, { error, error_description: "Sign in to AIX" }, { "www-authenticate": `Bearer resource_metadata="${metadataUrl}", scope="aix:gateway"${error === "invalid_token" ? `, error="invalid_token"` : ""}` });

  async function authenticate(req: IncomingMessage) {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return null;
    try {
      const { payload } = await jwtVerify(h.slice(7), jwks, { issuer: cfg.apiUrl, audience: [resource, cfg.gatewayUrl], algorithms: ["EdDSA"] });
      if (payload.token_use !== "access" || !String(payload.scope ?? "").split(" ").includes("aix:gateway") || !payload.sub) return null;
      return { userId: payload.sub, accessToken: h.slice(7) };
    } catch {
      return null;
    }
  }

  function limited(userId: string) {
    const now = Date.now();
    const b = buckets.get(userId);
    if (!b || b.reset < now) {
      buckets.set(userId, { n: 1, reset: now + 60_000 });
      return false;
    }
    return ++b.n > cfg.rateLimitPerMinute;
  }

  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      if (req.method === "OPTIONS") {
        return void res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" }).end();
      }
      if (path === "/health") return json(res, 200, { ok: true });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        return json(res, 200, { resource, authorization_servers: [cfg.apiUrl], scopes_supported: ["aix:gateway"], bearer_methods_supported: ["header"], resource_name: "AIX" });
      }
      // Compatibility: some clients look for AS metadata on the resource's origin.
      if (path === "/.well-known/oauth-authorization-server") {
        const r = await fetch(`${cfg.apiUrl}/.well-known/oauth-authorization-server`);
        return json(res, r.status, await r.json());
      }
      if (path !== "/mcp") return json(res, 404, { error: "not_found" });

      const user = await authenticate(req);
      if (!user) return unauthorized(res);
      if (limited(user.userId)) return json(res, 429, { error: "rate_limited" }, { "retry-after": "60" });
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" }, { allow: "POST" });

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const server = buildGatewayServer(cfg, user);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      console.error("[gateway]", e?.message);
    }
  });
}
