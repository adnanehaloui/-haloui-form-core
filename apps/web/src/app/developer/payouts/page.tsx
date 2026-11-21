import { api, money } from "@/lib/api";
import { ActionButton } from "@/components/client";

export default async function Payouts() {
  const [d, status, p] = await Promise.all([api<any>("/developer"), api<any>("/developer/connect/status"), api<{ data: any[] }>("/developer/payouts")]);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="h1">Payouts</h1>
      <section className="card flex flex-wrap items-center justify-between gap-3">
        <div><p className="label">Unpaid balance</p><p className="text-3xl font-semibold">{d.payableDisplay}</p><p className="muted">Paid monthly via Stripe Connect · status: {status.status}</p></div>
        {status.status !== "enabled" && <ActionButton className="btn-primary" path="/developer/connect/onboard" redirectField="url">{status.connected ? "Finish Stripe onboarding" : "Set up payouts with Stripe"}</ActionButton>}
      </section>
      <section className="card">
        <h2 className="h2 mb-2">History</h2>
        <table className="table"><thead><tr><th>Period</th><th>Status</th><th>Amount</th><th>Apps</th></tr></thead><tbody>
          {p.data.length === 0 && <tr><td colSpan={4} className="muted">No payouts yet.</td></tr>}
          {p.data.map((x) => (
            <tr key={x.id}><td>{x.period}</td><td>{x.status}{x.statement.reason ? <span className="muted"> — {x.statement.reason}</span> : null}</td><td>{money(x.amountCents)}</td>
              <td className="text-xs">{x.statement.apps?.filter((a: any) => a.charges).map((a: any) => <div key={a.appId}>{a.appName}: {a.charges} runs, {money(a.grossCents)} gross → {money(a.developerCents)} to you</div>)}</td></tr>
          ))}
        </tbody></table>
      </section>
    </div>
  );
}
