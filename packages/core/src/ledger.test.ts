import { describe, expect, it } from "vitest";
import {
  balanceOf,
  LedgerError,
  postCapture,
  postHold,
  postPayout,
  postRefund,
  postRelease,
  postSubscriptionPayment,
  postTopUp,
  validateTransaction,
  type AccountKind,
  type Entry,
  type TransactionDraft,
} from "./ledger.js";
import { splitCommission } from "./commission.js";
import { formatMoney, multiplyCents, parseDecimalToCents } from "./money.js";
import { evaluateSpend } from "./limits.js";
import { decryptSecret, encryptSecret, redact, signWebhook, verifyWebhookSignature } from "./crypto.js";

const A = {
  clearing: "stripe_clearing",
  walletAvailable: "wallet_available",
  walletHeld: "wallet_held",
  developerPayable: "developer_payable",
  platformRevenue: "platform_revenue",
} as const satisfies Record<string, AccountKind>;

/** Tiny deterministic PRNG so the property tests are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (max: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % max;
  };
}

function sumSide(t: TransactionDraft, side: "debit" | "credit") {
  return t.entries.filter((e) => e.direction === side).reduce((n, e) => n + e.amountCents, 0);
}

function balances(txs: TransactionDraft<AccountKind>[]) {
  const all = txs.flatMap((t) => t.entries);
  const of = (k: AccountKind) => balanceOf(k, all.filter((e) => e.account === k));
  return {
    clearing: of("stripe_clearing"),
    available: of("wallet_available"),
    held: of("wallet_held"),
    dev: of("developer_payable"),
    platform: of("platform_revenue"),
  };
}

describe("validateTransaction", () => {
  it("rejects unbalanced, non-integer, zero, negative and single-entry transactions", () => {
    const e = (direction: "debit" | "credit", amountCents: number): Entry => ({ account: "x", direction, amountCents });
    expect(() => validateTransaction({ kind: "topup", currency: "EUR", entries: [e("debit", 10), e("credit", 9)] })).toThrow(LedgerError);
    expect(() => validateTransaction({ kind: "topup", currency: "EUR", entries: [e("debit", 0.5), e("credit", 0.5)] })).toThrow(LedgerError);
    expect(() => validateTransaction({ kind: "topup", currency: "EUR", entries: [e("debit", 0), e("credit", 0)] })).toThrow(LedgerError);
    expect(() => validateTransaction({ kind: "topup", currency: "EUR", entries: [e("debit", -5), e("credit", -5)] })).toThrow(LedgerError);
    expect(() => validateTransaction({ kind: "topup", currency: "EUR", entries: [e("debit", 5)] })).toThrow(LedgerError);
    expect(validateTransaction({ kind: "topup", currency: "EUR", entries: [e("debit", 5), e("credit", 5)] }).entries).toHaveLength(2);
  });
});

describe("money flows", () => {
  it("top-up €20, hold €0.50, capture with 20% commission", () => {
    const txs = [postTopUp(A, 2000), postHold(A, 50)];
    expect(balances(txs)).toMatchObject({ available: 1950, held: 50, clearing: 2000 });
    txs.push(postCapture(A, 50, 2000));
    expect(balances(txs)).toEqual({ clearing: 2000, available: 1950, held: 0, dev: 40, platform: 10 });
  });

  it("release returns held money", () => {
    const txs = [postTopUp(A, 100), postHold(A, 60), postRelease(A, 60)];
    expect(balances(txs)).toMatchObject({ available: 100, held: 0 });
  });

  it("refund reverses a capture exactly", () => {
    const split = splitCommission(333, 2000);
    const txs = [postTopUp(A, 1000), postHold(A, 333), postCapture(A, 333, 2000), postRefund(A, split)];
    expect(balances(txs)).toMatchObject({ available: 1000, held: 0, dev: 0, platform: 0 });
  });

  it("subscription payment and payout", () => {
    const txs = [postSubscriptionPayment(A, 999, 2000), postPayout(A, 800)];
    const b = balances(txs);
    expect(b.dev + b.platform).toBe(999 - 800);
    expect(b.clearing).toBe(199);
  });

  it("0% commission drops the zero leg and still balances", () => {
    const t = postCapture(A, 50, 0);
    expect(t.entries).toHaveLength(2);
  });
});

describe("ledger invariants (randomized)", () => {
  it("every generated transaction balances and the books always sum to zero", () => {
    const r = rng(42);
    for (let run = 0; run < 200; run++) {
      const txs: TransactionDraft<AccountKind>[] = [];
      const open: number[] = [];
      for (let step = 0; step < 50; step++) {
        const b = balances(txs);
        const op = r(5);
        if (op === 0 || b.available === 0) txs.push(postTopUp(A, 1 + r(10_000)));
        else if (op === 1) {
          const amt = 1 + r(b.available);
          txs.push(postHold(A, amt));
          open.push(amt);
        } else if (op === 2 && open.length) txs.push(postCapture(A, open.pop()!, r(10_001)));
        else if (op === 3 && open.length) txs.push(postRelease(A, open.pop()!));
        else if (op === 4 && b.dev > 0) txs.push(postPayout(A, 1 + r(b.dev)));
      }
      for (const t of txs) expect(sumSide(t, "debit")).toBe(sumSide(t, "credit"));
      const b = balances(txs);
      // Assets (debit-normal) = liabilities + revenue (credit-normal): the accounting equation.
      expect(b.clearing).toBe(b.available + b.held + b.dev + b.platform);
      expect(b.available).toBeGreaterThanOrEqual(0);
      expect(b.held).toBe(open.reduce((n, x) => n + x, 0));
    }
  });

  it("commission split always sums exactly and never exceeds the rate", () => {
    const r = rng(7);
    for (let i = 0; i < 10_000; i++) {
      const amount = r(1_000_000);
      const bps = r(10_001);
      const { developerCents, platformCents } = splitCommission(amount, bps);
      expect(developerCents + platformCents).toBe(amount);
      expect(Number.isInteger(developerCents) && Number.isInteger(platformCents)).toBe(true);
      expect(platformCents * 10_000).toBeLessThanOrEqual(amount * bps);
    }
  });
});

describe("money helpers", () => {
  it("formats and parses without floats", () => {
    expect(formatMoney(50)).toBe("€0.50");
    expect(formatMoney(2000)).toBe("€20.00");
    expect(formatMoney(-5)).toBe("-€0.05");
    expect(parseDecimalToCents("20")).toBe(2000);
    expect(parseDecimalToCents("0,5")).toBe(50);
    expect(parseDecimalToCents("1.234")).toBeNull();
    expect(multiplyCents(50, 3)).toBe(150);
    expect(() => multiplyCents(50, 1.5)).toThrow();
  });
});

describe("spend limits", () => {
  const rule = (o: Partial<Parameters<typeof evaluateSpend>[1][number]> = {}) => ({
    label: "user monthly",
    period: "monthly" as const,
    capCents: 2000,
    autoApproveThresholdCents: 100,
    spentCents: 0,
    ...o,
  });
  it("allows small charges, asks approval above threshold, blocks over cap", () => {
    expect(evaluateSpend(50, [rule()]).decision).toBe("allow");
    expect(evaluateSpend(150, [rule()]).decision).toBe("needs_approval");
    expect(evaluateSpend(150, [rule()], { preApproved: true }).decision).toBe("allow");
    expect(evaluateSpend(100, [rule({ spentCents: 1950 })]).decision).toBe("exceeded");
    expect(evaluateSpend(100, [rule({ spentCents: 1950 })], { preApproved: true }).decision).toBe("exceeded");
  });
});

describe("crypto helpers", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  it("round-trips AES-GCM and detects tampering", () => {
    const enc = encryptSecret("sk_live_abc", key);
    expect(enc).not.toContain("sk_live_abc");
    expect(decryptSecret(enc, key)).toBe("sk_live_abc");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });
  it("signs and verifies webhooks", () => {
    const h = signWebhook('{"a":1}', "whsec_test");
    expect(verifyWebhookSignature('{"a":1}', h, "whsec_test")).toBe(true);
    expect(verifyWebhookSignature('{"a":2}', h, "whsec_test")).toBe(false);
    expect(verifyWebhookSignature('{"a":1}', h, "other")).toBe(false);
  });
  it("redacts secrets", () => {
    expect(redact("key sk_test_123 and Bearer abc.def")).toBe("key sk_[REDACTED] and Bearer [REDACTED]");
  });
});
