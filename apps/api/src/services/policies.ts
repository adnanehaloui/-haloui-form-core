import { and, eq } from "drizzle-orm";
import { orgAppPolicies, orgMembers, organizations, type DbOrTx } from "@aix/db";
import type { Deps } from "../context.js";
import { ApiError } from "../lib/errors.js";

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
  orgId?: string;
}

/**
 * Org policies apply to everything a member does with an app (decision D11): if ANY org the user
 * belongs to blocks the app — explicitly, by role, or because it runs an approved-only catalog
 * that doesn't list the app — the user can't install or call it.
 */
export async function checkAppAllowedForUser(db: DbOrTx, userId: string, appId: string): Promise<PolicyVerdict> {
  const memberships = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role, catalogMode: organizations.catalogMode, orgName: organizations.name })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId));
  for (const m of memberships) {
    const [p] = await db.select().from(orgAppPolicies).where(and(eq(orgAppPolicies.orgId, m.orgId), eq(orgAppPolicies.appId, appId)));
    if (p && !p.allowed) return { allowed: false, orgId: m.orgId, reason: `${m.orgName} has blocked this app` };
    if (p && p.allowed && !p.allowedRoles.includes(m.role)) return { allowed: false, orgId: m.orgId, reason: `${m.orgName} doesn't allow your role (${m.role}) to use this app` };
    if (!p && m.catalogMode === "approved_only") return { allowed: false, orgId: m.orgId, reason: `${m.orgName} only allows apps from its approved catalog` };
  }
  return { allowed: true };
}

export async function assertAppAllowedForUser(deps: Deps, userId: string, appId: string, installOrgId: string | null) {
  if (installOrgId) {
    const [m] = await deps.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, installOrgId), eq(orgMembers.userId, userId)));
    if (!m) throw new ApiError(403, "blocked_by_org_policy", "you are no longer a member of the organization that pays for this app");
  }
  const v = await checkAppAllowedForUser(deps.db, userId, appId);
  if (!v.allowed) throw new ApiError(403, "blocked_by_org_policy", v.reason ?? "blocked by organization policy", { orgId: v.orgId });
}
