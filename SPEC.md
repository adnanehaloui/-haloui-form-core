# Build prompt: AIX — an AI app store with one wallet

> "AIX" is a placeholder name — replace it everywhere if you choose another.

---

## Your role

You are a senior full-stack engineer building the MVP of **AIX**, a marketplace for AI apps. Work in milestones, write tests as you go, and stop at the end of each milestone to summarize what you built, how to run it, and any decisions I need to make. Ask me before adding any major dependency not listed here. Prefer simple, boring, well-documented choices.

## Product in one paragraph

AIX is like the Apple App Store for AI apps. Users have **one account and one wallet**. They browse a store, install apps, and use them inside the AI tools they already pay for (Claude, ChatGPT, Cursor, Claude Code) or on the web. Developers publish apps with an SDK and get paid without writing any login or billing code. The user's AI subscription pays for the AI conversation; the AIX wallet pays for the work the app does (renders, reports, data, tools). Companies get an admin console to control which apps their employees can use and how much they can spend.

## Hard rules (never break these)

1. **Never handle AI-provider subscription credentials.** Do not read, copy, store, proxy or forward Claude.ai / ChatGPT login tokens or CLI credential files. AIX only ever stores its own accounts, its own OAuth tokens, and developer-provided API keys (encrypted).
2. **Never bill by the host AI's tokens.** AIX cannot see Claude's or ChatGPT's token usage and must not pretend to. Apps bill per unit of work they declare (per run, per render, per query, per second, subscription).
3. **Only server-side code can charge a wallet.** Charges come from the developer's backend with a secret key, never from browser or client code.
4. **Money is integers.** Store amounts as integer minor units (euro cents) plus currency. No floats anywhere in money code.
5. **Every charge is idempotent** (idempotency key required) and recorded in a **double-entry ledger**. Balances are derived from the ledger, never edited directly.
6. **Prices come from the server-side catalog**, never from client metadata or the app manifest at charge time.
7. Secrets never appear in logs.

## Tech stack

- Monorepo: **pnpm workspaces + Turborepo**, TypeScript everywhere, strict mode.
- `apps/web` — **Next.js (App Router)** + React + Tailwind: store, user wallet, developer portal, org admin.
- `apps/api` — **Fastify** REST API with OpenAPI spec generated from schemas (Zod).
- `apps/mcp-gateway` — the **AIX marketplace MCP server** using the official `@modelcontextprotocol/sdk` (TypeScript), Streamable HTTP transport, OAuth 2.1 per the MCP authorization spec. UI panels via the MCP Apps extension (`@modelcontextprotocol/ext-apps`).
- `packages/sdk` — `@aix/sdk` for developers (server-side Node SDK).
- `packages/cli` — `aix` developer CLI (Node, using `commander`).
- `packages/manifest` — Zod schema + validator for `aix.json` app manifests.
- `packages/db` — **PostgreSQL** with **Drizzle ORM** and migrations.
- Payments: **Stripe** (test mode only for now): Checkout for wallet top-ups and subscriptions, **Stripe Connect Express** for developer payouts, webhooks for confirmation.
- Auth for users: email magic link + Google (use Auth.js or Lucia-style sessions — pick one and justify it). AIX is itself an **OAuth 2.1 provider** so AI hosts and third-party web apps can "Sign in with AIX".
- Local dev: `docker compose` for Postgres; Stripe CLI for webhooks.
- Tests: **Vitest** for units, **Playwright** for one end-to-end happy path.

## Core concepts and data model

Design the schema around these entities (add fields as needed, explain additions):

