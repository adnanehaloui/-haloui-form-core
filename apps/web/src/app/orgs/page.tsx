import Link from "next/link";
import { redirect } from "next/navigation";
import { getMe } from "@/lib/api";
import { ApiForm } from "@/components/client";

export default async function Orgs() {
  const me = await getMe();
  if (!me) redirect("/login?redirectTo=/orgs");
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="card">
        <h1 className="h2 mb-2">Your organizations</h1>
        <ul className="flex flex-col gap-1">{me.orgs.length ? me.orgs.map((o) => <li key={o.id}><Link className="underline" href={`/orgs/${o.id}`}>{o.name}</Link> <span className="pill">{o.role}</span></li>) : <li className="muted">None yet.</li>}</ul>
      </section>
      <section className="card">
        <h2 className="h2 mb-2">Create an organization</h2>
        <ApiForm path="/orgs" submit="Create" fields={[{ name: "name", label: "Name", placeholder: "Acme Corp" }, { name: "slug", label: "Slug", placeholder: "acme" }]} redirectTemplate="/orgs/{id}" />
      </section>
    </div>
  );
}
