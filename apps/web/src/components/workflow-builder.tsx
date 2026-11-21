"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { call } from "@/components/client";

type InstalledApp = { slug: string; name: string; type: string };
type Step = { app: string; tool: string; instruction: string };

const STARTERS: { name: string; description: string; steps: { app: string; tool?: string; instruction: string }[] }[] = [
  { name: "Launch kit", description: "Announcement, teaser video and ads for a launch", steps: [{ app: "launch-copy", tool: "launch-announcement", instruction: "Write the launch announcement from my notes" }, { app: "render-studio", tool: "render", instruction: "Turn the announcement into an 18s teaser storyboard" }, { app: "ad-copy-lab", instruction: "Write 5 ad headlines for the launch" }] },
  { name: "Weekly money check", description: "Categorize spending and suggest savings", steps: [{ app: "budget-buddy", instruction: "Categorize this week's transactions" }, { app: "inbox-zero-coach", instruction: "Draft a short note to myself with the 3 changes to make" }] },
  { name: "Market brief", description: "Research a market, then turn it into a deck outline", steps: [{ app: "market-scan", instruction: "Scan the market I name" }, { app: "deck-doctor", instruction: "Turn the findings into a 6-slide outline" }] },
];

export function WorkflowBuilder({ installed }: { installed: InstalledApp[] }) {
  const router = useRouter();
  const usable = installed.filter((a) => a.type === "server" || a.type === "prompt");
  const blank = (): Step => ({ app: usable[0]?.slug ?? "", tool: "", instruction: "" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<Step[]>([blank()]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  if (!usable.length) return <p className="muted">Install a tool or skill app first — workflows chain apps you've installed.</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <span className="text-sm text-muted">Start from:</span>
        {STARTERS.map((t) => (
          <button key={t.name} type="button" className="pill hover:border-accent" onClick={() => { setName(t.name); setDescription(t.description); setSteps(t.steps.map((s) => ({ app: s.app, tool: s.tool ?? "", instruction: s.instruction }))); }}>{t.name}</button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label><span className="label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch kit" /></label>
        <label><span className="label">What it does</span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Announcement + teaser + ads" /></label>
      </div>
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => {
          const app = usable.find((a) => a.slug === s.app);
          return (
            <li key={i} className="flex gap-3 rounded-2xl border border-line p-3">
              <span className="mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-ink">{i + 1}</span>
              <div className="grid flex-1 gap-2 sm:grid-cols-[200px_160px_1fr]">
                <select className="input" value={s.app} onChange={(e) => set(i, { app: e.target.value })} aria-label="App">
                  {!app && <option value={s.app}>{s.app} (not installed)</option>}
                  {usable.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
                </select>
                <input className="input" value={s.tool} onChange={(e) => set(i, { tool: e.target.value })} placeholder={app?.type === "prompt" ? "skill (optional)" : "tool (optional)"} aria-label="Tool or skill" />
                <input className="input" value={s.instruction} onChange={(e) => set(i, { instruction: e.target.value })} placeholder="What should this step do?" aria-label="Instruction" />
              </div>
              {steps.length > 1 && <button type="button" className="text-muted hover:text-bad" aria-label="Remove step" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>✕</button>}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {steps.length < 10 && <button type="button" className="btn" onClick={() => setSteps((x) => [...x, blank()])}>+ Add step</button>}
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await call("/me/workflows", "POST", { name, description, steps: steps.map((s) => ({ app: s.app, instruction: s.instruction, ...(s.tool ? { tool: s.tool } : {}) })) });
              setName(""); setDescription(""); setSteps([blank()]);
              router.refresh();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save workflow
        </button>
        {err && <span className="text-sm text-bad">{err}</span>}
      </div>
    </div>
  );
}
