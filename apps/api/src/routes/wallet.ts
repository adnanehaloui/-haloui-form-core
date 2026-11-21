import { z } from "zod";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { apps, auditLog, charges, ledgerEntries, ledgerTransactions, spendLimits, topups, users } from "@aix/db";
import { formatMoney, newId, type Currency } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireOrgRole, requireSessionUser, requireUser, type UserAuth } from "../lib/auth.js";
import { ApiError, badRequest } from "../lib/errors.js";
import { PaymentsUnavailableError } from "../lib/payments.js";
import { walletAccountIds } from "../services/ledger.js";
import { getOrCreateOrgWallet, getOrCreateUserWallet, walletBalance } from "../services/wallets.js";
import { audit } from "../services/audit.js";
import { publicCharge } from "../services/charges.js";

const walletQuery = z.object({ orgId: z.string().optional() });

/** Personal wallet, or an org wallet the caller may see (tenant check). */
export async function resolveWallet(deps: Deps, u: UserAuth, orgId: string | undefined, financial: boolean) {
  if (!orgId) return getOrCreateUserWallet(deps.db, u.userId);
  await requireOrgRole(deps, u.userId, orgId, financial ? ["owner", "admin", "billing"] : ["owner", "admin", "billing", "member"]);
  return getOrCreateOrgWallet(deps.db, orgId);
}

