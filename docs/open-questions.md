# Open questions

Resolved with the recommended defaults (see `decisions.md`): dependencies (`arctic`, `jose`, `nodemailer` +
Mailpit, Fastify plugins, `pdfkit`), free units (lifetime), hold expiry (15 min), default limits (€1 / €20),
minimum top-up (€5), subscriptions by card, Drizzle + postgres.js, prefixed text ids, keep `@aix/*` for now.

Still open — need a decision from you:

1. **Regulatory status of the wallet (important).** A prepaid wallet spent with third-party developers may fall
   under EU e-money / payment-services rules. Options: AIX as merchant of record with non-refundable store credit,
   or a licensed partner holding funds. Needed before live keys (the code refuses `sk_live_` keys today).
2. **Tax / merchant of record.** `apps/api/src/services/tax.ts` is a deliberate `TODO(tax)` stub. Consider Stripe Tax
   or a merchant-of-record provider.
3. **Product name.** `@aix` is likely taken on npm — rename before publishing the SDK/CLI.
4. **Deployment target** (Fly, Render, Railway, AWS…). Docker images and `docker-compose.full.yml` are ready; pick a host and domains so Claude/ChatGPT can reach the gateway over HTTPS.
5. **Card refunds of wallet top-ups** (money back to the card, `refunds_payable` account) — policy not decided, not built.
6. **Personal vs. company use under org policy** (D11) — confirm members should be blocked everywhere, not only on org-paid installs.
