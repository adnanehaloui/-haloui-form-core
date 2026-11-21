import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where each agent looks for skills (folder per skill with SKILL.md), like `npx skills add`.
 * Project scope = current directory; global = home directory.
 */
export const AGENT_DIRS: Record<string, { project: string; global: string; label: string }> = {
  "claude-code": { project: ".claude/skills", global: ".claude/skills", label: "Claude Code" },
  cursor: { project: ".cursor/skills", global: ".cursor/skills", label: "Cursor" },
  codex: { project: ".agents/skills", global: ".codex/skills", label: "Codex" },
  agents: { project: ".agents/skills", global: ".agents/skills", label: "any agent (.agents/skills)" },
};

export interface AddOptions { slug: string; token: string; apiUrl: string; agent: string; global?: boolean; cwd?: string; home?: string }

export async function addSkills(o: AddOptions) {
  const dirs = AGENT_DIRS[o.agent];
  if (!dirs) throw new Error(`unknown agent "${o.agent}" — use one of: ${Object.keys(AGENT_DIRS).join(", ")}`);
  const res = await fetch(`${o.apiUrl.replace(/\/$/, "")}/store/apps/${encodeURIComponent(o.slug)}/skills?token=${encodeURIComponent(o.token)}`);
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message ?? `AIX API error ${res.status}`);
  if (!json.skills?.length) throw new Error(`${o.slug} has no skills to install (server apps run through the AIX connector instead)`);
  const base = o.global ? join(o.home ?? homedir(), dirs.global) : resolve(o.cwd ?? process.cwd(), dirs.project);
  const written: string[] = [];
  for (const s of json.skills as { name: string; content: string }[]) {
    if (!/^[a-z0-9-]{1,64}$/.test(s.name)) throw new Error(`refusing unsafe skill name ${s.name}`);
    const dir = join(base, s.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), s.content);
    written.push(join(dir, "SKILL.md"));
  }
  return { app: json.app as { name: string; version: string }, written, agentLabel: dirs.label };
}
