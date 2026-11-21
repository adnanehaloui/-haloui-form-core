import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { apiKeys, developers, orgMembers, sessions, users } from "@aix/db";
import { newId, randomToken, sha256Hex } from "@aix/core";
import type { Deps } from "../context.js";
import { ApiError, forbidden, unauthorized } from "./errors.js";

export const SESSION_COOKIE = "aix_session";
const SESSION_DAYS = 30;

export interface UserAuth {
  userId: string;
  email: string;
  via: "session" | "token";
  scopes: string[];
  isAdmin: boolean;
}
export interface DeveloperAuth {
  developerId: string;
  keyId: string;
  scopes: string[];
}

export const API_KEY_SCOPES = ["auth:verify", "charges:write", "apps:write", "keys:write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

// ---- Sessions ------------------------------------------------------------------------------

export async function createSession(deps: Deps, reply: FastifyReply, userId: string) {
  const token = randomToken();
  const expiresAt = new Date(deps.now().getTime() + SESSION_DAYS * 86400_000);
  await deps.db.insert(sessions).values({ id: sha256Hex(token), userId, expiresAt });
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: deps.config.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export async function destroySession(deps: Deps, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await deps.db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Resolve the calling user from a session cookie or an AIX OAuth access token (scope aix:gateway). */
export async function getUser(deps: Deps, req: FastifyRequest): Promise<UserAuth | null> {
  const cached = (req as any)._aixUser as UserAuth | null | undefined;
  if (cached !== undefined) return cached;
  let result: UserAuth | null = null;
  const token = bearer(req);
  if (token && !token.startsWith("aixsk_")) {
    try {
      const p = await deps.signer.verifyJwt(token, { audience: [`${deps.config.AIX_GATEWAY_URL.replace(/\/$/, "")}/mcp`, deps.config.AIX_GATEWAY_URL, deps.config.AIX_API_URL], issuer: deps.config.AIX_API_URL });
      const scopes = String(p.scope ?? "").split(" ").filter(Boolean);
      if (p.sub && p.token_use === "access" && scopes.includes("aix:gateway")) {
        const [u] = await deps.db.select().from(users).where(eq(users.id, p.sub));
        if (u && !u.disabledAt && !u.deletedAt) result = { userId: u.id, email: u.email, via: "token", scopes, isAdmin: false };
      }
    } catch {
      result = null;
    }
  } else {
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) {
      const [row] = await deps.db
        .select({ userId: sessions.userId, email: users.email, expiresAt: sessions.expiresAt, disabledAt: users.disabledAt, deletedAt: users.deletedAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, sha256Hex(cookie)), gt(sessions.expiresAt, deps.now())));
      if (row && !row.disabledAt && !row.deletedAt) {
        result = { userId: row.userId, email: row.email, via: "session", scopes: ["*"], isAdmin: deps.config.adminEmails.has(row.email) };
      }
    }
  }
  (req as any)._aixUser = result;
  return result;
}

export async function requireUser(deps: Deps, req: FastifyRequest): Promise<UserAuth> {
  const u = await getUser(deps, req);
  if (!u) throw unauthorized();
  return u;
}

/** Session-only (browser) actions such as approving a charge or topping up. */
export async function requireSessionUser(deps: Deps, req: FastifyRequest): Promise<UserAuth> {
  const u = await requireUser(deps, req);
  if (u.via !== "session") throw forbidden("this action requires signing in on the AIX website");
  return u;
}

export async function requireAdmin(deps: Deps, req: FastifyRequest): Promise<UserAuth> {
  const u = await requireSessionUser(deps, req);
  if (!u.isAdmin) throw forbidden("admin only");
  return u;
}

// ---- Developer secret keys --------------------------------------------------------------------

export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = `aixsk_test_${randomToken(24)}`;
  return { secret, prefix: secret.slice(0, 16), hash: sha256Hex(secret) };
}

export async function requireDeveloperKey(deps: Deps, req: FastifyRequest, scope: ApiKeyScope): Promise<DeveloperAuth> {
  const token = bearer(req);
  if (!token || !token.startsWith("aixsk_")) throw unauthorized("developer secret key required (Authorization: Bearer aixsk_…)");
  const [k] = await deps.db.select().from(apiKeys).where(and(eq(apiKeys.hash, sha256Hex(token)), isNull(apiKeys.revokedAt)));
  if (!k) throw unauthorized("invalid or revoked secret key");
  const [owner] = await deps.db.select({ disabledAt: users.disabledAt }).from(developers).innerJoin(users, eq(users.id, developers.userId)).where(eq(developers.id, k.developerId));
  if (owner?.disabledAt) throw forbidden("this developer account is suspended");
  if (!k.scopes.includes(scope)) throw new ApiError(403, "forbidden", `secret key lacks scope ${scope}`);
  await deps.db.update(apiKeys).set({ lastUsedAt: deps.now() }).where(eq(apiKeys.id, k.id));
  return { developerId: k.developerId, keyId: k.id, scopes: k.scopes };
}

// ---- Org tenant checks --------------------------------------------------------------------------

export type OrgRole = "owner" | "admin" | "billing" | "member";

/** Row-level tenant check: throws unless the user belongs to the org with one of the roles. */
export async function requireOrgRole(deps: Deps, userId: string, orgId: string, roles: OrgRole[]): Promise<OrgRole> {
  const [m] = await deps.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
  // Same error for "not a member" and "no such org" — don't leak org existence.
  if (!m) throw new ApiError(404, "not_found", "organization not found");
  if (!roles.includes(m.role)) throw forbidden(`requires role: ${roles.join(" | ")}`);
  return m.role;
}

export { newId };
