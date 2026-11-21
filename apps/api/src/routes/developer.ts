/**
 * Developer portal API. Authenticated by session (web portal) or by a secret key with
 * scope apps:write / keys:write (the `aix` CLI).
 */
import { z } from "zod";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { apiKeys, apps, appVersions, charges, developers, installs, payouts, prices } from "@aix/db";
import { assertPublicUrl, encryptSecret, formatMoney, newId, randomToken } from "@aix/core";
import { sha256, slugify, unpackFiles, validateManifest } from "@aix/manifest";
import type { App, Deps } from "../context.js";
import { API_KEY_SCOPES, generateApiKey, getUser, requireDeveloperKey, requireSessionUser, type ApiKeyScope } from "../lib/auth.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { balance, ensureDeveloperAccount } from "../services/ledger.js";

export async function requireDeveloper(deps: Deps, req: FastifyRequest, keyScope: ApiKeyScope = "apps:write") {
  if (req.headers.authorization?.startsWith("Bearer aixsk_")) {
    const k = await requireDeveloperKey(deps, req, keyScope);
    const [d] = await deps.db.select().from(developers).where(eq(developers.id, k.developerId));
    return { developer: d!, userId: d!.userId, via: "key" as const };
  }
  const u = await getUser(deps, req);
  if (!u || u.via !== "session") throw new ApiError(401, "unauthorized", "sign in or use a secret key");
  const [d] = await deps.db.select().from(developers).where(eq(developers.userId, u.userId));
  if (!d) throw forbidden("not a developer yet — POST /developer first");
  return { developer: d, userId: u.userId, via: "session" as const };
}

async function ownedApp(deps: Deps, developerId: string, appIdOrSlug: string) {
  const [a] = await deps.db.select().from(apps).where(and(eq(apps.developerId, developerId), sql`(${apps.id} = ${appIdOrSlug} or ${apps.slug} = ${appIdOrSlug} or ${apps.manifestId} = ${appIdOrSlug})`));
  if (!a) throw notFound("app not found");
  return a;
}

const priceBody = z.object({
  lookupKey: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
  kind: z.enum(["free", "one_time", "subscription", "metered"]),
  unit: z.string().min(1).max(40).default("run"),
  unitAmountCents: z.number().int().nonnegative().max(1_000_000).default(0),
  interval: z.enum(["month", "year"]).optional(),
  includedUnits: z.number().int().nonnegative().max(1_000_000).default(0),
});

