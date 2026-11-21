/**
 * Demo data through the real API code paths (idempotent — safe to re-run):
 *  users: alice@aix.local (€20 test money), dev@aix.local (developer), carol@aix.local (org owner),
 *         bob@aix.local (org member), admin@aix.local (admin — add to AIX_ADMIN_EMAILS)
 *  org:   Acme Corp (carol owner, bob member, €100 org test money)
 *  apps:  Launch Copy (prompt), Render Studio (server, localhost:4200), Quick Notes (web, localhost:4300)
 * Writes the developer's secret key to ../../.env.seed (gitignored) for the sample apps and demo script.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { apiKeys, developers, ledgerTransactions, orgMembers, organizations, sessions, users } from "@aix/db";
import { newId, postSeedCredit, randomToken, sha256Hex } from "@aix/core";
import { initApp, packApp } from "@aix/cli";
import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname } from "node:path";
import { DEMO_APPS, demoFiles } from "./demo-catalog.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@aix/db";
import { buildApp, buildDeps } from "../app.js";
import { loadConfig } from "../config.js";
import { generateApiKey } from "../lib/auth.js";
import { findOrCreateUserByEmail } from "../services/users.js";
import { getOrCreateOrgWallet, getOrCreateUserWallet } from "../services/wallets.js";
import { PLATFORM, postTransaction, walletAccountIds } from "../services/ledger.js";

const config = loadConfig({ ...process.env, AIX_ADMIN_EMAILS: [process.env.AIX_ADMIN_EMAILS, "admin@aix.local"].filter(Boolean).join(",") });
if (config.NODE_ENV === "production") throw new Error("refusing to seed production");
const deps = buildDeps(config);
await runMigrations(deps.db);
const app = await buildApp(deps);

async function sessionCookie(userId: string) {
  const token = randomToken();
  await deps.db.insert(sessions).values({ id: sha256Hex(token), userId, expiresAt: new Date(Date.now() + 3600_000) });
  return `aix_session=${token}`;
}
async function credit(walletId: string, cents: number, ref: string) {
  const [done] = await deps.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.externalRef, ref));
  if (done) return;
  await deps.db.transaction((tx) => postTransaction(tx, { ...postSeedCredit({ clearing: PLATFORM.clearing, walletAvailable: walletAccountIds(walletId).available }, cents) }, { externalRef: ref, description: "Test money (seed)" }));
}
const user = async (email: string, name: string) => (await findOrCreateUserByEmail(deps.db, email, name)).user;

const alice = await user("alice@aix.local", "Alice");
const dev = await user("dev@aix.local", "Dana Developer");
const carol = await user("carol@aix.local", "Carol");
const bob = await user("bob@aix.local", "Bob");
const admin = await user("admin@aix.local", "Admin");
await credit((await getOrCreateUserWallet(deps.db, alice.id)).id, 2000, "seed:alice");

// Org
let [org] = await deps.db.select().from(organizations).where(eq(organizations.slug, "acme"));
if (!org) {
  [org] = await deps.db.insert(organizations).values({ id: newId("org"), name: "Acme Corp", slug: "acme" }).returning();
  await deps.db.insert(orgMembers).values([{ orgId: org!.id, userId: carol.id, role: "owner" }, { orgId: org!.id, userId: bob.id, role: "member" }]);
}
await credit((await getOrCreateOrgWallet(deps.db, org!.id)).id, 10_000, "seed:acme");

// Developer + secret key (fresh key each run; old seed keys revoked)
let [d] = await deps.db.select().from(developers).where(eq(developers.userId, dev.id));
if (!d) [d] = await deps.db.insert(developers).values({ id: newId("dev"), userId: dev.id, displayName: "Acme Labs" }).returning();
await deps.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.developerId, d!.id));
const key = generateApiKey();
await deps.db.insert(apiKeys).values({ id: newId("key"), developerId: d!.id, name: "seed", prefix: key.prefix, hash: key.hash, scopes: ["auth:verify", "charges:write", "apps:write", "keys:write"] });
const auth = { authorization: `Bearer ${key.secret}` };
const adminCookie = await sessionCookie(admin.id);

const SAMPLES = [
  { template: "prompt" as const, name: "Launch Copy", id: "com.acme.launchcopy", prices: [{ kind: "free", unit: "use", unitAmountCents: 0 }] },
  { template: "server" as const, name: "Render Studio", id: "com.acme.renderstudio", prices: [{ kind: "metered", unit: "render", unitAmountCents: 50, lookupKey: "render", includedUnits: 3 }] },
  { template: "web" as const, name: "Quick Notes", id: "com.acme.quicknotes", prices: [{ kind: "metered", unit: "summary", unitAmountCents: 20, lookupKey: "summary" }] },
];
const slugs: Record<string, string> = {};
for (const s of SAMPLES) {
  const dir = join(await mkdtemp(join(tmpdir(), "aix-seed-")), s.template);
  await initApp(dir, s.template, { name: s.name, id: s.id });
  // initApp resets to 0.1.0; keep it so re-runs hit "already exists".
  const { pkg } = await packApp(dir);
  const pub = await app.inject({ method: "POST", url: "/developer/publish", headers: auth, payload: { packageBase64: pkg.toString("base64") } });
  if (pub.statusCode === 200) {
    slugs[s.id] = pub.json().slug;
    for (const p of s.prices) await app.inject({ method: "POST", url: `/developer/apps/${pub.json().slug}/prices`, headers: auth, payload: p });
    await app.inject({ method: "POST", url: `/admin/versions/${pub.json().versionId}/approve`, headers: { cookie: adminCookie }, payload: { notes: "seed" } });
  } else {
    const list = (await app.inject({ method: "GET", url: "/developer", headers: auth })).json();
    slugs[s.id] = list.apps.find((a: any) => a.manifestId === s.id)?.slug;
  }
}

// Demo catalog: more apps with icons, showcase results, installs and reviews.
for (const d of DEMO_APPS) {
  const dir = await mkdtemp(join(tmpdir(), "aix-demo-"));
  for (const [p, c] of Object.entries(demoFiles(d))) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  const { pkg } = await packApp(dir);
  const pub = await app.inject({ method: "POST", url: "/developer/publish", headers: auth, payload: { packageBase64: pkg.toString("base64") } });
  if (pub.statusCode === 200) {
    slugs[d.id] = pub.json().slug;
    const price = d.price?.kind === "subscription" ? { kind: "subscription", unit: "month", unitAmountCents: d.price.unitAmountCents, interval: "month", lookupKey: "pro" } : { kind: "free", unit: "use", unitAmountCents: 0 };
    await app.inject({ method: "POST", url: `/developer/apps/${pub.json().slug}/prices`, headers: auth, payload: price });
    await app.inject({ method: "POST", url: `/admin/versions/${pub.json().versionId}/approve`, headers: { cookie: adminCookie }, payload: { notes: "seed" } });
  } else {
    const list = (await app.inject({ method: "GET", url: "/developer", headers: auth })).json();
    slugs[d.id] = list.apps.find((a: any) => a.manifestId === d.id)?.slug;
  }
}

// Demo users install apps and leave reviews (real installs/reviews → real counts and ratings).
const SAMPLE_SOCIAL: Record<string, { installs: number; reviews: [number, string][] }> = {
  "com.acme.renderstudio": { installs: 16, reviews: [[5, "Storyboards in seconds. The approval prompt makes paid runs feel safe."], [5, "Used it straight from Claude — no new account."], [4, "Love the preview panel."]] },
  "com.acme.launchcopy": { installs: 12, reviews: [[5, "My changelogs finally read like a human wrote them."], [4, "Great for launch tweets."]] },
  "com.acme.quicknotes": { installs: 4, reviews: [[4, "Summaries are crisp. €0.20 is fair."]] },
};
const social = [...DEMO_APPS.map((d) => ({ id: d.id, installs: d.installs, reviews: d.reviews })), ...Object.entries(SAMPLE_SOCIAL).map(([id, v]) => ({ id, ...v }))];
const NAMES = ["Maya", "Jonas", "Priya", "Luca", "Sofia", "Kenji", "Amara", "Tom", "Elena", "Omar", "Ines", "Felix", "Hana", "Diego", "Nora", "Sam", "Lea", "Ravi"];
const fans = [];
for (const [i, n] of NAMES.entries()) fans.push({ user: await user(`fan${i + 1}@aix.local`, n), i });
for (const a of social) {
  const slug = slugs[a.id];
  if (!slug) continue;
  for (const { user: u, i } of fans.slice(0, a.installs)) {
    const cookie = await sessionCookie(u.id);
    await app.inject({ method: "POST", url: `/store/apps/${slug}/install`, headers: { cookie }, payload: { acceptPermissions: true } });
    const r = a.reviews[i];
    if (r) await app.inject({ method: "POST", url: `/store/apps/${slug}/reviews`, headers: { cookie }, payload: { rating: r[0], body: r[1] } });
  }
}

// Alice installs Render Studio so the demo charge script works.
const aliceCookie = await sessionCookie(alice.id);
await app.inject({ method: "POST", url: `/store/apps/${slugs["com.acme.renderstudio"]}/install`, headers: { cookie: aliceCookie }, payload: { acceptPermissions: true } });

const envFile = resolve(process.cwd(), "../../.env.seed");
await writeFile(envFile, `# Generated by pnpm seed — test-mode developer key for the sample apps. Do not commit.\nAIX_SECRET_KEY=${key.secret}\nAIX_DEMO_USER_ID=${alice.id}\n`, { mode: 0o600 });
console.log(`✔ Seeded. Users: alice@ (€20), dev@, carol@ (Acme owner), bob@ (Acme member), admin@ — all @aix.local, sign in by magic link.`);
console.log(`✔ Apps: ${Object.values(slugs).join(", ")}. Developer secret key written to .env.seed`);
await app.close();
await deps.close();
