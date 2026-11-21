import { api, money } from "@/lib/api";
import { ActionButton, ApiForm } from "@/components/client";

export default async function DevApp({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const d = await api<any>(`/developer/apps/${slug}`);
  return (
    <div className="flex flex-col gap-6">
      <div><h1 className="h1">{d.app.name}</h1><p className="muted">{d.app.manifestId} · {d.app.status} · commission {d.app.commissionBps / 100}%</p></div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card"><p className="label">Active installs</p><p className="text-2xl font-semibold">{d.analytics.activeInstalls}</p></div>
        <div className="card"><p className="label">Paid runs</p><p className="text-2xl font-semibold">{d.analytics.capturedCharges}</p></div>
        <div className="card"><p className="label">Your revenue</p><p className="text-2xl font-semibold">{money(d.analytics.developerCents)}</p><p className="muted">of {money(d.analytics.grossCents)} gross</p></div>
      </div>
      <section className="card">
        <h2 className="h2 mb-2">Versions</h2>
        <table className="table"><thead><tr><th>Version</th><th>Status</th><th>Notes</th><th>sha256</th></tr></thead><tbody>
          {d.versions.map((v: any) => <tr key={v.id}><td>{v.version}</td><td>{v.status}</td><td className="muted">{v.reviewNotes}</td><td className="font-mono text-xs">{v.sha256.slice(0, 16)}…</td></tr>)}
        </tbody></table>
      </section>
      <section className="card grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="h2 mb-2">Prices (the only prices AIX charges)</h2>
          <table className="table"><tbody>
            {d.prices.map((p: any) => <tr key={p.id}><td><code>{p.lookupKey ?? p.id}</code></td><td>{p.kind}</td><td>{money(p.unitAmountCents)} / {p.unit}{p.includedUnits ? ` (${p.includedUnits} free)` : ""}</td><td>{p.active ? <ActionButton path={`/developer/apps/${slug}/prices/${p.id}`} method="PATCH" body={{ active: false }}>Deactivate</ActionButton> : <span className="muted">inactive</span>}</td></tr>)}
          </tbody></table>
        </div>
        <ApiForm
          path={`/developer/apps/${slug}/prices`}
          submit="Add price"
          fields={[
            { name: "kind", label: "Kind", type: "select", options: ["metered", "one_time", "subscription", "free"] },
            { name: "lookupKey", label: "Lookup key (used in the SDK)", placeholder: "render", optional: true },
            { name: "unit", label: "Unit", defaultValue: "run" },
            { name: "unitAmountCents", label: "Price (€)", type: "money", defaultValue: "0.50" },
            { name: "includedUnits", label: "Free units", type: "number", defaultValue: "0" },
            { name: "interval", label: "Interval (subscriptions)", type: "select", options: ["", "month", "year"], optional: true },
          ]}
        />
      </section>
    </div>
  );
}
