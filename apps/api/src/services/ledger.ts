import { and, eq, inArray, sql } from "drizzle-orm";
import { ledgerAccounts, ledgerEntries, ledgerTransactions, type DbOrTx } from "@aix/db";
import { newId, NORMAL_BALANCE, validateTransaction, type AccountKind, type TransactionDraft } from "@aix/core";

export const PLATFORM = {
  revenue: "acct_platform_revenue_eur",
  clearing: "acct_stripe_clearing_eur",
  refunds: "acct_refunds_payable_eur",
} as const;

export interface WalletAccounts { available: string; held: string }

/** Idempotently create a wallet's two ledger accounts. */
export async function ensureWalletAccounts(db: DbOrTx, walletId: string, currency = "EUR"): Promise<WalletAccounts> {
  await db
    .insert(ledgerAccounts)
    .values([
      { id: `acct_${walletId}_available`, kind: "wallet_available", walletId, currency },
      { id: `acct_${walletId}_held`, kind: "wallet_held", walletId, currency },
    ])
    .onConflictDoNothing();
  return { available: `acct_${walletId}_available`, held: `acct_${walletId}_held` };
}

export function walletAccountIds(walletId: string): WalletAccounts {
  return { available: `acct_${walletId}_available`, held: `acct_${walletId}_held` };
}

export async function ensureDeveloperAccount(db: DbOrTx, developerId: string, currency = "EUR"): Promise<string> {
  const id = `acct_${developerId}_payable`;
  await db.insert(ledgerAccounts).values({ id, kind: "developer_payable", developerId, currency }).onConflictDoNothing();
  return id;
}

/**
 * Persist a validated transaction. MUST be called inside a db transaction together with whatever
 * business row it accompanies (charge status change, etc.). The DB re-checks balance at commit.
 */
export async function postTransaction(
  tx: DbOrTx,
  draft: TransactionDraft<string>,
  meta: { chargeId?: string | null; externalRef?: string | null; description?: string | null } = {},
): Promise<string> {
  validateTransaction(draft);
  const id = newId("ltx");
  await tx.insert(ledgerTransactions).values({
    id,
    kind: draft.kind,
    currency: draft.currency,
    chargeId: meta.chargeId ?? null,
    externalRef: meta.externalRef ?? null,
    description: meta.description ?? null,
  });
  await tx.insert(ledgerEntries).values(
    draft.entries.map((e) => ({ id: newId("len"), transactionId: id, accountId: e.account, direction: e.direction, amountCents: e.amountCents })),
  );
  return id;
}

/** Derived balances for a set of accounts (never stored). */
export async function balances(db: DbOrTx, accountIds: string[]): Promise<Record<string, number>> {
  if (accountIds.length === 0) return {};
  const accounts = await db.select({ id: ledgerAccounts.id, kind: ledgerAccounts.kind }).from(ledgerAccounts).where(inArray(ledgerAccounts.id, accountIds));
  const sums = await db
    .select({
      accountId: ledgerEntries.accountId,
      debit: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.direction} = 'debit'), 0)`,
      credit: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.direction} = 'credit'), 0)`,
    })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.accountId, accountIds))
    .groupBy(ledgerEntries.accountId);
  const out: Record<string, number> = {};
  for (const a of accounts) {
    const s = sums.find((x) => x.accountId === a.id);
    const debit = Number(s?.debit ?? 0);
    const credit = Number(s?.credit ?? 0);
    out[a.id] = NORMAL_BALANCE[a.kind as AccountKind] === "debit" ? debit - credit : credit - debit;
  }
  return out;
}

export async function balance(db: DbOrTx, accountId: string): Promise<number> {
  return (await balances(db, [accountId]))[accountId] ?? 0;
}

/**
 * Serialize money movements on a wallet: row-lock its available account for the rest of the
 * db transaction, so concurrent holds can't both spend the same balance.
 */
export async function lockAccount(tx: DbOrTx, accountId: string) {
  await tx.execute(sql`select id from ledger_accounts where id = ${accountId} for update`);
}

/** Global invariant check used by tests and the admin health endpoint. */
export async function trialBalance(db: DbOrTx) {
  const [row] = await db
    .select({
      debit: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.direction} = 'debit'), 0)`,
      credit: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.direction} = 'credit'), 0)`,
    })
    .from(ledgerEntries);
  return { debitCents: Number(row?.debit ?? 0), creditCents: Number(row?.credit ?? 0) };
}

export async function accountExists(db: DbOrTx, id: string) {
  const r = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(eq(ledgerAccounts.id, id)));
  return r.length > 0;
}
