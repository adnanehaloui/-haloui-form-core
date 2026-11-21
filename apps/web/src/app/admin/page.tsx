import { redirect } from "next/navigation";
import { api, getMe } from "@/lib/api";
import { ActionButton } from "@/components/client";

export default async function Admin() {
  const me = await getMe();
  if (!me?.isAdmin) redirect("/");
  const [q, apps, charges, ledger] = await Promise.all([api<{ data: any[] }>("/admin/reviews"), api<{ data: any[] }>("/admin/apps"), api<{ data: any[] }>("/admin/charges"), api<any>("/admin/health/ledger")]);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between"><h1 className="h1">Admin</h1><span className={`pill ${ledger.balanced ? "text-good" : "text-bad"}`}>ledger {ledger.balanced ? "balanced" : "UNBALANCED"}</span></div>
      <section className="card">
        <h2 className="h2 mb-2">Review queue</h2>
        {q.data.length === 0 && <p className="muted">Nothing to review.</p>}
        {q.data.map((v) => (
          <div key={v.versionId} className="mb-4 border-t border-line pt-3" data-testid="review-item">
            <p><b>{v.app.name}</b> {v.version} <span className="pill">{v.app.type}</span> <span className="muted">by {v.developer}</span></p>
            <p className="muted">{v.manifest.description}</p>
            <p className="text-xs text-muted">Permissions: {JSON.stringify(v.manifest.permissions)} · entry: {JSON.stringify(v.manifest.entry)} · sha256 {v.sha256.slice(0, 16)}…</p>
            <div className="mt-2 flex gap-2">
              <ActionButton className="btn-primary" path={`/admin/versions/${v.versionId}/approve`}>Approve</ActionButton>
              <ActionButton path={`/admin/versions/${v.versionId}/reject`} body={{ notes: "Rejected by reviewer" }}>Reject</ActionButton>
            </div>
          </div>
        ))}
      </section>
      <section className="card">
        <h2 className="h2 mb-2">Apps</h2>
        <table className="table"><tbody>{apps.data.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.status}</td><td>{a.status === "suspended" ? <ActionButton path={`/admin/apps/${a.id}/unsuspend`}>Unsuspend</ActionButton> : <ActionButton path={`/admin/apps/${a.id}/suspend`} confirm={`Suspend ${a.name}?`}>Suspend</ActionButton>}</td></tr>)}</tbody></table>
      </section>
      <section className="card">
        <h2 className="h2 mb-2">Recent charges</h2>
        <table className="table"><tbody>{charges.data.map((c) => <tr key={c.id}><td className="font-mono text-xs">{c.id}</td><td>{c.appName}</td><td>{c.userEmail}</td><td>{c.status}</td><td>{c.display}</td><td>{c.status === "captured" && c.amountCents > 0 && <ActionButton path={`/admin/charges/${c.id}/refund`} body={{ reason: "Refund issued by support" }} confirm={`Refund ${c.display}?`}>Refund</ActionButton>}</td></tr>)}</tbody></table>
      </section>
    </div>
  );
}
