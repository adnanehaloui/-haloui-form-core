"use client";
import { useState } from "react";
import { call } from "@/components/client";

export type ConnectInfo = {
  mcpUrl: string;
  pluginMarketplace: string | null;
  hosts: Record<string, { steps: string[]; command?: string; deeplink?: string }>;
};

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-stretch overflow-hidden rounded-xl border border-line bg-[light-dark(#f6f6f9,#0f0f13)]">
      <code className="flex-1 overflow-x-auto whitespace-nowrap px-3 py-2 font-mono text-xs leading-6">{text}</code>
      <button
        type="button"
        className="border-l border-line px-3 text-xs font-medium text-accent hover:bg-card"
        onClick={async () => {
          await navigator.clipboard?.writeText(text).catch(() => {});
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "Copied" : (label ?? "Copy")}
      </button>
    </div>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="flex flex-col gap-2 text-sm">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{i + 1}</span><span className="pt-0.5">{s}</span></li>
      ))}
    </ol>
  );
}

const HOST_TABS = [
  { id: "claude", label: "Claude" },
  { id: "claude-code", label: "Claude Code" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "codex", label: "Codex" },
] as const;

/** The connector block, shared by the /connect page and server apps. */
export function ConnectorSteps({ host, info }: { host: string; info: ConnectInfo }) {
  const h = info.hosts[host];
  if (!h) return null;
  return (
    <div className="flex flex-col gap-3">
      {h.deeplink && (
        <a href={h.deeplink} className="btn-primary self-start rounded-full">{host === "cursor" ? "Add to Cursor" : "Add to VS Code"}</a>
      )}
      {h.command && <Copy text={h.command} />}
      <Steps steps={h.steps} />
      {!h.command && !h.deeplink && <Copy text={info.mcpUrl} label="Copy URL" />}
    </div>
  );
}

