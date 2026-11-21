/**
 * Double-entry ledger rules. Pure functions — no I/O.
 *
 * Every money movement is a transaction made of entries. Each entry debits or credits one
 * account by a positive integer amount. A transaction is valid only if
 * Σ debits = Σ credits (per currency). Balances are always derived from entries.
 */
import { type Currency } from "./money.js";
export type Direction = "debit" | "credit";
export declare const ACCOUNT_KINDS: readonly ["wallet_available", "wallet_held", "developer_payable", "platform_revenue", "stripe_clearing", "refunds_payable"];
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
/** Which side increases the account. Liabilities/revenue: credit. Assets: debit. */
export declare const NORMAL_BALANCE: Record<AccountKind, Direction>;
export declare const TRANSACTION_KINDS: readonly ["topup", "hold", "capture", "release", "refund", "subscription_payment", "payout", "card_refund", "seed"];
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
export declare class LedgerError extends Error {
    name: string;
}
/** Validates a draft: ≥2 entries, positive integer amounts, debits = credits. Returns it unchanged. */
export declare function validateTransaction<A>(draft: TransactionDraft<A>): TransactionDraft<A>;
/** Balance of an account from its entries, signed by the account's normal side. */
export declare function balanceOf(kind: AccountKind, entries: Iterable<Pick<Entry, "direction" | "amountCents">>): number;
/** Flow 1 — Stripe top-up confirmed: Dr stripe_clearing / Cr wallet_available. */
export declare function postTopUp<A>(a: {
    clearing: A;
    walletAvailable: A;
}, amountCents: number, currency?: Currency): TransactionDraft<A>;
/** Flow 2a — hold: move money from available to held (still the user's money). */
export declare function postHold<A>(a: {
    walletAvailable: A;
    walletHeld: A;
}, amountCents: number, currency?: Currency): TransactionDraft<A>;
/** Flow 2b — capture: held → developer payable + platform revenue, split by commission (basis points). */
export declare function postCapture<A>(a: {
    walletHeld: A;
    developerPayable: A;
    platformRevenue: A;
}, amountCents: number, commissionBps: number, currency?: Currency): TransactionDraft<A>;
/** Flow 4a — release an uncaptured hold: held → available. */
export declare function postRelease<A>(a: {
    walletHeld: A;
    walletAvailable: A;
}, amountCents: number, currency?: Currency): TransactionDraft<A>;
/** Flow 4b — refund a captured charge back to the wallet: exact reversal of the capture split. */
export declare function postRefund<A>(a: {
    walletAvailable: A;
    developerPayable: A;
    platformRevenue: A;
}, split: {
    developerCents: number;
    platformCents: number;
}, currency?: Currency): TransactionDraft<A>;
/** Flow 3 — subscription invoice paid by card: Dr stripe_clearing / Cr developer + platform. */
export declare function postSubscriptionPayment<A>(a: {
    clearing: A;
    developerPayable: A;
    platformRevenue: A;
}, amountCents: number, commissionBps: number, currency?: Currency): TransactionDraft<A>;
/** Flow 5 — payout via Stripe Connect transfer: Dr developer_payable / Cr stripe_clearing. */
export declare function postPayout<A>(a: {
    developerPayable: A;
    clearing: A;
}, amountCents: number, currency?: Currency): TransactionDraft<A>;
/** Dev/test only — fake money for seeds and `aix dev`. */
export declare function postSeedCredit<A>(a: {
    clearing: A;
    walletAvailable: A;
}, amountCents: number, currency?: Currency): {
    kind: "seed";
    currency: Currency;
    entries: Entry<A>[];
};
