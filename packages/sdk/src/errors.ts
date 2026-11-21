/** Base class for every error returned by the AIX API. */
export class AIXError extends Error {
  override name = "AIXError";
  constructor(
    message: string,
    /** Stable machine-readable code, e.g. "insufficient_funds". */
    public readonly code: string,
    /** HTTP status of the API response. */
    public readonly status: number,
    /** Extra structured information from the API. */
    public readonly details: Record<string, any> = {},
  ) {
    super(message);
  }
}

/** The user's wallet doesn't hold enough money. Send them to `topUpUrl`. */
export class InsufficientFunds extends AIXError {
  override name = "InsufficientFunds";
  get availableCents(): number { return this.details.availableCents; }
  get requiredCents(): number { return this.details.requiredCents; }
  get topUpUrl(): string | undefined { return this.details.topUpUrl; }
}

/** A daily/monthly cap (user, app or org budget) would be exceeded. Approval cannot override it. */
export class SpendLimitExceeded extends AIXError {
  override name = "SpendLimitExceeded";
}

/**
 * The charge is above the user's auto-approve threshold. Show the user `approvalUrl`
 * ("This costs €0.50 — approve?") and retry `hold` with the SAME idempotencyKey after they approve.
 */
export class NeedsUserApproval extends AIXError {
  override name = "NeedsUserApproval";
  get approvalId(): string { return this.details.approvalId; }
  get approvalUrl(): string { return this.details.approvalUrl; }
  get amountCents(): number { return this.details.amountCents; }
  get display(): string { return this.details.display; }
  /** "denied" if the user already declined. */
  get decision(): string | undefined { return this.details.status; }
}

/** The user hasn't installed your app (or uninstalled it). */
export class NotInstalled extends AIXError { override name = "NotInstalled"; }
/** The user's organization blocks your app. */
export class BlockedByOrgPolicy extends AIXError { override name = "BlockedByOrgPolicy"; }
/** Missing/invalid secret key, or an invalid/expired user token. */
export class Unauthorized extends AIXError { override name = "Unauthorized"; }
/** The idempotencyKey was reused with different parameters. */
export class IdempotencyMismatch extends AIXError { override name = "IdempotencyMismatch"; }

const BY_CODE: Record<string, new (m: string, c: string, s: number, d?: Record<string, any>) => AIXError> = {
  insufficient_funds: InsufficientFunds,
  spend_limit_exceeded: SpendLimitExceeded,
  needs_user_approval: NeedsUserApproval,
  not_installed: NotInstalled,
  blocked_by_org_policy: BlockedByOrgPolicy,
  unauthorized: Unauthorized,
  idempotency_mismatch: IdempotencyMismatch,
};

export function errorFromResponse(status: number, body: any): AIXError {
  const code = body?.error?.code ?? "unknown";
  const Cls = BY_CODE[code] ?? AIXError;
  return new Cls(body?.error?.message ?? `AIX API error ${status}`, code, status, body?.error?.details ?? {});
}
