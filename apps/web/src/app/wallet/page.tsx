import { redirect } from "next/navigation";
import { api, getMe, money } from "@/lib/api";
import { ActionButton, ApiForm } from "@/components/client";

const KIND: Record<string, string> = { topup: "Top-up", hold: "Reserved", capture: "Charge", release: "Released", refund: "Refund", seed: "Test money", subscription_payment: "Subscription" };

export default async function Wallet({ searchParams }: { searchParams: Promise<{ topup?: string }> }) {
  const me = await getMe();
  if (!me) redirect("/login?redirectTo=/wallet");
  const sp = await searchParams;
  const [subs, tops] = await Promise.all([api<{ data: any[] }>("/me/subscriptions"), api<{ data: any[] }>("/wallet/topups")]);
  const [w, tx, limits, inv, conns, installs] = await Promise.all([
    api<any>("/wallet"),
    api<{ data: any[] }>("/wallet/transactions?limit=50"),
    api<{ data: any[] }>("/wallet/limits"),
    api<any>("/wallet/invoices"),
    api<{ data: any[] }>("/me/connections"),
    api<{ data: any[] }>("/me/installs"),
  ]);
  const monthly = limits.data.find((l) => l.scope === "user" && l.period === "monthly");
  return (
    <div className="flex flex-col gap-6">
      {sp.topup === "success" && <p className="card text-sm text-good">Payment received — your balance updates as soon as Stripe confirms it.</p>}
      <div className="grid gap-4 md:grid-cols-3">
        <section className="card md:col-span-1">
          <p className="label">Available</p>
          <p className="text-4xl font-semibold tabular-nums" data-testid="balance">{w.display.available}</p>
          {w.heldCents > 0 && <p className="muted">{w.display.held} reserved for running work</p>}
        </section>
        <section className="card md:col-span-2">
          <h2 className="h2 mb-3">Top up</h2>
          <ApiForm path="/wallet/topup" submit="Continue to payment" fields={[{ name: "amountCents", label: "Amount (€)", type: "money", defaultValue: "20" }]} redirectField="checkoutUrl" />
          <p className="mt-2 text-xs text-muted">Stripe test mode. Minimum €5.</p>
        </section>
      </div>

      <section className="card">
        <h2 className="h2 mb-2">History</h2>
        <table className="table" data-testid="history">
          <thead><tr><th>When</th><th>What</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {tx.data.length === 0 && <tr><td colSpan={3} className="muted">No transactions yet.</td></tr>}
            {tx.data.map((t) => (
              <tr key={t.id}>
                <td className="whitespace-nowrap text-muted">{new Date(t.createdAt).toLocaleString()}</td>
                <td>{KIND[t.kind] ?? t.kind}{t.app ? ` · ${t.app.name}` : ""}{t.description && !t.app ? <span className="muted"> · {t.description}</span> : null}</td>
                <td className="text-right tabular-nums">{t.kind === "hold" || t.kind === "release" ? <span className="muted">{money(Math.abs(t.availableDeltaCents))} {t.kind === "hold" ? "reserved" : "returned"}</span> : money(t.netDeltaCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="h2 mb-1">Spend limits</h2>
          <p className="muted mb-3">Charges above the approval threshold ask you first. The monthly cap can't be exceeded, even with approval.</p>
          <ApiForm
            path="/wallet/limits"
            method="PUT"
            submit="Save limits"
            extra={{ period: "monthly" }}
            fields={[
              { name: "capCents", label: "Monthly cap (€)", type: "money", defaultValue: monthly?.capCents != null ? (monthly.capCents / 100).toFixed(2) : "" },
              { name: "autoApproveThresholdCents", label: "Ask me above (€ per charge)", type: "money", defaultValue: monthly?.autoApproveThresholdCents != null ? (monthly.autoApproveThresholdCents / 100).toFixed(2) : "" },
            ]}
            nullEmpty={["capCents", "autoApproveThresholdCents"]}
          />
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Invoices</h2>
          <p className="text-sm">This month so far: <b>{money(inv.current.totalCents)}</b> <a className="text-accent underline" href={`/api/wallet/invoices/${inv.current.period}.pdf`}>PDF</a></p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {inv.data.map((i: any) => <li key={i.id}>{i.period} — {money(i.totalCents)} · <a className="text-accent underline" href={`/api/wallet/invoices/${i.period}.pdf`}>PDF</a></li>)}
          </ul>
        </section>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <div className="mb-2 flex items-center justify-between gap-2"><h2 className="h2">Subscriptions</h2><ActionButton path="/me/billing-portal" redirectField="url">Manage payment methods</ActionButton></div>
          <ul className="flex flex-col gap-2 text-sm">
            {subs.data.length === 0 && <li className="muted">No subscriptions.</li>}
            {subs.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span><a className="underline" href={`/apps/${s.app.slug}`}>{s.app.name}</a> <span className="muted">· {s.price} · {s.status === "canceling" ? `ends ${s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : "at period end"}` : s.status}</span></span>
                {["active", "trialing"].includes(s.status) && <ActionButton path={`/me/subscriptions/${s.id}/cancel`} confirm={`Cancel ${s.app.name}? You keep access until the end of the period.`}>Cancel</ActionButton>}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Card top-ups</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {tops.data.length === 0 && <li className="muted">No card payments yet.</li>}
            {tops.data.map((t) => <li key={t.id} className="flex justify-between gap-2"><span className="muted">{new Date(t.createdAt).toLocaleDateString()}</span><span>{t.display}{t.refundedCents > 0 && <span className="muted"> · {money(t.refundedCents)} refunded</span>}</span></li>)}
          </ul>
          <p className="mt-2 text-xs text-muted">Need unused money back on your card? Contact support — refunds go back to the original card.</p>
        </section>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="h2 mb-2">Installed apps</h2>
          <ul className="flex flex-col gap-1 text-sm">{installs.data.length ? installs.data.map((i) => <li key={i.installId}><a className="underline" href={`/apps/${i.app.slug}`}>{i.app.name}</a> <span className="muted">v{i.version}{i.orgId ? " · org" : ""}</span></li>) : <li className="muted">None yet — browse the store.</li>}</ul>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Connected AI tools</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {conns.data.length === 0 && <li className="muted">None. Add the AIX MCP gateway to Claude, ChatGPT or Cursor.</li>}
            {conns.data.map((c) => <li key={c.clientId} className="flex items-center justify-between gap-2"><span>{c.name} <span className="muted">({c.scopes.join(", ")})</span></span><ActionButton path={`/me/connections/${encodeURIComponent(c.clientId)}`} method="DELETE">Revoke</ActionButton></li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
