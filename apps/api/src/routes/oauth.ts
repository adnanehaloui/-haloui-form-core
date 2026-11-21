/**
 * AIX as an OAuth 2.1 authorization server (MCP authorization spec):
 *  - RFC 8414 metadata, RFC 7591 dynamic client registration, client-ID metadata documents
 *  - authorization code + PKCE (S256 required), RFC 8707 resource indicators
 *  - rotating refresh tokens; codes and refresh tokens are stored hashed
 * Access tokens are short-lived EdDSA JWTs (JWKS at /.well-known/jwks.json).
 */
import { z } from "zod";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { oauthClients, oauthGrants, users } from "@aix/db";
import { newId, randomToken, safeEqual, safeFetchText, sha256Hex } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireSessionUser } from "../lib/auth.js";
import { ApiError, badRequest, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { requireDeveloper } from "./developer.js";

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 600;

export const SCOPES: Record<string, string> = {
  "aix:gateway": "Use your AIX apps and wallet from this AI tool (spending still follows your limits and approvals)",
  openid: "Know who you are on AIX",
  email: "See your email address",
  profile: "See your name",
};

export const gatewayResource = (deps: Deps) => `${deps.config.AIX_GATEWAY_URL.replace(/\/$/, "")}/mcp`;

function oauthError(status: number, error: string, description: string) {
  return new ApiError(status, "bad_request", description, { error, error_description: description });
}

export function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  // Native app schemes (cursor://, vscode://, claude://) — never script-capable schemes.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(u.protocol);
}

const cimdMisses = new Map<string, number>(); // negative cache: client_id URL → retry-after (ms)

/** Look up a client; for URL client ids, fetch and cache the client-ID metadata document (SSRF-guarded). */
async function getClient(deps: Deps, clientId: string) {
  const [c] = await deps.db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
  if (c) return c;
  const dev = deps.config.NODE_ENV !== "production";
  if (!/^https:\/\//.test(clientId) && !(dev && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(clientId))) return null;
  if ((cimdMisses.get(clientId) ?? 0) > Date.now()) return null;
  try {
    const res = await safeFetchText(clientId, { maxBytes: 16 * 1024, timeoutMs: 3000, allowInsecureLocal: dev, init: { headers: { accept: "application/json" } } });
    if (!res.ok) throw new Error("not ok");
    const doc = JSON.parse(res.text) as { client_id?: string; client_name?: string; redirect_uris?: string[] };
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(validRedirectUri)) return null;
    const [created] = await deps.db
      .insert(oauthClients)
      .values({ id: clientId, name: (doc.client_name ?? new URL(clientId).hostname).slice(0, 100), redirectUris: doc.redirect_uris, scopes: Object.keys(SCOPES) })
      .onConflictDoNothing()
      .returning();
    return created ?? null;
  } catch {
    if (cimdMisses.size > 10_000) cimdMisses.clear();
    cimdMisses.set(clientId, Date.now() + 10 * 60_000);
    return null;
  }
}

const authorizeParams = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(500).optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});
type AuthorizeParams = z.infer<typeof authorizeParams>;

async function validateAuthorize(deps: Deps, p: AuthorizeParams) {
  const client = await getClient(deps, p.client_id);
  if (!client) throw oauthError(400, "invalid_client", "unknown client_id");
  if (!client.redirectUris.includes(p.redirect_uri)) throw oauthError(400, "invalid_request", "redirect_uri is not registered for this client");
  const requested = (p.scope ?? (p.resource ? "aix:gateway" : "openid")).split(" ").filter(Boolean);
  const scopes = requested.filter((s) => s in SCOPES && client.scopes.includes(s));
  if (scopes.length === 0) throw oauthError(400, "invalid_scope", "no valid scopes requested");
  const resource = p.resource?.replace(/\/$/, "");
  if (scopes.includes("aix:gateway")) {
    const gw = gatewayResource(deps);
    if (resource && resource !== gw && resource !== deps.config.AIX_GATEWAY_URL.replace(/\/$/, "")) throw oauthError(400, "invalid_target", `unknown resource; use ${gw}`);
  }
  return { client, scopes, resource: scopes.includes("aix:gateway") ? gatewayResource(deps) : (resource ?? deps.config.AIX_API_URL) };
}

