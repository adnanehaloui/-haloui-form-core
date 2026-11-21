/** Scheduled jobs. Run from cron, e.g. `pnpm --filter @aix/api job:payouts -- 2026-10`. All idempotent. */
import { resolve } from "node:path";
import { buildDeps } from "../app.js";
import { loadConfig } from "../config.js";
import { expireHolds } from "../services/charges.js";
import { purgeGatewayPending } from "../routes/gateway.js";
import { runInvoices } from "../services/invoices.js";
import { exportMarketplace } from "../services/marketplace.js";
import { previousPeriod, runPayouts } from "../services/payouts.js";

const [job, arg] = process.argv.slice(2);
const deps = buildDeps(loadConfig());
try {
  switch (job) {
    case "payouts": {
      const results = await runPayouts(deps, arg ?? previousPeriod());
      console.table(results);
      break;
    }
    case "invoices":
      console.log(`invoices written: ${await runInvoices(deps, arg ?? previousPeriod())}`);
      break;
    case "expire-holds":
      console.log(`holds released: ${await expireHolds(deps)}, pending gateway actions purged: ${await purgeGatewayPending(deps)}`);
      break;
    case "export-marketplace": {
      const out = resolve(arg ?? "../../marketplace");
      console.log(await exportMarketplace(deps, out));
      break;
    }
    default:
      console.error("usage: cli.ts payouts|invoices|expire-holds|export-marketplace [period|dir]");
      process.exitCode = 1;
  }
} finally {
  await deps.close();
}
