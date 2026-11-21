/**
 * Monthly user/org invoices: one per wallet per month, one line per app.
 * Built from captured (and later refunded) charges; top-ups are listed separately.
 */
import PDFDocument from "pdfkit";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { apps, charges, invoices, ledgerTransactions, organizations, users, wallets } from "@aix/db";
import { formatMoney, newId } from "@aix/core";
import type { Deps } from "../context.js";
import { periodBounds } from "./payouts.js";
import { computeTax } from "./tax.js";

export interface InvoiceLine { appId: string; appName: string; charges: number; amountCents: number; refundedCents: number }

export async function computeInvoice(deps: Deps, walletId: string, period: string) {
  const { start, end } = periodBounds(period);
  const rows = await deps.db
    .select({
      appId: charges.appId,
      appName: apps.name,
      n: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${charges.amountCents}),0)`,
      refunded: sql<string>`coalesce(sum(${charges.amountCents}) filter (where ${charges.status} = 'refunded'),0)`,
    })
    .from(charges)
    .innerJoin(apps, eq(apps.id, charges.appId))
    .where(and(eq(charges.walletId, walletId), inArray(charges.status, ["captured", "refunded"]), gte(charges.capturedAt, start), lt(charges.capturedAt, end)))
    .groupBy(charges.appId, apps.name);
  const lines: InvoiceLine[] = rows.map((r) => ({ appId: r.appId, appName: r.appName, charges: r.n, amountCents: Number(r.amount), refundedCents: Number(r.refunded) }));
  const totalCents = lines.reduce((n, l) => n + l.amountCents - l.refundedCents, 0);
  const topups = await deps.db
    .select({ s: sql<string>`coalesce(sum(e.amount_cents),0)` })
    .from(ledgerTransactions)
    .innerJoin(sql`ledger_entries e`, sql`e.transaction_id = ${ledgerTransactions.id} and e.account_id = ${`acct_${walletId}_available`}`)
    .where(and(eq(ledgerTransactions.kind, "topup"), gte(ledgerTransactions.createdAt, start), lt(ledgerTransactions.createdAt, end)));
  return { period, lines, totalCents, topUpsCents: Number(topups[0]?.s ?? 0) };
}

/** Job: create (or refresh) invoices for every wallet with activity in the period. */
export async function runInvoices(deps: Deps, period: string) {
  const all = await deps.db.select({ id: wallets.id }).from(wallets);
  let n = 0;
  for (const w of all) {
    const inv = await computeInvoice(deps, w.id, period);
    if (inv.lines.length === 0) continue;
    await deps.db
      .insert(invoices)
      .values({ id: newId("inv"), walletId: w.id, period, totalCents: inv.totalCents, lines: inv.lines })
      .onConflictDoUpdate({ target: [invoices.walletId, invoices.period], set: { totalCents: inv.totalCents, lines: inv.lines } });
    n++;
  }
  return n;
}

export async function renderInvoicePdf(deps: Deps, walletId: string, period: string): Promise<Buffer> {
  const inv = await computeInvoice(deps, walletId, period);
  const [w] = await deps.db.select().from(wallets).where(eq(wallets.id, walletId));
  let billTo = "";
  if (w?.ownerUserId) billTo = (await deps.db.select().from(users).where(eq(users.id, w.ownerUserId)))[0]?.email ?? "";
  if (w?.ownerOrgId) billTo = (await deps.db.select().from(organizations).where(eq(organizations.id, w.ownerOrgId)))[0]?.name ?? "";
  const tax = computeTax({ country: null, subtotalCents: inv.totalCents, isBusiness: !!w?.ownerOrgId });

  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `AIX invoice ${period}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise<Buffer>((ok) => doc.on("end", () => ok(Buffer.concat(chunks))));

  doc.fontSize(20).text("AIX", { continued: true }).fontSize(12).fillColor("#666").text("   monthly statement");
  doc.moveDown().fillColor("#000").fontSize(10).text(`Period: ${period}`).text(`Wallet: ${walletId}`).text(`Billed to: ${billTo}`).moveDown();
  doc.fontSize(11).text("App", 50, doc.y, { width: 260, continued: false });
  const header = doc.y - 13;
  doc.text("Charges", 320, header, { width: 70, align: "right" }).text("Amount", 400, header, { width: 140, align: "right" });
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke("#ccc").moveDown(0.5);
  for (const l of inv.lines) {
    const y = doc.y;
    doc.fontSize(10).text(l.appName, 50, y, { width: 260 }).text(String(l.charges), 320, y, { width: 70, align: "right" }).text(formatMoney(l.amountCents), 400, y, { width: 140, align: "right" });
    if (l.refundedCents) {
      const y2 = doc.y;
      doc.fillColor("#666").text("  refunded", 50, y2, { width: 260 }).text(`-${formatMoney(l.refundedCents)}`, 400, y2, { width: 140, align: "right" }).fillColor("#000");
    }
  }
  if (inv.lines.length === 0) doc.fontSize(10).fillColor("#666").text("No app charges this month.").fillColor("#000");
  doc.moveDown().moveTo(50, doc.y).lineTo(545, doc.y).stroke("#ccc").moveDown(0.5);
  const yt = doc.y;
  doc.fontSize(12).text("Total", 50, yt).text(formatMoney(inv.totalCents), 400, yt, { width: 140, align: "right" });
  doc.moveDown().fontSize(9).fillColor("#666").text(`Wallet top-ups this month: ${formatMoney(inv.topUpsCents)}`).text(tax.note);
  doc.end();
  return done;
}
