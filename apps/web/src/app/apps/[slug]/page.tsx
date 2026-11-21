import { notFound } from "next/navigation";
import { api, ApiError, getMe } from "@/lib/api";
import { ApiForm } from "@/components/client";
import { InstallPanel, SubscribeButton } from "./install";

export default async function AppPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const app = await api<any>(`/store/apps/${slug}`).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  if (!app) notFound();
  const me = await getMe();
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="h1">{app.name}</h1>
            <span className="pill">{app.type}</span>
            <span className="pill">v{app.version}</span>
          </div>
          <p className="muted mt-1">by {app.developer} · {app.category}</p>
        </div>
        <p className="text-base">{app.description}</p>
        <section className="card">
          <h2 className="h2 mb-2">Works in</h2>
          <div className="flex flex-wrap gap-2">{app.hosts.map((h: string) => <span key={h} className="pill">{h}</span>)}</div>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Reviews</h2>
          {app.reviews.length === 0 && <p className="muted">No reviews yet.</p>}
          <ul className="flex flex-col gap-3">
            {app.reviews.map((r: any, i: number) => (
              <li key={i}><span className="font-medium">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span> <span className="muted">— {r.name}</span><p className="text-sm">{r.body}</p></li>
            ))}
          </ul>
          {app.me?.installed && (
            <div className="mt-4 border-t border-line pt-4">
              <ApiForm path={`/store/apps/${slug}/reviews`} submit="Post review" fields={[{ name: "rating", label: "Rating (1–5)", type: "number", defaultValue: "5" }, { name: "body", label: "Review", type: "textarea", optional: true }]} />
            </div>
          )}
        </section>
        <p className="text-xs text-muted">Package sha256 {app.sha256}</p>
      </div>
      <aside className="flex flex-col gap-4">
        <section className="card">
          <h2 className="h2 mb-2">Pricing</h2>
          <ul className="flex flex-col gap-1 text-sm">{app.prices.length ? app.prices.map((p: any) => <li key={p.id}>{p.label}</li>) : <li>Free</li>}</ul>
          <p className="mt-2 text-xs text-muted">Paid from your AIX wallet, per unit of work — never by your AI tool's tokens.</p>
        </section>
        <InstallPanel slug={slug} signedIn={!!me} me={app.me} permissionLines={app.permissionLines} orgs={me?.orgs ?? []} />
        {app.me?.installed && app.prices.filter((p: any) => p.kind === "subscription").map((p: any) => <SubscribeButton key={p.id} slug={slug} priceId={p.id} label={p.label} />)}
      </aside>
    </div>
  );
}
