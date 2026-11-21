import { unpackFiles, type Manifest } from "@aix/manifest";
import type { appVersions } from "@aix/db";
import type { Deps } from "../context.js";
import { verifyPackage } from "../routes/store.js";

export interface Skill { name: string; description: string; content: string; path: string }

/** Parse `name` / `description` from SKILL.md front matter (falls back to the file name). */
export function parseSkill(path: string, content: string): Skill {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const fallback = path.split("/").pop()!.replace(/\.md$/i, "").replace(/^SKILL$/i, path.split("/").slice(-2, -1)[0] ?? "skill");
  const name = (get("name") ?? fallback).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "skill";
  return { name, description: get("description") ?? "", content, path };
}

/** Skills of a prompt app, read from its verified, signed package. */
export async function appSkills(deps: Deps, version: typeof appVersions.$inferSelect): Promise<Skill[]> {
  const m = version.manifest as Manifest;
  if (!m.skills?.length) return [];
  const files = unpackFiles(await verifyPackage(deps, version));
  return m.skills
    .map((p) => files.find((f) => f.path === p))
    .filter((f): f is NonNullable<typeof f> => !!f)
    .map((f) => parseSkill(f.path, f.content.toString("utf8")));
}
