import { api, apiOrNull, money } from "@/lib/api";
import { ActionButton, ApiForm } from "@/components/client";

export default async function Org({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await apiOrNull<any>(`/orgs/${id}`);
  if (!org) return <p className="muted">Organization not found.</p>;
  const admin = ["owner", "admin"].includes(org.myRole);
  const finance = admin || org.myRole === "billing";
  const [members, policies, wallet, budgets, store, auditRows, charges] = await Promise.all([
    api<any[]>(`/orgs/${id}/members`),
    api<{ data: any[] }>(`/orgs/${id}/policies`),
    api<any>(`/wallet?orgId=${id}`),
    finance ? api<{ data: any[] }>(`/orgs/${id}/budgets`) : { data: [] },
    api<{ data: any[] }>("/store/apps"),
    admin ? api<{ data: any[] }>(`/orgs/${id}/audit?limit=20`) : { data: [] },
    finance ? api<{ data: any[] }>(`/wallet/charges?orgId=${id}&limit=20`) : { data: [] },
  ]);
  return (
    <div className="flex flex-col gap-6">
      <div><h1 className="h1">{org.name}</h1><p className="muted">You are {org.myRole} · catalog: {org.catalogMode === "approved_only" ? "approved apps only" : "open"}</p></div>
      <div className="grid gap-4 md:grid-cols-3">
        <section className="card"><p className="label">Org wallet</p><p className="text-3xl font-semibold">{wallet.display.available}</p>{wallet.heldCents > 0 && <p className="muted">{wallet.display.held} reserved</p>}</section>
        {finance && <section className="card md:col-span-2"><h2 className="h2 mb-2">Top up org wallet</h2><ApiForm path="/wallet/topup" submit="Continue to payment" extra={{ orgId: id }} fields={[{ name: "amountCents", label: "Amount (€)", type: "money", defaultValue: "100" }]} redirectField="checkoutUrl" /></section>}
      </div>

      <section className="card grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="h2 mb-2">Members</h2>
          <table className="table"><tbody>{members.map((m) => <tr key={m.userId}><td>{m.email}</td><td><span className="pill">{m.role}</span></td><td>{admin && <ActionButton path={`/orgs/${id}/members/${m.userId}`} method="DELETE" confirm={`Remove ${m.email}?`}>Remove</ActionButton>}</td></tr>)}</tbody></table>
        </div>
        {admin && <ApiForm path={`/orgs/${id}/members`} submit="Add member" fields={[{ name: "email", label: "Email", type: "email" }, { name: "role", label: "Role", type: "select", options: ["member", "billing", "admin", "owner"] }]} />}
      </section>

      <section className="card flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">Approved catalog</h2>
          {admin && (org.catalogMode === "open"
            ? <ActionButton path={`/orgs/${id}/catalog`} method="PUT" body={{ mode: "approved_only" }}>Allow approved apps only</ActionButton>
            : <ActionButton path={`/orgs/${id}/catalog`} method="PUT" body={{ mode: "open" }}>Open catalog</ActionButton>)}
        </div>
        <table className="table"><thead><tr><th>App</th><th>Policy</th><th>Roles</th><th></th></tr></thead><tbody>
          {store.data.map((a) => {
            const p = policies.data.find((x) => x.appId === a.id);
            return (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{p ? (p.allowed ? <span className="text-good">allowed</span> : <span className="text-bad">blocked</span>) : <span className="muted">{org.catalogMode === "approved_only" ? "not approved" : "default"}</span>}</td>
                <td className="muted">{p?.allowed ? p.allowedRoles.join(", ") : ""}</td>
                <td className="flex gap-2">{admin && <>
                  <ActionButton path={`/orgs/${id}/policies/${a.id}`} method="PUT" body={{ allowed: true }}>Allow</ActionButton>
                  <ActionButton path={`/orgs/${id}/policies/${a.id}`} method="PUT" body={{ allowed: true, allowedRoles: ["owner", "admin"] }}>Admins only</ActionButton>
                  <ActionButton path={`/orgs/${id}/policies/${a.id}`} method="PUT" body={{ allowed: false }}>Block</ActionButton>
                </>}</td>
              </tr>
            );
          })}
        </tbody></table>
      </section>

      {finance && (
        <section className="card grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="h2 mb-2">Per-member budgets</h2>
            <table className="table"><tbody>{budgets.data.map((b) => <tr key={b.id}><td>{b.email ?? "Every member (default)"}</td><td>{b.period}</td><td>{b.capCents != null ? money(b.capCents) : "no cap"}</td><td className="muted">ask above {b.autoApproveThresholdCents != null ? money(b.autoApproveThresholdCents) : "—"}</td></tr>)}</tbody></table>
          </div>
          <ApiForm
            path={`/orgs/${id}/budgets`}
            method="PUT"
            submit="Set budget"
            fields={[
              { name: "userId", label: "Member", type: "select", options: [{ label: "Every member", value: "" }, ...members.map((m) => ({ label: m.email, value: m.userId }))] },
              { name: "period", label: "Period", type: "select", options: ["monthly", "daily"] },
              { name: "capCents", label: "Cap (€)", type: "money", defaultValue: "50" },
              { name: "autoApproveThresholdCents", label: "Ask above (€ per charge)", type: "money", defaultValue: "1" },
            ]}
            nullEmpty={["userId"]}
          />
        </section>
      )}

      {finance && (
        <section className="card">
          <h2 className="h2 mb-2">Recent charges</h2>
          <table className="table"><tbody>{charges.data.map((c) => <tr key={c.id}><td>{c.appName}</td><td className="muted">{c.userEmail}</td><td>{c.status}</td><td className="text-right">{c.display}</td></tr>)}</tbody></table>
        </section>
      )}

      {admin && (
        <section className="card">
          <div className="mb-2 flex items-center justify-between"><h2 className="h2">Audit log</h2><a className="btn" href={`/api/orgs/${id}/audit.csv`}>Export CSV</a></div>
          <table className="table"><tbody>{auditRows.data.map((e) => <tr key={e.id}><td className="whitespace-nowrap text-muted">{new Date(e.createdAt).toLocaleString()}</td><td>{e.actorEmail ?? e.actorType}</td><td><code>{e.action}</code></td></tr>)}</tbody></table>
        </section>
      )}
    </div>
  );
}
