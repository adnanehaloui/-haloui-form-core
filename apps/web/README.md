# @aix/web

Next.js App Router + Tailwind. Talks to the API only through the same-origin `/api/*` rewrite (`next.config.ts`).

Pages: `/` store · `/apps/[slug]` app page + permission screen · `/login` · `/wallet` (balance, top-up, history,
limits, invoices, installed apps, connected AI tools) · `/approve/[id]` · `/oauth/consent` · `/developer`
(keys, OAuth clients, apps) · `/developer/apps/[slug]` (versions, prices, analytics) · `/developer/payouts` ·
`/orgs`, `/orgs/[id]` (members, catalog, budgets, org wallet, audit CSV) · `/admin` (review queue, suspend, refunds)
· `/dev-checkout/[id]` (fake Stripe checkout for local dev).

```bash
AIX_API_URL=http://localhost:4000 pnpm --filter @aix/web dev
```
