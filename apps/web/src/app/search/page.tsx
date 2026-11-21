import Link from "next/link";
import { api } from "@/lib/api";
import { CATEGORY } from "@/lib/ui";
import { AppIcon, GetButton, HostBadges, RatingLine, type AppSummary } from "@/components/store";

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string; category?: string; host?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
  const [{ data: apps }, { data: cats }] = await Promise.all([api<{ data: AppSummary[] }>(`/store/apps?${qs}`), api<{ data: string[] }>("/store/categories")]);
  const title = sp.q ? `Results for “${sp.q}”` : sp.category ? `${CATEGORY[sp.category]?.emoji ?? ""} ${CATEGORY[sp.category]?.label ?? sp.category}` : "All apps";
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-sm transition ${active ? "border-ink bg-ink text-[light-dark(#fff,#111)]" : "border-line text-muted hover:text-ink"}`;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {sp.category && <p className="text-muted">{CATEGORY[sp.category]?.blurb}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/search" className={chip(!sp.category)}>All</Link>
        {cats.map((c) => <Link key={c} href={`/search?category=${c}`} className={chip(sp.category === c)}>{CATEGORY[c]?.label ?? c}</Link>)}
      </div>
      {apps.length === 0 && <p className="text-muted">No apps match. Try another search.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {apps.map((a) => (
          <div key={a.id} className="flex flex-col gap-3 rounded-2xl border border-line p-4 transition hover:border-accent">
            <div className="flex items-center gap-3">
              <AppIcon app={a} size={64} />
              <Link href={`/apps/${a.slug}`} className="min-w-0 flex-1" data-testid="store-app">
                <p className="truncate font-semibold">{a.name}</p>
                <p className="truncate text-sm text-muted">{a.tagline ?? a.developer}</p>
                <RatingLine app={a} />
              </Link>
              <GetButton href={`/apps/${a.slug}`} />
            </div>
            <p className="line-clamp-2 text-sm text-muted">{a.description}</p>
            <div className="mt-auto flex items-center justify-between gap-2"><HostBadges hosts={a.hosts} small /><span className="shrink-0 whitespace-nowrap text-xs font-medium">{(a.priceLabels[0] ?? "Free").replace(/\s*\(.*\)$/, "")}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}
