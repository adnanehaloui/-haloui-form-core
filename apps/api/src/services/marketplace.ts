/**
 * Export published `prompt` apps as a Claude Code plugin marketplace:
 *   <out>/.claude-plugin/marketplace.json
 *   <out>/plugins/<slug>/.claude-plugin/plugin.json
 *   <out>/plugins/<slug>/skills/<skill>/SKILL.md
 * Users run `/plugin marketplace add <git repo or path>` then `/plugin install <slug>@aix`.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { apps, appVersions, developers } from "@aix/db";
import { unpackFiles, type Manifest } from "@aix/manifest";
import type { Deps } from "../context.js";
import { verifyPackage } from "../routes/store.js";

export async function buildMarketplace(deps: Deps) {
  const rows = await deps.db
    .select({ app: apps, version: appVersions, developer: developers.displayName })
    .from(apps)
    .innerJoin(appVersions, eq(appVersions.id, apps.currentVersionId))
    .innerJoin(developers, eq(developers.id, apps.developerId))
    .where(and(eq(apps.status, "published"), eq(apps.type, "prompt")));
  const plugins: { slug: string; manifest: Manifest; developer: string; files: { path: string; content: Buffer }[] }[] = [];
  for (const r of rows) {
    const bytes = await verifyPackage(deps, r.version); // only signed, intact packages are exported
    const m = r.version.manifest as Manifest;
    const files = unpackFiles(bytes).filter((f) => (m.skills ?? []).includes(f.path));
    plugins.push({ slug: r.app.slug, manifest: m, developer: r.developer, files });
  }
  const marketplace = {
    name: "aix",
    owner: { name: "AIX" },
    metadata: { description: "Prompt apps published on the AIX store", version: "1.0.0" },
    plugins: plugins.map((p) => ({
      name: p.slug,
      source: `./plugins/${p.slug}`,
      description: p.manifest.description,
      version: p.manifest.version,
      author: { name: p.developer },
      category: p.manifest.category,
      homepage: `${deps.config.AIX_WEB_URL}/apps/${p.slug}`,
    })),
  };
  return { marketplace, plugins };
}

export async function exportMarketplace(deps: Deps, outDir: string) {
  const { marketplace, plugins } = await buildMarketplace(deps);
  await rm(join(outDir, "plugins"), { recursive: true, force: true });
  await mkdir(join(outDir, ".claude-plugin"), { recursive: true });
  await writeFile(join(outDir, ".claude-plugin", "marketplace.json"), JSON.stringify(marketplace, null, 2) + "\n");
  for (const p of plugins) {
    const root = join(outDir, "plugins", p.slug);
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: p.slug, description: p.manifest.description, version: p.manifest.version, author: { name: p.developer } }, null, 2) + "\n",
    );
    for (const f of p.files) {
      const skillName = basename(f.path).replace(/\.md$/i, "");
      const target = join(root, "skills", skillName, "SKILL.md");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content);
    }
  }
  return { plugins: plugins.length, path: outDir };
}
