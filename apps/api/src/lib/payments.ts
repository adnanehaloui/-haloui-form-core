import Stripe from "stripe";

/**
 * Narrow payments interface so business logic doesn't depend on the Stripe SDK directly
 * (and tests can use FakePayments). All amounts are integer cents.
 */
export interface CheckoutResult { id: string; url: string }
export interface PaymentsEvent { id: string; type: string; data: { object: any } }

export interface Payments {
  createTopUpCheckout(i: { walletId: string; amountCents: number; currency: string; customerId?: string | null; email: string; successUrl: string; cancelUrl: string }): Promise<CheckoutResult>;
  createSubscriptionCheckout(i: { walletId: string; userId: string; priceId: string; stripePriceId: string; unitAmountCents: number; customerId?: string | null; email: string; successUrl: string; cancelUrl: string }): Promise<CheckoutResult>;
  /** Creates (once) a Stripe Product+Price mirroring an AIX subscription price. */
  ensureRecurringPrice(i: { aixPriceId: string; appName: string; unitAmountCents: number; currency: string; interval: "month" | "year" }): Promise<string>;
  constructWebhookEvent(rawBody: Buffer, signature: string): PaymentsEvent;
  createConnectAccount(i: { developerId: string; email: string }): Promise<string>;
  createConnectOnboardingLink(i: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<string>;
  getConnectAccountStatus(accountId: string): Promise<"pending" | "enabled" | "restricted">;
  createTransfer(i: { accountId: string; amountCents: number; currency: string; idempotencyKey: string; description: string }): Promise<string>;
}

export class PaymentsUnavailableError extends Error {
  constructor() {
    super("Stripe is not configured: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in .env (test mode keys)");
  }
}

export function stripePayments(secretKey: string, webhookSecret: string | undefined): Payments {
  const stripe = new Stripe(secretKey);
  return {
    async createTopUpCheckout(i) {
      const s = await stripe.checkout.sessions.create({
        mode: "payment",
        ...(i.customerId ? { customer: i.customerId } : { customer_email: i.email }),
        line_items: [{ quantity: 1, price_data: { currency: i.currency.toLowerCase(), unit_amount: i.amountCents, product_data: { name: "AIX wallet top-up" } } }],
        metadata: { aix_kind: "topup", aix_wallet_id: i.walletId, aix_amount_cents: String(i.amountCents) },
        payment_intent_data: { metadata: { aix_kind: "topup", aix_wallet_id: i.walletId } },
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      });
      return { id: s.id, url: s.url! };
    },
    async createSubscriptionCheckout(i) {
      const meta = { aix_kind: "subscription", aix_wallet_id: i.walletId, aix_user_id: i.userId, aix_price_id: i.priceId };
      const s = await stripe.checkout.sessions.create({
        mode: "subscription",
        ...(i.customerId ? { customer: i.customerId } : { customer_email: i.email }),
        line_items: [{ price: i.stripePriceId, quantity: 1 }],
        metadata: meta,
        subscription_data: { metadata: meta },
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      });
      return { id: s.id, url: s.url! };
    },
    async ensureRecurringPrice(i) {
      const product = await stripe.products.create({ name: i.appName, metadata: { aix_price_id: i.aixPriceId } }, { idempotencyKey: `product:${i.aixPriceId}` });
      const price = await stripe.prices.create(
        { product: product.id, currency: i.currency.toLowerCase(), unit_amount: i.unitAmountCents, recurring: { interval: i.interval }, metadata: { aix_price_id: i.aixPriceId } },
        { idempotencyKey: `price:${i.aixPriceId}` },
      );
      return price.id;
    },
    constructWebhookEvent(raw, sig) {
      if (!webhookSecret) throw new PaymentsUnavailableError();
      return stripe.webhooks.constructEvent(raw, sig, webhookSecret) as unknown as PaymentsEvent;
    },
    async createConnectAccount(i) {
      const a = await stripe.accounts.create(
        { type: "express", email: i.email, capabilities: { transfers: { requested: true } }, metadata: { aix_developer_id: i.developerId } },
        { idempotencyKey: `connect:${i.developerId}` },
      );
      return a.id;
    },
    async createConnectOnboardingLink(i) {
      const l = await stripe.accountLinks.create({ account: i.accountId, refresh_url: i.refreshUrl, return_url: i.returnUrl, type: "account_onboarding" });
      return l.url;
    },
    async getConnectAccountStatus(id) {
      const a = await stripe.accounts.retrieve(id);
      if (a.payouts_enabled && a.charges_enabled !== undefined) return "enabled";
      return a.requirements?.disabled_reason ? "restricted" : "pending";
    },
    async createTransfer(i) {
      const t = await stripe.transfers.create(
        { amount: i.amountCents, currency: i.currency.toLowerCase(), destination: i.accountId, description: i.description },
        { idempotencyKey: i.idempotencyKey },
      );
      return t.id;
    },
  };
}

/** In-memory fake for tests and for running locally without Stripe keys. */
export class FakePayments implements Payments {
  checkouts: { id: string; kind: string; input: any }[] = [];
  transfers: { id: string; accountId: string; amountCents: number; idempotencyKey: string }[] = [];
  connectStatus = new Map<string, "pending" | "enabled" | "restricted">();
  private n = 0;
  /** @param checkoutBaseUrl where the fake "checkout page" lives (web app /dev-checkout). */
  constructor(private checkoutBaseUrl = "https://checkout.stripe.test") {}
  private next(p: string) { return `${p}_fake_${Date.now().toString(36)}_${++this.n}`; }
  async createTopUpCheckout(i: any) { const id = this.next("cs"); this.checkouts.push({ id, kind: "topup", input: i }); return { id, url: `${this.checkoutBaseUrl}/${id}` }; }
  async createSubscriptionCheckout(i: any) { const id = this.next("cs"); this.checkouts.push({ id, kind: "subscription", input: i }); return { id, url: `${this.checkoutBaseUrl}/${id}` }; }
  async ensureRecurringPrice() { return this.next("price"); }
  constructWebhookEvent(raw: Buffer, sig: string): PaymentsEvent {
    if (sig !== "fake-valid") throw new Error("invalid signature");
    return JSON.parse(raw.toString("utf8"));
  }
  async createConnectAccount() { const id = this.next("acct"); this.connectStatus.set(id, "pending"); return id; }
  async createConnectOnboardingLink(i: { accountId: string }) { return `https://connect.stripe.test/onboard/${i.accountId}`; }
  async getConnectAccountStatus(id: string) { return this.connectStatus.get(id) ?? "pending"; }
  async createTransfer(i: { accountId: string; amountCents: number; idempotencyKey: string }) {
    const existing = this.transfers.find((t) => t.idempotencyKey === i.idempotencyKey);
    if (existing) return existing.id;
    const id = this.next("tr");
    this.transfers.push({ id, accountId: i.accountId, amountCents: i.amountCents, idempotencyKey: i.idempotencyKey });
    return id;
  }
}