- `users` — id, email, name, created_at
- `organizations`, `org_members` (role: owner | admin | billing | member)
- `wallets` — belongs to a user **or** an org; currency (EUR)
- `ledger_accounts` & `ledger_entries` — double-entry: user wallet, developer payable, platform revenue, Stripe clearing, refunds
- `developers` — linked user/org, Stripe Connect account id, payout status
- `apps` — slug, name, developer_id, type (`prompt` | `server` | `local` | `web`), status (draft | in_review | published | suspended)
- `app_versions` — semver, manifest JSON, package URL/hash, signature, review notes
- `prices` — app_id, kind (`free` | `one_time` | `subscription` | `metered`), unit name (e.g. "render"), unit_amount_cents, interval
- `installs` — user/org, app_id, version, granted permissions
- `subscriptions` — user/org, price_id, status, current_period_end
- `charges` — app_id, payer wallet, price_id, quantity, amount_cents, idempotency_key, run_id, status (held | captured | refunded | failed)
- `spend_limits` — per user, per org member, per app; daily/monthly caps; auto-approve threshold
- `api_keys` — developer secret keys (hashed), scopes
- `oauth_clients`, `oauth_grants` — for MCP hosts and "Sign in with AIX"
- `org_app_policies` — org approved catalog: allowed apps, which roles may install, max permissions
- `audit_log` — who did what, when (installs, charges, policy changes, approvals)

## App manifest (`aix.json`)

```json
{
  "id": "com.acme.videostudio",
  "name": "VideoStudio",
  "version": "1.0.0",
  "type": "server",
  "description": "Turn a script into a short product video.",
  "category": "video",
  "entry": { "mcp": "https://api.acme.com/mcp", "web": "https://videostudio.acme.com" },
  "compatibility": { "hosts": ["claude", "chatgpt", "cursor", "claude-code", "web"] },
  "permissions": { "network": ["https://api.acme.com"], "files": [], "userData": ["email"] },
  "pricing": [
    { "kind": "free", "includedUnits": 3, "unit": "render" },
    { "kind": "metered", "unit": "render", "displayPrice": "€0.50" }
  ]
}
```

- `type: prompt` apps contain skills/templates only (Markdown files); nothing runs on a server.
- `type: local` apps ship code for the user's machine; permissions must be declared and shown at install.
- `displayPrice` is for listings only — real prices live in the `prices` table.

## Developer SDK (`@aix/sdk`) — target API

```ts
import { AIX } from "@aix/sdk";
const aix = new AIX({ secretKey: process.env.AIX_SECRET_KEY });

const user = await aix.auth.verify(requestToken);          // who is calling
const ok = await aix.entitlements.check(user.id, "pro");   // has subscription / free units left?

const hold = await aix.wallet.hold({                       // reserve money before expensive work
  userId: user.id, priceId: "price_render", quantity: 1,
  idempotencyKey: runId, runId
});
// ... do the work ...
await aix.wallet.capture(hold.id);                         // success → take the money
// or
await aix.wallet.release(hold.id, { reason: "render_failed" }); // failure → refund automatically
```

Also: `aix.usage.report()` for batched metered units, typed errors (`InsufficientFunds`, `SpendLimitExceeded`, `NeedsUserApproval`), webhook signature verification helper, and full TSDoc.

When a charge exceeds the user's auto-approve threshold, `hold` returns `NeedsUserApproval` with an approval URL; the MCP gateway or web UI shows "This costs €0.50 — approve?".

## Developer CLI (`aix`)

```
aix login
aix app init [--template prompt|server|local|web]
aix dev            # local dev server, test wallet with fake money
aix app validate   # manifest + permissions check
aix app publish    # package, hash, upload, submit for review
aix keys create
```

Provide one working template per app type in `templates/`, including a sample **server app** (an MCP server with one paid tool and one MCP Apps UI panel) that uses `@aix/sdk` end to end.

## Marketplace MCP gateway (`apps/mcp-gateway`)

The single MCP server a user adds to Claude / ChatGPT / Cursor once.

- OAuth sign-in to the user's AIX account.
- Exposes tools: `store_search`, `app_install`, `wallet_balance`, plus the tools of every **installed** server app, namespaced (`videostudio__render`). It proxies tool calls to the developer's MCP endpoint, attaching a short-lived signed AIX user token so the developer's server can call `aix.auth.verify`.
- Renders approval and receipt panels via MCP Apps.
- Enforces org policies and spend limits before forwarding a call.
- Writes an audit entry per call (app, tool, user, charge id) — never the content of the conversation.

