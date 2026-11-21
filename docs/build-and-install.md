# Building AIX and installing apps into AI tools

## 1. Build and run

**Development** (hot reload):
```bash
pnpm install
cp .env.example .env && pnpm keys:generate >> .env
pnpm db:up                 # Postgres + Mailpit (docker)
pnpm build                 # shared packages + web
pnpm seed                  # demo store: 12 apps, users, org
pnpm --filter @aix/api dev            # http://localhost:4000  (API docs: /docs)
pnpm --filter @aix/web dev            # http://localhost:3000  (the store)
pnpm --filter @aix/mcp-gateway dev    # http://localhost:4100/mcp
```

**Production** (containers):
```bash
docker compose -f docker-compose.full.yml up --build -d
# or build images separately:
docker build --target api -t aix-api .
docker build --target gateway -t aix-gateway .
docker build --target migrate -t aix-migrate .
docker build --target web --build-arg AIX_API_URL=http://api:4000 -t aix-web .
```
Put the web app, API and gateway behind HTTPS (three domains or paths) and set `AIX_WEB_URL`, `AIX_API_URL`,
`AIX_GATEWAY_URL` to those public URLs. AI hosts (Claude, ChatGPT…) can only reach a public HTTPS gateway.
Schedule the jobs (`job:expire-holds` every minute, `job:invoices` and `job:payouts` monthly).

**Tests:** `pnpm test` (all suites, needs Postgres) · `pnpm e2e` (Playwright) · CI runs both on every push.

## 2. How users install apps in their AI tools

Each app page has a **"Use it in…"** section; `/connect` connects AIX once. What happens depends on the app type:

| App type | Claude (web/desktop) | Claude Code | ChatGPT | Cursor / VS Code | Codex |
|---|---|---|---|---|---|
| **server** (tools, workflows, paid runs) | AIX connector | `claude mcp add --transport http aix <gateway>/mcp` | AIX connector (Developer mode) | one-click **Add to Cursor / VS Code** | — |
| **prompt** (skills) | Upload skill ZIP **or** via connector | `aix add <app> --token … --agent claude-code` (or plugin marketplace) | via connector (prompts + `skill_load`) | `aix add … --agent cursor` or via connector | `aix add … --agent codex` |
| **web** | Open the app → "Sign in with AIX" | | | | |
| **local** | Download signed package; run with declared permissions | | | | |

### The AIX connector (one MCP server for everything)
- URL: `<AIX_GATEWAY_URL>/mcp` — OAuth 2.1 sign-in, the host registers itself automatically.
- **Claude:** Settings → Connectors → Add custom connector → paste URL → sign in → Allow.
- **Claude Code:** `claude mcp add --transport http aix https://<gateway>/mcp`, then `/mcp` to sign in.
- **ChatGPT:** Settings → Apps & Connectors → Advanced → Developer mode → create connector → URL + OAuth.
- **Cursor:** `cursor://anysphere.cursor-deeplink/mcp/install?name=aix&config=<base64 {"url": …}>` (the "Add to Cursor" button).
- **VS Code:** `vscode:mcp/install?<url-encoded {"name":"aix","type":"http","url":…}>` (the "Add to VS Code" button).

Once connected, **every app the user installs on AIX appears automatically**: server apps' tools as
`<app>__<tool>`, skills as MCP prompts and through the `skill_load` tool, plus `store_search`, `app_install`,
`wallet_balance` and approval panels.

### Skills installed natively (like `npx skills add`)
On a prompt app's page → Claude Code / Cursor / Codex tab → **Get install command** gives a personal command
(valid 15 minutes, scoped to that app):
```bash
aix add launch-copy --token aixit_… --agent claude-code      # → .claude/skills/<skill>/SKILL.md
aix add launch-copy --token aixit_… --agent cursor -g        # → ~/.cursor/skills/<skill>/SKILL.md
aix add launch-copy --token aixit_… --agent codex            # → .agents/skills/<skill>/SKILL.md
```
For Claude.ai, the **Claude** tab offers `<skill>.zip` (a folder with `SKILL.md`) to upload under
Customize → Skills → Upload a skill. Claude Code users can also use the plugin marketplace
(`job:export-marketplace`, then set `AIX_PLUGIN_MARKETPLACE_URL`).

> Menu names in Claude/ChatGPT change over time, and Cursor/Codex skill folder locations differ between
> sources — check the host's current docs if a step doesn't match. The connector path works in all hosts.
