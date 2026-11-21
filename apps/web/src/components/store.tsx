import Link from "next/link";
import { CATEGORY, HOSTS, compactNumber, hashColor, shortPrice } from "@/lib/ui";

export type ShowcaseItem = { title: string; input: string; kind: "text" | "image" | "table" | "list"; output: any; caption?: string };
export type AppSummary = {
  id: string; slug: string; name: string; description: string; category: string; type: string; developer: string;
  hosts: string[]; priceLabels: string[]; rating: { average: number; count: number } | null; installs: number;
  tagline: string | null; color: string | null; iconUrl: string | null; showcase: ShowcaseItem[];
};

export function AppIcon({ app, size = 64 }: { app: Pick<AppSummary, "name" | "iconUrl" | "color" | "slug">; size?: number }) {
  const color = app.color ?? hashColor(app.slug);
  const style = { width: size, height: size, borderRadius: size * 0.24 };
  if (app.iconUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={app.iconUrl} alt="" style={style} className="shrink-0 object-cover shadow-sm ring-1 ring-black/5" />;
  }
  return (
    <div
      aria-hidden
      style={{ ...style, background: `linear-gradient(135deg, ${color}, color-mix(in oklab, ${color} 55%, #000))`, fontSize: size * 0.42 }}
      className="flex shrink-0 items-center justify-center font-semibold text-white shadow-sm ring-1 ring-black/5"
    >
      {app.name.slice(0, 1)}
    </div>
  );
}

export function Stars({ value, size = "text-sm" }: { value: number; size?: string }) {
  const full = Math.round(value);
  return (
    <span className={`${size} tracking-tight text-amber-500`} aria-label={`${value} out of 5`}>
      {"★".repeat(full)}
      <span className="text-line">{"★".repeat(5 - full)}</span>
    </span>
  );
}

export function HostBadges({ hosts, small }: { hosts: string[]; small?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {hosts.map((h) => (
        <span key={h} className={`rounded-full bg-ink/5 px-2 ${small ? "py-0 text-[11px]" : "py-0.5 text-xs"} font-medium text-muted`}>{HOSTS[h] ?? h}</span>
      ))}
    </div>
  );
}

export function GetButton({ label = "Get", href }: { label?: string; href: string }) {
  return <Link href={href} className="rounded-full bg-ink/5 px-4 py-1 text-sm font-semibold text-accent transition hover:bg-accent hover:text-accent-ink">{label}</Link>;
}

/** Compact tile used in horizontal rows. */
export function AppTile({ app }: { app: AppSummary }) {
  return (
    <div className="group flex w-[280px] shrink-0 snap-start items-center gap-3 rounded-2xl p-2 transition hover:bg-card">
      <Link href={`/apps/${app.slug}`} className="flex min-w-0 flex-1 items-center gap-3" data-testid="store-app">
        <AppIcon app={app} size={60} />
        <div className="min-w-0">
          <p className="truncate font-semibold">{app.name}</p>
          <p className="truncate text-xs text-muted">{app.tagline ?? CATEGORY[app.category]?.label}</p>
          <p className="mt-0.5 text-xs text-muted">{app.rating ? <>{app.rating.average} ★</> : "New"} · {shortPrice(app.priceLabels)}</p>
        </div>
      </Link>
      <GetButton href={`/apps/${app.slug}`} />
    </div>
  );
}

export function AppRow({ title, subtitle, apps, href }: { title: string; subtitle?: string | null; apps: AppSummary[]; href?: string }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        {href && <Link href={href} className="text-sm font-medium text-accent">See all</Link>}
      </div>
      <div className="-mx-2 flex snap-x gap-1 overflow-x-auto pb-2 [scrollbar-width:thin]">
        {apps.map((a) => <AppTile key={a.id} app={a} />)}
      </div>
    </section>
  );
}

