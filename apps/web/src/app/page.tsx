import Link from "next/link";
import { api } from "@/lib/api";
import { CATEGORY, hashColor, shortPrice } from "@/lib/ui";
import { AppIcon, AppRow, GetButton, HostBadges, RatingLine, ShowcaseCard, type AppSummary } from "@/components/store";

type Home = { featured: AppSummary[]; sections: { id: string; title: string; subtitle: string | null; category?: string; apps: AppSummary[] }[]; total: number };

function Featured({ app }: { app: AppSummary }) {
  const color = app.color ?? hashColor(app.slug);
  return (
    <article
      className="relative grid w-[min(88vw,980px)] shrink-0 snap-center overflow-hidden rounded-[28px] text-white md:grid-cols-[1fr_1.05fr]"
      style={{ background: `radial-gradient(120% 140% at 0% 0%, color-mix(in oklab, ${color} 85%, #fff) 0%, ${color} 40%, color-mix(in oklab, ${color} 45%, #000) 100%)` }}
    >
      <div className="flex flex-col justify-between gap-6 p-7 md:p-9">
        <div className="flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/75">Featured · {CATEGORY[app.category]?.label}</p>
          <h2 className="text-3xl font-semibold leading-tight tracking-tight md:text-4xl">{app.tagline ?? app.name}</h2>
          <p className="max-w-md text-white/85">{app.description}</p>
        </div>
        <div className="flex items-center gap-3">
          <AppIcon app={app} size={56} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{app.name}</p>
            <p className="text-xs text-white/75">{app.developer} · {shortPrice(app.priceLabels)}</p>
          </div>
          <Link href={`/apps/${app.slug}`} className="rounded-full bg-white px-5 py-2 text-sm font-semibold" style={{ color }}>Get</Link>
        </div>
      </div>
      <div className="hidden p-6 md:block">
        {app.showcase[0] && <div className="text-ink"><ShowcaseCard item={app.showcase[0]} compact /></div>}
      </div>
    </article>
  );
}

export default async function Store() {
  const [home, cats] = await Promise.all([api<Home>("/store/home"), api<{ data: string[] }>("/store/categories")]);
  const top = home.sections.find((s) => s.id === "top")?.apps ?? [];
  const results = home.sections.flatMap((s) => s.apps).filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i).flatMap((a) => a.showcase.slice(0, 1).map((item) => ({ app: a, item }))).slice(0, 6);
  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-muted">{new Date().toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric" })}</p>
            <h1 className="text-4xl font-bold tracking-tight">Discover</h1>
          </div>
          <p className="max-w-sm text-sm text-muted">AI apps that do real work — inside Claude, ChatGPT, Cursor or on the web. One account, one wallet.</p>
        </div>
        {home.featured.length > 0 ? (
          <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
            {home.featured.map((a) => <Featured key={a.id} app={a} />)}
          </div>
        ) : (
          <div className="card text-muted">No apps yet — publish one with <code>aix app publish</code>.</div>
        )}
      </section>

      {results.length > 0 && (
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">See what people make</h2>
            <p className="text-sm text-muted">Real results from apps on AIX — ask in your AI chat, get this back.</p>
          </div>
          <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
            {results.map(({ app, item }) => (
              <Link key={app.id + item.title} href={`/apps/${app.slug}`} className="block transition hover:-translate-y-0.5">
                <ShowcaseCard item={item} app={app} compact />
              </Link>
            ))}
          </div>
        </section>
      )}

      {top.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold tracking-tight">Top charts</h2>
          <ol className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {top.slice(0, 9).map((a, i) => (
              <li key={a.id} className="flex items-center gap-3 border-b border-line py-2.5">
                <span className="w-5 text-center text-lg font-semibold text-muted">{i + 1}</span>
                <AppIcon app={a} size={48} />
                <Link href={`/apps/${a.slug}`} className="min-w-0 flex-1">
                  <p className="truncate font-medium">{a.name}</p>
                  <RatingLine app={a} />
                </Link>
                <GetButton href={`/apps/${a.slug}`} />
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Browse by what you want done</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {cats.data.map((c) => (
            <Link key={c} href={`/search?category=${c}`} className="group flex flex-col gap-1 rounded-2xl border border-line p-4 transition hover:border-accent hover:bg-card">
              <span className="text-2xl">{CATEGORY[c]?.emoji}</span>
              <span className="font-semibold">{CATEGORY[c]?.label ?? c}</span>
              <span className="text-xs text-muted">{CATEGORY[c]?.blurb}</span>
            </Link>
          ))}
        </div>
      </section>

      {home.sections.map((s) => (
        <AppRow key={s.id} title={s.category ? `${CATEGORY[s.category]?.emoji ?? ""} ${CATEGORY[s.category]?.label ?? s.title}` : s.title} subtitle={s.subtitle} apps={s.apps} href={s.category ? `/search?category=${s.category}` : "/search"} />
      ))}

      <section className="grid gap-4 rounded-[28px] border border-line bg-card p-8 md:grid-cols-3">
        <div className="md:col-span-2">
          <h2 className="text-2xl font-semibold tracking-tight">Use AIX inside the AI you already pay for</h2>
          <p className="mt-2 text-muted">Add one connector to Claude, ChatGPT, Cursor or Claude Code. Your subscription pays for the conversation; your AIX wallet pays only for the work apps do — with limits and approvals you control.</p>
          <div className="mt-4"><HostBadges hosts={["claude", "chatgpt", "cursor", "claude-code", "web"]} /></div>
        </div>
        <div className="flex flex-col justify-center gap-2">
          <Link href="/wallet" className="btn-primary">Open your wallet</Link>
          <Link href="/developer" className="btn">Sell your app on AIX</Link>
        </div>
      </section>
    </div>
  );
}
