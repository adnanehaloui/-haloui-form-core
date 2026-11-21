import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describePermissions, packFiles, sha256, validateManifest, type PackageFile, type ValidationResult } from "@aix/manifest";

export const TEMPLATES = ["prompt", "server", "local", "web"] as const;
export type Template = (typeof TEMPLATES)[number];

const ALWAYS_IGNORE = new Set(["node_modules", ".git", ".env", ".turbo", "dist", ".DS_Store", ".storage"]);

export function templatesDir(): string {
  if (process.env.AIX_TEMPLATES_DIR) return process.env.AIX_TEMPLATES_DIR;
  // packages/cli/dist → repo-root/templates (see README: bundle templates before publishing the CLI)
  return fileURLToPath(new URL("../../../templates", import.meta.url));
}

export async function initApp(dir: string, template: Template, o: { name: string; id: string }) {
  const target = resolve(dir);
  if (existsSync(join(target, "aix.json"))) throw new Error(`${target} already contains an aix.json`);
  const src = join(templatesDir(), template);
  await cp(src, target, { recursive: true, filter: (p) => !p.split(sep).some((s) => ALWAYS_IGNORE.has(s)) });
  const manifestPath = join(target, "aix.json");
  const m = JSON.parse(await readFile(manifestPath, "utf8"));
  m.name = o.name;
  m.id = o.id;
  m.version = "0.1.0";
  await writeFile(manifestPath, JSON.stringify(m, null, 2) + "\n");
  // Template package.json: give it a unique name, keep workspace deps.
  const pj = join(target, "package.json");
  if (existsSync(pj)) {
    const p = JSON.parse(await readFile(pj, "utf8"));
    p.name = o.id.split(".").at(-1);
    await writeFile(pj, JSON.stringify(p, null, 2) + "\n");
  }
  return target;
}

export async function readManifest(dir: string): Promise<ValidationResult & { raw: unknown }> {
  const path = join(resolve(dir), "aix.json");
  if (!existsSync(path)) return { ok: false, errors: [{ path: "aix.json", message: `not found in ${resolve(dir)}` }], warnings: [], raw: null };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e: any) {
    return { ok: false, errors: [{ path: "aix.json", message: `invalid JSON: ${e.message}` }], warnings: [], raw: null };
  }
  const r = validateManifest(raw);
  if (r.ok && r.manifest!.type === "prompt") {
    for (const s of r.manifest!.skills ?? []) if (!existsSync(join(dir, s))) r.errors.push({ path: "skills", message: `missing file ${s}` });
    r.ok = r.errors.length === 0;
  }
  return { ...r, raw };
}

async function walk(root: string, dir: string, ignore: Set<string>, out: PackageFile[]) {
  for (const entry of await readdir(dir)) {
    if (ALWAYS_IGNORE.has(entry) || ignore.has(entry)) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) await walk(root, full, ignore, out);
    else if (s.isFile()) out.push({ path: relative(root, full).split(sep).join("/"), content: await readFile(full) });
  }
}

export async function packApp(dir: string) {
  const root = resolve(dir);
  let ignore = new Set<string>();
  if (existsSync(join(root, ".aixignore"))) ignore = new Set((await readFile(join(root, ".aixignore"), "utf8")).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")));
  const files: PackageFile[] = [];
  await walk(root, root, ignore, files);
  const pkg = packFiles(files);
  return { pkg, sha256: sha256(pkg), files: files.map((f) => f.path) };
}

export { describePermissions };
