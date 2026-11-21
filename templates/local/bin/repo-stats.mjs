#!/usr/bin/env node
// Local AIX app: reads files under the given folder (declared in aix.json → permissions.files).
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const skip = new Set(["node_modules", ".git", "dist", ".next"]);
const stats = new Map();
async function walk(dir) {
  for (const name of await readdir(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) await walk(p);
    else if (s.size < 2_000_000) {
      const ext = extname(name) || "(none)";
      const lines = (await readFile(p, "utf8")).split("\n").length;
      const cur = stats.get(ext) ?? { files: 0, lines: 0 };
      stats.set(ext, { files: cur.files + 1, lines: cur.lines + lines });
    }
  }
}
await walk(root);
console.log(JSON.stringify(Object.fromEntries([...stats].sort((a, b) => b[1].lines - a[1].lines)), null, 2));
