# Running AIX locally

Requirements: Node 22+, pnpm 10 (`corepack enable`), Docker (Postgres + Mailpit). Optional: Stripe CLI.

## 1. Install and configure

```bash
pnpm install
cp .env.example .env
pnpm keys:generate >> .env      # AIX_ENCRYPTION_KEY + AIX_SIGNING_PRIVATE_KEY (or let dev auto-generate)
pnpm db:up                      # Postgres :5432, Mailpit :1025 (inbox UI http://localhost:8025)
pnpm build                      # builds the shared packages
pnpm seed                       # demo users, org, 3 sample apps; writes .env.seed
```

Keys you add to `.env` yourself (everything works without them, using fallbacks):

| Variable | Where to get it | Without it |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys (**test mode**, `sk_test_…`) | Fake checkout page at `/dev-checkout` (when `AIX_DEV_ENDPOINTS=1`) |
| `STRIPE_WEBHOOK_SECRET` | `stripe listen --forward-to localhost:4000/webhooks/stripe` prints `whsec_…` | Webhooks rejected |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud console → OAuth client, redirect `http://localhost:3000/api/auth/google/callback` | Magic link only |
| `AIX_SIGNING_PRIVATE_KEY` | `pnpm keys:generate` | Dev key auto-created in `apps/api/.storage/` |
| `AIX_ENCRYPTION_KEY` | `pnpm keys:generate` | Developer webhooks disabled |

## 2. Run everything

```bash
pnpm --filter @aix/api dev           # API        http://localhost:4000  (OpenAPI UI at /docs)
pnpm --filter @aix/web dev           # Web        http://localhost:3000
pnpm --filter @aix/mcp-gateway dev   # Gateway    http://localhost:4100/mcp
# sample server app (uses the seeded developer key):
cd templates/server && node --env-file=../../.env.seed --import tsx src/server.ts   # :4200
```

Sign in at http://localhost:3000/login with any seeded user (`alice@aix.local`, `dev@aix.local`, `carol@aix.local`,
`bob@aix.local`, `admin@aix.local`) — the magic link arrives in Mailpit (http://localhost:8025).

## 3. Milestone checks

| Milestone | How to check |
|---|---|
| M1 | `pnpm test` (ledger invariants, DB guards). Sign up at `/login` → `/wallet` shows €0.00 |
| M2 | Top up €20 at `/wallet` (Stripe test card `4242 4242 4242 4242`, or the fake checkout). Then `pnpm --filter @aix/api demo:charge` (first 3 renders are free, the 4th charges €0.50) — `/wallet` history shows it |
| M3 | `aix app init my-app --template server`, `aix login --key <key from .env.seed>`, `aix app publish`, approve at `/admin` as admin@aix.local, install from the store |
| M4 | Connect the gateway to Claude (below), install Render Studio, run `render-studio__render`, approve €0.50 in the panel, see it in `/wallet` |
| M5 | Developer → Payouts → "Set up payouts with Stripe" (Connect test onboarding), then `pnpm --filter @aix/api job:payouts -- 2026-11` |
| M6 | As carol@ open Organizations → Acme Corp → Block an app; as bob@ installing or calling it fails |

Automated end-to-end versions: `pnpm test` (API + gateway suites run the M1–M6 criteria against real Postgres)
and `pnpm e2e` (Playwright: sign up → top up → install → charge; needs `pnpm --filter @aix/web build` first).

## 4. Connecting the gateway to an AI host

The gateway is a remote MCP server with OAuth. Hosts must reach it over HTTPS, so expose your local ports with a
tunnel (e.g. `cloudflared tunnel --url http://localhost:4100`, plus one for the API on :4000) and set
`AIX_GATEWAY_URL` / `AIX_API_URL` / `AIX_WEB_URL` in `.env` to the public URLs.

- **Claude** (claude.ai → Settings → Connectors → Add custom connector): URL `https://<gateway>/mcp`. Claude registers
  itself (dynamic client registration), you sign in to AIX and approve the consent screen.
- **Claude Code**: `claude mcp add --transport http aix https://<gateway>/mcp`, then `/mcp` to authenticate.
- **Cursor / ChatGPT**: add a remote MCP server with the same URL.

Prompt apps for Claude Code: `pnpm --filter @aix/api job:export-marketplace` writes `marketplace/`; then
`/plugin marketplace add <path-or-git-url-of-marketplace>` and `/plugin install launch-copy@aix`.

## 5. Containers and CI

```bash
docker compose -f docker-compose.full.yml up --build   # postgres, mailpit, migrate, api, gateway, web
docker build --target api -t aix-api .                 # or gateway | migrate | web (--build-arg AIX_API_URL=…)
```
For a real deployment set `AIX_NODE_ENV=production` (the API then refuses to start without
`AIX_ENCRYPTION_KEY`, `AIX_SIGNING_PRIVATE_KEY`, Stripe keys, and refuses `sk_live_` keys and dev endpoints) and
public HTTPS URLs for `AIX_WEB_URL`, `AIX_API_URL`, `AIX_GATEWAY_URL`. Run `aix-api` with
`pnpm job:…` commands on a schedule for jobs.

CI (`.github/workflows/ci.yml`): typecheck, all test suites against Postgres, the Playwright happy path, and the
four Docker images.

## 6. Jobs (cron in production)

```bash
pnpm --filter @aix/api job:expire-holds          # every minute
pnpm --filter @aix/api job:invoices -- 2026-10   # monthly, 1st of month
pnpm --filter @aix/api job:payouts -- 2026-10    # monthly, after invoices
pnpm --filter @aix/api job:export-marketplace    # after each approval
```
All jobs are idempotent and safe to re-run.
