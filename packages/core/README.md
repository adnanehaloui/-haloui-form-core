# @aix/core

Pure, dependency-free domain logic (no I/O):
- `money.ts` — integer cents, safe multiplication, display formatting, float-free decimal parsing.
- `ledger.ts` — account kinds, normal balances, `validateTransaction` (debits = credits, positive integers) and one
  posting function per money flow (top-up, hold, capture, release, refund, subscription, payout).
- `commission.ts` — basis-point split, platform share rounded down.
- `limits.ts` — spend-cap / auto-approve evaluation.
- `crypto.ts` — ids, AES-256-GCM secret encryption, webhook signing, log redaction.

Tests include randomized property checks of the accounting equation.
