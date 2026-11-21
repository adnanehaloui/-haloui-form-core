/**
 * @aix/sdk — server-side SDK for apps sold on AIX.
 *
 * ```ts
 * const aix = new AIX({ secretKey: process.env.AIX_SECRET_KEY });
 * const user = await aix.auth.verify(requestToken);
 * const hold = await aix.wallet.hold({ userId: user.id, priceId: "render", idempotencyKey: runId, runId });
 * try { await doWork(); await aix.wallet.capture(hold.id); }
 * catch (e) { await aix.wallet.release(hold.id, { reason: "render_failed" }); throw e; }
 * ```
 *
 * Never use this SDK in a browser: secret keys must stay on your server.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AIXError, errorFromResponse } from "./errors.js";

export * from "./errors.js";

/** Verify AIX webhooks (header `aix-signature`). No secret key needed. */
export const webhooks = {
  verify(body: string, signatureHeader: string, webhookSecret: string, toleranceSec = 300): boolean {
    const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    if (!Number.isInteger(t) || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
    const expected = Buffer.from(createHmac("sha256", webhookSecret).update(`${t}.${body}`).digest("hex"));
    const got = Buffer.from(parts.v1);
    return expected.length === got.length && timingSafeEqual(expected, got);
  },
  /** Verify and parse; throws if the signature is invalid. */
  constructEvent<T = { id: string; type: string; createdAt: string; data: any }>(body: string, signatureHeader: string, webhookSecret: string): T {
    if (!webhooks.verify(body, signatureHeader, webhookSecret)) throw new AIXError("invalid webhook signature", "invalid_signature", 400);
    return JSON.parse(body) as T;
  },
};

export interface AIXOptions {
  /** Your developer secret key (aixsk_…). Defaults to process.env.AIX_SECRET_KEY. */
  secretKey?: string | undefined;
  /** AIX API base URL. Defaults to process.env.AIX_API_URL or http://localhost:4000. */
  apiUrl?: string | undefined;
  /** Request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Custom fetch (tests). */
  fetch?: typeof fetch;
}

/** The verified caller. Only fields the user granted in your manifest's permissions.userData are present. */
export interface AIXUser {
  id: string;
  appId: string;
  manifestId: string;
  orgId: string | null;
  /** Set when the call came through the AIX MCP gateway: use it as your idempotencyKey/runId. */
  runId: string | null;
  email?: string;
  name?: string | null;
}

export type ChargeStatus = "held" | "captured" | "released" | "refunded" | "failed";

/** A hold (reserved money) / charge. Amounts are integer euro cents. */
export interface Charge {
  id: string;
  object: "charge";
  status: ChargeStatus;
  appId: string;
  userId: string;
  priceId: string;
  quantity: number;
  freeUnits: number;
  amountCents: number;
  currency: "EUR";
  /** e.g. "€0.50" — display only. */
  display: string;
  idempotencyKey: string;
  runId: string | null;
  holdExpiresAt: string | null;
}

export interface HoldParams {
  userId: string;
  /** A price id (price_…) or your price lookup key (e.g. "render"). Prices come from the AIX catalog, never from here. */
  priceId: string;
  /** Needed only if the lookup key is shared by several of your apps. */
  appId?: string;
  /** Number of units (default 1). */
  quantity?: number;
  /** Required. Reusing a key returns the original hold — retries are safe. */
  idempotencyKey: string;
  runId?: string;
  /** How long the hold lives before auto-release (default 15 min, max 24 h). */
  holdTtlSeconds?: number;
}

export interface Entitlement {
  entitled: boolean;
  kind?: "free" | "metered" | "one_time" | "subscription";
  reason?: string;
  freeUnitsRemaining?: number;
  currentPeriodEnd?: string;
}

export interface UsageRecord {
  userId: string;
  priceId: string;
  quantity: number;
  idempotencyKey: string;
  runId?: string;
  appId?: string;
}

export class AIX {
  private readonly secretKey: string;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AIXOptions = {}) {
    if (typeof (globalThis as any).window !== "undefined" && typeof (globalThis as any).document !== "undefined") {
      throw new Error("@aix/sdk must only run on your server — never ship your secret key to a browser.");
    }
    const key = opts.secretKey ?? process.env.AIX_SECRET_KEY;
    if (!key || !key.startsWith("aixsk_")) throw new Error("AIX secret key missing: pass { secretKey } or set AIX_SECRET_KEY (aixsk_…)");
    this.secretKey = key;
    this.apiUrl = (opts.apiUrl ?? process.env.AIX_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.apiUrl + path, {
        method,
        headers: { authorization: `Bearer ${this.secretKey}`, "user-agent": "aix-sdk-node/0.1.0", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e: any) {
      throw new AIXError(`could not reach AIX API: ${e.message}`, "network_error", 0);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw errorFromResponse(res.status, json);
    return json as T;
  }

  readonly auth = {
    /**
     * Verify the short-lived AIX user token the gateway attached to a request
     * (header `X-AIX-User-Token`). Throws {@link Unauthorized} if invalid or expired.
     */
    verify: async (token: string): Promise<AIXUser> => (await this.request<{ user: AIXUser }>("POST", "/v1/auth/verify", { token })).user,
  };

  readonly entitlements = {
    /** Does the user have an active subscription for `key`, or free units / a free price? */
    check: (userId: string, key: string, opts: { appId?: string } = {}): Promise<Entitlement> =>
      this.request("POST", "/v1/entitlements/check", { userId, key, ...opts }),
  };

  readonly wallet = {
    /**
     * Reserve money before doing expensive work.
     * @throws {@link NeedsUserApproval} above the user's auto-approve threshold
     * @throws {@link InsufficientFunds} | {@link SpendLimitExceeded} | {@link NotInstalled} | {@link BlockedByOrgPolicy}
     */
    hold: (p: HoldParams): Promise<Charge> => this.request("POST", "/v1/holds", { quantity: 1, ...p }),
    /** Work succeeded: take the money. Idempotent. */
    capture: (holdId: string): Promise<Charge> => this.request("POST", `/v1/holds/${encodeURIComponent(holdId)}/capture`),
    /** Work failed: give the money back. Idempotent. */
    release: (holdId: string, opts: { reason?: string } = {}): Promise<Charge> => this.request("POST", `/v1/holds/${encodeURIComponent(holdId)}/release`, opts),
    /** Fetch a charge. */
    get: (chargeId: string): Promise<Charge> => this.request("GET", `/v1/charges/${encodeURIComponent(chargeId)}`),
    /**
     * Hold, run `work`, then capture on success or release on failure.
     * Returns the work's result and the captured charge.
     */
    run: async <T>(p: HoldParams, work: (hold: Charge) => Promise<T>): Promise<{ result: T; charge: Charge }> => {
      const hold = await this.wallet.hold(p);
      if (hold.status === "captured") return { result: await work(hold), charge: hold };
      let result: T;
      try {
        result = await work(hold);
      } catch (e) {
        await this.wallet.release(hold.id, { reason: e instanceof Error ? e.message.slice(0, 200) : "work_failed" }).catch(() => {});
        throw e;
      }
      return { result, charge: await this.wallet.capture(hold.id) };
    },
  };

  readonly usage = {
    /**
     * Report metered units after the fact (batched, ≤ 100 per call). Each record becomes a
     * captured charge, subject to the same limits and approvals. Never throws per-record errors:
     * inspect `results[i].ok`.
     */
    report: (records: UsageRecord[]): Promise<{ results: { idempotencyKey: string; ok: boolean; charge?: Charge; error?: { code: string; message: string } }[] }> =>
      this.request("POST", "/v1/usage", { records }),
  };

  /** Same as {@link webhooks}, available on the instance. */
  readonly webhooks = webhooks;

}

/** Header name the AIX gateway uses to pass the user token to your MCP server. */
export const AIX_USER_TOKEN_HEADER = "x-aix-user-token";
/** Header with the gateway-generated run id (use as idempotencyKey). */
export const AIX_RUN_ID_HEADER = "x-aix-run-id";
