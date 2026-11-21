/**
 * Workflows: a user's saved recipe chaining several installed apps (e.g. Launch Copy → Render Studio →
 * Ad Copy Lab). AIX stores and renders them; the user's own AI runs them through the AIX connector
 * (MCP prompt `workflow__<slug>` or the `workflow_run` tool). Paid steps still hold/approve/charge per app.
 */
import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { apps, installs, workflows } from "@aix/db";
import { newId } from "@aix/core";
import { slugify } from "@aix/manifest";
import type { App, Deps } from "../context.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";

const step = z.object({
  app: z.string().max(60).describe("installed app slug"),
  tool: z.string().max(100).optional().describe("tool or skill name; empty = let the AI pick"),
  instruction: z.string().min(3).max(1000),
});
const body = z.object({ name: z.string().min(2).max(60), description: z.string().max(500).default(""), steps: z.array(step).min(1).max(10) });
type Step = z.infer<typeof step>;

async function installedApps(deps: Deps, userId: string, slugs: string[]) {
  if (!slugs.length) return [];
  return deps.db
    .select({ slug: apps.slug, name: apps.name, type: apps.type })
    .from(installs)
    .innerJoin(apps, eq(apps.id, installs.appId))
    .where(and(eq(installs.userId, userId), isNull(installs.uninstalledAt), inArray(apps.slug, slugs)));
}

/** Turn a workflow into instructions any MCP host's model can follow. */
export function renderWorkflow(w: { name: string; description: string; steps: Step[] }, appInfo: Map<string, { name: string; type: string }>) {
  const lines = w.steps.map((s, i) => {
    const a = appInfo.get(s.app);
    const name = a?.name ?? s.app;
    const how =
      a?.type === "prompt"
        ? `load the skill \`${s.app}__${s.tool ?? "<the most relevant skill>"}\` with skill_load and apply it`
        : s.tool
          ? `call the tool \`${s.app}__${s.tool}\``
          : `use the best ${name} tool (\`${s.app}__…\`)`;
    return `${i + 1}. **${name}** — ${how}: ${s.instruction}`;
  });
  return [
    `# Workflow: ${w.name}`,
    w.description,
    "",
    "Run these steps in order with the user's installed AIX apps. Use each step's output as input for the next.",
    "If a step needs the user's approval for a charge, call aix_approve and wait — never approve for them. If an app isn't installed, stop and tell the user.",
    "",
    ...lines,
    "",
    "Finish with a short summary of what each step produced and any AIX receipts.",
  ].join("\n");
}

export async function workflowRoutes(app: App, deps: Deps) {
  const load = async (userId: string) => deps.db.select().from(workflows).where(eq(workflows.userId, userId)).orderBy(desc(workflows.updatedAt));

  async function validate(userId: string, steps: Step[]) {
    const slugs = [...new Set(steps.map((s) => s.app))];
    const found = await installedApps(deps, userId, slugs);
    const missing = slugs.filter((s) => !found.some((f) => f.slug === s));
    if (missing.length) throw badRequest(`install these apps first: ${missing.join(", ")}`);
    const bad = found.filter((f) => f.type === "web" || f.type === "local");
    if (bad.length) throw badRequest(`${bad.map((b) => b.name).join(", ")} can't run inside a chat workflow`);
  }

  app.get("/me/workflows", { schema: { tags: ["workflows"] } }, async (req) => {
    const u = await requireUser(deps, req);
    const rows = await load(u.userId);
    const info = new Map((await installedApps(deps, u.userId, [...new Set(rows.flatMap((w) => (w.steps as Step[]).map((s) => s.app)))])).map((a) => [a.slug, a]));
    return { data: rows.map((w) => ({ ...w, promptName: `workflow__${w.slug}`, rendered: renderWorkflow(w as any, info) })) };
  });

  app.post("/me/workflows", { schema: { tags: ["workflows"], body } }, async (req) => {
    const u = await requireUser(deps, req);
    await validate(u.userId, req.body.steps);
    const slug = slugify(req.body.name).slice(0, 40) || "workflow";
    const [dupe] = await deps.db.select().from(workflows).where(and(eq(workflows.userId, u.userId), eq(workflows.slug, slug)));
    if (dupe) throw conflict("you already have a workflow with that name");
    const [w] = await deps.db.insert(workflows).values({ id: newId("wf"), userId: u.userId, slug, ...req.body }).returning();
    return w;
  });

  app.put("/me/workflows/:id", { schema: { tags: ["workflows"], params: z.object({ id: z.string() }), body } }, async (req) => {
    const u = await requireUser(deps, req);
    await validate(u.userId, req.body.steps);
    const [w] = await deps.db.update(workflows).set({ ...req.body, updatedAt: deps.now() }).where(and(eq(workflows.id, req.params.id), eq(workflows.userId, u.userId))).returning();
    if (!w) throw notFound("workflow not found");
    return w;
  });

  app.delete("/me/workflows/:id", { schema: { tags: ["workflows"], params: z.object({ id: z.string() }) } }, async (req) => {
    const u = await requireUser(deps, req);
    const r = await deps.db.delete(workflows).where(and(eq(workflows.id, req.params.id), eq(workflows.userId, u.userId))).returning();
    if (!r.length) throw notFound("workflow not found");
    return { ok: true };
  });
}
