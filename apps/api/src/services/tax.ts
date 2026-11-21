/**
 * TODO(tax): VAT / merchant-of-record handling.
 *
 * Deliberately NOT implemented — tax logic must not be invented. Before real money:
 *  - Decide who is merchant of record (AIX vs. each developer) per market.
 *  - EU VAT on digital services is charged at the customer's country rate (OSS scheme);
 *    B2B reverse charge needs validated VAT ids.
 *  - Wallet top-ups may be prepaid store credit (VAT at redemption) — needs legal advice
 *    together with the e-money question in docs/open-questions.md (Q6).
 *  - Consider Stripe Tax or a merchant-of-record provider instead of building this.
 *
 * The invoice code calls this hook so tax can be added without touching money flows.
 */
export interface TaxLine { label: string; amountCents: number }

export function computeTax(_input: { country: string | null; subtotalCents: number; isBusiness: boolean }): { lines: TaxLine[]; note: string } {
  // TODO(tax): return real tax lines.
  return { lines: [], note: "Prices shown without tax calculation (test mode). TODO(tax)." };
}
