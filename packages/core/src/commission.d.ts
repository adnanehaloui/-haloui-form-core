/** Default platform commission: 2000 basis points = 20%. */
export declare const DEFAULT_COMMISSION_BPS = 2000;
/**
 * Split an amount between developer and platform.
 * Platform share is rounded DOWN; the developer gets the remainder, so the parts always sum exactly.
 */
export declare function splitCommission(amountCents: number, commissionBps: number): {
    developerCents: number;
    platformCents: number;
};
