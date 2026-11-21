/**
 * Demo store catalog (prompt apps — skills only, nothing to host) so a fresh install looks like a real
 * store: icons, taglines, showcase results, prices, installs and reviews. Used by `pnpm seed` only.
 */
import { chartSvg, iconSvg, paletteSvg } from "./svg-art.js";

export interface DemoApp {
  id: string;
  name: string;
  category: string;
  tagline: string;
  description: string;
  glyph: string;
  colors: [string, string];
  showcase: any[];
  extraAssets?: Record<string, string>;
  price?: { kind: "subscription"; unitAmountCents: number; interval: "month" } | { kind: "free" };
  reviews: [number, string][];
  installs: number;
}

export const DEMO_APPS: DemoApp[] = [
  {
    id: "com.aixdemo.brandkit",
    name: "Brand Kit Studio",
    category: "images",
    tagline: "A complete brand identity from one sentence",
    description: "Describe your business and get a color palette, type pairing, logo directions and tone of voice — ready to hand to a designer or use right away.",
    glyph: "🎨",
    colors: ["#f472b6", "#9d174d"],
    showcase: [
      { title: "Palette for a bakery", input: "Brand kit for 'Crumb & Co', a cozy neighborhood bakery", kind: "image", output: "assets/palette.svg", caption: "Palette + type pairing · 20s" },
      { title: "Tone of voice", input: "How should Crumb & Co sound on Instagram?", kind: "list", output: ["Warm, a little cheeky — like the baker who knows your order", "Short sentences, sensory words: crackly, buttery, still-warm", "Emoji sparingly: 🥐 ☕ only", "Never: 'artisanal', 'curated', 'elevated'"] },
    ],
    extraAssets: { "assets/palette.svg": paletteSvg("Crumb & Co", ["#3b2a20", "#c8873f", "#f2d8b3", "#fbf6ee", "#7a8b5a"]) },
    price: { kind: "subscription", unitAmountCents: 699, interval: "month" },
    reviews: [[5, "Got a usable palette and voice guide in a minute. Our designer used it as the brief."], [5, "Way better than the generic logo generators."], [4, "Great start, I tweaked the fonts."]],
    installs: 9,
  },
  {
    id: "com.aixdemo.sqlsherpa",
    name: "SQL Sherpa",
    category: "data",
    tagline: "Ask your data questions in plain English",
    description: "Paste a schema or CSV and ask questions. SQL Sherpa writes the query, explains it, and shows the result table.",
    glyph: "🗄️",
    colors: ["#38bdf8", "#1e40af"],
    showcase: [
      { title: "Top customers", input: "Which 4 customers spent the most last quarter?", kind: "table", output: [["Customer", "Orders", "Revenue"], ["Northwind GmbH", "38", "€41,220"], ["Bluebird Ltd", "27", "€33,904"], ["Atelier Nove", "19", "€21,310"], ["Kestrel AB", "22", "€18,775"]], caption: "SELECT … GROUP BY customer ORDER BY revenue DESC LIMIT 4" },
      { title: "Explain a query", input: "What does this window function do?", kind: "text", output: "It ranks each order inside its customer by amount (largest first), so `rank = 1` gives every customer's biggest order. PARTITION BY restarts the ranking per customer." },
    ],
    price: { kind: "free" },
    reviews: [[5, "Saved me an afternoon of JOIN debugging."], [4, "Explanations are really clear."], [5, "My PM uses it instead of pinging me."], [5, "Perfect for ad-hoc questions."]],
    installs: 14,
  },
  {
    id: "com.aixdemo.marketscan",
    name: "Market Scan",
    category: "research",
    tagline: "Competitive research with sources, in minutes",
    description: "Name a market or competitor and get a structured brief: players, pricing, positioning and recent moves — every claim linked to a source.",
    glyph: "🔭",
    colors: ["#a3e635", "#3f6212"],
    showcase: [
      { title: "Note-taking apps", input: "Scan the market for AI note-taking apps for teams", kind: "table", output: [["App", "Price/user", "Angle"], ["Notion AI", "€8", "All-in-one workspace"], ["Mem", "€10", "Self-organizing notes"], ["Reflect", "€9", "Networked thought, privacy"], ["Granola", "€14", "Meeting notes first"]], caption: "12 sources cited" },
      { title: "Recent moves", input: "What changed in the last 90 days?", kind: "list", output: ["Two players launched meeting bots", "Average price rose ~12%", "Enterprise SSO is now table stakes", "One acquisition rumor (unconfirmed — flagged)"] },
    ],
    price: { kind: "subscription", unitAmountCents: 999, interval: "month" },
    reviews: [[5, "The sources make it trustworthy enough to share with my boss."], [4, "Great structure, occasionally misses tiny players."]],
    installs: 7,
  },
  {
    id: "com.aixdemo.codereviewer",
    name: "Code Reviewer",
    category: "code",
    tagline: "A senior reviewer on every pull request",
    description: "Paste a diff or point Claude Code at a branch. Get prioritized review comments: bugs first, then security, then style.",
    glyph: "🔍",
    colors: ["#94a3b8", "#0f172a"],
    showcase: [
      { title: "Review a diff", input: "Review my change to the payment retry logic", kind: "list", output: ["🔴 Retry loop never resets `attempt` — infinite retries on 503", "🟠 Idempotency key is regenerated per retry: double-charge risk", "🟡 Magic number 3 → make RETRY_LIMIT a constant", "✅ Good: timeouts are now explicit"], caption: "4 findings · 6 files" },
    ],
    price: { kind: "free" },
    reviews: [[5, "Caught a real double-charge bug before prod."], [5, "Bugs-first ordering is exactly right."], [4, "Sometimes nitpicky, but useful."]],
    installs: 18,
  },
  {
    id: "com.aixdemo.adcopylab",
    name: "Ad Copy Lab",
    category: "marketing",
    tagline: "10 ad variations, scored before you spend",
    description: "Give it your product and audience. Get headline and body variations for each platform, each scored for clarity and hook strength.",
    glyph: "📣",
    colors: ["#fbbf24", "#b45309"],
    showcase: [
      { title: "Headlines", input: "Ads for a budgeting app aimed at students", kind: "list", output: ["“Ramen budget? Let’s fix that.” — hook 9/10", "“Know where every euro went by Friday” — clarity 9/10", "“Your loan, but make it manageable” — hook 7/10", "“Save €40 this month without trying” — clarity 8/10"] },
    ],
    price: { kind: "free" },
    reviews: [[4, "Variations are on-brand and fast."], [5, "The scoring helps me pick what to test."]],
    installs: 6,
  },
  {
    id: "com.aixdemo.budgetbuddy",
    name: "Budget Buddy",
    category: "finance",
    tagline: "Your spending, explained like a friend would",
    description: "Drop in a bank export (CSV). Budget Buddy categorizes spending, charts it, and suggests three realistic changes.",
    glyph: "💶",
    colors: ["#34d399", "#065f46"],
    showcase: [
      { title: "Monthly breakdown", input: "Where did my money go in October?", kind: "image", output: "assets/chart.svg", caption: "From 214 transactions" },
      { title: "Suggestions", input: "Where can I save without pain?", kind: "list", output: ["3 unused subscriptions → €27/month", "Takeaway twice less per week → €48/month", "Switch phone plan (same data) → €11/month"] },
    ],
    extraAssets: { "assets/chart.svg": chartSvg("October spending (€)", [["Rent", 950], ["Food", 410], ["Transport", 120], ["Fun", 260], ["Subs", 64], ["Other", 140]], "#059669") },
    price: { kind: "free" },
    reviews: [[5, "Finally understand my spending."], [5, "The subscription finder paid for itself."], [4, "Wish it supported more banks' CSV formats."]],
    installs: 11,
  },
  {
    id: "com.aixdemo.inboxzero",
    name: "Inbox Zero Coach",
    category: "productivity",
    tagline: "Triage 100 emails in 5 minutes",
    description: "Paste or forward a batch of emails: get a triage plan — reply now, delegate, schedule, archive — plus drafted replies for the urgent ones.",
    glyph: "📬",
    colors: ["#60a5fa", "#1d4ed8"],
    showcase: [
      { title: "Morning triage", input: "Triage my 63 unread emails", kind: "table", output: [["Action", "Count", "Example"], ["Reply now", "4", "Contract question from Lena"], ["Delegate", "7", "Invoice copies → finance"], ["Schedule", "9", "Q4 planning invites"], ["Archive", "43", "Newsletters, receipts"]], caption: "4 reply drafts ready" },
    ],
    price: { kind: "free" },
    reviews: [[5, "My mornings are calmer."], [4, "Drafts need a light edit but save tons of time."]],
    installs: 8,
  },
  {
    id: "com.aixdemo.deckdoctor",
    name: "Deck Doctor",
    category: "productivity",
    tagline: "Fix your slides' story before the meeting",
    description: "Share an outline or deck text. Deck Doctor restructures it into a clear narrative, flags weak slides, and writes speaker notes.",
    glyph: "🩺",
    colors: ["#c084fc", "#6b21a8"],
    showcase: [
      { title: "Board update", input: "Restructure my 14-slide board update", kind: "list", output: ["1. The headline: ARR +32%, burn −18%", "2. What worked (2 bets) and what didn't (1)", "3. The ask: approve EU hiring plan", "4. Risks and how we'll know early", "Cut: slides 6, 9, 11 (repeat the same chart)"] },
    ],
    price: { kind: "subscription", unitAmountCents: 499, interval: "month" },
    reviews: [[5, "Board meeting went smoother than ever."], [4, "Great structure suggestions."]],
    installs: 5,
  },
  {
    id: "com.aixdemo.tripplanner",
    name: "Weekend Planner",
    category: "other",
    tagline: "A perfect 48 hours anywhere",
    description: "Tell it the city, your budget and vibe. Get a day-by-day plan with timings, bookings to make and rainy-day swaps.",
    glyph: "🧭",
    colors: ["#2dd4bf", "#0f766e"],
    showcase: [
      { title: "Lisbon, food & views", input: "48h in Lisbon, love food and viewpoints, mid budget", kind: "table", output: [["When", "Plan"], ["Sat 09:00", "Pastéis at Manteigaria, walk Chiado"], ["Sat 13:00", "Time Out Market → Miradouro de Santa Catarina"], ["Sat 20:00", "Dinner in Alfama + fado (book ahead)"], ["Sun 10:00", "Tram 28 early, Graça viewpoint"], ["Sun 15:00", "Belém: tower + MAAT, sunset by the river"]] },
    ],
    price: { kind: "free" },
    reviews: [[5, "Followed it exactly. Best weekend trip."], [5, "The rainy-day swaps saved Sunday."]],
    installs: 10,
  },
];

export function demoFiles(a: DemoApp): Record<string, string> {
  const manifest = {
    id: a.id,
    name: a.name,
    version: "1.0.0",
    type: "prompt",
    description: a.description,
    category: a.category,
    tagline: a.tagline,
    icon: "assets/icon.svg",
    color: a.colors[1],
    compatibility: { hosts: ["claude", "chatgpt", "claude-code", "cursor"] },
    permissions: { network: [], files: [], userData: [] },
    skills: ["skills/main.md"],
    showcase: a.showcase,
    pricing: [a.price?.kind === "subscription" ? { kind: "subscription", interval: "month", displayPrice: `€${(a.price.unitAmountCents / 100).toFixed(2)}` } : { kind: "free" }],
  };
  return {
    "aix.json": JSON.stringify(manifest, null, 2),
    "skills/main.md": `---\nname: ${a.id.split(".").pop()}\ndescription: ${a.tagline}\n---\n\n# ${a.name}\n\n${a.description}\n`,
    "assets/icon.svg": iconSvg(a.glyph, a.colors[0], a.colors[1]),
    ...(a.extraAssets ?? {}),
  };
}
