import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Google, generateCodeVerifier, generateState, decodeIdToken } from "arctic";
import { authIdentities, magicLinkTokens, orgMembers, organizations, developers, users } from "@aix/db";
import { newId, randomToken, sha256Hex } from "@aix/core";
import type { App, Deps } from "../context.js";
import { createSession, destroySession, requireUser } from "../lib/auth.js";
import { ApiError, badRequest } from "../lib/errors.js";
import { findOrCreateUserByEmail, normalizeEmail } from "../services/users.js";
import { getOrCreateUserWallet, walletBalance } from "../services/wallets.js";

const MAGIC_LINK_TTL_MIN = 15;

/** Only allow relative redirects to prevent open-redirects. */
export function safeRedirect(path: string | undefined | null, fallback = "/wallet") {
  return path && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : fallback;
}

export async function authRoutes(app: App, deps: Deps) {
  const web = deps.config.AIX_WEB_URL;

  app.post(
    "/auth/magic-link",
    {
      config: { rateLimit: { max: deps.config.NODE_ENV === "test" ? 1000 : 5, timeWindow: "1 minute" } },
      schema: { tags: ["auth"], body: z.object({ email: z.email(), redirectTo: z.string().optional() }), response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async (req) => {
      const token = randomToken();
      await deps.db.insert(magicLinkTokens).values({
        id: sha256Hex(token),
        email: normalizeEmail(req.body.email),
        redirectTo: safeRedirect(req.body.redirectTo),
        expiresAt: new Date(deps.now().getTime() + MAGIC_LINK_TTL_MIN * 60_000),
      });
      const link = `${web}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
      await deps.mailer.send({
        to: req.body.email,
        subject: "Your AIX sign-in link",
        text: `Sign in to AIX:\n\n${link}\n\nThis link expires in ${MAGIC_LINK_TTL_MIN} minutes. If you didn't ask for it, ignore this email.`,
      });
      return { ok: true as const };
    },
  );

  app.get(
    "/auth/magic-link/verify",
    { schema: { tags: ["auth"], querystring: z.object({ token: z.string().min(10) }) } },
    async (req, reply) => {
      const id = sha256Hex(req.query.token);
      const [row] = await deps.db
        .update(magicLinkTokens)
        .set({ usedAt: deps.now() })
        .where(and(eq(magicLinkTokens.id, id), isNull(magicLinkTokens.usedAt), gt(magicLinkTokens.expiresAt, deps.now())))
        .returning();
      if (!row) return reply.redirect(`${web}/login?error=link_expired`);
      const { user } = await deps.db.transaction((tx) => findOrCreateUserByEmail(tx, row.email));
      if (user.disabledAt || user.deletedAt) return reply.redirect(`${web}/login?error=account_disabled`);
      await createSession(deps, reply, user.id);
      return reply.redirect(`${web}${safeRedirect(row.redirectTo)}`);
    },
  );

  // ---- Google ----
  const google = () => {
    if (!deps.config.GOOGLE_CLIENT_ID || !deps.config.GOOGLE_CLIENT_SECRET) {
      throw new ApiError(503, "payments_unavailable", "Google sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
    }
    return new Google(deps.config.GOOGLE_CLIENT_ID, deps.config.GOOGLE_CLIENT_SECRET, `${web}/api/auth/google/callback`);
  };

  app.get("/auth/google/start", { schema: { tags: ["auth"], querystring: z.object({ redirectTo: z.string().optional() }) } }, async (req, reply) => {
    const state = generateState();
    const verifier = generateCodeVerifier();
    const url = google().createAuthorizationURL(state, verifier, ["openid", "email", "profile"]);
    const opts = { path: "/", httpOnly: true, sameSite: "lax" as const, maxAge: 600, secure: deps.config.NODE_ENV === "production" };
    reply.setCookie("aix_g_state", state, opts).setCookie("aix_g_verifier", verifier, opts).setCookie("aix_g_redirect", safeRedirect(req.query.redirectTo), opts);
    return reply.redirect(url.toString());
  });

  app.get("/auth/google/callback", { schema: { tags: ["auth"], querystring: z.object({ code: z.string(), state: z.string() }) } }, async (req, reply) => {
    const { aix_g_state: state, aix_g_verifier: verifier, aix_g_redirect: redirectTo } = req.cookies;
    if (!state || !verifier || state !== req.query.state) throw badRequest("invalid OAuth state");
    const tokens = await google().validateAuthorizationCode(req.query.code, verifier);
    const claims = decodeIdToken(tokens.idToken()) as { sub: string; email?: string; email_verified?: boolean; name?: string };
    if (!claims.email || !claims.email_verified) throw badRequest("Google account email is not verified");
    const user = await deps.db.transaction(async (tx) => {
      const [ident] = await tx.select().from(authIdentities).where(and(eq(authIdentities.provider, "google"), eq(authIdentities.providerUserId, claims.sub)));
      if (ident) return (await tx.select().from(users).where(eq(users.id, ident.userId)))[0]!;
      const { user } = await findOrCreateUserByEmail(tx, claims.email!, claims.name);
      await tx.insert(authIdentities).values({ id: newId("idn"), userId: user.id, provider: "google", providerUserId: claims.sub }).onConflictDoNothing();
      return user;
    });
    if (user.disabledAt || user.deletedAt) return reply.redirect(`${web}/login?error=account_disabled`);
    await createSession(deps, reply, user.id);
    reply.clearCookie("aix_g_state", { path: "/" }).clearCookie("aix_g_verifier", { path: "/" }).clearCookie("aix_g_redirect", { path: "/" });
    return reply.redirect(`${web}${safeRedirect(redirectTo)}`);
  });

  app.post("/auth/logout", { schema: { tags: ["auth"] } }, async (req, reply) => {
    await destroySession(deps, req, reply);
    return { ok: true };
  });

  app.get("/me", { schema: { tags: ["account"] } }, async (req) => {
    const auth = await requireUser(deps, req);
    const [user] = await deps.db.select().from(users).where(eq(users.id, auth.userId));
    const wallet = await getOrCreateUserWallet(deps.db, auth.userId);
    const orgs = await deps.db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: orgMembers.role })
      .from(orgMembers)
      .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, auth.userId));
    const [developer] = await deps.db.select({ id: developers.id, displayName: developers.displayName, payoutStatus: developers.payoutStatus }).from(developers).where(eq(developers.userId, auth.userId));
    return {
      user: { id: user!.id, email: user!.email, name: user!.name, createdAt: user!.createdAt },
      isAdmin: auth.isAdmin,
      webUrl: deps.config.AIX_WEB_URL,
      wallet: { id: wallet.id, currency: wallet.currency, ...(await walletBalance(deps.db, wallet.id)) },
      orgs,
      developer: developer ?? null,
    };
  });
}
