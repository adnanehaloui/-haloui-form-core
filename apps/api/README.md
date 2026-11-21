# @aix/api

Fastify REST API. Zod schemas → OpenAPI (`/docs`, or `pnpm --filter @aix/api openapi` → `openapi.json`).

| Area | Routes | Auth |
|---|---|---|
| Auth | `/auth/magic-link`, `/auth/google/*`, `/auth/logout`, `/me` | session cookie |
| Wallet | `/wallet`, `/wallet/transactions`, `/wallet/charges`, `/wallet/topup`, `/wallet/limits`, `/wallet/invoices[/:period.pdf]` | session (or gateway token for reads) |
| Developer API | `/v1/auth/verify`, `/v1/holds[/:id/capture|release]`, `/v1/usage`, `/v1/entitlements/check`, `/v1/prices` | **secret key only** — the only way to charge |
| Developer portal | `/developer/*` (keys, publish, apps, prices, webhook, oauth-clients, connect, payouts, statements) | session or secret key |
| Store | `/store/apps[/:slug[/install|reviews|subscribe|package]]`, `/me/installs`, `/marketplace/claude-code.json` | public / session / gateway token |
| Approvals | `/approvals/:id[/decision]` | the approval's own user |
| OAuth 2.1 | `/.well-known/*`, `/oauth/register|authorize|token|revoke|userinfo` | — |
| Gateway | `/gateway/apps`, `/gateway/calls[/:runId/complete]` | gateway OAuth token |
| Orgs | `/orgs/*` (members, catalog, policies, budgets, audit[.csv]) | org role checks on every query |
| Admin | `/admin/*` (reviews, apps, charges/refund, ledger health) | `AIX_ADMIN_EMAILS` |
| Stripe | `/webhooks/stripe` | Stripe signature |

Code map: `src/services/charges.ts` (hold/capture/release/refund — the money core), `ledger.ts`, `stripe-events.ts`,
`payouts.ts`, `invoices.ts`, `tax.ts` (`TODO(tax)`), `policies.ts`, `user-tokens.ts`. Jobs: `src/jobs/cli.ts`.

```bash
pnpm --filter @aix/api dev      # :4000, runs migrations in dev
pnpm --filter @aix/api test     # integration tests against TEST_DATABASE_URL
pnpm --filter @aix/api seed     # demo data
```
