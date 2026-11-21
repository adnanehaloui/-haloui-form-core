/**
 * Background scheduler (run one or many `worker` processes — only the lock holder runs jobs).
 *   every minute : release expired holds, purge expired gateway actions
 *   1st of month : invoices for the previous month (emailed with PDF)
 *   2nd of month : developer payouts for the previous month
 *   hourly       : export the Claude Code plugin marketplace (if AIX_MARKETPLACE_DIR is set)
 * Exactly-once per (job, key) via the job_runs table; safe across restarts.
 */
import { sql } from "drizzle-orm";
import { jobRuns } from "@aix/db";
import { newId } from "@aix/core";
import type { Deps } from "../context.js";
import { expireHolds } from "../services/charges.js";
import { runInvoices } from "../services/invoices.js";
import { exportMarketplace } from "../services/marketplace.js";
import { previousPeriod, runPayouts } from "../services/payouts.js";
import { purgeGatewayPending } from "../routes/gateway.js";

const LOCK_ID = 726_143_001; // pg advisory lock key for "aix-scheduler"

export interface Job { name: string; key: (now: Date) => string | null; run: (deps: Deps, key: string) => Promise<unknown> }

export function defaultJobs(opts: { marketplaceDir?: string | undefined } = {}): Job[] {
  const minute = (d: Date) => d.toISOString().slice(0, 16);
  return [
    { name: "expire-holds", key: minute, run: async (deps) => ({ released: await expireHolds(deps), purged: await purgeGatewayPending(deps) }) },
    { name: "invoices", key: (d) => (d.getUTCDate() >= 1 ? previousPeriod(d) : null), run: (deps, period) => runInvoices(deps, period) },
    { name: "payouts", key: (d) => (d.getUTCDate() >= 2 ? previousPeriod(d) : null), run: (deps, period) => runPayouts(deps, period) },
    ...(opts.marketplaceDir ? [{ name: "export-marketplace", key: (d: Date) => d.toISOString().slice(0, 13), run: (deps: Deps) => exportMarketplace(deps, opts.marketplaceDir!) }] : []),
  ];
}

/** One scheduler tick. Returns which jobs ran. Every-minute jobs aren't recorded in job_runs. */
export async function tick(deps: Deps, jobs: Job[], now = deps.now()) {
  const ran: string[] = [];
  // Session-level advisory lock on a dedicated connection-scoped transaction.
  return deps.db.transaction(async (tx) => {
    const [l] = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${LOCK_ID}) as ok`);
    if (!l?.ok) return { ran, locked: false };
    for (const job of jobs) {
      const key = job.key(now);
      if (!key) continue;
      if (job.name !== "expire-holds") {
        const inserted = await tx.insert(jobRuns).values({ id: newId("job"), job: job.name, key }).onConflictDoNothing().returning();
        if (!inserted.length) continue; // already ran for this key
      }
      try {
        const result = await job.run(deps, key);
        if (job.name !== "expire-holds") await tx.update(jobRuns).set({ result: (result ?? null) as any }).where(sql`${jobRuns.job} = ${job.name} and ${jobRuns.key} = ${key}`);
        ran.push(job.name);
      } catch (e: any) {
        // Let it retry next tick: forget the run marker.
        if (job.name !== "expire-holds") await tx.delete(jobRuns).where(sql`${jobRuns.job} = ${job.name} and ${jobRuns.key} = ${key}`);
        console.error(`[worker] ${job.name} ${key} failed: ${e.message}`);
      }
    }
    return { ran, locked: true };
  });
}
