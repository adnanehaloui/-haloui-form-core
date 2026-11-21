/**
 * Double-entry ledger rules. Pure functions — no I/O.
 *
 * Every money movement is a transaction made of entries. Each entry debits or credits one
 * account by a positive integer amount. A transaction is valid only if
 * Σ debits = Σ credits (per currency). Balances are always derived from entries.
 */
import { assertCents, type Currency, MoneyError } from "./money.js";
import { splitCommission } from "./commission.js";

export type Direction = "debit" | "credit";

export const ACCOUNT_KINDS = [
  "wallet_available",
  "wallet_held",
  "developer_payable",
  "platform_revenue",
  "stripe_clearing",
  "refunds_payable",
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Which side increases the account. Liabilities/revenue: credit. Assets: debit. */
export const NORMAL_BALANCE: Record<AccountKind, Direction> = {
  wallet_available: "credit",
  wallet_held: "credit",
  developer_payable: "credit",
  platform_revenue: "credit",
  stripe_clearing: "debit",
  refunds_payable: "credit",
};

export const TRANSACTION_KINDS = [
  "topup",
  "hold",
  "capture",
  "release",
  "refund",
  "subscription_payment",
  "payout",
  "card_refund",
  "seed",
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export interface Entry<A = string> {
  account: A;
  direction: Direction;
  amountCents: number;
}

export interface TransactionDraft<A = string> {
  kind: TransactionKind;
  currency: Currency;
  entries: Entry<A>[];
}

export class LedgerError extends Error {
  override name = "LedgerError";
}

/** Validates a draft: ≥2 entries, positive integer amounts, debits = credits. Returns it unchanged. */
export function validateTransaction<A>(draft: TransactionDraft<A>): TransactionDraft<A> {
  if (draft.entries.length < 2) throw new LedgerError("a transaction needs at least two entries");
  let debits = 0;
  let credits = 0;
  for (const e of draft.entries) {
    try {
      assertCents(e.amountCents, { positive: true });
    } catch (err) {
      throw new LedgerError((err as MoneyError).message);
    }
    if (e.direction === "debit") debits += e.amountCents;
    else if (e.direction === "credit") credits += e.amountCents;
    else throw new LedgerError(`invalid direction ${String(e.direction)}`);
  }
  if (debits !== credits) throw new LedgerError(`unbalanced transaction: debits ${debits} != credits ${credits}`);
  return draft;
}

/** Balance of an account from its entries, signed by the account's normal side. */
export function balanceOf(kind: AccountKind, entries: Iterable<Pick<Entry, "direction" | "amountCents">>): number {
  const normal = NORMAL_BALANCE[kind];
  let bal = 0;
  for (const e of entries) bal += e.direction === normal ? e.amountCents : -e.amountCents;
  return bal;
}

/** Drop zero-amount legs (e.g. a 0% commission) so all entries stay strictly positive. */
function tx<A>(kind: TransactionKind, currency: Currency, entries: Entry<A>[]): TransactionDraft<A> {
  return validateTransaction({ kind, currency, entries: entries.filter((e) => e.amountCents !== 0) });
}

// ---- Posting rules (one function per money flow) ---------------------------------------------

/** Flow 1 — Stripe top-up confirmed: Dr stripe_clearing / Cr wallet_available. */
export function postTopUp<A>(a: { clearing: A; walletAvailable: A }, amountCents: number, currency: Currency = "EUR") {
  return tx("topup", currency, [
    { account: a.clearing, direction: "debit", amountCents },
    { account: a.walletAvailable, direction: "credit", amountCents },
  ]);
}

/** Flow 2a — hold: move money from available to held (still the user's money). */
export function postHold<A>(a: { walletAvailable: A; walletHeld: A }, amountCents: number, currency: Currency = "EUR") {
  return tx("hold", currency, [
    { account: a.walletAvailable, direction: "debit", amountCents },
    { account: a.walletHeld, direction: "credit", amountCents },
  ]);
}

/** Flow 2b — capture: held → developer payable + platform revenue, split by commission (basis points). */
export function postCapture<A>(
  a: { walletHeld: A; developerPayable: A; platformRevenue: A },
  amountCents: number,
  commissionBps: number,
  currency: Currency = "EUR",
) {
  const { developerCents, platformCents } = splitCommission(amountCents, commissionBps);
  return tx("capture", currency, [
    { account: a.walletHeld, direction: "debit", amountCents },
    { account: a.developerPayable, direction: "credit", amountCents: developerCents },
    { account: a.platformRevenue, direction: "credit", amountCents: platformCents },
  ]);
}

/** Flow 4a — release an uncaptured hold: held → available. */
export function postRelease<A>(a: { walletHeld: A; walletAvailable: A }, amountCents: number, currency: Currency = "EUR") {
  return tx("release", currency, [
    { account: a.walletHeld, direction: "debit", amountCents },
    { account: a.walletAvailable, direction: "credit", amountCents },
  ]);
}

/** Flow 4b — refund a captured charge back to the wallet: exact reversal of the capture split. */
export function postRefund<A>(
  a: { walletAvailable: A; developerPayable: A; platformRevenue: A },
  split: { developerCents: number; platformCents: number },
  currency: Currency = "EUR",
) {
  const amountCents = split.developerCents + split.platformCents;
  return tx("refund", currency, [
    { account: a.developerPayable, direction: "debit", amountCents: split.developerCents },
    { account: a.platformRevenue, direction: "debit", amountCents: split.platformCents },
    { account: a.walletAvailable, direction: "credit", amountCents },
  ]);
}

/** Flow 3 — subscription invoice paid by card: Dr stripe_clearing / Cr developer + platform. */
export function postSubscriptionPayment<A>(
  a: { clearing: A; developerPayable: A; platformRevenue: A },
  amountCents: number,
  commissionBps: number,
  currency: Currency = "EUR",
) {
  const { developerCents, platformCents } = splitCommission(amountCents, commissionBps);
  return tx("subscription_payment", currency, [
    { account: a.clearing, direction: "debit", amountCents },
    { account: a.developerPayable, direction: "credit", amountCents: developerCents },
    { account: a.platformRevenue, direction: "credit", amountCents: platformCents },
  ]);
}

/** Flow 5 — payout via Stripe Connect transfer: Dr developer_payable / Cr stripe_clearing. */
export function postPayout<A>(a: { developerPayable: A; clearing: A }, amountCents: number, currency: Currency = "EUR") {
  return tx("payout", currency, [
    { account: a.developerPayable, direction: "debit", amountCents },
    { account: a.clearing, direction: "credit", amountCents },
  ]);
}

/** Dev/test only — fake money for seeds and `aix dev`. */
export function postSeedCredit<A>(a: { clearing: A; walletAvailable: A }, amountCents: number, currency: Currency = "EUR") {
  return { ...postTopUp(a, amountCents, currency), kind: "seed" as const };
}
