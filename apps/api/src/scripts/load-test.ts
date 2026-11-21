/**
 * Load test: concurrent hold→capture pairs through the public developer API against a running server,
 * then verify the books: ledger balanced, and the wallet moved by exactly the captured total.
 *   pnpm seed && pnpm --filter @aix/api start   (in another terminal)
 *   pnpm --filter @aix/api load-test -- --requests 1000 --concurrency 25
 */
import { and, eq } from "drizzle-orm";
import { apps, installs, prices, spendLimits } from "@aix/db";
import { newId, postSeedCredit } from "@aix/core";
import { buildDeps } from "../app.js";
import { loadConfig } from "../config.js";
import { PLATFORM, postTransaction, trialBalance, walletAccountIds } from "../services/ledger.js";
import { findOrCreateUserByEmail } from "../services/users.js";
import { getOrCreateUserWallet, walletBalance } from "../services/wallets.js";

const arg = (k: string, d: number) => Number(process.argv[process.argv.indexOf(`--${k}`) + 1] || d) || d;
const REQUESTS = arg("requests", 500);
const CONCURRENCY = arg("concurrency", 20);
const api = process.env.AIX_API_URL ?? "http://localhost:4000";
const key = process.env.AIX_SECRET_KEY;
if (!key) throw new Error("set AIX_SECRET_KEY (run pnpm seed — it's in .env.seed)");

const deps = buildDeps(loadConfig());
const { user } = await findOrCreateUserByEmail(deps.db, `load-${Date.now()}@aix.local`);
const [render] = await deps.db.select({ app: apps, price: prices }).from(prices).innerJoin(apps, eq(apps.id, prices.appId)).where(and(eq(apps.slug, "render-studio"), eq(prices.lookupKey, "render")));
if (!render) throw new Error("run pnpm seed first (needs the Render Studio app)");
await deps.db.insert(installs).values({ id: newId("ins"), userId: user.id, appId: render.app.id, appVersionId: render.app.currentVersionId!, grantedPermissions: {} });
await deps.db.update(spendLimits).set({ capCents: null, autoApproveThresholdCents: 1_000_000 }).where(eq(spendLimits.userId, user.id));
const w = await getOrCreateUserWallet(deps.db, user.id);
const CREDIT = REQUESTS * render.price.unitAmountCents + 10_000;
await deps.db.transaction((tx) => postTransaction(tx, postSeedCredit({ clearing: PLATFORM.clearing, walletAvailable: walletAccountIds(w.id).available }, CREDIT), { description: "load test" }));

const lat: number[] = [];
let ok = 0;
let failed = 0;
let next = 0;
const call = async (path: string, body?: unknown) => {
  const r = await fetch(api + path, { method: "POST", headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json()) as any };
};
const started = Date.now();
const run = Date.now().toString(36);
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < REQUESTS) {
      const i = next++;
      const t0 = performance.now();
      const h = await call("/v1/holds", { userId: user.id, priceId: "render", idempotencyKey: `load-${run}-${i}` });
      const c = h.status === 200 ? await call(`/v1/holds/${h.json.id}/capture`) : h;
      lat.push(performance.now() - t0);
      if (c.status === 200 && c.json.status === "captured") ok++;
      else failed++;
    }
  }),
);
const secs = (Date.now() - started) / 1000;
lat.sort((a, b) => a - b);
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]!.toFixed(1);
const after = await walletBalance(deps.db, w.id);
const spent = CREDIT - after.availableCents - after.heldCents;
const tb = await trialBalance(deps.db);
const freeUnits = Math.min(render.price.includedUnits, ok);
const expectedSpent = (ok - freeUnits) * render.price.unitAmountCents;
console.log(`hold+capture pairs: ${ok} ok, ${failed} failed in ${secs.toFixed(1)}s → ${(ok / secs).toFixed(0)} charges/s (${CONCURRENCY} concurrent)`);
console.log(`latency per pair: p50 ${pct(50)} ms · p95 ${pct(95)} ms · p99 ${pct(99)} ms`);
console.log(`wallet: spent ${spent} cents, expected ${expectedSpent} → ${spent === expectedSpent ? "EXACT" : "MISMATCH"}; still held ${after.heldCents}`);
console.log(`ledger: ${tb.debitCents === tb.creditCents ? "balanced" : "UNBALANCED"}`);
await deps.close();
process.exit(failed === 0 && spent === expectedSpent && after.heldCents === 0 && tb.debitCents === tb.creditCents ? 0 : 1);
