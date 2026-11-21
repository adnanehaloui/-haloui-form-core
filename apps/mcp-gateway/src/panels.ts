/**
 * MCP Apps UI panels rendered by the gateway: approval, receipt/wallet, install.
 * Each is a self-contained HTML document with the ext-apps browser bundle inlined.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const PANELS = {
  approval: "ui://aix/approval.html",
  wallet: "ui://aix/wallet.html",
  install: "ui://aix/install.html",
} as const;

let bundle: string | null = null;
function extAppsBundle(): string {
  if (bundle) return bundle;
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  bundle = src.replace(/export\s*\{([^}]*)\}\s*;?\s*$/, (_m, list: string) => {
    const pairs = list.split(",").map((p) => p.trim().split(/\s+as\s+/)).map(([local, exported]) => `${JSON.stringify(exported ?? local)}:${local}`);
    return `globalThis.McpExtApps={${pairs.join(",")}};`;
  });
  return bundle;
}

const CSS = `
:root{color-scheme:light dark;--fg:#17171c;--muted:#6a6a75;--card:#f3f3f6;--line:#e2e2e8;--accent:#4f46e5;--accent-fg:#fff;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--fg:#ededf2;--muted:#a1a1ad;--card:#202027;--line:#33333d;--accent:#818cf8;--accent-fg:#111;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:transparent}
.card{padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
.brand{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.big{font-size:26px;font-weight:650;margin:2px 0}.muted{color:var(--muted)}.row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
button{font:inherit;border-radius:10px;padding:8px 14px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}
ul{margin:8px 0 0;padding-left:18px}li{margin:2px 0}.ok{color:var(--ok)}.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}td{padding:4px 0;border-top:1px solid var(--line)}td:last-child{text-align:right;font-variant-numeric:tabular-nums}`;

function doc(title: string, body: string, script: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head>
<body>${body}<script type="module">
${extAppsBundle()}
const { App } = globalThis.McpExtApps;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
const app = new App({ name: ${JSON.stringify(title)}, version: "1.0.0" });
${script}
await app.connect();
</script></body></html>`;
}

export function approvalPanel() {
  return doc(
    "AIX approval",
    `<div class="card"><div class="brand">AIX wallet</div><div id="msg" class="muted">Loading…</div>
     <div class="big" id="amount"></div><div id="detail" class="muted"></div>
     <div class="row"><button class="primary" id="yes" disabled>Approve</button><button id="no" disabled>Deny</button><button id="web" disabled>Open on AIX</button></div>
     <div id="out" style="margin-top:10px"></div></div>`,
    `let ctx = null;
app.ontoolresult = (r) => {
  const a = r.structuredContent && r.structuredContent.approval;
  if (!a) return;
  ctx = { approvalId: a.id, nonce: (r._meta || {})["aix/nonce"], url: a.approvalUrl };
  $("msg").textContent = a.status === "pending" ? "This costs" : "Approval " + a.status;
  $("amount").textContent = a.display;
  $("detail").textContent = a.app.name + " · " + a.quantity + " × " + a.unit + " — approve?";
  const pending = a.status === "pending";
  $("yes").disabled = $("no").disabled = !pending || !ctx.nonce; $("web").disabled = false;
};
async function decide(decision) {
  $("yes").disabled = $("no").disabled = true;
  $("out").innerHTML = "<span class='muted'>" + (decision === "approve" ? "Approving and running…" : "Declining…") + "</span>";
  try {
    const r = await app.callServerTool({ name: "approval_decide", arguments: { approvalId: ctx.approvalId, decision, nonce: ctx.nonce } });
    const sc = r.structuredContent || {};
    const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\\n");
    $("out").innerHTML = (r.isError ? "<div class='bad'>" : "<div class='ok'>") + esc(sc.receipt ? "Receipt: " + sc.receipt : sc.status || "") + "</div><div class='muted' style='white-space:pre-wrap;margin-top:6px'>" + esc(text) + "</div>";
  } catch (e) { $("out").innerHTML = "<div class='bad'>" + esc(e.message) + "</div>"; }
}
$("yes").onclick = () => decide("approve");
$("no").onclick = () => decide("deny");
$("web").onclick = () => ctx && app.openLink({ url: ctx.url });`,
  );
}

export function walletPanel() {
  return doc(
    "AIX wallet",
    `<div class="card"><div class="brand">AIX wallet</div><div class="big" id="bal">…</div><div id="held" class="muted"></div>
     <table id="t"></table><div class="row"><button id="top">Top up on AIX</button></div></div>`,
    `let url = null;
app.ontoolresult = (r) => {
  const w = r.structuredContent; if (!w) return;
  url = w.walletUrl;
  $("bal").textContent = w.available;
  $("held").textContent = w.heldCents > 0 ? w.held + " reserved for running work" : "Available balance";
  $("t").innerHTML = (w.receipts || []).map((c) => "<tr><td>" + esc(c.appName) + "<div class='muted'>" + esc(new Date(c.createdAt).toLocaleString()) + " · " + esc(c.status) + "</div></td><td>" + esc(c.display) + "</td></tr>").join("") || "<tr><td class='muted'>No charges yet</td><td></td></tr>";
};
$("top").onclick = () => url && app.openLink({ url });`,
  );
}

export function installPanel() {
  return doc(
    "Install app",
    `<div class="card"><div class="brand">AIX store</div><div class="big" id="name" style="font-size:20px">…</div><div id="desc" class="muted"></div>
     <div style="margin-top:10px"><b>This app will be able to:</b><ul id="perms"></ul></div><div id="price" class="muted" style="margin-top:8px"></div>
     <div class="row"><button class="primary" id="go" disabled>Install</button><button id="web" disabled>View in store</button></div><div id="out" style="margin-top:8px"></div></div>`,
    `let ctx = null;
app.ontoolresult = (r) => {
  const a = r.structuredContent && r.structuredContent.app; if (!a) return;
  ctx = { slug: a.slug, nonce: (r._meta || {})["aix/nonce"], url: a.storeUrl };
  $("name").textContent = a.name + " · " + a.developer;
  $("desc").textContent = a.description;
  $("perms").innerHTML = a.permissionLines.map((l) => "<li>" + esc(l) + "</li>").join("");
  $("price").textContent = (a.prices || []).join(" · ");
  $("go").disabled = !!a.installed || !a.allowed || !ctx.nonce; $("web").disabled = false;
  if (a.installed) $("out").innerHTML = "<span class='ok'>Already installed</span>";
  if (!a.allowed) $("out").innerHTML = "<span class='bad'>" + esc(a.blockedReason) + "</span>";
};
$("go").onclick = async () => {
  $("go").disabled = true;
  const r = await app.callServerTool({ name: "app_install_confirm", arguments: { slug: ctx.slug, nonce: ctx.nonce } });
  const text = (r.content || []).map((c) => c.text).join("\\n");
  $("out").innerHTML = (r.isError ? "<span class='bad'>" : "<span class='ok'>") + esc(text) + "</span>";
};
$("web").onclick = () => ctx && app.openLink({ url: ctx.url });`,
  );
}
