import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError, getMe } from "@/lib/api";
import { CATEGORY, HOSTS, compactNumber, hashColor } from "@/lib/ui";
import { ApiForm } from "@/components/client";
import { AppIcon, AppRow, ChatPreview, ShowcaseCard, Stars, type AppSummary } from "@/components/store";
import { InstallPanel, SubscribeButton } from "./install";
import { UseIn, type ConnectInfo } from "@/components/use-in";

const PERM_ICON = (l: string) => (l.startsWith("Connect") ? "🌐" : l.startsWith("Access files") ? "📁" : l.startsWith("Read your") ? "👤" : l.startsWith("Run code") ? "💻" : "🛡️");

export default async function AppPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const app = await api<any>(`/store/apps/${slug}`).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
  if (!app) notFound();
  const me = await getMe();
  const info = await api<ConnectInfo>("/store/connect-info");
  const skills = app.type === "prompt" && app.me?.installed ? (await api<{ skills: { name: string; description: string }[] }>(`/store/apps/${slug}/skills`).catch(() => ({ skills: [] }))).skills : [];
  const color = app.color ?? hashColor(app.slug);
  const paid = app.prices.find((p: any) => p.unitAmountCents > 0);
  const price = paid?.label ?? "Free";
  const isSub = paid?.kind === "subscription";
  const dist = [5, 4, 3, 2, 1].map((n) => ({ n, c: app.reviews.filter((r: any) => r.rating === n).length }));
  const maxC = Math.max(1, ...dist.map((d) => d.c));

  return (
    <div className="flex flex-col gap-10">
      {/* Header */}
      <section className="relative -mx-4 overflow-hidden rounded-[28px] px-4 py-8 md:mx-0 md:px-8" style={{ background: `linear-gradient(180deg, color-mix(in oklab, ${color} 16%, transparent), transparent)` }}>
        <div className="flex flex-col gap-6 md:flex-row md:items-center">
          <AppIcon app={app} size={128} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{app.name}</h1>
            <p className="text-lg text-muted">{app.tagline ?? app.description}</p>
            <p className="text-sm"><span className="font-medium" style={{ color }}>{app.developer}</span> <span className="text-muted">· {CATEGORY[app.category]?.label} · v{app.version}</span></p>
          </div>
          <div className="w-full md:w-72"><InstallPanel slug={slug} signedIn={!!me} me={app.me} permissionLines={app.permissionLines} orgs={me?.orgs ?? []} price={price} /></div>
        </div>
        <dl className="mt-8 grid grid-cols-2 divide-line border-t border-line pt-5 text-center sm:grid-cols-4 sm:divide-x">
          <div><dt className="text-xs uppercase tracking-wide text-muted">Rating</dt><dd className="mt-1 text-xl font-semibold">{app.rating ? <>{app.rating.average} <span className="text-base text-amber-500">★</span></> : "—"}</dd><dd className="text-xs text-muted">{app.rating ? `${app.rating.count} ratings` : "No ratings yet"}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted">Installs</dt><dd className="mt-1 text-xl font-semibold">{compactNumber(app.installs)}</dd><dd className="text-xs text-muted">active</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted">Price</dt><dd className="mt-1 text-xl font-semibold">{price.split(" (")[0]}</dd><dd className="text-xs text-muted">{app.prices.some((p: any) => p.includedUnits) ? `${app.prices.find((p: any) => p.includedUnits).includedUnits} free to start` : isSub ? "subscription" : paid ? "from your AIX wallet" : "no charge"}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-muted">Works in</dt><dd className="mt-1 text-xl font-semibold">{app.hosts.length}</dd><dd className="text-xs text-muted">{app.hosts.map((h: string) => HOSTS[h] ?? h).join(" · ")}</dd></div>
        </dl>
      </section>

      <UseIn app={{ slug, name: app.name, type: app.type, entry: app.entry }} info={info} installed={!!app.me?.installed} skills={skills} example={app.showcase[0]?.input} />

      {/* Results */}
      {app.showcase.length > 0 && (
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">See what it makes</h2>
            <p className="text-sm text-muted">Example results — what you ask, and what {app.name} gives back.</p>
          </div>
          <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:thin]">
            {app.showcase.map((s: any, i: number) => <div key={i} className="w-[min(85vw,380px)] shrink-0 snap-start"><ShowcaseCard item={s} /></div>)}
          </div>
        </section>
      )}

      {app.screenshots.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">Screenshots</h2>
          <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {app.screenshots.map((u: string) => <img key={u} src={u} alt="" className="h-72 shrink-0 snap-start rounded-2xl border border-line object-cover" />)}
          </div>
        </section>
      )}

      <div className="grid gap-10 lg:grid-cols-[1.15fr_1fr]">
        <div className="flex flex-col gap-10">
          <section className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">About</h2>
            <p className="leading-relaxed">{app.description}</p>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">Permissions</h2>
            <p className="text-sm text-muted">Everything this app declared. You approve it once at install; AIX enforces it.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {app.permissionLines.map((l: string) => (
                <div key={l} className="flex items-start gap-3 rounded-2xl border border-line p-4"><span className="text-xl">{PERM_ICON(l)}</span><span className="text-sm">{l}</span></div>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">Ratings & reviews</h2>
            <div className="flex items-center gap-6">
              <div className="text-center"><p className="text-5xl font-bold">{app.rating?.average ?? "—"}</p><p className="text-xs text-muted">out of 5</p></div>
              <div className="flex flex-1 flex-col gap-1">
                {dist.map((d) => (
                  <div key={d.n} className="flex items-center gap-2 text-xs"><span className="w-16 shrink-0 text-right text-[10px] tracking-tight text-amber-500">{"★".repeat(d.n)}</span><span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-ink/70" style={{ width: `${(d.c / maxC) * 100}%` }} /></span></div>
                ))}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {app.reviews.length === 0 && <p className="text-sm text-muted">No reviews yet — be the first.</p>}
              {app.reviews.map((r: any, i: number) => (
                <div key={i} className="flex flex-col gap-1 rounded-2xl bg-card p-4">
                  <div className="flex items-center justify-between"><Stars value={r.rating} /><span className="text-xs text-muted">{new Date(r.createdAt).toLocaleDateString()}</span></div>
                  <p className="text-sm">{r.body}</p>
                  <p className="text-xs text-muted">{r.name}</p>
                </div>
              ))}
            </div>
            {app.me?.installed && (
              <details className="rounded-2xl border border-line p-4">
                <summary className="cursor-pointer text-sm font-medium text-accent">Write a review</summary>
                <div className="mt-3"><ApiForm path={`/store/apps/${slug}/reviews`} submit="Post review" fields={[{ name: "rating", label: "Rating (1–5)", type: "number", defaultValue: "5" }, { name: "body", label: "Review", type: "textarea", optional: true }]} /></div>
              </details>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          {app.showcase[0] && (
            <section className="flex flex-col gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">How it runs in your AI</h2>
              <ChatPreview app={app} item={app.showcase[0]} price={price} subscription={isSub} />
            </section>
          )}
          <section className="rounded-2xl border border-line p-5">
            <h2 className="mb-3 font-semibold">Pricing</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {(app.prices.length ? app.prices : [{ id: "free", label: "Free" }]).map((p: any) => <li key={p.id} className="flex items-center justify-between gap-2"><span>{p.label}</span>{p.kind && <span className="pill">{p.kind.replace("_", " ")}</span>}</li>)}
            </ul>
            <p className="mt-3 text-xs text-muted">{isSub ? "Monthly subscription billed by card through AIX — cancel any time." : paid ? "Billed per unit of work from your AIX wallet — never by your AI tool's tokens. Charges above your threshold ask you first." : "Free to use."}</p>
            {app.me?.installed && app.prices.filter((p: any) => p.kind === "subscription").map((p: any) => <div key={p.id} className="mt-3"><SubscribeButton slug={slug} priceId={p.id} label={p.label} /></div>)}
          </section>
          <section className="rounded-2xl border border-line p-5 text-sm">
            <h2 className="mb-3 font-semibold">Information</h2>
            <dl className="grid grid-cols-[110px_1fr] gap-y-2">
              <dt className="text-muted">Developer</dt><dd>{app.developer}</dd>
              <dt className="text-muted">Category</dt><dd>{CATEGORY[app.category]?.label}</dd>
              <dt className="text-muted">Type</dt><dd className="capitalize">{app.type} app</dd>
              <dt className="text-muted">Version</dt><dd>{app.version}</dd>
              <dt className="text-muted">App ID</dt><dd className="truncate font-mono text-xs">{app.manifestId}</dd>
              <dt className="text-muted">Verified</dt><dd className="truncate font-mono text-xs" title={app.sha256}>✓ signed · {app.sha256.slice(0, 12)}…</dd>
            </dl>
          </section>
        </aside>
      </div>

      {app.related.length > 0 && <AppRow title="You might also like" apps={app.related as AppSummary[]} href={`/search?category=${app.category}`} />}
      <p className="text-center text-xs text-muted"><Link href="/search" className="underline">Browse all apps</Link></p>
    </div>
  );
}
