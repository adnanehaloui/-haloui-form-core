/**
 * Evaluate a charge against all applicable rules.
 * - Any cap that would be exceeded → "exceeded" (approval cannot override a cap).
 * - Otherwise, if the charge is above the lowest applicable auto-approve threshold and not
 *   pre-approved → "needs_approval".
 */
export function evaluateSpend(amountCents, rules, opts = {}) {
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
    if (opts.preApproved || amountCents === 0)
        return { decision: "allow" };
    const thresholds = rules.map((r) => r.autoApproveThresholdCents).filter((t) => t !== null);
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
};
/** Start of the current UTC day / month for period accounting. */
export function periodStart(period, now = new Date()) {
    return period === "daily"
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
//# sourceMappingURL=limits.js.map