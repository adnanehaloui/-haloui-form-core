/** Internal admin console API (emails in AIX_ADMIN_EMAILS, browser session only). */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { apps, appVersions, charges, developers, users } from "@aix/db";
import { sha256, signingPayload } from "@aix/manifest";
import type { App, Deps } from "../context.js";
import { requireAdmin } from "../lib/auth.js";
import { conflict, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { publicCharge, refund } from "../services/charges.js";
import { trialBalance } from "../services/ledger.js";

export async function adminRoutes(app: App, deps: Deps) {
  app.get("/admin/reviews", { schema: { tags: ["admin"] } }, async (req) => {
    await requireAdmin(deps, req);
    const rows = await deps.db
      .select({ version: appVersions, app: apps, developer: developers.displayName })
      .from(appVersions)
      .innerJoin(apps, eq(apps.id, appVersions.appId))
      .innerJoin(developers, eq(developers.id, apps.developerId))
      .where(eq(appVersions.status, "submitted"))
      .orderBy(appVersions.createdAt);
    return {
      data: rows.map((r) => ({
        versionId: r.version.id,
        version: r.version.version,
        sha256: r.version.packageSha256,
        size: r.version.packageSize,
        manifest: r.version.manifest,
        submittedAt: r.version.createdAt,
        releaseNotes: r.version.reviewNotes,
        app: { id: r.app.id, slug: r.app.slug, name: r.app.name, type: r.app.type, status: r.app.status },
        developer: r.developer,
      })),
    };
  });

  app.post(
    "/admin/versions/:id/:decision",
    { schema: { tags: ["admin"], params: z.object({ id: z.string(), decision: z.enum(["approve", "reject"]) }), body: z.object({ notes: z.string().max(2000).optional() }).nullish() } },
    async (req) => {
      const admin = await requireAdmin(deps, req);
      return deps.db.transaction(async (tx) => {
        const [v] = await tx.select().from(appVersions).where(eq(appVersions.id, req.params.id)).for("update");
        if (!v) throw notFound("version not found");
        if (v.status !== "submitted") throw conflict(`version is already ${v.status}`);
        const notes = req.body?.notes ?? null;
        if (req.params.decision === "reject") {
          await tx.update(appVersions).set({ status: "rejected", reviewNotes: notes, reviewedBy: admin.userId, reviewedAt: deps.now() }).where(eq(appVersions.id, v.id));
        } else {
          // Verify the stored bytes still match the submitted hash, then sign.
          const bytes = await deps.storage.get(v.packagePath);
          if (sha256(bytes) !== v.packageSha256) throw conflict("stored package does not match its hash");
          const signature = deps.signer.signBytes(signingPayload(v.appId, v.version, v.packageSha256));
          await tx.update(appVersions).set({ status: "approved", signature, reviewNotes: notes, reviewedBy: admin.userId, reviewedAt: deps.now() }).where(eq(appVersions.id, v.id));
          const m = v.manifest as { name: string; description: string; category: string };
          await tx.update(apps).set({ status: "published", currentVersionId: v.id, name: m.name, description: m.description, category: m.category }).where(and(eq(apps.id, v.appId)));
        }
        await audit(tx, { actorUserId: admin.userId, actorType: "admin", action: `app_version.${req.params.decision}d`, targetType: "app_version", targetId: v.id, metadata: { appId: v.appId } });
        return { ok: true, status: req.params.decision === "approve" ? "approved" : "rejected" };
      });
    },
  );

  app.post(
    "/admin/apps/:id/:action",
    { schema: { tags: ["admin"], params: z.object({ id: z.string(), action: z.enum(["suspend", "unsuspend"]) }), body: z.object({ reason: z.string().max(500).optional() }).nullish() } },
    async (req) => {
      const admin = await requireAdmin(deps, req);
      const [a] = await deps.db.select().from(apps).where(eq(apps.id, req.params.id));
      if (!a) throw notFound("app not found");
      const status = req.params.action === "suspend" ? "suspended" : a.currentVersionId ? "published" : "draft";
      await deps.db.update(apps).set({ status }).where(eq(apps.id, a.id));
      await audit(deps.db, { actorUserId: admin.userId, actorType: "admin", action: `app.${req.params.action}ed`, targetType: "app", targetId: a.id, metadata: { reason: req.body?.reason ?? null } });
      return { ok: true, status };
    },
  );

  app.get("/admin/apps", { schema: { tags: ["admin"] } }, async (req) => {
    await requireAdmin(deps, req);
    return { data: await deps.db.select().from(apps).orderBy(desc(apps.createdAt)).limit(200) };
  });

  app.get("/admin/charges", { schema: { tags: ["admin"], querystring: z.object({ email: z.string().optional() }) } }, async (req) => {
    await requireAdmin(deps, req);
    const rows = await deps.db
      .select({ charge: charges, appName: apps.name, email: users.email })
      .from(charges)
      .innerJoin(apps, eq(apps.id, charges.appId))
      .innerJoin(users, eq(users.id, charges.userId))
      .where(req.query.email ? eq(users.email, req.query.email.toLowerCase()) : undefined)
      .orderBy(desc(charges.createdAt))
      .limit(100);
    return { data: rows.map((r) => ({ ...publicCharge(r.charge, r.appName), userEmail: r.email })) };
  });

  app.post("/admin/charges/:id/refund", { schema: { tags: ["admin"], params: z.object({ id: z.string() }), body: z.object({ reason: z.string().min(3).max(500) }) } }, async (req) => {
    const admin = await requireAdmin(deps, req);
    return publicCharge(await refund(deps, req.params.id, admin.userId, req.body.reason));
  });

  app.get("/admin/health/ledger", { schema: { tags: ["admin"] } }, async (req) => {
    await requireAdmin(deps, req);
    const tb = await trialBalance(deps.db);
    return { ...tb, balanced: tb.debitCents === tb.creditCents };
  });
}
