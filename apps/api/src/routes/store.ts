import { z } from "zod";
import { and, avg, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { apps, appVersions, developers, installs, orgAppPolicies, orgMembers, prices, reviews, users } from "@aix/db";
import { formatMoney, newId } from "@aix/core";
import { CATEGORIES, describePermissions, listingAssetPaths, sha256, signingPayload, unpackFiles, type Manifest } from "@aix/manifest";
import type { App, Deps } from "../context.js";
import { getUser, requireOrgRole, requireSessionUser, requireUser } from "../lib/auth.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { PaymentsUnavailableError } from "../lib/payments.js";
import { audit } from "../services/audit.js";
import { checkAppAllowedForUser } from "../services/policies.js";
import { getOrCreateUserWallet } from "../services/wallets.js";

type PriceRow = typeof prices.$inferSelect;

export function priceLabel(p: PriceRow): string {
  switch (p.kind) {
    case "free":
      return p.includedUnits ? `${p.includedUnits} free ${p.unit}s` : "Free";
    case "metered":
      return `${formatMoney(p.unitAmountCents)} / ${p.unit}${p.includedUnits ? ` (first ${p.includedUnits} free)` : ""}`;
    case "one_time":
      return `${formatMoney(p.unitAmountCents)} per ${p.unit}`;
    case "subscription":
      return `${formatMoney(p.unitAmountCents)} / ${p.interval}`;
  }
}

async function loadPublishedApp(deps: Deps, slug: string) {
  const [row] = await deps.db
    .select({ app: apps, version: appVersions, developer: developers.displayName })
    .from(apps)
    .innerJoin(appVersions, eq(appVersions.id, apps.currentVersionId))
    .innerJoin(developers, eq(developers.id, apps.developerId))
    .where(and(eq(apps.slug, slug), eq(apps.status, "published")));
  if (!row) throw notFound("app not found");
  return row;
}

/** Re-verify a package before installing it: bytes match the hash, and the hash carries our signature. */
export async function verifyPackage(deps: Deps, v: typeof appVersions.$inferSelect) {
  if (v.status !== "approved" || !v.signature) throw new ApiError(409, "conflict", "app version is not approved");
  const bytes = await deps.storage.get(v.packagePath);
  if (sha256(bytes) !== v.packageSha256) throw new ApiError(409, "conflict", "package integrity check failed (hash mismatch)");
  if (!deps.signer.verifyBytes(signingPayload(v.appId, v.version, v.packageSha256), v.signature)) throw new ApiError(409, "conflict", "package signature is invalid");
  return bytes;
}

/** Install an app for a user (optionally paid by an org). Used by the web store and the MCP gateway. */
export async function installApp(deps: Deps, userId: string, slug: string, opts: { orgId?: string | undefined; via: "web" | "gateway" }) {
  const { app: a, version: v } = await loadPublishedApp(deps, slug);
  await verifyPackage(deps, v);
  const verdict = await checkAppAllowedForUser(deps.db, userId, a.id);
  if (!verdict.allowed) throw new ApiError(403, "blocked_by_org_policy", verdict.reason ?? "blocked by organization policy", { orgId: verdict.orgId });
  if (opts.orgId) {
    const role = await requireOrgRole(deps, userId, opts.orgId, ["owner", "admin", "billing", "member"]);
    const [p] = await deps.db.select().from(orgAppPolicies).where(and(eq(orgAppPolicies.orgId, opts.orgId), eq(orgAppPolicies.appId, a.id)));
    const allowedRoles = p?.allowed ? p.allowedRoles : ["owner", "admin"];
    if (!allowedRoles.includes(role)) throw new ApiError(403, "blocked_by_org_policy", `your role (${role}) can't install this app on the organization's account`);
  }
  const manifest = v.manifest as Manifest;
  // Org "max permissions": an org may cap what apps its members install may access.
  const caps = await deps.db
    .select({ max: orgAppPolicies.maxPermissions })
    .from(orgAppPolicies)
    .innerJoin(orgMembers, and(eq(orgMembers.orgId, orgAppPolicies.orgId), eq(orgMembers.userId, userId)))
    .where(eq(orgAppPolicies.appId, a.id));
  for (const { max } of caps) {
    const m = max as { network: boolean; files: boolean; userData: string[] } | null;
    if (!m) continue;
    const p = manifest.permissions;
    if ((p.network.length && !m.network) || (p.files.length && !m.files) || p.userData.some((d) => !m.userData.includes(d))) {
      throw new ApiError(403, "blocked_by_org_policy", "this app asks for more permissions than your organization allows");
    }
  }
  await getOrCreateUserWallet(deps.db, userId);
  return deps.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(installs).where(and(eq(installs.userId, userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
    if (existing) {
      const [u] = await tx.update(installs).set({ appVersionId: v.id, grantedPermissions: manifest.permissions, orgId: opts.orgId ?? existing.orgId }).where(eq(installs.id, existing.id)).returning();
      return { install: u!, app: a, upgraded: existing.appVersionId !== v.id };
    }
    const [i] = await tx
      .insert(installs)
      .values({ id: newId("ins"), userId, appId: a.id, appVersionId: v.id, orgId: opts.orgId ?? null, grantedPermissions: manifest.permissions })
      .returning();
    await audit(tx, { actorUserId: userId, actorType: opts.via === "gateway" ? "gateway" : "user", orgId: opts.orgId ?? null, action: "app.installed", targetType: "app", targetId: a.id, metadata: { version: v.version, permissions: manifest.permissions } });
    return { install: i!, app: a, upgraded: false };
  });
}

// ---- Listing helpers ---------------------------------------------------------------------------

const assetUrl = (deps: Deps, slug: string, versionId: string, p: string) =>
  /^https:\/\//.test(p) ? p : `${deps.config.AIX_WEB_URL}/api/store/apps/${slug}/assets/${versionId}/${p.split("/").map(encodeURIComponent).join("/")}`;

export function listing(deps: Deps, a: typeof apps.$inferSelect, v: typeof appVersions.$inferSelect) {
  const m = v.manifest as Manifest;
  return {
    tagline: m.tagline ?? null,
    color: m.color ?? null,
    iconUrl: m.icon ? assetUrl(deps, a.slug, v.id, m.icon) : null,
    screenshots: (m.screenshots ?? []).map((p) => assetUrl(deps, a.slug, v.id, p)),
    showcase: (m.showcase ?? []).map((sc) => (sc.kind === "image" && typeof sc.output === "string" ? { ...sc, output: assetUrl(deps, a.slug, v.id, sc.output) } : sc)),
  };
}

async function installCounts(deps: Deps, appIds: string[]) {
  if (!appIds.length) return new Map<string, number>();
  const rows = await deps.db
    .select({ appId: installs.appId, n: count() })
    .from(installs)
    .where(and(inArray(installs.appId, appIds), isNull(installs.uninstalledAt)))
    .groupBy(installs.appId);
  return new Map(rows.map((r) => [r.appId, r.n]));
}

// ---- Full-text search (GIN index in migrations/0004_search_index.sql) --------------------------
const searchDoc = sql`(setweight(to_tsvector('simple', coalesce(${apps.name}, '')), 'A') || setweight(to_tsvector('english', coalesce(${apps.description}, '')), 'B') || setweight(to_tsvector('simple', coalesce(${apps.category}, '')), 'C'))`;
const STOPWORDS = new Set("a an and are as at be by can do for from get help how i in is it make me my of on or our please some that the this to want we what with you your".split(" "));
/** "vid edit" → 'vid:* | edit:*' — prefix match while typing, any word matches, ranking rewards more words. */
function prefixQuery(q: string) {
  const all = q.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const meaningful = all.filter((w) => !STOPWORDS.has(w));
  const words = (meaningful.length ? meaningful : all).slice(0, 8);
  return words.length ? words.map((w) => `${w}:*`).join(" | ") : null;
}
function searchMatch(q: string) {
  const pq = prefixQuery(q);
  return or(
    pq ? sql`${searchDoc} @@ to_tsquery('simple', ${pq})` : undefined,
    pq ? sql`${searchDoc} @@ to_tsquery('english', ${pq})` : undefined,
    ilike(sql`${appVersions.manifest}->>'tagline'`, `%${q}%`),
    // Typos: "brnad" → Brand Kit Studio (pg_trgm word similarity on the name).
    sql`word_similarity(${q.toLowerCase()}, lower(${apps.name})) >= 0.3`,
  );
}
function searchRank(q: string) {
  const pq = prefixQuery(q);
  return sql`(${pq ? sql`ts_rank(${searchDoc}, to_tsquery('simple', ${pq})) + ts_rank(${searchDoc}, to_tsquery('english', ${pq}))` : sql`0`} + word_similarity(${q.toLowerCase()}, lower(${apps.name})) + (case when lower(${apps.name}) like ${q.toLowerCase().replace(/[%_]/g, "") + "%"} then 1 else 0 end))`;
}

export async function storeSearch(deps: Deps, q: { q?: string | undefined; category?: string | undefined; type?: string | undefined; host?: string | undefined; limit?: number }) {
  const rows = await deps.db
    .select({ app: apps, version: appVersions, developer: developers.displayName })
    .from(apps)
    .innerJoin(appVersions, eq(appVersions.id, apps.currentVersionId))
    .innerJoin(developers, eq(developers.id, apps.developerId))
    .where(
      and(
        eq(apps.status, "published"),
        q.q ? searchMatch(q.q) : undefined,
        q.category ? eq(apps.category, q.category) : undefined,
        q.type ? eq(apps.type, q.type as any) : undefined,
        q.host ? sql`${appVersions.manifest}->'compatibility'->'hosts' ? ${q.host}` : undefined,
      ),
    )
    .orderBy(...(q.q ? [desc(searchRank(q.q)), desc(apps.createdAt)] : [desc(apps.createdAt)]))
    .limit(q.limit ?? 50);
  const counts = await installCounts(deps, rows.map((r) => r.app.id));
  const out = [];
  for (const r of rows) {
    const ps = await deps.db.select().from(prices).where(and(eq(prices.appId, r.app.id), eq(prices.active, true)));
    const [rv] = await deps.db.select({ avg: avg(reviews.rating), n: count() }).from(reviews).where(and(eq(reviews.appId, r.app.id), isNull(reviews.hiddenAt)));
    const m = r.version.manifest as Manifest;
    out.push({
      id: r.app.id,
      slug: r.app.slug,
      name: r.app.name,
      description: r.app.description,
      category: r.app.category,
      type: r.app.type,
      developer: r.developer,
      hosts: m.compatibility.hosts,
      priceLabels: ps.map(priceLabel),
      isFree: ps.every((p) => p.kind === "free" || p.unitAmountCents === 0) || ps.some((p) => p.includedUnits > 0),
      rating: rv?.n ? { average: Number(Number(rv.avg).toFixed(1)), count: rv.n } : null,
      installs: counts.get(r.app.id) ?? 0,
      createdAt: r.app.createdAt,
      ...listing(deps, r.app, r.version),
    });
  }
  return out;
}

export async function storeRoutes(app: App, deps: Deps) {
  app.get("/store/categories", { schema: { tags: ["store"] } }, async () => ({ data: CATEGORIES }));

  /** Curated home: featured apps (with showcase results) and rows, like an app store front page. */
  app.get("/store/home", { schema: { tags: ["store"] } }, async () => {
    const all = await storeSearch(deps, { limit: 200 });
    const score = (a: (typeof all)[number]) => a.installs * 2 + (a.rating ? a.rating.average * a.rating.count : 0) + a.showcase.length;
    const byScore = [...all].sort((x, y) => score(y) - score(x));
    const featured = byScore.filter((a) => a.showcase.length > 0).slice(0, 5);
    const sections = [
      { id: "top", title: "Top apps", subtitle: "Most installed this month", apps: byScore.slice(0, 12) },
      { id: "new", title: "New & noteworthy", subtitle: "Fresh from developers", apps: [...all].sort((x, y) => +new Date(y.createdAt) - +new Date(x.createdAt)).slice(0, 12) },
      { id: "free", title: "Try for free", subtitle: "Free or with free runs included", apps: byScore.filter((a) => a.isFree).slice(0, 12) },
      // Category rows only when they'd look full; smaller categories are reached from the category grid.
      ...CATEGORIES.map((c) => ({ id: `cat-${c}`, title: c, subtitle: null, category: c, apps: byScore.filter((a) => a.category === c).slice(0, 12) })).filter((s) => s.apps.length >= 3),
    ].filter((s) => s.apps.length > 0);
    return { featured, sections, total: all.length };
  });

  /**
   * Listing images (icon, screenshots, showcase images) served from the SIGNED package.
   * Only paths the manifest declares as listing assets; SVG is sandboxed (no scripts).
   */
  const assetCache = new Map<string, Map<string, Buffer>>();
  app.get("/store/apps/:slug/assets/:versionId/*", { schema: { tags: ["store"], hide: true, params: z.object({ slug: z.string(), versionId: z.string(), "*": z.string() }) } }, async (req, reply) => {
    const [row] = await deps.db.select({ app: apps, version: appVersions }).from(appVersions).innerJoin(apps, eq(apps.id, appVersions.appId)).where(and(eq(apps.slug, req.params.slug), eq(appVersions.id, req.params.versionId)));
    if (!row || row.app.status !== "published" || row.version.status !== "approved") throw notFound("asset not found");
    const path = req.params["*"];
    if (!listingAssetPaths(row.version.manifest as Manifest).includes(path)) throw notFound("asset not found");
    let files = assetCache.get(row.version.id);
    if (!files) {
      const bytes = await verifyPackage(deps, row.version);
      files = new Map(unpackFiles(bytes).filter((f) => listingAssetPaths(row.version.manifest as Manifest).includes(f.path)).map((f) => [f.path, f.content]));
      if (assetCache.size > 200) assetCache.clear();
      assetCache.set(row.version.id, files);
    }
    const file = files.get(path);
    if (!file) throw notFound("asset not found");
    const ext = path.split(".").pop()!.toLowerCase();
    const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" }[ext]!;
    return reply
      .header("content-type", type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
      .header("cache-control", "public, max-age=31536000, immutable") // versioned URL
      .send(file);
  });

  app.get(
    "/store/apps",
    { schema: { tags: ["store"], querystring: z.object({ q: z.string().max(100).optional(), category: z.string().optional(), type: z.enum(["prompt", "server", "local", "web"]).optional(), host: z.string().optional() }) } },
    async (req) => ({ data: await storeSearch(deps, req.query) }),
  );

  app.get("/store/apps/:slug", { schema: { tags: ["store"], params: z.object({ slug: z.string() }) } }, async (req) => {
    const { app: a, version: v, developer } = await loadPublishedApp(deps, req.params.slug);
    const m = v.manifest as Manifest;
    const ps = await deps.db.select().from(prices).where(and(eq(prices.appId, a.id), eq(prices.active, true)));
    const rv = await deps.db
      .select({ id: reviews.id, rating: reviews.rating, body: reviews.body, createdAt: reviews.createdAt, name: users.name })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.userId))
      .where(and(eq(reviews.appId, a.id), isNull(reviews.hiddenAt)))
      .orderBy(desc(reviews.createdAt))
      .limit(20);
    const user = await getUser(deps, req);
    let mine = null;
    if (user) {
      const [i] = await deps.db.select().from(installs).where(and(eq(installs.userId, user.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
      const verdict = await checkAppAllowedForUser(deps.db, user.userId, a.id);
      const orgs = await deps.db.select({ orgId: orgMembers.orgId, role: orgMembers.role }).from(orgMembers).where(eq(orgMembers.userId, user.userId));
      mine = { installed: !!i, installId: i?.id ?? null, installedOrgId: i?.orgId ?? null, allowed: verdict.allowed, blockedReason: verdict.reason ?? null, orgs };
    }
    return {
      id: a.id,
      slug: a.slug,
      manifestId: a.manifestId,
      name: a.name,
      description: a.description,
      category: a.category,
      type: a.type,
      developer,
      version: v.version,
      sha256: v.packageSha256,
      hosts: m.compatibility.hosts,
      entry: m.entry,
      permissions: m.permissions,
      permissionLines: describePermissions(m),
      prices: ps.map((p) => ({ id: p.id, lookupKey: p.lookupKey, kind: p.kind, unit: p.unit, unitAmountCents: p.unitAmountCents, interval: p.interval, includedUnits: p.includedUnits, label: priceLabel(p) })),
      reviews: rv.map((r) => ({ ...r, name: r.name ?? "AIX user" })),
      rating: await (async () => {
        const [x] = await deps.db.select({ avg: avg(reviews.rating), n: count() }).from(reviews).where(and(eq(reviews.appId, a.id), isNull(reviews.hiddenAt)));
        return x?.n ? { average: Number(Number(x.avg).toFixed(1)), count: x.n } : null;
      })(),
      installs: (await installCounts(deps, [a.id])).get(a.id) ?? 0,
      ...listing(deps, a, v),
      related: await (async () => {
        const same = (await storeSearch(deps, { category: a.category, limit: 8 })).filter((x) => x.id !== a.id);
        if (same.length >= 3) return same.slice(0, 6);
        const more = (await storeSearch(deps, { limit: 30 })).filter((x) => x.id !== a.id && !same.some((s) => s.id === x.id)).sort((x, y) => y.installs - x.installs);
        return [...same, ...more].slice(0, 6);
      })(),
      me: mine,
    };
  });

  app.post(
    "/store/apps/:slug/install",
    { schema: { tags: ["store"], params: z.object({ slug: z.string() }), body: z.object({ acceptPermissions: z.literal(true), orgId: z.string().optional() }) } },
    async (req) => {
      const u = await requireUser(deps, req);
      const r = await installApp(deps, u.userId, req.params.slug, { orgId: req.body.orgId, via: u.via === "token" ? "gateway" : "web" });
      return { installId: r.install.id, appId: r.app.id, slug: r.app.slug, orgId: r.install.orgId, upgraded: r.upgraded };
    },
  );

  app.delete("/store/apps/:slug/install", { schema: { tags: ["store"], params: z.object({ slug: z.string() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    const [a] = await deps.db.select().from(apps).where(eq(apps.slug, req.params.slug));
    if (!a) throw notFound("app not found");
    const r = await deps.db.update(installs).set({ uninstalledAt: deps.now() }).where(and(eq(installs.userId, u.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt))).returning();
    if (!r.length) throw notFound("not installed");
    await audit(deps.db, { actorUserId: u.userId, actorType: "user", action: "app.uninstalled", targetType: "app", targetId: a.id });
    return { ok: true };
  });

  /** Download the signed package (prompt / local apps), for installed users only. */
  app.get("/store/apps/:slug/package", { schema: { tags: ["store"], params: z.object({ slug: z.string() }) } }, async (req, reply) => {
    const u = await requireUser(deps, req);
    const { app: a, version: v } = await loadPublishedApp(deps, req.params.slug);
    const [i] = await deps.db.select().from(installs).where(and(eq(installs.userId, u.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
    if (!i) throw forbidden("install the app first");
    const bytes = await verifyPackage(deps, v);
    reply.header("content-type", "application/octet-stream").header("x-aix-sha256", v.packageSha256).header("x-aix-signature", v.signature!);
    return reply.send(bytes);
  });

  app.get("/me/installs", { schema: { tags: ["store"] } }, async (req) => {
    const u = await requireUser(deps, req);
    const rows = await deps.db
      .select({ install: installs, app: apps, version: appVersions.version, manifest: appVersions.manifest })
      .from(installs)
      .innerJoin(apps, eq(apps.id, installs.appId))
      .innerJoin(appVersions, eq(appVersions.id, installs.appVersionId))
      .where(and(eq(installs.userId, u.userId), isNull(installs.uninstalledAt)));
    return {
      data: rows.map((r) => ({
        installId: r.install.id,
        orgId: r.install.orgId,
        installedAt: r.install.createdAt,
        app: { id: r.app.id, slug: r.app.slug, name: r.app.name, type: r.app.type, status: r.app.status, manifestId: r.app.manifestId },
        version: r.version,
        entry: (r.manifest as Manifest).entry,
      })),
    };
  });

  app.post(
    "/store/apps/:slug/reviews",
    { schema: { tags: ["store"], params: z.object({ slug: z.string() }), body: z.object({ rating: z.number().int().min(1).max(5), body: z.string().max(2000).default("") }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const { app: a } = await loadPublishedApp(deps, req.params.slug);
      const [i] = await deps.db.select().from(installs).where(and(eq(installs.userId, u.userId), eq(installs.appId, a.id)));
      if (!i) throw forbidden("only users who installed the app can review it");
      await deps.db
        .insert(reviews)
        .values({ id: newId("rev"), appId: a.id, userId: u.userId, rating: req.body.rating, body: req.body.body })
        .onConflictDoUpdate({ target: [reviews.appId, reviews.userId], set: { rating: req.body.rating, body: req.body.body } });
      return { ok: true };
    },
  );

  app.post(
    "/store/apps/:slug/subscribe",
    { schema: { tags: ["store"], params: z.object({ slug: z.string() }), body: z.object({ priceId: z.string() }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const { app: a } = await loadPublishedApp(deps, req.params.slug);
      const [p] = await deps.db.select().from(prices).where(and(eq(prices.id, req.body.priceId), eq(prices.appId, a.id), eq(prices.active, true)));
      if (!p || p.kind !== "subscription") throw badRequest("not an active subscription price");
      if (!deps.payments) throw new PaymentsUnavailableError();
      const [i] = await deps.db.select().from(installs).where(and(eq(installs.userId, u.userId), eq(installs.appId, a.id), isNull(installs.uninstalledAt)));
      if (!i) throw conflict("install the app before subscribing");
      let stripePriceId = p.stripePriceId;
      if (!stripePriceId) {
        stripePriceId = await deps.payments.ensureRecurringPrice({ aixPriceId: p.id, appName: a.name, unitAmountCents: p.unitAmountCents, currency: p.currency, interval: p.interval! });
        await deps.db.update(prices).set({ stripePriceId }).where(eq(prices.id, p.id));
      }
      const wallet = await getOrCreateUserWallet(deps.db, u.userId);
      const [user] = await deps.db.select().from(users).where(eq(users.id, u.userId));
      const s = await deps.payments.createSubscriptionCheckout({
        walletId: wallet.id,
        userId: u.userId,
        priceId: p.id,
        stripePriceId,
        unitAmountCents: p.unitAmountCents,
        customerId: user!.stripeCustomerId,
        email: user!.email,
        successUrl: `${deps.config.AIX_WEB_URL}/apps/${a.slug}?subscribed=1`,
        cancelUrl: `${deps.config.AIX_WEB_URL}/apps/${a.slug}`,
      });
      return { checkoutUrl: s.url, checkoutSessionId: s.id };
    },
  );
}

export async function marketplaceRoutes(app: App, deps: Deps) {
  const { buildMarketplace } = await import("../services/marketplace.js");
  /** The Claude Code marketplace manifest (the file export is what `/plugin marketplace add` reads). */
  app.get("/marketplace/claude-code.json", { schema: { tags: ["store"] } }, async () => (await buildMarketplace(deps)).marketplace);
}
