# Running locally

Requirements: Node 22+, pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up          # Postgres on localhost:5432
pnpm build
```

More steps (migrations, seed, Stripe CLI webhooks, dev servers) are added as milestones land.
