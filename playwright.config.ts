import { defineConfig } from "@playwright/test";

// One end-to-end happy path across web + API (fake Stripe checkout, memory mailer).
// Requires Postgres (pnpm db:up) and a built web app (pnpm --filter @aix/web build).
const env = { AIX_MAILER: "memory", AIX_DEV_ENDPOINTS: "1", STRIPE_SECRET_KEY: "", AIX_ADMIN_EMAILS: "admin@aix.local" };

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:3000", trace: "off" },
  webServer: [
    { command: "pnpm --filter @aix/api start", url: "http://localhost:4000/health", reuseExistingServer: true, env, timeout: 60_000 },
    { command: "pnpm --filter @aix/web start", url: "http://localhost:3000", reuseExistingServer: true, env: { AIX_API_URL: "http://localhost:4000" }, timeout: 60_000 },
  ],
});
