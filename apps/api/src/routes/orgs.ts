import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { orgMembers, organizations, users } from "@aix/db";
import { newId } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireOrgRole, requireSessionUser, requireUser } from "../lib/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { getOrCreateOrgWallet } from "../services/wallets.js";

const role = z.enum(["owner", "admin", "billing", "member"]);

export async function orgRoutes(app: App, deps: Deps) {
  app.post(
    "/orgs",
    { schema: { tags: ["orgs"], body: z.object({ name: z.string().min(2).max(80), slug: z.string().regex(/^[a-z0-9-]{2,40}$/) }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      return deps.db.transaction(async (tx) => {
        const [exists] = await tx.select().from(organizations).where(eq(organizations.slug, req.body.slug));
        if (exists) throw conflict("slug already taken");
        const id = newId("org");
        await tx.insert(organizations).values({ id, name: req.body.name, slug: req.body.slug });
        await tx.insert(orgMembers).values({ orgId: id, userId: u.userId, role: "owner" });
        const wallet = await getOrCreateOrgWallet(tx, id);
        await audit(tx, { actorUserId: u.userId, actorType: "user", orgId: id, action: "org.created", targetType: "org", targetId: id });
        return { id, name: req.body.name, slug: req.body.slug, walletId: wallet.id };
      });
    },
  );

  app.get("/orgs/:orgId", { schema: { tags: ["orgs"], params: z.object({ orgId: z.string() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    const myRole = await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin", "billing", "member"]);
    const [org] = await deps.db.select().from(organizations).where(eq(organizations.id, req.params.orgId));
    return { ...org!, myRole };
  });

  app.get("/orgs/:orgId/members", { schema: { tags: ["orgs"], params: z.object({ orgId: z.string() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin", "billing", "member"]);
    return deps.db
      .select({ userId: users.id, email: users.email, name: users.name, role: orgMembers.role, joinedAt: orgMembers.createdAt })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, req.params.orgId));
  });

  /** Change a member's role. Only owners can grant or remove the owner role. */
  app.patch(
    "/orgs/:orgId/members/:userId",
    { schema: { tags: ["orgs"], params: z.object({ orgId: z.string(), userId: z.string() }), body: z.object({ role }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const myRole = await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
      const [target] = await deps.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, req.params.orgId), eq(orgMembers.userId, req.params.userId)));
      if (!target) throw notFound("member not found");
      if ((target.role === "owner" || req.body.role === "owner") && myRole !== "owner") throw forbidden("only owners can change owner roles");
      if (target.role === "owner" && req.body.role !== "owner") {
        const owners = await deps.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, req.params.orgId), eq(orgMembers.role, "owner")));
        if (owners.length === 1) throw badRequest("an organization needs at least one owner");
      }
      await deps.db.update(orgMembers).set({ role: req.body.role }).where(and(eq(orgMembers.orgId, req.params.orgId), eq(orgMembers.userId, req.params.userId)));
      await audit(deps.db, { actorUserId: u.userId, actorType: "user", orgId: req.params.orgId, action: "org.member_role_changed", targetType: "user", targetId: req.params.userId, metadata: { from: target.role, to: req.body.role } });
      return { ok: true };
    },
  );

  app.delete(
    "/orgs/:orgId/members/:userId",
    { schema: { tags: ["orgs"], params: z.object({ orgId: z.string(), userId: z.string() }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const myRole = await requireOrgRole(deps, u.userId, req.params.orgId, ["owner", "admin"]);
      const [target] = await deps.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, req.params.orgId), eq(orgMembers.userId, req.params.userId)));
      if (target?.role === "owner" && myRole !== "owner") throw forbidden("only owners can remove owners");
      const owners = await deps.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, req.params.orgId), eq(orgMembers.role, "owner")));
      if (owners.length === 1 && owners[0]!.userId === req.params.userId) throw badRequest("cannot remove the last owner");
      const r = await deps.db.delete(orgMembers).where(and(eq(orgMembers.orgId, req.params.orgId), eq(orgMembers.userId, req.params.userId))).returning();
      if (!r.length) throw notFound("member not found");
      await audit(deps.db, { actorUserId: u.userId, actorType: "user", orgId: req.params.orgId, action: "org.member_removed", targetType: "user", targetId: req.params.userId });
      return { ok: true };
    },
  );
}
