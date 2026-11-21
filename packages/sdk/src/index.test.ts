import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { AIX, InsufficientFunds, NeedsUserApproval, webhooks } from "./index.js";

const fakeFetch = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as any;

describe("@aix/sdk", () => {
  it("requires a secret key", () => {
    expect(() => new AIX({ secretKey: "nope" })).toThrow();
  });
  it("maps API errors to typed errors", async () => {
    const aix = new AIX({ secretKey: "aixsk_test_x", fetch: fakeFetch(402, { error: { code: "needs_user_approval", message: "approve", details: { approvalUrl: "http://a/approve/1", display: "€0.50" } } }) });
    const err = await aix.wallet.hold({ userId: "u", priceId: "render", idempotencyKey: "k" }).catch((e) => e);
    expect(err).toBeInstanceOf(NeedsUserApproval);
    expect(err.approvalUrl).toBe("http://a/approve/1");
    const aix2 = new AIX({ secretKey: "aixsk_test_x", fetch: fakeFetch(402, { error: { code: "insufficient_funds", message: "x" } }) });
    await expect(aix2.wallet.hold({ userId: "u", priceId: "p", idempotencyKey: "k" })).rejects.toBeInstanceOf(InsufficientFunds);
  });
  it("verifies webhook signatures", () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_x").update(`${t}.{"a":1}`).digest("hex");
    expect(webhooks.verify('{"a":1}', `t=${t},v1=${sig}`, "whsec_x")).toBe(true);
    expect(webhooks.verify('{"a":2}', `t=${t},v1=${sig}`, "whsec_x")).toBe(false);
  });
});
