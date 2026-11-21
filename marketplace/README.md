# Claude Code plugin marketplace export

Generated from published `prompt` apps: `pnpm --filter @aix/api job:export-marketplace`.
Produces `.claude-plugin/marketplace.json` and `plugins/<slug>/{.claude-plugin/plugin.json, skills/*/SKILL.md}`.

In Claude Code: `/plugin marketplace add <path or git URL of this folder>` then `/plugin install <slug>@aix`.
