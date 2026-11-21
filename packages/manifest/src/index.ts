import { z } from "zod";

export const HOSTS = ["claude", "chatgpt", "cursor", "claude-code", "web"] as const;
export const APP_TYPES = ["prompt", "server", "local", "web"] as const;
export const USER_DATA_FIELDS = ["email", "name"] as const;
export const CATEGORIES = ["video", "images", "writing", "research", "data", "code", "productivity", "marketing", "finance", "other"] as const;

const httpsUrl = z.url().refine((u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u), {
  message: "must be an https URL (http allowed only for localhost)",
});
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "must be semver, e.g. 1.0.0");

const pricingEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("free"), includedUnits: z.number().int().positive().optional(), unit: z.string().min(1).optional() }),
  z.object({ kind: z.literal("one_time"), displayPrice: z.string().optional() }),
  z.object({ kind: z.literal("subscription"), interval: z.enum(["month", "year"]), displayPrice: z.string().optional(), plan: z.string().optional() }),
  z.object({ kind: z.literal("metered"), unit: z.string().min(1), displayPrice: z.string().optional() }),
]);

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+){2,}$/, "must be reverse-DNS, e.g. com.acme.videostudio"),
    name: z.string().min(2).max(50),
    version: semver,
    type: z.enum(APP_TYPES),
    description: z.string().min(10).max(500),
    category: z.enum(CATEGORIES).default("other"),
    entry: z
      .object({
        mcp: httpsUrl.optional(),
        web: httpsUrl.optional(),
        /** local apps: relative path of the executable inside the package */
        command: z.string().optional(),
      })
      .default({}),
    compatibility: z.object({ hosts: z.array(z.enum(HOSTS)).min(1) }),
    permissions: z
      .object({
        network: z.array(httpsUrl).default([]),
        files: z.array(z.string()).default([]),
        userData: z.array(z.enum(USER_DATA_FIELDS)).default([]),
      })
      .default({ network: [], files: [], userData: [] }),
    pricing: z.array(pricingEntry).default([]),
    /** prompt apps: Markdown skill files shipped in the package */
    skills: z.array(z.string()).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === "server" && !m.entry.mcp) ctx.addIssue({ code: "custom", path: ["entry", "mcp"], message: "server apps need entry.mcp" });
    if (m.type === "web" && !m.entry.web) ctx.addIssue({ code: "custom", path: ["entry", "web"], message: "web apps need entry.web" });
    if (m.type === "local" && !m.entry.command) ctx.addIssue({ code: "custom", path: ["entry", "command"], message: "local apps need entry.command" });
    if (m.type === "prompt" && (m.entry.mcp || m.entry.command)) {
      ctx.addIssue({ code: "custom", path: ["entry"], message: "prompt apps cannot run code (no entry.mcp / entry.command)" });
    }
    // Server/web apps may only reach the hosts they declare.
    for (const url of [m.entry.mcp, m.entry.web].filter(Boolean) as string[]) {
      const origin = new URL(url).origin;
      if (m.type === "server" && url === m.entry.mcp && !m.permissions.network.some((n) => new URL(n).origin === origin)) {
        ctx.addIssue({ code: "custom", path: ["permissions", "network"], message: `entry ${origin} must be listed in permissions.network` });
      }
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;

export interface ValidationResult {
  ok: boolean;
  manifest?: Manifest;
  errors: { path: string; message: string }[];
  warnings: string[];
}

/** Validate a parsed aix.json. Never throws. */
export function validateManifest(input: unknown): ValidationResult {
  const r = manifestSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, errors: r.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })), warnings: [] };
  }
  const warnings: string[] = [];
  const m = r.data;
  if (m.type === "local" && m.permissions.files.length === 0) warnings.push("local app declares no file permissions — is that right?");
  if (m.pricing.some((p) => "displayPrice" in p && p.displayPrice)) {
    warnings.push("displayPrice is for store listings only; real prices are set in the AIX catalog (aix prices create).");
  }
  return { ok: true, manifest: m, errors: [], warnings };
}

/** Human-readable permission lines for the install screen. */
export function describePermissions(m: Pick<Manifest, "type" | "permissions">): string[] {
  const lines: string[] = [];
  for (const n of m.permissions.network) lines.push(`Connect to ${n}`);
  for (const f of m.permissions.files) lines.push(`Access files: ${f}`);
  for (const u of m.permissions.userData) lines.push(`Read your ${u}`);
  if (m.type === "local") lines.push("Run code on your computer");
  if (lines.length === 0) lines.push("No special permissions");
  return lines;
}

/** Turn "VideoStudio" / "com.acme.videostudio" into a URL slug. */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** JSON Schema for editors ($schema in aix.json). */
export function manifestJsonSchema() {
  return z.toJSONSchema(manifestSchema, { io: "input" });
}
