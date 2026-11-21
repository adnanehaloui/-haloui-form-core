import { and, eq } from "drizzle-orm";
import { apps, developers, prices, stripeEvents, subscriptions, users, wallets } from "@aix/db";
import { newId, postSubscriptionPayment, postTopUp, type Currency } from "@aix/core";
import type { Deps } from "../context.js";
import type { PaymentsEvent } from "../lib/payments.js";
import { ensureDeveloperAccount, PLATFORM, postTransaction, walletAccountIds } from "./ledger.js";
import { audit } from "./audit.js";

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
  return deps.db.transaction(async (tx) => {
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
          .set({ status: event.type.endsWith("deleted") ? "canceled" : o.status, currentPeriodEnd: periodEndOf(o) })
          .where(eq(subscriptions.stripeSubscriptionId, o.id));
        break;
      }
      case "account.updated": {
        const status = o.payouts_enabled ? "enabled" : o.requirements?.disabled_reason ? "restricted" : "pending";
        await tx.update(developers).set({ payoutStatus: status }).where(eq(developers.stripeConnectAccountId, o.id));
        break;
      }
      default:
        // TODO: charge.refunded / charge.dispute.created for card-level refunds of top-ups (refunds_payable).
        break;
    }
    return true;
  });
}
