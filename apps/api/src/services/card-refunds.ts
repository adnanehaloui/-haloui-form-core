/**
 * Refund unused wallet money back to the card it came from (admin action; see docs/decisions.md D23).
 * Ledger: wallet_available → refunds_payable (reserve), then refunds_payable → stripe_clearing once Stripe
 * accepted the refund. If Stripe rejects it, the reservation is reversed in the same request.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { topups } from "@aix/db";
import { postCardRefundRequested, postCardRefundSettled, type Currency } from "@aix/core";
import type { Deps } from "../context.js";
import { ApiError, badRequest, notFound } from "../lib/errors.js";
import { PaymentsUnavailableError } from "../lib/payments.js";
import { balance, lockAccount, PLATFORM, postTransaction, walletAccountIds } from "./ledger.js";
import { audit } from "./audit.js";
import { emailRefund } from "./emails.js";

export async function refundTopUp(deps: Deps, topupId: string, amountCents: number, actorUserId: string, reason: string) {
  if (!deps.payments) throw new PaymentsUnavailableError();
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequest("amountCents must be a positive integer");
  const reserved = await deps.db.transaction(async (tx) => {
    const [t] = await tx.select().from(topups).where(eq(topups.id, topupId)).for("update");
    if (!t) throw notFound("top-up not found");
    if (!t.paymentIntentId) throw badRequest("this top-up has no card payment to refund");
    if (amountCents > t.amountCents - t.refundedCents) throw badRequest(`at most ${t.amountCents - t.refundedCents} cents of this top-up can still be refunded`);
    const acct = walletAccountIds(t.walletId);
    await lockAccount(tx, acct.available);
    const available = await balance(tx, acct.available);
    if (available < amountCents) throw new ApiError(402, "insufficient_funds", "the wallet no longer holds that much unused money", { availableCents: available });
    await postTransaction(tx, postCardRefundRequested({ walletAvailable: acct.available, refundsPayable: PLATFORM.refunds }, amountCents, t.currency as Currency), { externalRef: `refund-req:${t.id}:${t.refundedCents}`, description: "Refund to card" });
    await tx.update(topups).set({ refundedCents: t.refundedCents + amountCents }).where(eq(topups.id, t.id));
    return { topup: t, idempotencyKey: `refund:${t.id}:${t.refundedCents}` };
  });

  const { topup } = reserved;
  let r: { id: string; status: string };
  try {
    r = await deps.payments.refundPayment({ paymentIntentId: topup.paymentIntentId!, amountCents, idempotencyKey: reserved.idempotencyKey, reason, topupId: topup.id });
  } catch (e: any) {
    // Only when STRIPE refused do we undo the reservation (money never left).
    await deps.db.transaction(async (tx) => {
      await postTransaction(tx, { ...postCardRefundRequested({ walletAvailable: PLATFORM.refunds, refundsPayable: walletAccountIds(topup.walletId).available }, amountCents, topup.currency as Currency) }, { externalRef: `refund-undo:${topup.id}:${topup.refundedCents}`, description: "Refund to card failed — returned" });
      await tx.update(topups).set({ refundedCents: sql`${topups.refundedCents} - ${amountCents}` }).where(eq(topups.id, topup.id));
    });
    throw new ApiError(502, "payments_unavailable", `Stripe refused the refund: ${e.message}`);
  }
  {
    // Stripe accepted: settle. If this fails, the refund is still real — never re-credit the wallet here;
    // the reservation stays in refunds_payable and is visible on the metrics/ledger for follow-up.
    await deps.db.transaction(async (tx) => {
      await postTransaction(tx, postCardRefundSettled({ refundsPayable: PLATFORM.refunds, clearing: PLATFORM.clearing }, amountCents, topup.currency as Currency), { externalRef: r.id, description: "Refund sent to card" });
      await audit(tx, { actorUserId, actorType: "admin", action: "wallet.refunded_to_card", targetType: "topup", targetId: topup.id, metadata: { amountCents, refundId: r.id, reason } });
    });
  }
  await emailRefund(deps, topup.walletId, amountCents, "card_refund").catch(() => {});
  return { refundId: r.id, status: r.status, amountCents };
}

export async function listTopUps(deps: Deps, walletId: string) {
  return deps.db.select().from(topups).where(and(eq(topups.walletId, walletId))).orderBy(desc(topups.createdAt));
}
