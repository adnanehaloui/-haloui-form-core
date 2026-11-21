import { assertCents, MoneyError } from "./money.js";

/** Default platform commission: 2000 basis points = 20%. */
export const DEFAULT_COMMISSION_BPS = 2000;

/**
 * Split an amount between developer and platform.
 * Platform share is rounded DOWN; the developer gets the remainder, so the parts always sum exactly.
 */
export function splitCommission(amountCents: number, commissionBps: number): { developerCents: number; platformCents: number } {
  assertCents(amountCents, { nonNegative: true });
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new MoneyError(`commissionBps must be an integer in [0, 10000], got ${commissionBps}`);
  }
  // Integer math only: amount * bps fits in a safe integer for any realistic amount (< 9e11 cents).
  const product = amountCents * commissionBps;
  assertCents(product);
  const platformCents = Math.floor(product / 10_000);
  return { developerCents: amountCents - platformCents, platformCents };
}
