import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { developers, invoices, payouts, users } from "@aix/db";
import type { App, Deps } from "../context.js";
import { requireUser } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { PaymentsUnavailableError } from "../lib/payments.js";
import { computeInvoice, renderInvoicePdf } from "../services/invoices.js";
import { developerStatement, previousPeriod } from "../services/payouts.js";
import { requireDeveloper } from "./developer.js";
import { resolveWallet } from "./wallet.js";

const period = z.string().regex(/^\d{4}-\d{2}$/);

export async function billingRoutes(app: App, deps: Deps) {
  // ---- Stripe Connect (developer payouts) ----
  app.post("/developer/connect/onboard", { schema: { tags: ["developer"] } }, async (req) => {
    const { developer, userId } = await requireDeveloper(deps, req);
    if (!deps.payments) throw new PaymentsUnavailableError();
    let accountId = developer.stripeConnectAccountId;
    if (!accountId) {
      const [u] = userId ? await deps.db.select().from(users).where(eq(users.id, userId)) : [];
      accountId = await deps.payments.createConnectAccount({ developerId: developer.id, email: u?.email ?? "" });
      await deps.db.update(developers).set({ stripeConnectAccountId: accountId, payoutStatus: "pending" }).where(eq(developers.id, developer.id));
    }
    const url = await deps.payments.createConnectOnboardingLink({
      accountId,
      refreshUrl: `${deps.config.AIX_WEB_URL}/developer/payouts?connect=refresh`,
      returnUrl: `${deps.config.AIX_WEB_URL}/developer/payouts?connect=done`,
    });
    return { url, accountId };
  });

  app.get("/developer/connect/status", { schema: { tags: ["developer"] } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    if (!developer.stripeConnectAccountId || !deps.payments) return { status: developer.payoutStatus, connected: false };
    const status = await deps.payments.getConnectAccountStatus(developer.stripeConnectAccountId);
    await deps.db.update(developers).set({ payoutStatus: status }).where(eq(developers.id, developer.id));
    return { status, connected: true };
  });

  app.get("/developer/statements/:period", { schema: { tags: ["developer"], params: z.object({ period }) } }, async (req) => {
    const { developer } = await requireDeveloper(deps, req);
    const [p] = await deps.db.select().from(payouts).where(and(eq(payouts.developerId, developer.id), eq(payouts.period, req.params.period)));
    return { statement: await developerStatement(deps, developer.id, req.params.period), payout: p ?? null };
  });

  // ---- Monthly invoices (user or org wallet) ----
  app.get("/wallet/invoices", { schema: { tags: ["wallet"], querystring: z.object({ orgId: z.string().optional() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    const w = await resolveWallet(deps, u, req.query.orgId, true);
    const stored = await deps.db.select().from(invoices).where(eq(invoices.walletId, w.id)).orderBy(desc(invoices.period));
    const now = deps.now();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const live = await computeInvoice(deps, w.id, current);
    return { current: { ...live, draft: true }, data: stored, lastClosedPeriod: previousPeriod(now) };
  });

  app.get("/wallet/invoices/:period.pdf", { schema: { tags: ["wallet"], params: z.object({ period }), querystring: z.object({ orgId: z.string().optional() }) } }, async (req, reply) => {
    const u = await requireUser(deps, req);
    const w = await resolveWallet(deps, u, req.query.orgId, true);
    if (!w) throw notFound();
    const pdf = await renderInvoicePdf(deps, w.id, req.params.period);
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="aix-invoice-${req.params.period}.pdf"`).send(pdf);
  });
}
