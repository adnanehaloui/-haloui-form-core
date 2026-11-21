import { runMigrations } from "@aix/db";
import { buildApp, buildDeps } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const deps = buildDeps(config);
if (config.NODE_ENV !== "production") await runMigrations(deps.db);
const app = await buildApp(deps, { logger: true });
await app.listen({ port: config.PORT, host: "0.0.0.0" });
if (!deps.payments) app.log.warn("Stripe not configured — top-ups disabled. Set STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET, or AIX_DEV_ENDPOINTS=1 for fake payments.");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await deps.close();
    process.exit(0);
  });
}
