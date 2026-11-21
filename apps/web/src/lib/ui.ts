export const CATEGORY: Record<string, { label: string; emoji: string; blurb: string }> = {
  video: { label: "Video", emoji: "🎬", blurb: "Scripts to finished videos" },
  images: { label: "Images", emoji: "🎨", blurb: "Logos, visuals, brand kits" },
  writing: { label: "Writing", emoji: "✍️", blurb: "Copy that converts" },
  research: { label: "Research", emoji: "🔎", blurb: "Answers with sources" },
  data: { label: "Data", emoji: "📊", blurb: "Clean, query, chart" },
  code: { label: "Code", emoji: "🧑‍💻", blurb: "Review, test, ship" },
  productivity: { label: "Productivity", emoji: "⚡", blurb: "Do more in less time" },
  marketing: { label: "Marketing", emoji: "📣", blurb: "Grow your audience" },
  finance: { label: "Finance", emoji: "💶", blurb: "Budgets and reports" },
  other: { label: "Other", emoji: "✨", blurb: "Everything else" },
};

export const HOSTS: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", cursor: "Cursor", "claude-code": "Claude Code", web: "Web" };

/** Stable pleasant color from a string when the app has no brand color. */
export function hashColor(s: string): string {
  const palette = ["#6d28d9", "#2563eb", "#0891b2", "#059669", "#d97706", "#dc2626", "#db2777", "#4f46e5", "#0d9488", "#7c3aed"];
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

export function shortPrice(labels: string[]): string {
  if (!labels.length) return "Free";
  const paid = labels.find((l) => l.startsWith("€"));
  if (!paid) return "Free";
  return paid.replace(/\s*\(.*\)$/, "");
}

export function compactNumber(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
