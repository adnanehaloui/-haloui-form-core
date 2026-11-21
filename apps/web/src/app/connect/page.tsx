import Link from "next/link";
import { api } from "@/lib/api";
import { ConnectTabs, Copy, type ConnectInfo } from "@/components/use-in";

export default async function Connect() {
  const info = await api<ConnectInfo>("/store/connect-info");
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Connect AIX to your AI</h1>
        <p className="text-lg text-muted">Add one connector. Every app you install on AIX — tools, skills, workflows — appears inside Claude, ChatGPT, Cursor, VS Code and Claude Code. Your AI subscription pays for the chat; your AIX wallet pays only for the work.</p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="label">Your AIX connector URL</p>
        <Copy text={info.mcpUrl} label="Copy URL" />
      </div>
      <ConnectTabs info={info} />
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["🔐", "You stay in control", "AIX never sees your Claude or ChatGPT login. Disconnect any time from your wallet."],
          ["💳", "One wallet", "Paid runs ask first above your threshold, and never exceed your monthly cap."],
          ["🧩", "Install once", "Apps you add on AIX appear in every connected AI tool automatically."],
        ].map(([i, t, d]) => (
          <div key={t} className="rounded-2xl bg-card p-4"><p className="text-2xl">{i}</p><p className="mt-1 font-semibold">{t}</p><p className="text-sm text-muted">{d}</p></div>
        ))}
      </div>
      <Link href="/" className="btn-primary self-start rounded-full">Find apps to install</Link>
    </div>
  );
}
