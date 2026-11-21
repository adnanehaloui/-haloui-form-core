/**
 * Monthly developer payouts via Stripe Connect.
 * Amount = current developer_payable balance (captures + subscription revenue − refunds − previous payouts),
 * so refunds after a payout are netted next month. Idempotent per (developer, period).
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { apps, charges, developers, ledgerEntries, ledgerTransactions, payouts } from "@aix/db";
import { formatMoney, newId, postPayout } from "@aix/core";
import type { Deps } from "../context.js";
import { audit } from "./audit.js";
import { emailPayout } from "./emails.js";
import { users } from "@aix/db";
import { balance, ensureDeveloperAccount, PLATFORM, postTransaction } from "./ledger.js";

export function periodBounds(period: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error("period must be YYYY-MM");
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return { start, end };
}

export function previousPeriod(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Per-app statement for the period (for humans; the payout amount comes from the ledger balance). */
export async function developerStatement(deps: Deps, developerId: string, period: string) {
  const { start, end } = periodBounds(period);
  const devApps = await deps.db.select().from(apps).where(eq(apps.developerId, developerId));
  const lines = [];
  for (const a of devApps) {
    const [cap] = await deps.db
      .select({ n: sql<number>`count(*)::int`, gross: sql<string>`coalesce(sum(${charges.amountCents}),0)`, dev: sql<string>`coalesce(sum(${charges.developerCents}),0)`, plat: sql<string>`coalesce(sum(${charges.platformCents}),0)` })
      .from(charges)
      .where(and(eq(charges.appId, a.id), inArray(charges.status, ["captured", "refunded"]), gte(charges.capturedAt, start), lt(charges.capturedAt, end)));
    const [ref] = await deps.db
      .select({ n: sql<number>`count(*)::int`, dev: sql<string>`coalesce(sum(${charges.developerCents}),0)` })
      .from(charges)
      .where(and(eq(charges.appId, a.id), eq(charges.status, "refunded"), gte(charges.refundedAt, start), lt(charges.refundedAt, end)));
    lines.push({
      appId: a.id,
      appName: a.name,
      commissionBps: a.commissionBps,
      charges: cap?.n ?? 0,
      grossCents: Number(cap?.gross ?? 0),
      developerCents: Number(cap?.dev ?? 0),
      platformCents: Number(cap?.plat ?? 0),
      refunds: ref?.n ?? 0,
      refundedDeveloperCents: Number(ref?.dev ?? 0),
    });
  }
  const payable = await ensureDeveloperAccount(deps.db, developerId);
  const [subs] = await deps.db
    .select({ s: sql<string>`coalesce(sum(${ledgerEntries.amountCents}),0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(and(eq(ledgerEntries.accountId, payable), eq(ledgerTransactions.kind, "subscription_payment"), gte(ledgerTransactions.createdAt, start), lt(ledgerTransactions.createdAt, end)));
  return { period, apps: lines, subscriptionDeveloperCents: Number(subs?.s ?? 0) };
}

export interface PayoutResult { developerId: string; status: "paid" | "skipped" | "failed" | "already_paid"; amountCents: number; reason?: string; transferId?: string }

export async function runPayouts(deps: Deps, period = previousPeriod(deps.now())): Promise<PayoutResult[]> {
  const results: PayoutResult[] = [];
  const devs = await deps.db.select().from(developers);
  for (const d of devs) {
    const [existing] = await deps.db.select().from(payouts).where(and(eq(payouts.developerId, d.id), eq(payouts.period, period)));
    if (existing?.status === "paid") {
      results.push({ developerId: d.id, status: "already_paid", amountCents: existing.amountCents });
      continue;
    }
    const payable = await ensureDeveloperAccount(deps.db, d.id);
    const amountCents = await balance(deps.db, payable);
    const statement = await developerStatement(deps, d.id, period);
    const skip = async (reason: string) => {
      await deps.db
        .insert(payouts)
        .values({ id: newId("po"), developerId: d.id, period, amountCents: Math.max(0, amountCents), status: "skipped", statement: { ...statement, reason } })
        .onConflictDoUpdate({ target: [payouts.developerId, payouts.period], set: { status: "skipped", amountCents: Math.max(0, amountCents), statement: { ...statement, reason } } });
      results.push({ developerId: d.id, status: "skipped", amountCents, reason });
    };
    if (amountCents < Math.max(1, deps.config.AIX_MIN_PAYOUT_CENTS)) {
      await skip(`balance ${formatMoney(amountCents)} below minimum payout`);
      continue;
    }
    if (!deps.payments) {
      await skip("Stripe not configured");
      continue;
    }
    if (!d.stripeConnectAccountId || (await deps.payments.getConnectAccountStatus(d.stripeConnectAccountId)) !== "enabled") {
      await skip("Stripe Connect onboarding not complete");
      continue;
    }
    const id = existing?.id ?? newId("po");
    await deps.db
      .insert(payouts)
      .values({ id, developerId: d.id, period, amountCents, status: "pending", statement })
      .onConflictDoUpdate({ target: [payouts.developerId, payouts.period], set: { status: "pending", amountCents, statement } });
    try {
      const transferId = await deps.payments.createTransfer({
        accountId: d.stripeConnectAccountId,
        amountCents,
        currency: "EUR",
        idempotencyKey: `payout:${d.id}:${period}`,
        description: `AIX payout ${period}`,
      });
      await deps.db.transaction(async (tx) => {
        await postTransaction(tx, postPayout({ developerPayable: payable, clearing: PLATFORM.clearing }, amountCents), { externalRef: transferId, description: `Payout ${period}` });
        await tx.update(payouts).set({ status: "paid", stripeTransferId: transferId }).where(eq(payouts.id, id));
        await audit(tx, { actorType: "system", action: "payout.paid", targetType: "developer", targetId: d.id, metadata: { period, amountCents, transferId } });
      });
      results.push({ developerId: d.id, status: "paid", amountCents, transferId });
      const [u] = d.userId ? await deps.db.select().from(users).where(eq(users.id, d.userId)) : [];
      if (u) await emailPayout(deps, u.email, period, amountCents, "paid");
    } catch (e: any) {
      await deps.db.update(payouts).set({ status: "failed", statement: { ...statement, error: String(e.message).slice(0, 300) } }).where(eq(payouts.id, id));
      results.push({ developerId: d.id, status: "failed", amountCents, reason: e.message });
    }
  }
  return results;
}
