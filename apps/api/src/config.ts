import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default("postgres://aix:aix@localhost:5432/aix"),
  AIX_WEB_URL: z.string().default("http://localhost:3000"),
  AIX_API_URL: z.string().default("http://localhost:4000"),
  AIX_GATEWAY_URL: z.string().default("http://localhost:4100"),
  /** Comma-separated emails that get the internal admin console. */
  AIX_ADMIN_EMAILS: z.string().default(""),
  /** 32-byte base64 key (AES-256-GCM) for stored third-party secrets. */
  AIX_ENCRYPTION_KEY: z.string().optional(),
  /** Ed25519 private key, PKCS#8 PEM (\n-escaped ok). Signs OAuth tokens, AIX user tokens and app packages. */
  AIX_SIGNING_PRIVATE_KEY: z.string().optional(),
  AIX_STORAGE_DIR: z.string().default("./.storage"),
  /** "fs" (local disk, default) or "s3" (AWS S3 / Cloudflare R2 / MinIO). */
  AIX_STORAGE: z.enum(["fs", "s3"]).default("fs"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  /** Bearer token required for /metrics (always required in production). */
  AIX_METRICS_TOKEN: z.string().optional(),
  /** Git URL (or path) of the exported Claude Code plugin marketplace (`job:export-marketplace`), if published. */
  AIX_PLUGIN_MARKETPLACE_URL: z.string().optional(),
  AIX_MAILER: z.enum(["smtp", "memory"]).default("smtp"),
  SMTP_URL: z.string().default("smtp://localhost:1025"),
  MAIL_FROM: z.string().default("AIX <no-reply@aix.local>"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Hold lifetime default (seconds). */
  /** Requests per minute: per IP for browsers/hosts, per secret key for developer servers. */
  AIX_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  AIX_DEV_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(6000),
  AIX_HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Minimum wallet top-up in cents. */
  AIX_MIN_TOPUP_CENTS: z.coerce.number().int().positive().default(500),
  /** Fraud limits on card top-ups (per wallet): daily total, checkout attempts per hour, and a lower cap for new accounts. */
  AIX_MAX_TOPUP_DAILY_CENTS: z.coerce.number().int().positive().default(50_000),
  AIX_MAX_TOPUP_ATTEMPTS_PER_HOUR: z.coerce.number().int().positive().default(5),
  AIX_NEW_ACCOUNT_TOPUP_DAILY_CENTS: z.coerce.number().int().positive().default(10_000),
  /** Minimum developer payout in cents. */
  AIX_MIN_PAYOUT_CENTS: z.coerce.number().int().nonnegative().default(100),
  /** Enables /_dev endpoints (memory mailbox, fake top-ups). Never in production. */
  AIX_DEV_ENDPOINTS: bool,
});

export type Config = z.infer<typeof schema> & { adminEmails: Set<string> };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  if (c.NODE_ENV === "production") {
    for (const k of ["AIX_ENCRYPTION_KEY", "AIX_SIGNING_PRIVATE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const) {
      if (!c[k]) throw new Error(`${k} is required in production`);
    }
    if (c.AIX_DEV_ENDPOINTS) throw new Error("AIX_DEV_ENDPOINTS must be off in production");
    if (c.AIX_STORAGE === "s3" && (!c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) throw new Error("S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required with AIX_STORAGE=s3");
    if (!c.AIX_METRICS_TOKEN) throw new Error("AIX_METRICS_TOKEN is required in production (protects /metrics)");
    if (c.STRIPE_SECRET_KEY?.startsWith("sk_live_")) throw new Error("Live Stripe keys are not allowed yet (test mode only)");
  }
  return { ...c, adminEmails: new Set(c.AIX_ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) };
}
