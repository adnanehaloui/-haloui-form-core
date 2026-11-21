/**
 * Transactional emails. Plain text (renders everywhere, nothing to escape). Sending never breaks a money
 * flow: callers run these AFTER the database transaction commits, and failures are logged and dropped.
 */
import { and, eq, inArray } from "drizzle-orm";
import { orgMembers, organizations, users, wallets } from "@aix/db";
import { formatMoney } from "@aix/core";
import type { Deps } from "../context.js";
import type { Mail } from "../lib/mailer.js";

export async function sendSafe(deps: Deps, mail: Mail) {
  try {
    await deps.mailer.send(mail);
  } catch (e: any) {
    console.warn(`[aix] email to ${mail.to.replace(/(.).*@/, "$1…@")} failed: ${e.message}`);
  }
}

/** Who gets mail about a wallet: its user, or an org's owners + billing members. */
export async function walletRecipients(deps: Deps, walletId: string): Promise<{ emails: string[]; label: string }> {
  const [w] = await deps.db.select().from(wallets).where(eq(wallets.id, walletId));
  if (!w) return { emails: [], label: "" };
  if (w.ownerUserId) {
    const [u] = await deps.db.select().from(users).where(eq(users.id, w.ownerUserId));
    return { emails: u && !u.deletedAt ? [u.email] : [], label: "your AIX wallet" };
  }
  const [org] = await deps.db.select().from(organizations).where(eq(organizations.id, w.ownerOrgId!));
  const rows = await deps.db.select({ email: users.email }).from(orgMembers).innerJoin(users, eq(users.id, orgMembers.userId)).where(and(eq(orgMembers.orgId, w.ownerOrgId!), inArray(orgMembers.role, ["owner", "billing"])));
  return { emails: rows.map((r) => r.email), label: `the ${org?.name ?? "organization"} wallet` };
}

const footer = (deps: Deps) => `\n\n—\nAIX · ${deps.config.AIX_WEB_URL}\nManage limits and receipts: ${deps.config.AIX_WEB_URL}/wallet`;

export async function emailTopUpReceipt(deps: Deps, walletId: string, amountCents: number, ref: string) {
  const r = await walletRecipients(deps, walletId);
  for (const to of r.emails) {
    await sendSafe(deps, { to, subject: `Receipt: ${formatMoney(amountCents)} added to ${r.label}`, text: `Thanks! We added ${formatMoney(amountCents)} to ${r.label}.\n\nReference: ${ref}${footer(deps)}` });
  }
}

export async function emailRefund(deps: Deps, walletId: string, amountCents: number, kind: "card_refund" | "dispute" | "dispute_won") {
  const r = await walletRecipients(deps, walletId);
  const text =
    kind === "card_refund"
      ? `We refunded ${formatMoney(amountCents)} from ${r.label} to your card. It usually arrives within 5–10 business days.`
      : kind === "dispute"
        ? `Your bank opened a dispute for ${formatMoney(amountCents)}. We removed that amount from ${r.label} while it's reviewed. Reply to this email if this wasn't you.`
        : `The bank dispute for ${formatMoney(amountCents)} is closed and the amount is back in ${r.label}.`;
  for (const to of r.emails) await sendSafe(deps, { to, subject: kind === "card_refund" ? `Refund of ${formatMoney(amountCents)} on its way` : "About a payment dispute", text: text + footer(deps) });
}

export async function emailInvoice(deps: Deps, walletId: string, period: string, totalCents: number, pdf: Buffer) {
  const r = await walletRecipients(deps, walletId);
  for (const to of r.emails) {
    await sendSafe(deps, {
      to,
      subject: `Your AIX statement for ${period}: ${formatMoney(totalCents)}`,
      text: `Attached is the statement for ${r.label}, ${period}. It lists every app you paid for this month.${footer(deps)}`,
      attachments: [{ filename: `aix-statement-${period}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
  }
}

export async function emailPayout(deps: Deps, email: string, period: string, amountCents: number, status: string, reason?: string) {
  const text = status === "paid" ? `We sent ${formatMoney(amountCents)} to your Stripe account for ${period}.` : `Your payout for ${period} (${formatMoney(amountCents)}) was ${status}${reason ? `: ${reason}` : ""}.`;
  await sendSafe(deps, { to: email, subject: `AIX payout ${period}: ${status === "paid" ? formatMoney(amountCents) : status}`, text: `${text}\n\nStatement: ${deps.config.AIX_WEB_URL}/developer/payouts${footer(deps)}` });
}
