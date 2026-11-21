/**
 * Money is always an integer number of minor units (euro cents) plus a currency.
 * Never use floats for money (hard rule 4).
 */
export type Currency = "EUR";
export const CURRENCIES: readonly Currency[] = ["EUR"] as const;

export interface Money {
  readonly amountCents: number;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  override name = "MoneyError";
}

/** Throws unless `n` is a safe integer (optionally > 0 / >= 0). */
export function assertCents(n: unknown, opts: { positive?: boolean; nonNegative?: boolean } = {}): asserts n is number {
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new MoneyError(`amount must be an integer number of cents, got ${String(n)}`);
  }
  if (opts.positive && n <= 0) throw new MoneyError(`amount must be > 0, got ${n}`);
  if (opts.nonNegative && n < 0) throw new MoneyError(`amount must be >= 0, got ${n}`);
}

export function money(amountCents: number, currency: Currency = "EUR"): Money {
  assertCents(amountCents);
  return { amountCents, currency };
}

/** Multiply a unit price by an integer quantity, guarding against overflow. */
export function multiplyCents(unitAmountCents: number, quantity: number): number {
  assertCents(unitAmountCents, { nonNegative: true });
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new MoneyError(`quantity must be a positive integer, got ${quantity}`);
  const total = unitAmountCents * quantity;
  assertCents(total);
  return total;
}

/** Format cents for display, e.g. 50 → "€0.50". Display only — never parse this back. */
export function formatMoney(amountCents: number, currency: Currency = "EUR"): string {
  assertCents(amountCents);
  const sign = amountCents < 0 ? "-" : "";
  const abs = Math.abs(amountCents);
  const units = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  const symbol = currency === "EUR" ? "€" : `${currency} `;
  return `${sign}${symbol}${units}.${cents}`;
}

/**
 * Parse a user-entered decimal string like "20", "20.5", "0.50" into cents without floats.
 * Returns null on invalid input.
 */
export function parseDecimalToCents(input: string): number | null {
  const m = /^\s*(\d{1,12})(?:[.,](\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const units = Number(m[1]);
  const frac = (m[2] ?? "").padEnd(2, "0");
  return units * 100 + Number(frac);
}
