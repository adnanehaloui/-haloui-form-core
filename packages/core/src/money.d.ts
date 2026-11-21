/**
 * Money is always an integer number of minor units (euro cents) plus a currency.
 * Never use floats for money (hard rule 4).
 */
export type Currency = "EUR";
export declare const CURRENCIES: readonly Currency[];
export interface Money {
    readonly amountCents: number;
    readonly currency: Currency;
}
export declare class MoneyError extends Error {
    name: string;
}
/** Throws unless `n` is a safe integer (optionally > 0 / >= 0). */
export declare function assertCents(n: unknown, opts?: {
    positive?: boolean;
    nonNegative?: boolean;
}): asserts n is number;
export declare function money(amountCents: number, currency?: Currency): Money;
/** Multiply a unit price by an integer quantity, guarding against overflow. */
export declare function multiplyCents(unitAmountCents: number, quantity: number): number;
/** Format cents for display, e.g. 50 → "€0.50". Display only — never parse this back. */
export declare function formatMoney(amountCents: number, currency?: Currency): string;
/**
 * Parse a user-entered decimal string like "20", "20.5", "0.50" into cents without floats.
 * Returns null on invalid input.
 */
export declare function parseDecimalToCents(input: string): number | null;
