import { runMigrations } from "@aix/db";
import { buildDeps } from "./app.js";
import { loadConfig } from "./config.js";
import { defaultJobs, tick } from "./jobs/scheduler.js";

const config = loadConfig();
const deps = buildDeps(config);
if (config.NODE_ENV !== "production") await runMigrations(deps.db);
const jobs = defaultJobs({ marketplaceDir: process.env.AIX_MARKETPLACE_DIR });
console.log(`[worker] started — jobs: ${jobs.map((j) => j.name).join(", ")}`);
let stopping = false;
const loop = async () => {
  while (!stopping) {
    try {
      const r = await tick(deps, jobs);
      if (r.ran.some((n) => n !== "expire-holds")) console.log(`[worker] ran ${r.ran.join(", ")}`);
    } catch (e: any) {
      console.error(`[worker] tick failed: ${e.message}`);
    }
    await new Promise((ok) => setTimeout(ok, 30_000));
  }
};
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, async () => { stopping = true; await deps.close(); process.exit(0); });
await loop();
