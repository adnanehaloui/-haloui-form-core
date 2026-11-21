# @aix/mcp-gateway

The one MCP server a user adds to Claude / ChatGPT / Cursor / Claude Code: `https://<gateway>/mcp`.

- **Transport:** Streamable HTTP, stateless (one MCP server instance per request, bound to the user's token).
- **Auth:** OAuth 2.1 resource server. 401 + `WWW-Authenticate: Bearer resource_metadata=…` →
  `/.well-known/oauth-protected-resource/mcp` → AIX API authorization server (DCR + PKCE). Tokens are verified
  against the API's JWKS (audience = `<gateway>/mcp`, scope `aix:gateway`).
- **Tools:** `store_search`, `app_install`, `wallet_balance`, `aix_approve`, plus every installed server app's
  tools as `<slug>__<tool>`. Panel-only tools (`approval_decide`, `app_install_confirm`) need a nonce from `_meta`.
- **Proxying:** before each app call the gateway asks the API to authorize it (install, app status, org policy,
  spend caps) and gets a 5-minute signed user token + run id, sent to the developer as `X-AIX-User-Token` /
  `X-AIX-Run-Id`. Afterwards it records an audit entry (app, tool, user, charge ids — never content) and appends a receipt.
- **Panels (MCP Apps):** approval ("This costs €0.50 — approve?"), wallet/receipts, install/permissions.
  App UI resources are proxied under `ui://aix-app/<slug>/…`.
- Rate limit: `GATEWAY_RATE_LIMIT` requests/min per user (default 120).

```bash
pnpm --filter @aix/mcp-gateway dev    # :4100
pnpm --filter @aix/mcp-gateway test   # full OAuth + paid tool + approval e2e with real processes
```
