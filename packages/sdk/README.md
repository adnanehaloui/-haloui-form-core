# @aix/sdk

Server-side SDK for AIX developers. **Never use it in a browser** (it refuses to construct there).

```ts
import { AIX, NeedsUserApproval } from "@aix/sdk";
const aix = new AIX({ secretKey: process.env.AIX_SECRET_KEY });

const user = await aix.auth.verify(req.headers["x-aix-user-token"]);
const { result, charge } = await aix.wallet.run(
  { userId: user.id, priceId: "render", idempotencyKey: req.headers["x-aix-run-id"] },
  () => render(script),                       // throws → hold is released automatically
);
```

API: `auth.verify`, `entitlements.check`, `wallet.hold | capture | release | get | run`, `usage.report`,
`webhooks.verify | constructEvent`. Typed errors: `InsufficientFunds`, `SpendLimitExceeded`, `NeedsUserApproval`
(`approvalUrl`, `display`), `NotInstalled`, `BlockedByOrgPolicy`, `Unauthorized`, `IdempotencyMismatch`.
Retrying `hold` with the same `idempotencyKey` is always safe.