function SkillCommand({ slug, agent }: { slug: string; agent: string }) {
  const [cmd, setCmd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return cmd ? (
    <div className="flex flex-col gap-1"><Copy text={cmd} /><p className="text-xs text-muted">Personal command, valid for 15 minutes. Run it in your project folder (add <code>-g</code> for all projects).</p></div>
  ) : (
    <div className="flex flex-col gap-1">
      <button
        className="btn self-start"
        onClick={async () => {
          try {
            const r = await call(`/store/apps/${slug}/install-token`);
            setCmd(r.commands[agent]);
          } catch (e: any) {
            setErr(e.message);
          }
        }}
      >
        Get install command
      </button>
      {err && <p className="text-xs text-bad">{err}</p>}
    </div>
  );
}

export function UseIn(props: {
  app: { slug: string; name: string; type: string; entry?: { web?: string; command?: string } };
  info: ConnectInfo;
  installed: boolean;
  skills: { name: string; description: string }[];
  example?: string;
}) {
  const { app, info, installed, skills } = props;
  const tabs = app.type === "web" ? [{ id: "web", label: "Web" }] : app.type === "local" ? [{ id: "claude-code", label: "Claude Code" }, { id: "cursor", label: "Cursor" }] : HOST_TABS.filter((t) => app.type === "prompt" || t.id !== "codex");
  const [tab, setTab] = useState<string>(tabs[0]!.id);
  const isSkill = app.type === "prompt";

  return (
    <section className="flex flex-col gap-4" id="use-in">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Use it in…</h2>
        <p className="text-sm text-muted">{isSkill ? "Skills install natively where supported — or work everywhere through the AIX connector." : app.type === "server" ? "Connect AIX once. Every app you install shows up in your AI automatically." : app.type === "web" ? "A web app with Sign in with AIX — your wallet works there too." : "Runs on your computer with the permissions you approved."}</p>
      </div>
      {!installed && <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">Install {app.name} first (the Get button above) — then come back here to add it to your AI.</p>}
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${tab === t.id ? "bg-ink text-[light-dark(#fff,#111)]" : "bg-ink/5 text-muted hover:text-ink"}`}>{t.label}</button>
        ))}
      </div>
      <div className="rounded-2xl border border-line p-5">
        {app.type === "web" && (
          <div className="flex flex-col gap-3">
            {app.entry?.web && <a className="btn-primary self-start rounded-full" href={app.entry.web} target="_blank" rel="noreferrer">Open {app.name}</a>}
            <Steps steps={["Open the app", "Click “Sign in with AIX” — no new account", "Paid actions use your AIX wallet, with your limits and approvals"]} />
          </div>
        )}

        {app.type === "local" && (
          <div className="flex flex-col gap-3">
            {installed && <a className="btn self-start" href={`/api/store/apps/${app.slug}/package`}>Download signed package</a>}
            <Steps steps={["Download the package (signed and hash-verified by AIX)", `Run ${app.entry?.command ?? "the included command"} — it only gets the permissions you approved`, "Or connect AIX to your AI tool (Claude Code tab) to use it from chat"]} />
          </div>
        )}

        {app.type === "server" && <ConnectorSteps host={tab} info={info} />}

        {isSkill && (
          <div className="flex flex-col gap-4">
            {tab === "claude" && (
              <>
                <p className="text-sm font-medium">Option A — upload the skill to Claude</p>
                <div className="flex flex-wrap gap-2">
                  {skills.map((s) => <a key={s.name} className="btn" href={`/api/store/apps/${app.slug}/skills/${s.name}.zip`} aria-disabled={!installed}>⬇ {s.name}.zip</a>)}
                  {!skills.length && <span className="text-sm text-muted">Install the app to download its skills.</span>}
                </div>
                <Steps steps={["Download the ZIP", "Claude → Customize → Skills → “+” → Upload a skill", "Pick the ZIP — Claude uses it automatically when relevant"]} />
                <p className="pt-2 text-sm font-medium">Option B — through the AIX connector (always up to date)</p>
                <ConnectorSteps host="claude" info={info} />
              </>
            )}
            {(tab === "claude-code" || tab === "cursor" || tab === "codex") && (
              <>
                <p className="text-sm font-medium">Install the skill files into {tab === "claude-code" ? "Claude Code" : tab === "cursor" ? "Cursor" : "Codex"}</p>
                {installed ? <SkillCommand slug={app.slug} agent={tab} /> : <p className="text-sm text-muted">Install the app first.</p>}
                <Steps steps={tab === "claude-code" ? ["Run the command in your project", "Start a new Claude Code session — the skill loads when relevant"] : ["Run the command in your project", "Restart the agent so it picks up the new skill"]} />
                {tab === "claude-code" && info.pluginMarketplace && (
                  <details className="text-sm"><summary className="cursor-pointer text-muted">Prefer plugins? Use the AIX plugin marketplace</summary><div className="mt-2 flex flex-col gap-2"><Copy text={`/plugin marketplace add ${info.pluginMarketplace}`} /><Copy text={`/plugin install ${app.slug}@aix`} /></div></details>
                )}
              </>
            )}
            {(tab === "chatgpt" || tab === "vscode") && (
              <>
                <p className="text-sm text-muted">{tab === "chatgpt" ? "ChatGPT" : "VS Code"} uses your installed skills through the AIX connector (as prompts and the skill_load tool).</p>
                <ConnectorSteps host={tab} info={info} />
              </>
            )}
          </div>
        )}
      </div>
      {props.example && installed && app.type !== "web" && (
        <p className="text-sm text-muted">Then just ask: <span className="rounded-lg bg-accent/10 px-2 py-0.5 text-ink">“{props.example}”</span></p>
      )}
    </section>
  );
}

export function ConnectTabs({ info }: { info: ConnectInfo }) {
  const tabs = HOST_TABS.filter((t) => t.id !== "codex");
  const [tab, setTab] = useState<string>("claude");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((t) => <button key={t.id} onClick={() => setTab(t.id)} className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${tab === t.id ? "bg-ink text-[light-dark(#fff,#111)]" : "bg-ink/5 text-muted hover:text-ink"}`}>{t.label}</button>)}
      </div>
      <div className="rounded-2xl border border-line p-5"><ConnectorSteps host={tab} info={info} /></div>
    </div>
  );
}
