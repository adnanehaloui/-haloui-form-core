import { and, eq } from "drizzle-orm";
import { apps, disputes, developers, prices, stripeEvents, subscriptions, topups, users, wallets } from "@aix/db";
import { newId, postDispute, postDisputeReversal, postSubscriptionPayment, postTopUp, type Currency } from "@aix/core";
import type { Deps } from "../context.js";
import type { PaymentsEvent } from "../lib/payments.js";
import { ensureDeveloperAccount, PLATFORM, postTransaction, walletAccountIds } from "./ledger.js";
import { audit } from "./audit.js";
import { emailRefund, emailTopUpReceipt } from "./emails.js";

const subIdOf = (inv: any): string | null =>
  inv.subscription ?? inv.parent?.subscription_details?.subscription ?? inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ?? null;
const periodEndOf = (o: any): Date | null => {
  const t = o.current_period_end ?? o.items?.data?.[0]?.current_period_end ?? o.lines?.data?.[0]?.period?.end;
  return t ? new Date(t * 1000) : null;
};

/**
 * Process one verified Stripe event exactly once (stripe_events dedupe + unique ledger external_ref).
 * Returns false if the event was already processed.
 */
export async function handleStripeEvent(deps: Deps, event: PaymentsEvent): Promise<boolean> {
  // Side effects (emails) run only after the money movement has committed.
  const after: (() => Promise<void>)[] = [];
  const processed = await deps.db.transaction(async (tx) => {
    const [fresh] = await tx.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning();
    if (!fresh) return false;
    const o = event.data.object;

    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const meta = o.metadata ?? {};
        if (meta.aix_kind === "topup") {
          if (o.payment_status !== "paid") break; // async methods: wait for async_payment_succeeded
          const [w] = await tx.select().from(wallets).where(eq(wallets.id, meta.aix_wallet_id));
          if (!w) throw new Error(`unknown wallet ${meta.aix_wallet_id}`);
          // Credit what Stripe actually collected, not what the client asked for.
          const amount = Number(o.amount_total);
          if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("invalid amount_total");
          if (String(o.currency).toUpperCase() !== w.currency) throw new Error("currency mismatch");
          await postTransaction(tx, postTopUp({ clearing: PLATFORM.clearing, walletAvailable: walletAccountIds(w.id).available }, amount, w.currency as Currency), {
            externalRef: o.id,
            description: "Wallet top-up",
          });
          await tx
            .insert(topups)
            .values({ id: newId("top"), walletId: w.id, checkoutSessionId: o.id, paymentIntentId: typeof o.payment_intent === "string" ? o.payment_intent : (o.payment_intent?.id ?? null), amountCents: amount, currency: w.currency })
            .onConflictDoNothing();
          after.push(() => emailTopUpReceipt(deps, w.id, amount, o.id));
          if (o.customer && w.ownerUserId) await tx.update(users).set({ stripeCustomerId: o.customer }).where(and(eq(users.id, w.ownerUserId)));
          await audit(tx, { actorUserId: w.ownerUserId, actorType: "system", orgId: w.ownerOrgId, action: "wallet.topped_up", targetType: "wallet", targetId: w.id, metadata: { amountCents: amount, checkoutSessionId: o.id } });
        } else if (meta.aix_kind === "subscription" && o.subscription) {
          await tx
            .insert(subscriptions)
            .values({ id: newId("sub"), walletId: meta.aix_wallet_id, userId: meta.aix_user_id, priceId: meta.aix_price_id, stripeSubscriptionId: o.subscription, status: "active" })
            .onConflictDoNothing();
          if (o.customer) await tx.update(users).set({ stripeCustomerId: o.customer }).where(eq(users.id, meta.aix_user_id));
        }
        break;
      }
      case "invoice.paid": {
        const subId = subIdOf(o);
        if (!subId) break;
        const [s] = await tx.select({ sub: subscriptions, price: prices, app: apps }).from(subscriptions).innerJoin(prices, eq(prices.id, subscriptions.priceId)).innerJoin(apps, eq(apps.id, prices.appId)).where(eq(subscriptions.stripeSubscriptionId, subId));
        if (!s) throw new Error(`unknown subscription ${subId}`); // Stripe retries; checkout event may arrive later
        const amount = Number(o.amount_paid);
        if (amount > 0) {
          const payable = await ensureDeveloperAccount(tx, s.app.developerId, s.price.currency);
          await postTransaction(tx, postSubscriptionPayment({ clearing: PLATFORM.clearing, developerPayable: payable, platformRevenue: PLATFORM.revenue }, amount, s.app.commissionBps, s.price.currency as Currency), {
            externalRef: o.id,
            description: `Subscription: ${s.app.name}`,
          });
        }
        await tx.update(subscriptions).set({ status: "active", currentPeriodEnd: periodEndOf(o) ?? s.sub.currentPeriodEnd }).where(eq(subscriptions.id, s.sub.id));
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await tx
          .update(subscriptions)
          .set({ status: event.type.endsWith("deleted") ? "canceled" : o.cancel_at_period_end && o.status === "active" ? "canceling" : o.status, currentPeriodEnd: periodEndOf(o) })
          .where(eq(subscriptions.stripeSubscriptionId, o.id));
        break;
      }
      case "account.updated": {
        const status = o.payouts_enabled ? "enabled" : o.requirements?.disabled_reason ? "restricted" : "pending";
        await tx.update(developers).set({ payoutStatus: status }).where(eq(developers.stripeConnectAccountId, o.id));
        break;
      }
      case "charge.dispute.created": {
        // A chargeback: the bank pulled the money from Stripe → take it from the wallet (may go negative).
        const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent?.id;
        const [t] = pi ? await tx.select().from(topups).where(eq(topups.paymentIntentId, pi)) : [];
        const amount = Number(o.amount);
        await tx.insert(disputes).values({ id: newId("dsp"), topupId: t?.id ?? null, stripeDisputeId: o.id, amountCents: amount, status: o.status ?? "needs_response" }).onConflictDoNothing();
        if (t && amount > 0) {
          await postTransaction(tx, postDispute({ walletAvailable: walletAccountIds(t.walletId).available, clearing: PLATFORM.clearing }, amount, t.currency as Currency), { externalRef: o.id, description: "Card payment disputed" });
          await audit(tx, { actorType: "system", action: "wallet.disputed", targetType: "wallet", targetId: t.walletId, metadata: { amountCents: amount, disputeId: o.id } });
          after.push(() => emailRefund(deps, t.walletId, amount, "dispute"));
        }
        break;
      }
      case "charge.dispute.closed": {
        const [d] = await tx.select().from(disputes).where(eq(disputes.stripeDisputeId, o.id));
        if (!d) break;
        await tx.update(disputes).set({ status: o.status }).where(eq(disputes.id, d.id));
        if (o.status === "won" && d.topupId) {
          const [t] = await tx.select().from(topups).where(eq(topups.id, d.topupId));
          await postTransaction(tx, postDisputeReversal({ clearing: PLATFORM.clearing, walletAvailable: walletAccountIds(t!.walletId).available }, d.amountCents, t!.currency as Currency), { externalRef: `${o.id}:won`, description: "Dispute closed — funds returned" });
          after.push(() => emailRefund(deps, t!.walletId, d.amountCents, "dispute_won"));
        }
        break;
      }
      case "refund.failed":
      case "charge.refund.updated": {
        // A refund we initiated failed: the money never left Stripe → give it back to the wallet.
        if (event.type === "charge.refund.updated" && o.status !== "failed") break;
        const topupId = o.metadata?.aix_topup_id;
        const [t] = topupId ? await tx.select().from(topups).where(eq(topups.id, topupId)) : [];
        if (!t) break;
        await postTransaction(tx, postDisputeReversal({ clearing: PLATFORM.clearing, walletAvailable: walletAccountIds(t.walletId).available }, Number(o.amount), t.currency as Currency), { externalRef: `${o.id}:failed`, description: "Card refund failed — returned to wallet" });
        await tx.update(topups).set({ refundedCents: Math.max(0, t.refundedCents - Number(o.amount)) }).where(eq(topups.id, t.id));
        break;
      }
      default:
        break;
    }
    return true;
  });
  for (const fn of after) await fn();
  return processed;
}
