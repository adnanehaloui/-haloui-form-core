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
export type SpendDecision = {
    decision: "allow";
} | {
    decision: "needs_approval";
    reason: string;
    thresholdCents: number;
} | {
    decision: "exceeded";
    reason: string;
    rule: string;
    capCents: number;
    spentCents: number;
};
/**
 * Evaluate a charge against all applicable rules.
 * - Any cap that would be exceeded → "exceeded" (approval cannot override a cap).
 * - Otherwise, if the charge is above the lowest applicable auto-approve threshold and not
 *   pre-approved → "needs_approval".
 */
export declare function evaluateSpend(amountCents: number, rules: SpendLimitRule[], opts?: {
    preApproved?: boolean;
}): SpendDecision;
/** Default limits for new users (see docs/open-questions.md Q9). */
export declare const DEFAULT_USER_LIMITS: {
    readonly autoApproveThresholdCents: 100;
    readonly monthlyCapCents: 2000;
};
/** Start of the current UTC day / month for period accounting. */
export declare function periodStart(period: "daily" | "monthly", now?: Date): Date;
