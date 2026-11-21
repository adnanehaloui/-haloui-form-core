# @aix/db

Drizzle schema (`src/schema.ts`), migrations (`migrations/`), client.

`0001_ledger_guards.sql` adds database-level guarantees: ledger rows are append-only (UPDATE/DELETE raise),
every transaction must balance at COMMIT (deferred constraint trigger), entry currency must match.

```bash
pnpm --filter @aix/db db:generate   # after editing schema.ts
pnpm --filter @aix/db db:migrate
```
