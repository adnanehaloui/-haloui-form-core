import Link from "next/link";
import { redirect } from "next/navigation";
import { api, getMe } from "@/lib/api";
import { ActionButton } from "@/components/client";
import { WorkflowBuilder } from "@/components/workflow-builder";
import { Copy } from "@/components/use-in";

export default async function Workflows() {
  if (!(await getMe())) redirect("/login?redirectTo=/workflows");
  const [flows, installs] = await Promise.all([api<{ data: any[] }>("/me/workflows"), api<{ data: any[] }>("/me/installs")]);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Workflows</h1>
        <p className="max-w-2xl text-lg text-muted">Chain your apps into one request. Your AI runs the steps in order through the AIX connector — paid steps still ask before charging.</p>
      </div>
      <section className="card flex flex-col gap-4">
        <h2 className="h2">New workflow</h2>
        <WorkflowBuilder installed={installs.data.map((i) => i.app)} />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-2xl font-semibold tracking-tight">Your workflows</h2>
        {flows.data.length === 0 && <p className="muted">None yet. <Link className="underline" href="/connect">Connect AIX to your AI</Link> to run them.</p>}
        <div className="grid gap-4 lg:grid-cols-2">
          {flows.data.map((f) => (
            <article key={f.id} className="flex flex-col gap-3 rounded-2xl border border-line p-5">
              <div className="flex items-start justify-between gap-2">
                <div><h3 className="text-lg font-semibold">{f.name}</h3><p className="text-sm text-muted">{f.description}</p></div>
                <ActionButton path={`/me/workflows/${f.id}`} method="DELETE" confirm={`Delete ${f.name}?`}>Delete</ActionButton>
              </div>
              <ol className="flex flex-col gap-1 text-sm">{f.steps.map((s: any, i: number) => <li key={i}><span className="font-medium">{i + 1}. {s.app}</span>{s.tool ? <span className="muted"> · {s.tool}</span> : null} — {s.instruction}</li>)}</ol>
              <p className="label mt-1">Run it in your AI</p>
              <Copy text={`Run my AIX workflow "${f.slug}"`} />
              <p className="text-xs text-muted">Or pick the prompt <code>{f.promptName}</code> in hosts that show prompts.</p>
              <details className="text-sm"><summary className="cursor-pointer text-muted">Plan your AI will follow</summary><pre className="mt-2 whitespace-pre-wrap rounded-xl bg-card p-3 text-xs">{f.rendered}</pre></details>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