function clientCredentials(req: FastifyRequest, body: Record<string, string | undefined>) {
  const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString() : null;
  if (basic) {
    const i = basic.indexOf(":");
    return { clientId: decodeURIComponent(basic.slice(0, i)), clientSecret: decodeURIComponent(basic.slice(i + 1)) };
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

async function issueTokens(deps: Deps, g: { userId: string; clientId: string; scopes: string[]; resource: string | null }) {
  const accessToken = await deps.signer.signJwt(
    { token_use: "access", scope: g.scopes.join(" "), client_id: g.clientId },
    { audience: g.resource ?? deps.config.AIX_API_URL, issuer: deps.config.AIX_API_URL, subject: g.userId, expiresInSec: ACCESS_TTL },
  );
  const refresh = randomToken();
  await deps.db.insert(oauthGrants).values({
    id: newId("grt"),
    clientId: g.clientId,
    userId: g.userId,
    kind: "refresh",
    tokenHash: sha256Hex(refresh),
    scopes: g.scopes,
    resource: g.resource,
    expiresAt: new Date(deps.now().getTime() + REFRESH_TTL * 1000),
  });
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: g.scopes.join(" ") };
}

export async function oauthRoutes(app: App, deps: Deps) {
  const issuer = deps.config.AIX_API_URL;
  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: Object.keys(SCOPES),
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["EdDSA"],
    client_id_metadata_document_supported: true,
  });
  app.get("/.well-known/oauth-authorization-server", { schema: { tags: ["oauth"] } }, async () => metadata());
  app.get("/.well-known/openid-configuration", { schema: { tags: ["oauth"] } }, async () => metadata());
  app.get("/.well-known/jwks.json", { schema: { tags: ["oauth"] } }, async () => deps.signer.jwks());

  app.post(
    "/oauth/register",
    {
      config: { rateLimit: { max: deps.config.NODE_ENV === "test" ? 1000 : 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["oauth"],
        body: z.object({
          client_name: z.string().max(100).optional(),
          redirect_uris: z.array(z.string()).min(1).max(10),
          token_endpoint_auth_method: z.enum(["none"]).default("none"),
          grant_types: z.array(z.string()).optional(),
          response_types: z.array(z.string()).optional(),
          scope: z.string().optional(),
        }).passthrough(),
      },
    },
    async (req, reply) => {
      if (!req.body.redirect_uris.every(validRedirectUri)) throw oauthError(400, "invalid_redirect_uri", "redirect_uris must be https, localhost, or a native app scheme");
      const id = newId("client");
      const name = req.body.client_name ?? "MCP client";
      await deps.db.insert(oauthClients).values({ id, name, redirectUris: req.body.redirect_uris, scopes: Object.keys(SCOPES) });
      return reply.status(201).send({
        client_id: id,
        client_id_issued_at: Math.floor(deps.now().getTime() / 1000),
        client_name: name,
        redirect_uris: req.body.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    },
  );

  // Browser hits this; we validate, then hand over to the web consent screen.
  app.get("/oauth/authorize", { schema: { tags: ["oauth"], querystring: z.record(z.string(), z.string()) } }, async (req, reply) => {
    const parsed = authorizeParams.safeParse(req.query);
    if (!parsed.success) throw oauthError(400, "invalid_request", "missing or invalid parameters (PKCE S256 is required)");
    await validateAuthorize(deps, parsed.data);
    return reply.redirect(`${deps.config.AIX_WEB_URL}/oauth/consent?${new URLSearchParams(req.query).toString()}`);
  });

  app.get("/oauth/authorize/info", { schema: { tags: ["oauth"], querystring: authorizeParams } }, async (req) => {
    const v = await validateAuthorize(deps, req.query);
    return { client: { id: v.client.id, name: v.client.name }, scopes: v.scopes.map((s) => ({ scope: s, description: SCOPES[s] })), redirectHost: new URL(req.query.redirect_uri).host };
  });

  app.post("/oauth/authorize/decision", { schema: { tags: ["oauth"], body: authorizeParams.extend({ decision: z.enum(["allow", "deny"]) }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    const v = await validateAuthorize(deps, req.body);
    const redirect = new URL(req.body.redirect_uri);
    if (req.body.state) redirect.searchParams.set("state", req.body.state);
    if (req.body.decision === "deny") {
      redirect.searchParams.set("error", "access_denied");
      return { redirectTo: redirect.toString() };
    }
    const code = randomToken();
    await deps.db.insert(oauthGrants).values({
      id: newId("grt"),
      clientId: v.client.id,
      userId: u.userId,
      kind: "code",
      tokenHash: sha256Hex(code),
      scopes: v.scopes,
      resource: v.resource,
      redirectUri: req.body.redirect_uri,
      codeChallenge: req.body.code_challenge,
      expiresAt: new Date(deps.now().getTime() + CODE_TTL * 1000),
    });
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", action: "oauth.authorized", targetType: "oauth_client", targetId: v.client.id, metadata: { scopes: v.scopes, client: v.client.name } });
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("iss", issuer);
    return { redirectTo: redirect.toString() };
  });

  app.post("/oauth/token", { schema: { tags: ["oauth"], body: z.record(z.string(), z.string()) } }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body;
    const { clientId, clientSecret } = clientCredentials(req, b);
    if (!clientId) throw oauthError(401, "invalid_client", "client_id required");
    const client = await getClient(deps, clientId);
    if (!client) throw oauthError(401, "invalid_client", "unknown client");
    if (client.secretHash && (!clientSecret || !safeEqual(sha256Hex(clientSecret), client.secretHash))) throw oauthError(401, "invalid_client", "bad client credentials");

    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.code_verifier) throw oauthError(400, "invalid_request", "code and code_verifier are required");
      const [g] = await deps.db
        .update(oauthGrants)
        .set({ usedAt: deps.now() })
        .where(and(eq(oauthGrants.tokenHash, sha256Hex(b.code)), eq(oauthGrants.kind, "code"), isNull(oauthGrants.usedAt), gt(oauthGrants.expiresAt, deps.now())))
        .returning();
      if (!g || g.clientId !== client.id) throw oauthError(400, "invalid_grant", "invalid or expired code");
      if (g.redirectUri !== b.redirect_uri) throw oauthError(400, "invalid_grant", "redirect_uri mismatch");
      const challenge = createHash("sha256").update(b.code_verifier).digest("base64url");
      if (!g.codeChallenge || !safeEqual(challenge, g.codeChallenge)) throw oauthError(400, "invalid_grant", "PKCE verification failed");
      return issueTokens(deps, { userId: g.userId, clientId: client.id, scopes: g.scopes, resource: g.resource });
    }
    if (b.grant_type === "refresh_token") {
      if (!b.refresh_token) throw oauthError(400, "invalid_request", "refresh_token required");
      const [g] = await deps.db
        .update(oauthGrants)
        .set({ usedAt: deps.now() })
        .where(and(eq(oauthGrants.tokenHash, sha256Hex(b.refresh_token)), eq(oauthGrants.kind, "refresh"), isNull(oauthGrants.usedAt), isNull(oauthGrants.revokedAt), gt(oauthGrants.expiresAt, deps.now())))
        .returning();
      if (!g || g.clientId !== client.id) {
        // Reuse of an already-rotated refresh token = likely theft: revoke every refresh token of that user+client.
        const [old] = await deps.db.select().from(oauthGrants).where(and(eq(oauthGrants.tokenHash, sha256Hex(b.refresh_token)), eq(oauthGrants.kind, "refresh")));
        if (old?.usedAt) await deps.db.update(oauthGrants).set({ revokedAt: deps.now() }).where(and(eq(oauthGrants.userId, old.userId), eq(oauthGrants.clientId, old.clientId), eq(oauthGrants.kind, "refresh"), isNull(oauthGrants.revokedAt)));
        throw oauthError(400, "invalid_grant", "invalid refresh token");
      }
      return issueTokens(deps, { userId: g.userId, clientId: client.id, scopes: g.scopes, resource: g.resource });
    }
    throw oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  });

  app.post("/oauth/revoke", { schema: { tags: ["oauth"], body: z.record(z.string(), z.string()) } }, async (req) => {
    if (req.body.token) await deps.db.update(oauthGrants).set({ revokedAt: deps.now() }).where(eq(oauthGrants.tokenHash, sha256Hex(req.body.token)));
    return {};
  });

  /** "Sign in with AIX" — returns only what the granted scopes allow. */
  app.get("/oauth/userinfo", { schema: { tags: ["oauth"] } }, async (req) => {
    const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    if (!token) throw new ApiError(401, "unauthorized", "Bearer token required");
    let p;
    try {
      p = await deps.signer.verifyJwt(token, { audience: [deps.config.AIX_API_URL, gatewayResource(deps)], issuer });
    } catch {
      throw new ApiError(401, "unauthorized", "invalid token");
    }
    const scopes = String(p.scope ?? "").split(" ");
    if (!scopes.includes("openid") && !scopes.includes("aix:gateway")) throw new ApiError(403, "forbidden", "openid scope required");
    const [u] = await deps.db.select().from(users).where(eq(users.id, p.sub!));
    if (!u) throw notFound("user not found");
    return { sub: u.id, ...(scopes.includes("email") ? { email: u.email, email_verified: true } : {}), ...(scopes.includes("profile") ? { name: u.name } : {}) };
  });

  // ---- Developer-owned confidential clients ("Sign in with AIX" for web apps) ----
  app.post(
    "/developer/oauth-clients",
    { schema: { tags: ["developer"], body: z.object({ name: z.string().min(2).max(100), redirectUris: z.array(z.string()).min(1).max(10) }) } },
    async (req) => {
      const { developer } = await requireDeveloper(deps, req);
      if (!req.body.redirectUris.every(validRedirectUri)) throw badRequest("invalid redirect URI");
      const id = newId("client");
      const secret = `aixcs_${randomToken(24)}`;
      await deps.db.insert(oauthClients).values({ id, name: req.body.name, redirectUris: req.body.redirectUris, secretHash: sha256Hex(secret), developerId: developer.id, scopes: ["openid", "email", "profile"] });
      return { clientId: id, clientSecret: secret, name: req.body.name, redirectUris: req.body.redirectUris };
    },
  );

  app.get("/developer/oauth-clients", { schema: { tags: ["developer"] } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    const rows = await deps.db.select({ id: oauthClients.id, name: oauthClients.name, redirectUris: oauthClients.redirectUris, createdAt: oauthClients.createdAt }).from(oauthClients).where(eq(oauthClients.developerId, developer.id)).orderBy(desc(oauthClients.createdAt));
    return { data: rows };
  });

  /** Connected AI tools for the signed-in user, with revoke. */
  app.get("/me/connections", { schema: { tags: ["account"] } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    const rows = await deps.db
      .select({ clientId: oauthGrants.clientId, name: oauthClients.name, scopes: oauthGrants.scopes, createdAt: oauthGrants.createdAt })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(and(eq(oauthGrants.userId, u.userId), eq(oauthGrants.kind, "refresh"), isNull(oauthGrants.usedAt), isNull(oauthGrants.revokedAt), gt(oauthGrants.expiresAt, deps.now())));
    return { data: rows };
  });

  app.delete("/me/connections/:clientId", { schema: { tags: ["account"], params: z.object({ clientId: z.string() }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    await deps.db.update(oauthGrants).set({ revokedAt: deps.now() }).where(and(eq(oauthGrants.userId, u.userId), eq(oauthGrants.clientId, req.params.clientId)));
    return { ok: true };
  });
}
