import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobRuns } from "@aix/db";
import { setup, type Ctx } from "./helpers.js";
import { tick, type Job } from "../src/jobs/scheduler.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup({ AIX_METRICS_TOKEN: "metrics-secret" });
});
afterAll(() => ctx.close());

describe("scheduler", () => {
  it("runs monthly jobs exactly once per period, retries failures, one instance at a time", async () => {
    const calls: string[] = [];
    let failOnce = true;
    const jobs: Job[] = [
      { name: "invoices", key: () => "2026-10", run: async (_d, k) => { await new Promise((r) => setTimeout(r, 300)); calls.push(`invoices:${k}`); } },
      { name: "flaky", key: () => "2026-10", run: async () => { if (failOnce) { failOnce = false; throw new Error("boom"); } calls.push("flaky"); } },
    ];
    const [a, b] = await Promise.all([tick(ctx.deps, jobs), tick(ctx.deps, jobs)]);
    expect([a.locked, b.locked].filter(Boolean)).toHaveLength(1); // only one instance runs
    await tick(ctx.deps, jobs);
    await tick(ctx.deps, jobs);
    expect(calls).toEqual(["invoices:2026-10", "flaky"]);
    expect((await ctx.db.select().from(jobRuns)).map((r) => r.job).sort()).toEqual(["flaky", "invoices"]);
  });
});

describe("metrics and readiness", () => {
  it("requires the token and exposes Prometheus text", async () => {
    await ctx.app.inject({ method: "GET", url: "/store/apps" });
    expect((await ctx.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const m = await ctx.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-secret" } });
    expect(m.headers["content-type"]).toContain("text/plain");
    expect(m.body).toContain('aix_http_requests_total{method="GET",route="/store/apps",status="200"} 1');
    expect(m.body).toContain("aix_ledger_balanced 1");
    expect(m.body).toMatch(/aix_apps_published \d+/);
    expect((await ctx.app.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({ ok: true, db: "up" });
  });
});
