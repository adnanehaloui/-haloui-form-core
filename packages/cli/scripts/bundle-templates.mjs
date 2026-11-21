// Copies the repo's templates/ into the CLI package before `npm pack` / `npm publish`.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", "templates");
const dest = join(here, "..", "templates");
if (!existsSync(src)) throw new Error(`templates not found at ${src}`);
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: (p) => !p.split(sep).some((s) => ["node_modules", ".turbo", "dist"].includes(s)) });
console.log(`bundled templates → ${dest}`);