Also generate a **Claude Code plugin marketplace** repo layout (`.claude-plugin/marketplace.json`) that lists published `prompt` apps so Claude Code users can `/plugin marketplace add` it.

## Web app (`apps/web`)

- **Store:** browse by outcome category, search, app page (price, type, compatible hosts, permissions, developer, reviews), install button.
- **Wallet:** balance, top-up via Stripe Checkout, transaction history from the ledger, spend limits, monthly invoices (PDF) listing each app.
- **Developer portal:** create app, versions, pricing, review status, analytics (installs, revenue), Stripe Connect onboarding, payout history.
- **Org admin:** members & roles, approved app catalog, per-member budgets, org wallet, audit log export (CSV).
- **Admin (internal):** review queue to approve/reject app versions, suspend apps, issue refunds.

## Money flows to implement

1. **Top-up:** Stripe Checkout → webhook → ledger: Stripe clearing → user wallet.
2. **Metered charge:** hold → capture → ledger: user wallet → developer payable (80%) + platform revenue (20%). Commission rate configurable per app.
3. **Subscription:** Stripe Billing subscription on the payer; on paid invoice webhook, split into developer payable + platform revenue.
4. **Refund/release:** reverse entries; never delete ledger rows.
5. **Monthly payout job:** sum developer payable, minus refunds, transfer via Stripe Connect, record payout statement.
6. **Monthly user invoice:** one invoice per wallet per month listing all apps. Leave a clearly marked `// TODO(tax)` module for VAT/merchant-of-record handling — do not invent tax logic.

## Security

- Signed, hashed app packages; verify hash on install.
- Developer secret keys hashed at rest; scoped; rotatable.
- Rate limits on API and gateway.
- Webhook signature verification (Stripe and AIX outbound webhooks).
- Encrypt any stored third-party secrets (libsodium / AES-GCM with key from env).
- Permission screen at install showing everything from the manifest.
- Row-level tenant checks on every org query; add tests that a member of org A can never read org B data.

## Milestones (stop after each one)

**M0 — Plan.** Read this spec, propose the repo structure, schema diagram, and list open questions. No code beyond scaffolding.

**M1 — Foundations.** Monorepo, Postgres + migrations, auth, users/orgs, ledger with tests (balance always derived; double-entry always balances).
✅ Done when: `pnpm test` passes ledger invariants; I can sign up and see an empty wallet.

**M2 — Wallet & payments.** Stripe top-up, hold/capture/release API, spend limits, approval flow, transaction history.
✅ Done when: I top up €20 in test mode, a script charges €0.50 via the API, and the history shows it.

**M3 — Apps & store.** Manifest package, developer portal, CLI `init/dev/validate/publish`, review queue, store pages, installs.
✅ Done when: I create the sample server app with the CLI, publish it, approve it as admin, and install it as a user.

**M4 — SDK & MCP gateway.** `@aix/sdk`, the gateway with OAuth, proxied tools, approval/receipt MCP Apps panels, Claude Code plugin marketplace export.
✅ Done when: I add the gateway to Claude, sign in, run the sample app's paid tool, approve €0.50, and see the charge in my wallet.

**M5 — Developers get paid.** Stripe Connect onboarding, commission split, monthly payout job, statements, user monthly invoice PDF.
✅ Done when: a test payout appears in Stripe for the sample developer with the correct 80/20 split.

**M6 — Enterprise.** Org wallet, approved catalog, role-based install rules, per-member budgets, audit log export.
✅ Done when: an org admin blocks an app and a member can no longer install or call it via the gateway.

## Out of scope for now

Own hosted execution runtime, workflow builder UI, team channels, local runner orchestration of Claude Code / Codex CLIs, managed AI credits, mobile apps, crypto payments (x402) — design interfaces so these can be added later, but do not build them.

## Working style

- Small commits with clear messages.
- A `README.md` per package and a root `docs/` folder with architecture, money-flow diagrams (Mermaid), and a "how to run locally" guide.
- Seed script with demo users, one org, a developer, and three sample apps (one prompt, one server, one web).
- When unsure, choose the simpler option and note it in `docs/decisions.md`.
- Branches: every branch for this project starts with `v3`.