export async function walletTransactions(deps: Deps, walletId: string, limit: number, before?: Date) {
  const acct = walletAccountIds(walletId);
  const rows = await deps.db
    .select({
      txId: ledgerTransactions.id,
      kind: ledgerTransactions.kind,
      description: ledgerTransactions.description,
      createdAt: ledgerTransactions.createdAt,
      currency: ledgerTransactions.currency,
      accountId: ledgerEntries.accountId,
      direction: ledgerEntries.direction,
      amountCents: ledgerEntries.amountCents,
      chargeId: ledgerTransactions.chargeId,
      appName: apps.name,
      appSlug: apps.slug,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .leftJoin(charges, eq(charges.id, ledgerTransactions.chargeId))
    .leftJoin(apps, eq(apps.id, charges.appId))
    .where(and(inArray(ledgerEntries.accountId, [acct.available, acct.held]), before ? lt(ledgerTransactions.createdAt, before) : undefined))
    .orderBy(desc(ledgerTransactions.createdAt), desc(ledgerTransactions.id))
    .limit(limit * 2);
  const byTx = new Map<string, any>();
  for (const r of rows) {
    const t = byTx.get(r.txId) ?? {
      id: r.txId,
      kind: r.kind,
      description: r.description,
      createdAt: r.createdAt,
      currency: r.currency,
      chargeId: r.chargeId,
      app: r.appName ? { name: r.appName, slug: r.appSlug } : null,
      availableDeltaCents: 0,
      heldDeltaCents: 0,
    };
    const signed = r.direction === "credit" ? r.amountCents : -r.amountCents; // wallet accounts are credit-normal
    if (r.accountId === acct.available) t.availableDeltaCents += signed;
    else t.heldDeltaCents += signed;
    byTx.set(r.txId, t);
  }
  return [...byTx.values()].slice(0, limit).map((t) => ({
    ...t,
    netDeltaCents: t.availableDeltaCents + t.heldDeltaCents,
    display: formatMoney(t.availableDeltaCents + t.heldDeltaCents === 0 ? t.availableDeltaCents : t.availableDeltaCents + t.heldDeltaCents, t.currency as Currency),
  }));
}

export async function walletRoutes(app: App, deps: Deps) {
  app.get("/wallet", { schema: { tags: ["wallet"], querystring: walletQuery } }, async (req) => {
    const u = await requireUser(deps, req);
    const w = await resolveWallet(deps, u, req.query.orgId, false);
    const b = await walletBalance(deps.db, w.id);
    return { id: w.id, currency: w.currency, ownerOrgId: w.ownerOrgId, ...b, display: { available: formatMoney(b.availableCents), held: formatMoney(b.heldCents) } };
  });

  app.get(
    "/wallet/transactions",
    { schema: { tags: ["wallet"], querystring: walletQuery.extend({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.date().optional() }) } },
    async (req) => {
      const u = await requireUser(deps, req);
      const w = await resolveWallet(deps, u, req.query.orgId, true);
      return { data: await walletTransactions(deps, w.id, req.query.limit, req.query.before) };
    },
  );

  app.get("/wallet/charges", { schema: { tags: ["wallet"], querystring: walletQuery.extend({ limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req) => {
    const u = await requireUser(deps, req);
    const w = await resolveWallet(deps, u, req.query.orgId, true);
    const rows = await deps.db
      .select({ charge: charges, appName: apps.name, userEmail: users.email })
      .from(charges)
      .innerJoin(apps, eq(apps.id, charges.appId))
      .innerJoin(users, eq(users.id, charges.userId))
      .where(eq(charges.walletId, w.id))
      .orderBy(desc(charges.createdAt))
      .limit(req.query.limit);
    return { data: rows.map((r) => ({ ...publicCharge(r.charge, r.appName), userEmail: r.userEmail })) };
  });

  app.post(
    "/wallet/topup",
    { schema: { tags: ["wallet"], body: z.object({ amountCents: z.number().int().positive().max(100_000_00), orgId: z.string().optional() }) } },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      if (req.body.amountCents < deps.config.AIX_MIN_TOPUP_CENTS) throw badRequest(`minimum top-up is ${formatMoney(deps.config.AIX_MIN_TOPUP_CENTS)}`);
      if (!deps.payments) throw new PaymentsUnavailableError();
      const w = await resolveWallet(deps, u, req.body.orgId, true);
      const [user] = await deps.db.select().from(users).where(eq(users.id, u.userId));
      // Velocity limits (card-testing / stolen-card protection).
      const dayAgo = new Date(deps.now().getTime() - 86400_000);
      const hourAgo = new Date(deps.now().getTime() - 3600_000);
      const [paid] = await deps.db.select({ s: sql<string>`coalesce(sum(${topups.amountCents}),0)` }).from(topups).where(and(eq(topups.walletId, w.id), gt(topups.createdAt, dayAgo)));
      const [attempts] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(eq(auditLog.action, "wallet.topup_started"), eq(auditLog.targetId, w.id), gt(auditLog.createdAt, hourAgo)));
      const newAccount = !req.body.orgId && user!.createdAt > dayAgo;
      const dailyCap = newAccount ? deps.config.AIX_NEW_ACCOUNT_TOPUP_DAILY_CENTS : deps.config.AIX_MAX_TOPUP_DAILY_CENTS;
      if ((attempts?.n ?? 0) >= deps.config.AIX_MAX_TOPUP_ATTEMPTS_PER_HOUR) throw new ApiError(429, "rate_limited", "too many top-up attempts — try again in an hour");
      if (Number(paid?.s ?? 0) + req.body.amountCents > dailyCap) throw badRequest(`daily top-up limit is ${formatMoney(dailyCap)}${newAccount ? " for new accounts" : ""}`);
      const back = req.body.orgId ? `/orgs/${req.body.orgId}` : "/wallet";
      const session = await deps.payments.createTopUpCheckout({
        walletId: w.id,
        amountCents: req.body.amountCents,
        currency: w.currency,
        customerId: user!.stripeCustomerId,
        email: user!.email,
        successUrl: `${deps.config.AIX_WEB_URL}${back}?topup=success`,
        cancelUrl: `${deps.config.AIX_WEB_URL}${back}?topup=cancelled`,
      });
      await audit(deps.db, { actorUserId: u.userId, actorType: "user", orgId: req.body.orgId ?? null, action: "wallet.topup_started", targetType: "wallet", targetId: w.id, metadata: { amountCents: req.body.amountCents, checkoutSessionId: session.id } });
      return { checkoutUrl: session.url, checkoutSessionId: session.id };
    },
  );

  // ---- Personal spend limits ----
  app.get("/wallet/limits", { schema: { tags: ["wallet"] } }, async (req) => {
    const u = await requireUser(deps, req);
    const rows = await deps.db
      .select({ limit: spendLimits, appName: apps.name })
      .from(spendLimits)
      .leftJoin(apps, eq(apps.id, spendLimits.appId))
      .where(and(eq(spendLimits.userId, u.userId), inArray(spendLimits.scope, ["user", "app"])));
    return { data: rows.map((r) => ({ ...r.limit, appName: r.appName })) };
  });

  app.put(
    "/wallet/limits",
    {
      schema: {
        tags: ["wallet"],
        body: z.object({
          period: z.enum(["daily", "monthly"]),
          appId: z.string().optional(),
          capCents: z.number().int().nonnegative().nullable(),
          autoApproveThresholdCents: z.number().int().nonnegative().nullable(),
        }),
      },
    },
    async (req) => {
      const u = await requireSessionUser(deps, req);
      const scope = req.body.appId ? ("app" as const) : ("user" as const);
      const where = and(eq(spendLimits.userId, u.userId), eq(spendLimits.scope, scope), eq(spendLimits.period, req.body.period), req.body.appId ? eq(spendLimits.appId, req.body.appId) : isNull(spendLimits.appId));
      const [existing] = await deps.db.select().from(spendLimits).where(where);
      const values = { capCents: req.body.capCents, autoApproveThresholdCents: req.body.autoApproveThresholdCents };
      if (existing) await deps.db.update(spendLimits).set(values).where(eq(spendLimits.id, existing.id));
      else await deps.db.insert(spendLimits).values({ id: newId("lim"), scope, userId: u.userId, appId: req.body.appId ?? null, period: req.body.period, ...values });
      await audit(deps.db, { actorUserId: u.userId, actorType: "user", action: "limits.updated", metadata: { scope, ...req.body } });
      return { ok: true };
    },
  );
}
