/** Tiny Prometheus exposition (no dependency): request counters/latency + business gauges on scrape. */
import { sql } from "drizzle-orm";
import type { App, Deps } from "../context.js";
import { trialBalance } from "../services/ledger.js";
import { safeEqual } from "@aix/core";

export function registerMetrics(app: App, deps: Deps) {
  const requests = new Map<string, number>();
  const durations = new Map<string, { sum: number; count: number }>();
  const started = Date.now();

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    const k = `method="${req.method}",route="${route}",status="${reply.statusCode}"`;
    requests.set(k, (requests.get(k) ?? 0) + 1);
    const dk = `route="${route}"`;
    const d = durations.get(dk) ?? { sum: 0, count: 0 };
    d.sum += reply.elapsedTime / 1000;
    d.count++;
    durations.set(dk, d);
  });

  app.get("/health/ready", { schema: { hide: true } }, async (_req, reply) => {
    try {
      await deps.db.execute(sql`select 1`);
      return { ok: true, db: "up" };
    } catch {
      return reply.status(503).send({ ok: false, db: "down" });
    }
  });

  app.get("/metrics", { schema: { hide: true } }, async (req, reply) => {
    const token = deps.config.AIX_METRICS_TOKEN;
    const given = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (token ? !safeEqual(given, token) : deps.config.NODE_ENV === "production") return reply.status(401).send("unauthorized");
    const [counts] = await deps.db.execute<Record<string, string>>(sql`
      select
        (select count(*) from users where deleted_at is null) as users,
        (select count(*) from apps where status = 'published') as apps_published,
        (select count(*) from installs where uninstalled_at is null) as installs,
        (select count(*) from charges where status = 'captured' and captured_at > now() - interval '1 day') as charges_captured_24h,
        (select coalesce(sum(amount_cents), 0) from charges where status = 'captured' and captured_at > now() - interval '1 day') as revenue_gross_cents_24h,
        (select count(*) from charges where status = 'held') as holds_open,
        (select count(*) from approval_requests where status = 'pending' and expires_at > now()) as approvals_pending,
        (select count(*) from reports where status = 'open') as reports_open,
        (select count(*) from disputes where status not in ('won', 'lost')) as disputes_open`);
    const tb = await trialBalance(deps.db);
    const lines = [
      "# HELP aix_http_requests_total HTTP requests",
      "# TYPE aix_http_requests_total counter",
      ...[...requests].map(([k, v]) => `aix_http_requests_total{${k}} ${v}`),
      "# HELP aix_http_request_duration_seconds Request latency",
      "# TYPE aix_http_request_duration_seconds summary",
      ...[...durations].flatMap(([k, v]) => [`aix_http_request_duration_seconds_sum{${k}} ${v.sum.toFixed(6)}`, `aix_http_request_duration_seconds_count{${k}} ${v.count}`]),
      "# HELP aix_ledger_balanced 1 if total debits equal total credits",
      "# TYPE aix_ledger_balanced gauge",
      `aix_ledger_balanced ${tb.debitCents === tb.creditCents ? 1 : 0}`,
      ...Object.entries(counts ?? {}).flatMap(([k, v]) => [`# TYPE aix_${k} gauge`, `aix_${k} ${Number(v)}`]),
      "# TYPE aix_process_uptime_seconds gauge",
      `aix_process_uptime_seconds ${((Date.now() - started) / 1000).toFixed(0)}`,
    ];
    return reply.header("content-type", "text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });
}
