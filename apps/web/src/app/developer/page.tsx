import Link from "next/link";
import { redirect } from "next/navigation";
import { api, getMe } from "@/lib/api";
import { ActionButton, ApiForm } from "@/components/client";
import { NewKey } from "./new-key";

export default async function Developer() {
  const me = await getMe();
  if (!me) redirect("/login?redirectTo=/developer");
  if (!me.developer)
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 py-8">
        <h1 className="h1">Sell your AI app on AIX</h1>
        <p className="muted">Publish with the SDK and get paid — no login or billing code. AIX keeps 20%, you get 80%.</p>
        <ApiForm path="/developer" submit="Become a developer" fields={[{ name: "displayName", label: "Developer name", placeholder: "Acme Labs" }]} />
      </div>
    );
  const [d, keys, clients] = await Promise.all([api<any>("/developer"), api<{ data: any[] }>("/developer/keys"), api<{ data: any[] }>("/developer/oauth-clients")]);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="h1">{d.developer.displayName}</h1><p className="muted">Unpaid balance {d.payableDisplay} · payouts {d.developer.payoutStatus}</p></div>
        <Link className="btn" href="/developer/payouts">Payouts</Link>
      </div>
      <section className="card">
        <h2 className="h2 mb-2">Apps</h2>
        {d.apps.length === 0 && <p className="muted">No apps yet. Run <code>aix app init --template server</code> then <code>aix app publish</code>.</p>}
        <table className="table"><tbody>
          {d.apps.map((a: any) => <tr key={a.id}><td><Link className="underline" href={`/developer/apps/${a.slug}`}>{a.name}</Link></td><td><span className="pill">{a.type}</span></td><td>{a.status}</td></tr>)}
        </tbody></table>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card flex flex-col gap-3">
          <h2 className="h2">Secret keys</h2>
          <p className="muted">Server-side only. Use with <code>aix login</code> and <code>@aix/sdk</code>.</p>
          <NewKey />
          <table className="table"><tbody>
            {keys.data.map((k) => <tr key={k.id}><td><code>{k.prefix}…</code> {k.name}</td><td className="muted">{k.revokedAt ? "revoked" : k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "never used"}</td><td>{!k.revokedAt && <ActionButton path={`/developer/keys/${k.id}`} method="DELETE" confirm="Revoke this key?">Revoke</ActionButton>}</td></tr>)}
          </tbody></table>
        </section>
        <section className="card flex flex-col gap-3">
          <h2 className="h2">Sign in with AIX (OAuth clients)</h2>
          <ApiForm path="/developer/oauth-clients" submit="Create client" fields={[{ name: "name", label: "Name" }, { name: "redirectUris", label: "Redirect URI", placeholder: "https://myapp.com/callback" }]} arrays={["redirectUris"]} showResult={{ title: "Copy the secret now — it won't be shown again:", fields: ["clientId", "clientSecret"] }} />
          <ul className="text-sm">{clients.data.map((c) => <li key={c.id}><code>{c.id}</code> {c.name}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}