export async function developerRoutes(app: App, deps: Deps) {
  app.post("/developer", { schema: { tags: ["developer"], body: z.object({ displayName: z.string().min(2).max(80) }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    const [existing] = await deps.db.select().from(developers).where(eq(developers.userId, u.userId));
    if (existing) return existing;
    const [d] = await deps.db.insert(developers).values({ id: newId("dev"), userId: u.userId, displayName: req.body.displayName }).returning();
    await ensureDeveloperAccount(deps.db, d!.id);
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", action: "developer.created", targetType: "developer", targetId: d!.id });
    return d;
  });

  app.get("/developer", { schema: { tags: ["developer"] } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    const list = await deps.db.select().from(apps).where(eq(apps.developerId, developer.id)).orderBy(desc(apps.createdAt));
    const payableCents = await balance(deps.db, await ensureDeveloperAccount(deps.db, developer.id));
    return {
      developer: { id: developer.id, displayName: developer.displayName, payoutStatus: developer.payoutStatus, stripeConnected: !!developer.stripeConnectAccountId, webhookUrl: developer.webhookUrl },
      payableCents,
      payableDisplay: formatMoney(payableCents),
      apps: list,
    };
  });

  // ---- Secret keys ----
  app.post(
    "/developer/keys",
    { schema: { tags: ["developer"], body: z.object({ name: z.string().min(1).max(60), scopes: z.array(z.enum(API_KEY_SCOPES)).optional() }) } },
    async (req) => {
      const { developer, userId } = await requireDeveloper(deps, req, "keys:write");
      const k = generateApiKey();
      const scopes = req.body.scopes ?? [...API_KEY_SCOPES];
      const id = newId("key");
      await deps.db.insert(apiKeys).values({ id, developerId: developer.id, name: req.body.name, prefix: k.prefix, hash: k.hash, scopes });
      await audit(deps.db, { actorUserId: userId, actorType: "developer", action: "api_key.created", targetType: "api_key", targetId: id, metadata: { scopes } });
      // The secret is shown exactly once and never stored in plaintext.
      return { id, name: req.body.name, prefix: k.prefix, scopes, secret: k.secret };
    },
  );

  app.get("/developer/keys", { schema: { tags: ["developer"] } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req, "keys:write");
    const rows = await deps.db
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt })
      .from(apiKeys)
      .where(eq(apiKeys.developerId, developer.id))
      .orderBy(desc(apiKeys.createdAt));
    return { data: rows };
  });

  app.delete("/developer/keys/:id", { schema: { tags: ["developer"], params: z.object({ id: z.string() }) } }, async (req) => {
    const { developer, userId } = await requireDeveloper(deps, req, "keys:write");
    const r = await deps.db.update(apiKeys).set({ revokedAt: deps.now() }).where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.developerId, developer.id), isNull(apiKeys.revokedAt))).returning();
    if (!r.length) throw notFound("key not found");
    await audit(deps.db, { actorUserId: userId, actorType: "developer", action: "api_key.revoked", targetType: "api_key", targetId: req.params.id });
    return { ok: true };
  });

  app.put("/developer/webhook", { schema: { tags: ["developer"], body: z.object({ url: z.url().nullable() }) } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    if (!req.body.url) {
      await deps.db.update(developers).set({ webhookUrl: null, webhookSecretEnc: null }).where(eq(developers.id, developer.id));
      return { ok: true };
    }
    if (!deps.config.AIX_ENCRYPTION_KEY) throw new ApiError(503, "payments_unavailable", "set AIX_ENCRYPTION_KEY in .env to enable webhooks");
    await assertPublicUrl(req.body.url, { allowInsecureLocal: deps.config.NODE_ENV !== "production" }).catch((e) => {
      throw badRequest(`webhook URL rejected: ${e.message}`);
    });
    const secret = `whsec_aix_${randomToken(24)}`;
    await deps.db.update(developers).set({ webhookUrl: req.body.url, webhookSecretEnc: encryptSecret(secret, deps.config.AIX_ENCRYPTION_KEY) }).where(eq(developers.id, developer.id));
    return { url: req.body.url, secret };
  });

  // ---- Publish (CLI) ----
  app.post(
    "/developer/publish",
    { schema: { tags: ["developer"], body: z.object({ packageBase64: z.string().min(10), releaseNotes: z.string().max(2000).optional() }) } },
    async (req) => {
      const { developer, userId } = await requireDeveloper(deps, req);
      const pkg = Buffer.from(req.body.packageBase64, "base64");
      let files;
      try {
        files = unpackFiles(pkg);
      } catch (e: any) {
        throw badRequest(`invalid package: ${e.message}`);
      }
      const manifestFile = files.find((f) => f.path === "aix.json");
      if (!manifestFile) throw badRequest("package has no aix.json");
      const v = validateManifest(JSON.parse(manifestFile.content.toString("utf8")));
      if (!v.ok) throw badRequest("invalid aix.json", { errors: v.errors });
      const m = v.manifest!;
      if (deps.config.NODE_ENV === "production" && [m.entry.mcp, m.entry.web, ...m.permissions.network].some((u) => u && !u.startsWith("https://"))) {
        throw badRequest("production apps must use https URLs (localhost is for development only)");
      }
      if (m.type === "prompt") {
        for (const s of m.skills ?? []) if (!files.some((f) => f.path === s)) throw badRequest(`skill file ${s} listed in aix.json is missing from the package`);
      }
      const hash = sha256(pkg);

      return deps.db.transaction(async (tx) => {
        let [a] = await tx.select().from(apps).where(eq(apps.manifestId, m.id));
        if (a && a.developerId !== developer.id) throw forbidden(`app id ${m.id} belongs to another developer`);
        if (!a) {
          let slug = slugify(m.name);
          const [taken] = await tx.select().from(apps).where(eq(apps.slug, slug));
          if (taken) slug = `${slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
          [a] = await tx.insert(apps).values({ id: newId("app"), slug, manifestId: m.id, name: m.name, developerId: developer.id, type: m.type, category: m.category, description: m.description, status: "draft" }).returning();
        }
        if (a!.type !== m.type) throw badRequest(`app type cannot change (${a!.type} → ${m.type})`);
        const [dup] = await tx.select().from(appVersions).where(and(eq(appVersions.appId, a!.id), eq(appVersions.version, m.version)));
        if (dup) throw conflict(`version ${m.version} already exists — bump "version" in aix.json`);
        const versionId = newId("ver");
        const key = `packages/${a!.id}/${m.version}-${hash.slice(0, 12)}.aixpkg`;
        await deps.storage.put(key, pkg);
        await tx.insert(appVersions).values({ id: versionId, appId: a!.id, version: m.version, manifest: m, packagePath: key, packageSha256: hash, packageSize: pkg.length, reviewNotes: req.body.releaseNotes ?? null });
        if (a!.status === "draft") await tx.update(apps).set({ status: "in_review" }).where(eq(apps.id, a!.id));
        await audit(tx, { actorUserId: userId, actorType: "developer", action: "app_version.submitted", targetType: "app_version", targetId: versionId, metadata: { appId: a!.id, version: m.version, sha256: hash } });
        return { appId: a!.id, slug: a!.slug, versionId, version: m.version, sha256: hash, status: "submitted", warnings: v.warnings };
      });
    },
  );

  app.get("/developer/apps/:app", { schema: { tags: ["developer"], params: z.object({ app: z.string() }) } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    const a = await ownedApp(deps, developer.id, req.params.app);
    const versions = await deps.db
      .select({ id: appVersions.id, version: appVersions.version, status: appVersions.status, reviewNotes: appVersions.reviewNotes, sha256: appVersions.packageSha256, createdAt: appVersions.createdAt, reviewedAt: appVersions.reviewedAt })
      .from(appVersions)
      .where(eq(appVersions.appId, a.id))
      .orderBy(desc(appVersions.createdAt));
    const priceList = await deps.db.select().from(prices).where(eq(prices.appId, a.id));
    const [inst] = await deps.db.select({ n: count() }).from(installs).where(and(eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
    const [rev] = await deps.db
      .select({ gross: sql<string>`coalesce(sum(${charges.amountCents}), 0)`, dev: sql<string>`coalesce(sum(${charges.developerCents}), 0)`, n: count() })
      .from(charges)
      .where(and(eq(charges.appId, a.id), eq(charges.status, "captured")));
    return {
      app: a,
      versions,
      prices: priceList,
      analytics: { activeInstalls: inst?.n ?? 0, capturedCharges: rev?.n ?? 0, grossCents: Number(rev?.gross ?? 0), developerCents: Number(rev?.dev ?? 0) },
    };
  });

  app.post("/developer/apps/:app/prices", { schema: { tags: ["developer"], params: z.object({ app: z.string() }), body: priceBody } }, async (req) => {
    const { developer, userId } = await requireDeveloper(deps, req);
    const a = await ownedApp(deps, developer.id, req.params.app);
    const b = req.body;
    if (b.kind === "subscription" && !b.interval) throw badRequest("subscription prices need interval");
    if ((b.kind === "metered" || b.kind === "one_time" || b.kind === "subscription") && b.unitAmountCents <= 0) throw badRequest("paid prices need unitAmountCents > 0");
    if (b.kind === "free" && b.unitAmountCents !== 0) throw badRequest("free prices must have unitAmountCents = 0");
    if (b.lookupKey) {
      const [dupe] = await deps.db.select().from(prices).where(and(eq(prices.appId, a.id), eq(prices.lookupKey, b.lookupKey), eq(prices.active, true)));
      if (dupe) throw conflict(`lookup key ${b.lookupKey} already used — deactivate the old price first`);
    }
    const id = newId("price");
    let stripePriceId: string | null = null;
    if (b.kind === "subscription" && deps.payments) {
      stripePriceId = await deps.payments.ensureRecurringPrice({ aixPriceId: id, appName: a.name, unitAmountCents: b.unitAmountCents, currency: "EUR", interval: b.interval! });
    }
    const [p] = await deps.db
      .insert(prices)
      .values({ id, appId: a.id, lookupKey: b.lookupKey ?? null, kind: b.kind, unit: b.unit, unitAmountCents: b.unitAmountCents, interval: b.interval ?? null, includedUnits: b.includedUnits, stripePriceId })
      .returning();
    await audit(deps.db, { actorUserId: userId, actorType: "developer", action: "price.created", targetType: "price", targetId: id, metadata: { appId: a.id, kind: b.kind, unitAmountCents: b.unitAmountCents } });
    return p;
  });

  app.patch(
    "/developer/apps/:app/prices/:priceId",
    { schema: { tags: ["developer"], params: z.object({ app: z.string(), priceId: z.string() }), body: z.object({ active: z.boolean() }) } },
    async (req) => {
      const { developer } = await requireDeveloper(deps, req);
      const a = await ownedApp(deps, developer.id, req.params.app);
      // Prices are immutable apart from active: to change an amount, create a new price.
      const [p] = await deps.db.update(prices).set({ active: req.body.active }).where(and(eq(prices.id, req.params.priceId), eq(prices.appId, a.id))).returning();
      if (!p) throw notFound("price not found");
      return p;
    },
  );

  app.get("/developer/payouts", { schema: { tags: ["developer"] } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    return { data: await deps.db.select().from(payouts).where(eq(payouts.developerId, developer.id)).orderBy(desc(payouts.createdAt)) };
  });

  app.get("/developer/charges", { schema: { tags: ["developer"], querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    const devApps = await deps.db.select({ id: apps.id }).from(apps).where(eq(apps.developerId, developer.id));
    if (!devApps.length) return { data: [] };
    const rows = await deps.db.select().from(charges).where(inArray(charges.appId, devApps.map((a) => a.id))).orderBy(desc(charges.createdAt)).limit(req.query.limit);
    return { data: rows };
  });
}
