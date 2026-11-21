# Open questions — only things that need you

Everything that could be decided with a sensible default is built and recorded in `decisions.md`.

1. **Regulatory status of the wallet (important, before real money).** A prepaid wallet spent with third-party
   developers may be e-money / a payment service in the EU. Typical answers: AIX as merchant of record selling
   non-refundable store credit, or a licensed partner holding funds. Live Stripe keys are refused until then.
2. **Tax / merchant of record.** `apps/api/src/services/tax.ts` is a deliberate `TODO(tax)`. Options: Stripe Tax,
   or a merchant-of-record provider (Paddle, Lemon Squeezy-style).
3. **Name, npm scope and license.** Packages are publish-ready as `@aix/sdk`, `@aix/manifest`, `@aix/cli` (MIT).
   `@aix` is probably taken on npm — pick the final name/scope, then `pnpm -r publish`.
4. **Hosting + domains.** Docker images (api, worker, gateway, web, migrate, backup) and `docker-compose.full.yml`
   are ready. Pick a host and three HTTPS URLs; then connect Claude/ChatGPT/Cursor for real.
5. **Accounts/keys to add to `.env`:** Stripe (test), Google OAuth (optional), SMTP provider, S3/R2 bucket,
   metrics token. See `.env.example`.
6. **Refund policy for users** (D23): refunds to card are admin-only today; decide whether users get self-service.
7. **Company blocks** (D11): today an org block applies to members everywhere — confirm or limit to org-paid use.
