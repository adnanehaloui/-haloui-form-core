/**
 * Spend-limit evaluation. Pure: the caller provides current spend totals.
 */
export interface SpendLimitRule {
  /** Human label, e.g. "user monthly" or "app VideoStudio daily". */
  label: string;
  period: "daily" | "monthly";
  /** Hard cap for the period; null = no cap. */
  capCents: number | null;
  /** Charges at or below this (per charge) are auto-approved; null = inherit / no threshold. */
  autoApproveThresholdCents: number | null;
  /** Amount already spent (captured + held) in the current period for this rule's scope. */
  spentCents: number;
}

export type SpendDecision =
  | { decision: "allow" }
  | { decision: "needs_approval"; reason: string; thresholdCents: number }
  | { decision: "exceeded"; reason: string; rule: string; capCents: number; spentCents: number };

/**
 * Evaluate a charge against all applicable rules.
 * - Any cap that would be exceeded → "exceeded" (approval cannot override a cap).
 * - Otherwise, if the charge is above the lowest applicable auto-approve threshold and not
 *   pre-approved → "needs_approval".
 */
export function evaluateSpend(amountCents: number, rules: SpendLimitRule[], opts: { preApproved?: boolean } = {}): SpendDecision {
  for (const r of rules) {
    if (r.capCents !== null && r.spentCents + amountCents > r.capCents) {
      return {
        decision: "exceeded",
        reason: `${r.label} limit of ${r.capCents} cents would be exceeded`,
        rule: r.label,
        capCents: r.capCents,
        spentCents: r.spentCents,
      };
    }
  }
  if (opts.preApproved || amountCents === 0) return { decision: "allow" };
  const thresholds = rules.map((r) => r.autoApproveThresholdCents).filter((t): t is number => t !== null);
  if (thresholds.length > 0) {
    const threshold = Math.min(...thresholds);
    if (amountCents > threshold) {
      return { decision: "needs_approval", reason: `charge is above the auto-approve threshold`, thresholdCents: threshold };
    }
  }
  return { decision: "allow" };
}

/** Default limits for new users (see docs/open-questions.md Q9). */
export const DEFAULT_USER_LIMITS = {
  autoApproveThresholdCents: 100, // €1.00 per charge
  monthlyCapCents: 2000, // €20 per month
} as const;

/** Start of the current UTC day / month for period accounting. */
export function periodStart(period: "daily" | "monthly", now: Date = new Date()): Date {
  return period === "daily"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
