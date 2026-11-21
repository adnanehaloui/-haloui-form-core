# Server app template — Render Studio

An MCP server with **one paid tool** (`render`, €0.50 per render after 3 free) and **one MCP Apps UI panel**
(storyboard preview), billed through the user's AIX wallet with `@aix/sdk`. No login or billing code.

```bash
aix app init my-app --template server
cd my-app
aix dev                       # mock AIX API with €100 fake money + runs `npm run dev`
aix app validate
aix app publish
aix prices create --app <slug> --kind metered --unit render --amount 50 --lookup render --included 3
```

How it works (see `src/server.ts`):
1. The AIX gateway calls `/mcp` with `X-AIX-User-Token` and `X-AIX-Run-Id`.
2. `aix.auth.verify(token)` → the user.
3. `aix.wallet.run({ priceId: "render", idempotencyKey: runId }, work)` holds €0.50, runs the work, captures — or releases on failure.
4. Above the user's auto-approve threshold the SDK throws `NeedsUserApproval`; the tool returns the approval
   link and the gateway shows its approval panel. Retrying with the same run id then succeeds.
