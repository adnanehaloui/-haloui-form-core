/** Error codes are stable API contract; the SDK maps them to typed errors. */
export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "insufficient_funds"
  | "spend_limit_exceeded"
  | "needs_user_approval"
  | "idempotency_mismatch"
  | "not_installed"
  | "blocked_by_org_policy"
  | "payments_unavailable"
  | "rate_limited";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, d?: Record<string, unknown>) => new ApiError(400, "bad_request", m, d);
export const unauthorized = (m = "authentication required") => new ApiError(401, "unauthorized", m);
export const forbidden = (m = "forbidden") => new ApiError(403, "forbidden", m);
export const notFound = (m = "not found") => new ApiError(404, "not_found", m);
export const conflict = (m: string) => new ApiError(409, "conflict", m);
