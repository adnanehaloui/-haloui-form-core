import { createDb, resetDatabase, apps, appVersions, developers, installs, prices, apiKeys } from "@aix/db";
import { newId } from "@aix/core";
import { packFiles, sha256, signingPayload } from "@aix/manifest";
import { eq } from "drizzle-orm";
import { buildApp, buildDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FakePayments } from "../src/lib/payments.js";
import { memoryMailer } from "../src/lib/mailer.js";
import { memoryStorage } from "../src/lib/storage.js";
import { generateApiKey } from "../src/lib/auth.js";
import { getOrCreateUserWallet } from "../src/services/wallets.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://aix:aix@localhost:5432/aix_test";

export async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: TEST_DB, AIX_MAILER: "memory", AIX_DEV_ENDPOINTS: "1", AIX_ADMIN_EMAILS: "admin@aix.test", AIX_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), ...env });
  const { db, close } = createDb(TEST_DB, { max: 20 });
  await resetDatabase(db);
  const payments = new FakePayments();
  const deps = buildDeps(config, { db, payments, mailer: memoryMailer(), storage: memoryStorage() });
  const app = await buildApp(deps);
  return {
    app,
    deps,
    payments,
    db,
    close: async () => {
      await app.close();
      await close();
    },
  };
}
export type Ctx = Awaited<ReturnType<typeof setup>>;

/** Sign in through the real magic-link flow; returns a cookie header. */
export async function signIn(ctx: Ctx, email: string): Promise<string> {
  await ctx.app.inject({ method: "POST", url: "/auth/magic-link", payload: { email } });
  const mail = ctx.deps.mailer.outbox!.filter((m) => m.to === email).at(-1)!;
  const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get("token")!;
  const res = await ctx.app.inject({ method: "GET", url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}` });
  const set = res.headers["set-cookie"];
  const c = (Array.isArray(set) ? set : [set]).find((x) => x?.startsWith("aix_session="))!;
  return c.split(";")[0]!;
}

export async function me(ctx: Ctx, cookie: string) {
  return (await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie } })).json();
}

/** Topup through the real webhook handler (fake-signed). */
export async function topUp(ctx: Ctx, cookie: string, amountCents: number, orgId?: string) {
  const r = await ctx.app.inject({ method: "POST", url: "/wallet/topup", headers: { cookie }, payload: { amountCents, ...(orgId ? { orgId } : {}) } });
  const { checkoutSessionId } = r.json();
  const c = ctx.payments.checkouts.find((x) => x.id === checkoutSessionId)!;
  const event = {
    id: `evt_${checkoutSessionId}`,
    type: "checkout.session.completed",
    data: { object: { id: checkoutSessionId, payment_status: "paid", amount_total: amountCents, currency: "eur", metadata: { aix_kind: "topup", aix_wallet_id: c.input.walletId } } },
  };
  return ctx.app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "stripe-signature": "fake-valid", "content-type": "application/json" }, payload: JSON.stringify(event) });
}

/** Direct DB fixture: a developer with a published app, a metered price and a secret key. */
export async function fixtureApp(ctx: Ctx, o: { userId?: string; unitAmountCents?: number; includedUnits?: number; commissionBps?: number; slug?: string } = {}) {
  const developerId = newId("dev");
  const slug = o.slug ?? `app-${Math.random().toString(36).slice(2, 8)}`;
  await ctx.db.insert(developers).values({ id: developerId, userId: o.userId ?? null, displayName: "Acme" });
  const appId = newId("app");
  await ctx.db.insert(apps).values({ id: appId, slug, manifestId: `com.acme.${slug.replace(/-/g, "")}`, name: "VideoStudio", developerId, type: "server", status: "published", commissionBps: o.commissionBps ?? 2000 });
  const versionId = newId("ver");
  const manifest = { id: `com.acme.${slug.replace(/-/g, "")}`, name: "VideoStudio", version: "1.0.0", type: "server", description: "Fixture app for tests.", category: "video", entry: { mcp: "https://api.acme.test/mcp" }, compatibility: { hosts: ["claude"] }, permissions: { network: ["https://api.acme.test"], files: [], userData: ["email"] }, pricing: [] };
  const pkg = packFiles([{ path: "aix.json", content: Buffer.from(JSON.stringify(manifest)) }]);
  const hash = sha256(pkg);
  await ctx.deps.storage.put(`packages/${appId}.aixpkg`, pkg);
  await ctx.db.insert(appVersions).values({ id: versionId, appId, version: "1.0.0", manifest, packagePath: `packages/${appId}.aixpkg`, packageSha256: hash, packageSize: pkg.length, status: "approved", signature: ctx.deps.signer.signBytes(signingPayload(appId, "1.0.0", hash)) });
  await ctx.db.update(apps).set({ currentVersionId: versionId }).where(eq(apps.id, appId));
  const priceId = newId("price");
  await ctx.db.insert(prices).values({ id: priceId, appId, lookupKey: "render", kind: "metered", unit: "render", unitAmountCents: o.unitAmountCents ?? 50, includedUnits: o.includedUnits ?? 0 });
  const key = generateApiKey();
  await ctx.db.insert(apiKeys).values({ id: newId("key"), developerId, name: "test", prefix: key.prefix, hash: key.hash, scopes: ["auth:verify", "charges:write", "apps:write", "keys:write"] });
  return { developerId, appId, priceId, versionId, secret: key.secret, slug };
}

export async function installFixture(ctx: Ctx, userId: string, appId: string, versionId: string, orgId?: string) {
  await getOrCreateUserWallet(ctx.db, userId);
  await ctx.db.insert(installs).values({ id: newId("ins"), userId, appId, appVersionId: versionId, orgId: orgId ?? null, grantedPermissions: { userData: ["email"] } });
}

export function dev(secret: string) {
  return { authorization: `Bearer ${secret}` };
}
