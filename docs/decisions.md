# Decisions log

Simple-first choices. Each entry: decision — why — revisit when.

## D1. Auth: Lucia-style database sessions owned by `apps/api` (not Auth.js)
- **Why:** Auth.js is designed to live inside Next.js, but AIX needs one session/identity source shared by the
  web app, the API, the MCP gateway *and* AIX's own OAuth 2.1 provider. Auth.js is a client of OAuth providers,
  not a provider. Lucia (the library) is deprecated, but its pattern is small and well documented: random
  session token → SHA-256 hash stored in `sessions`, HttpOnly SameSite=Lax cookie. Google uses `arctic`.
- **Revisit when:** we need SAML/SCIM for enterprise SSO.

## D2. `packages/core` for pure money/ledger logic
- **Why:** money rules must be testable without a DB; API and jobs share them.

## D3. Holds are real ledger movements (`wallet_available` → `wallet_held`)
- **Why:** keeps "balances derived from the ledger" true for held money too; no mutable reserved column.
  Concurrent holds are serialized with a row lock on the wallet's available account (tested with 12 parallel holds).

## D4. Commission as integer basis points; platform share rounded down
- **Why:** no floats in money code; split always sums exactly; rounding favours the developer.

## D5. Jobs are plain idempotent scripts; developer webhooks retry in-process
- **Why:** no queue dependency for an MVP. Webhooks get 4 attempts (0s, 1s, 5s, 30s backoff), same event id,
  re-signed per attempt; 4xx (except 408/429) stops retries. **Revisit:** `pg-boss` for durable retries across restarts.

## D6. Web talks to the API through a same-origin `/api/*` rewrite
- **Why:** one source of business logic; the session cookie stays first-party. No direct DB access from `web`.

## D7. EUR only, but every amount column has a `currency`
## D8. Ledger append-only and balanced, enforced in the database (triggers) as well as in code

## D9. One Ed25519 platform key signs OAuth access tokens, AIX user tokens and app packages
- **Why:** one key to manage, published as JWKS. **Revisit:** separate keys + rotation (`kid` already in tokens).

## D10. Hand-rolled OAuth 2.1 server with `jose` (not `oidc-provider`)
- Authorization code + PKCE S256 only, DCR for public clients, client-ID metadata documents, RFC 8707 resource →
  token audience, rotating refresh tokens, codes/refresh tokens hashed. ~300 lines, covered by the gateway test.

## D11. Org policies apply to everything a member does with an app
- If any org the user belongs to blocks an app (explicitly, by role, or via an approved-only catalog), the user can't
  install or call it — personal installs included. Simple and predictable for admins. **Revisit:** if users want
  personal use outside company policy, scope policies to org-paid installs only.

## D12. Charges require an install; the payer is the install's wallet
- A developer key can only charge users who installed that developer's app; org installs charge the org wallet with
  per-member budgets.

## D13. Approval inside AI hosts uses panel-only tools guarded by a nonce
- `approval_decide` / `app_install_confirm` are marked `visibility: ["app"]` (MCP Apps) **and** require a nonce that
  is only sent in the tool result's `_meta` (delivered to the panel, not the model). Hosts without MCP Apps fall back
  to the approval URL on the AIX website. Caps can never be overridden by an approval.

## D14. MCP SDK v1 + ext-apps 1.7
- The spec names `@modelcontextprotocol/sdk` (v1). ext-apps 2.x targets the split v2 SDK packages, so we pin
  `@modelcontextprotocol/ext-apps@~1.7` which pairs with SDK v1. **Revisit:** migrate both to v2 together.

## D15. Gateway is stateless; pending approvals/install nonces live in Postgres (via the API)
- `gateway_pending` stores only the nonce's SHA-256 and an AES-GCM-encrypted payload (the original tool call), is
  single-use (row deleted on consume) and expires after 10 minutes (`job:expire-holds` purges leftovers). Any
  number of gateway instances can serve a user — tested by deciding an approval on a second instance.

## D16. Package format `aixpkg/1` = gzip(JSON of files)
- No tar dependency; deterministic; path traversal rejected; 10 MB cap. Hash on upload, signed on approval,
  re-verified on every install and marketplace export.

## D17. Free included units are lifetime per user per price; holds expire after 15 min (max 24 h)
## D18. New users: auto-approve ≤ €1.00 per charge, €20 monthly cap; minimum top-up €5
## D19. Subscriptions are paid by card through Stripe Billing, not from the wallet
## D20. Package storage on the local filesystem behind a `Storage` interface (swap for S3/R2 later)
## D21. In development without keys: generated signing key in `.storage/`, fake Stripe checkout page
## D22. One multi-target Dockerfile; API and gateway run TypeScript with tsx in production
- **Why:** no separate bundling step to maintain. Images: `api`, `gateway`, `migrate`, `web`. **Revisit:** compile to JS for faster cold starts.
