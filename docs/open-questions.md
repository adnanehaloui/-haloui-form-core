# Open questions (need your decision)

Each has my recommendation so you can just answer "yes" / "go with the recommendation".

## Dependencies to approve (not listed in the spec)
1. **`arctic`** — tiny OAuth 2.0 client for Google sign-in. *Recommend: yes.* (Alternative: hand-roll the Google flow.)
2. **OAuth 2.1 provider implementation.** MCP authorization needs metadata discovery (RFC 8414 / RFC 9728), PKCE,
   and dynamic client registration or client-ID metadata documents.
   - (a) `oidc-provider` (panva) — battle-tested, certified, but large and opinionated;
   - (b) hand-rolled minimal authorization-code + PKCE + DCR with `jose` for JWTs.
   *Recommend: (b) with `jose`* — smaller surface, matches the MCP spec exactly, and is easy to read. `jose` is also used
   for the short-lived AIX user tokens.
3. **Magic-link email in dev:** `nodemailer` + a **Mailpit** container in docker compose (catch-all inbox at localhost:8025).
   *Recommend: yes.*
4. **Fastify plugins:** `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/swagger`, `fastify-type-provider-zod`. *Recommend: yes* (they're the standard way to do what the spec requires).
5. **Invoice PDFs (M5):** `pdfkit`. *Recommend: decide at M5.*

## Product / business
6. **Regulatory status of the wallet.** A prepaid, stored-value wallet usable across third-party merchants can fall
   under EU e-money / payment-services rules. Common mitigations: AIX acts as merchant of record and wallet credit is
   non-refundable store credit, or a licensed partner holds funds. *This needs a legal answer before real money;
   the MVP is test-mode only, so I'll proceed and keep the `TODO(tax)` / MoR module isolated.*
7. **Free included units** (`includedUnits: 3`): per user per app **lifetime**, or reset **monthly**? *Recommend: lifetime for MVP.*
8. **Hold expiry:** how long can an uncaptured hold live? *Recommend: 15 minutes default, max 24 h, set per hold.*
9. **Default auto-approve threshold** for new users? *Recommend: €1.00 per charge, €20/month cap.*
10. **Minimum top-up / wallet expiry?** *Recommend: €5 minimum, no expiry.*
11. **Subscriptions** are paid by card via Stripe Billing (per spec), not from wallet balance — confirm. *Recommend: confirm.*
12. **Name:** keep "AIX"? The npm scope `@aix` is likely already taken, which matters only once we publish the SDK/CLI publicly.
    *Recommend: keep `@aix/*` internally for now; rename before publishing.*

## Technical
13. **Next.js version:** latest stable at M1 start. **Drizzle** with `postgres` (postgres.js) driver. OK?
14. **IDs:** UUID v7 in the DB, prefixed public ids in the API (`usr_`, `wal_`, `chg_`, `price_`). OK?
15. **Deployment target** (affects nothing in M1–M3): decide later.