/** Renders an example result: what the user asked → what the app produced. */
export function ShowcaseCard({ item, app, compact }: { item: ShowcaseItem; app?: Pick<AppSummary, "name" | "slug" | "iconUrl" | "color">; compact?: boolean }) {
  return (
    <figure className={`flex flex-col overflow-hidden rounded-2xl border border-line bg-[light-dark(#fff,#16161b)] shadow-sm ${compact ? "" : "min-h-full"}`}>
      <div className="flex flex-col gap-2 p-4">
        {app && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <AppIcon app={app} size={20} /> <span className="font-medium text-ink">{app.name}</span> · {item.title}
          </div>
        )}
        {!app && <p className="text-xs font-semibold uppercase tracking-wide text-muted">{item.title}</p>}
        <p className="self-end rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-accent-ink">{item.input}</p>
      </div>
      <div className={`flex-1 border-t border-line bg-card/60 p-4 text-sm ${compact ? "max-h-56 overflow-hidden" : ""}`}>
        <ShowcaseOutput item={item} />
      </div>
      {item.caption && <figcaption className="border-t border-line px-4 py-2 text-xs text-muted">{item.caption}</figcaption>}
    </figure>
  );
}

export function ShowcaseOutput({ item }: { item: ShowcaseItem }) {
  if (item.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={item.output} alt={item.title} className="w-full rounded-xl object-cover ring-1 ring-black/5" />;
  }
  if (item.kind === "list") {
    return (
      <ol className="flex flex-col gap-1.5">
        {(item.output as string[]).map((x, i) => (
          <li key={i} className="flex gap-2"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{i + 1}</span><span>{x}</span></li>
        ))}
      </ol>
    );
  }
  if (item.kind === "table") {
    const [head, ...rows] = item.output as string[][];
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr>{head?.map((h, i) => <th key={i} className="border-b border-line pb-1.5 pr-3 text-left font-semibold">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border-b border-line/60 py-1.5 pr-3 tabular-nums">{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  return <div className="whitespace-pre-line leading-relaxed">{String(item.output)}</div>;
}

/** "How it runs in Claude" — a mock conversation built from a showcase entry. */
export function ChatPreview({ app, item, price, subscription }: { app: Pick<AppSummary, "name" | "slug" | "iconUrl" | "color">; item: ShowcaseItem; price: string; subscription?: boolean }) {
  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-[light-dark(#fbfbfd,#141418)]">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs text-muted">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" /><span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" /><span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2">Your AI chat · AIX connected</span>
      </div>
      <div className="flex flex-col gap-3 p-4 text-sm">
        <p className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-accent px-3 py-2 text-accent-ink">{item.input}</p>
        <div className="flex items-center gap-2 self-start rounded-full border border-line bg-card px-3 py-1 text-xs">
          <AppIcon app={app} size={16} /> Using <b>{app.name}</b>
        </div>
        {subscription ? (
          <div className="self-start rounded-xl border border-line bg-card px-3 py-2 text-xs"><span className="text-muted">AIX · </span>Included in your <b>{app.name}</b> subscription</div>
        ) : price !== "Free" && (
          <div className="self-start rounded-xl border border-line bg-card px-3 py-2 text-xs">
            <span className="text-muted">AIX wallet · </span>This costs <b>{price.split(" /")[0]}</b> — <span className="font-semibold text-good">Approved</span>
          </div>
        )}
        <div className="max-w-[92%] self-start rounded-2xl rounded-bl-md border border-line bg-[light-dark(#fff,#1b1b21)] p-3">
          <ShowcaseOutput item={item} />
        </div>
        {price !== "Free" && !subscription && <p className="self-start text-xs text-muted">🧾 Receipt saved to your AIX wallet</p>}
      </div>
    </div>
  );
}

export function RatingLine({ app }: { app: Pick<AppSummary, "rating" | "installs"> }) {
  return (
    <span className="text-xs text-muted">
      {app.rating ? <>{app.rating.average} <Stars value={app.rating.average} size="text-xs" /> ({app.rating.count})</> : "No ratings yet"} · {compactNumber(app.installs)} installs
    </span>
  );
}
