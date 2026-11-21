# AIX — an AI app store with one wallet (v3)

Marketplace for AI apps: one account, one wallet, apps usable inside Claude, ChatGPT, Cursor, Claude Code or on the web.
Developers publish with an SDK and get paid without writing login or billing code.

- Product spec: [`SPEC.md`](SPEC.md)
- Architecture, schema and money flows: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/decisions.md`](docs/decisions.md)
- Open questions: [`docs/open-questions.md`](docs/open-questions.md)
- Running locally: [`docs/running-locally.md`](docs/running-locally.md)
- Build & install into Claude / ChatGPT / Cursor / Claude Code: [`docs/build-and-install.md`](docs/build-and-install.md)
- Security model, review and fixes: [`docs/security.md`](docs/security.md)

**Status:** M0–M6 implemented (test mode). `pnpm test` runs 100 tests incl. end-to-end M1–M6 criteria; `pnpm e2e` runs the Playwright happy path; CI and Docker images included.

| Path | What |
|---|---|
| `apps/web` | Store, wallet, developer portal, org admin, internal admin (Next.js) |
| `apps/api` | REST API, OAuth 2.1 provider, ledger, Stripe, jobs (Fastify) |
| `apps/mcp-gateway` | The marketplace MCP server users add to their AI tools |
| `packages/core` · `db` · `manifest` · `sdk` · `cli` | Money/ledger logic · schema · aix.json · developer SDK · `aix` CLI |
| `templates/*` | prompt, server (paid MCP tool + UI panel), local, web starter apps |

Store UI: app-store style storefront (featured apps, results wall, top charts, curated rows) and app pages with
example results, a chat preview, permissions, ratings and reviews — see `docs/screenshots/`.

Quick start: see [`docs/running-locally.md`](docs/running-locally.md).

Branch convention: every branch for this project starts with `v3`.
