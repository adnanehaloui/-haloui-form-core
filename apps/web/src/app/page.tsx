import Link from "next/link";
import { api } from "@/lib/api";

const CATEGORY_LABEL: Record<string, string> = {
  video: "Make videos", images: "Create images", writing: "Write better", research: "Research", data: "Work with data",
  code: "Ship code", productivity: "Get organized", marketing: "Grow", finance: "Money", other: "Other",
};

export default async function Store({ searchParams }: { searchParams: Promise<{ q?: string; category?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.category ? { category: sp.category } : {}) });
  const [{ data: apps }, { data: cats }] = await Promise.all([api<{ data: any[] }>(`/store/apps?${qs}`), api<{ data: string[] }>("/store/categories")]);
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">AI apps that do the work.</h1>
        <p className="muted max-w-2xl text-base">Use them inside Claude, ChatGPT, Cursor or Claude Code — your AI subscription pays for the conversation, your AIX wallet pays for the work.</p>
        <form className="mt-2 flex max-w-xl gap-2">
          <input name="q" defaultValue={sp.q} placeholder="What do you want to get done?" className="input" />
          <button className="btn-primary">Search</button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Link href="/" className={`pill ${!sp.category ? "border-accent text-ink" : ""}`}>All</Link>
          {cats.map((c) => (
            <Link key={c} href={`/?category=${c}`} className={`pill ${sp.category === c ? "border-accent text-ink" : ""}`}>{CATEGORY_LABEL[c] ?? c}</Link>
          ))}
        </div>
      </section>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {apps.length === 0 && <p className="muted">No apps found.</p>}
        {apps.map((a) => (
          <Link key={a.id} href={`/apps/${a.slug}`} className="card flex flex-col gap-2 transition hover:border-accent" data-testid="store-app">
            <div className="flex items-center justify-between gap-2">
              <h2 className="h2">{a.name}</h2>
              <span className="pill">{a.type}</span>
            </div>
            <p className="muted line-clamp-2">{a.description}</p>
            <p className="text-xs text-muted">by {a.developer}{a.rating ? ` · ★ ${a.rating.average} (${a.rating.count})` : ""}</p>
            <p className="mt-auto text-sm font-medium">{a.priceLabels.join(" · ") || "Free"}</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
