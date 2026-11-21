import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * MCP Apps panels are sandboxed HTML documents. We inline the ext-apps browser bundle,
 * turning its trailing `export { … }` into a global so a classic inline script can use it.
 */
let cached: string | null = null;
export function extAppsBundle(): string {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  cached = src.replace(/export\s*\{([^}]*)\}\s*;?\s*$/, (_m, list: string) => {
    const pairs = list.split(",").map((p) => p.trim().split(/\s+as\s+/)).map(([local, exported]) => `${JSON.stringify(exported ?? local)}:${local}`);
    return `globalThis.McpExtApps={${pairs.join(",")}};`;
  });
  return cached;
}

export function previewPanelHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; --fg:#1b1b1f; --muted:#6b6b76; --card:#f4f4f7; --accent:#5b5bd6; }
  @media (prefers-color-scheme: dark) { :root { --fg:#ececf1; --muted:#a0a0ab; --card:#22222a; } }
  body { margin:0; font:14px/1.45 system-ui,sans-serif; color:var(--fg); background:transparent; }
  .wrap { padding:12px; } h2 { font-size:15px; margin:0 0 8px; }
  .frames { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:8px; }
  .frame { background:var(--card); border-radius:10px; padding:10px; } .n { color:var(--accent); font-weight:600; font-size:12px; }
  .meta { color:var(--muted); font-size:12px; margin-top:8px; }
</style></head><body><div class="wrap" id="root"><p class="meta">Waiting for render…</p></div>
<script type="module">
${extAppsBundle()}
const { App } = globalThis.McpExtApps;
const root = document.getElementById("root");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" })[c]);
function show(sc) {
  if (!sc || !sc.frames) return;
  root.innerHTML = "<h2>" + esc(sc.title) + "</h2><div class='frames'>" +
    sc.frames.map((f, i) => "<div class='frame'><div class='n'>Shot " + (i + 1) + "</div>" + esc(f) + "</div>").join("") +
    "</div><p class='meta'>" + esc(sc.durationSec) + "s · " + esc(sc.charge) + "</p>";
}
const app = new App({ name: "Render Studio preview", version: "1.0.0" });
app.ontoolresult = (r) => show(r.structuredContent);
await app.connect();
</script></body></html>`;
}
