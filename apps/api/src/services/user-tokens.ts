import { and, eq, isNull } from "drizzle-orm";
import { apps, installs, users } from "@aix/db";
import type { Deps } from "../context.js";
import { ApiError, unauthorized } from "../lib/errors.js";

export const USER_TOKEN_TTL_SEC = 300;
export const appAudience = (appId: string) => `aix:app:${appId}`;

/**
 * Short-lived signed token that tells a developer's server "this request is from user X".
 * Issued by the gateway per tool call; verified by the developer via `aix.auth.verify`.
 * It is NOT an access token for AIX APIs.
 */
export async function issueUserToken(deps: Deps, userId: string, appId: string, runId?: string) {
  const [install] = await deps.db.select().from(installs).where(and(eq(installs.userId, userId), eq(installs.appId, appId), isNull(installs.uninstalledAt)));
  if (!install) throw new ApiError(403, "not_installed", "app is not installed");
  return deps.signer.signJwt(
    { token_use: "aix_user", install_id: install.id, org_id: install.orgId, ...(runId ? { run_id: runId } : {}) },
    { audience: appAudience(appId), issuer: deps.config.AIX_API_URL, subject: userId, expiresInSec: USER_TOKEN_TTL_SEC },
  );
}

/** Verify a user token for one of this developer's apps; returns only data the user granted. */
export async function verifyUserToken(deps: Deps, developerId: string, token: string) {
  const devApps = await deps.db.select().from(apps).where(eq(apps.developerId, developerId));
  if (devApps.length === 0) throw unauthorized("developer has no apps");
  let payload;
  try {
    payload = await deps.signer.verifyJwt(token, { audience: devApps.map((a) => appAudience(a.id)), issuer: deps.config.AIX_API_URL });
  } catch {
    throw unauthorized("invalid or expired AIX user token");
  }
  if (payload.token_use !== "aix_user" || !payload.sub) throw unauthorized("not an AIX user token");
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  const app = devApps.find((a) => appAudience(a.id) === aud)!;
  const [install] = await deps.db.select().from(installs).where(and(eq(installs.id, String(payload.install_id)), isNull(installs.uninstalledAt)));
  if (!install) throw unauthorized("app was uninstalled");
  const [user] = await deps.db.select().from(users).where(eq(users.id, payload.sub));
  const granted = (install.grantedPermissions as { userData?: string[] }).userData ?? [];
  return {
    id: payload.sub,
    appId: app.id,
    manifestId: app.manifestId,
    orgId: install.orgId,
    runId: (payload.run_id as string | undefined) ?? null,
    ...(granted.includes("email") ? { email: user!.email } : {}),
    ...(granted.includes("name") ? { name: user!.name } : {}),
  };
}
