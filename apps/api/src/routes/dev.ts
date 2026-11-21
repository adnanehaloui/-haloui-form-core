/**
 * Local-development helpers. Registered ONLY when AIX_DEV_ENDPOINTS=1 (refused in production).
 */
import { z } from "zod";
import { postSeedCredit } from "@aix/core";
import type { App, Deps } from "../context.js";
import { requireSessionUser } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { FakePayments } from "../lib/payments.js";
import { PLATFORM, postTransaction, walletAccountIds } from "../services/ledger.js";
import { handleStripeEvent } from "../services/stripe-events.js";
import { resolveWallet } from "./wallet.js";

export async function devRoutes(app: App, deps: Deps) {
  app.get("/_dev/mailbox", { schema: { hide: true, querystring: z.object({ to: z.string() }) } }, async (req) => {
    const mails = (deps.mailer.outbox ?? []).filter((m) => m.to.toLowerCase() === req.query.to.toLowerCase());
    const last = mails.at(-1);
    if (!last) throw notFound("no mail");
    return { ...last, link: /(https?:\/\/\S+)/.exec(last.text)?.[1] ?? null };
  });

  app.post("/_dev/wallet/credit", { schema: { hide: true, body: z.object({ amountCents: z.number().int().positive().max(1_000_000), orgId: z.string().optional() }) } }, async (req) => {
    const u = await requireSessionUser(deps, req);
    const w = await resolveWallet(deps, u, req.body.orgId, true);
    await deps.db.transaction((tx) =>
      postTransaction(tx, postSeedCredit({ clearing: PLATFORM.clearing, walletAvailable: walletAccountIds(w.id).available }, req.body.amountCents), { description: "Test money (dev)" }),
    );
    return { ok: true };
  });

  /** Completes a FakePayments checkout by running the same handler a real Stripe webhook would. */
  app.post("/_dev/checkout/:id/complete", { schema: { hide: true, params: z.object({ id: z.string() }) } }, async (req) => {
    if (!(deps.payments instanceof FakePayments)) throw badRequest("only available with fake payments (no STRIPE_SECRET_KEY)");
    const c = deps.payments.checkouts.find((x) => x.id === req.params.id);
    if (!c) throw notFound("checkout not found");
    const i = c.input;
    const sub = c.kind === "subscription" ? `sub_fake_${c.id}` : null;
    await handleStripeEvent(deps, {
      id: `evt_${c.id}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: c.id,
          payment_status: "paid",
          amount_total: i.amountCents ?? 0,
          currency: (i.currency ?? "eur").toLowerCase(),
          subscription: sub,
          metadata: c.kind === "topup" ? { aix_kind: "topup", aix_wallet_id: i.walletId } : { aix_kind: "subscription", aix_wallet_id: i.walletId, aix_user_id: i.userId, aix_price_id: i.priceId },
        },
      },
    });
    if (sub) {
      await handleStripeEvent(deps, {
        id: `evt_inv_${c.id}`,
        type: "invoice.paid",
        data: { object: { id: `in_${c.id}`, subscription: sub, amount_paid: i.unitAmountCents ?? 0, lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 30 * 86400 } }] } } },
      });
    }
    return { ok: true, kind: c.kind };
  });
}
