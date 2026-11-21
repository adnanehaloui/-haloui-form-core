# Decisions log

Simple-first choices. Each entry: decision — why — revisit when.

## D1. Auth: Lucia-style database sessions owned by `apps/api` (not Auth.js)
- **Why:** Auth.js is designed to live inside Next.js, but AIX needs one session/identity source shared by the
  web app, the API, the MCP gateway *and* AIX's own OAuth 2.1 provider. Auth.js is a client of OAuth providers,
  not a provider. Lucia (the library) is deprecated, but its pattern is small and well documented: random
  session token → SHA-256 hash stored in `sessions`, HttpOnly cookie, sliding expiry. Magic-link tokens follow the
  same pattern. Google sign-in uses a small OAuth client helper (proposed: `arctic`, pending approval — see Q1).
- **Revisit when:** we need SAML/SCIM for enterprise SSO.

## D2. Add `packages/core` for pure money/ledger logic
- **Why:** money rules must be testable without a DB; API and jobs share them.

## D3. Holds are real ledger movements (`wallet_available` → `wallet_held`)
- **Why:** keeps "balances derived from the ledger" true for held money too; no mutable reserved column.

## D4. Commission as integer basis points; platform share rounded down
- **Why:** no floats in money code; split always sums exactly.

## D5. Jobs (payouts, invoices, hold expiry) are plain scripts in `apps/api/src/jobs`
- **Why:** no queue dependency for an MVP; cron (or `pnpm job:payouts`) runs them. Jobs are idempotent by period key.
- **Revisit when:** we need retries/concurrency → consider `pg-boss` (Postgres-backed, no new infra).

## D6. Web talks to the API over HTTP with the session cookie (same parent domain)
- **Why:** one source of business logic; Next.js server components call the API, no direct DB access from `web`.

## D7. Currency: EUR only, but every amount column is paired with a `currency` column
- **Why:** spec says EUR; the pairing makes multi-currency a later addition rather than a migration rewrite.

## D8. Ledger append-only enforced in the database
- **Why:** the app DB role gets no UPDATE/DELETE on `ledger_entries`/`ledger_transactions`; a deferred constraint
  trigger rejects unbalanced transactions. Defence in depth beyond application code.
