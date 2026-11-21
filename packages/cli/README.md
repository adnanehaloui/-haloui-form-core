# @aix/cli — `aix`

```
aix login [--key aixsk_…] [--api-url URL]
aix app init [dir] --template prompt|server|local|web [--name] [--id]
aix app validate [dir]
aix app publish [dir] [--notes]
aix dev [dir]            # mock AIX API on :4900, €100 fake-money wallet, runs `npm run dev`
aix keys create|list|revoke
aix prices create --app <slug> --kind metered --unit render --amount 50 --lookup render [--included 3]
```
Config is stored in `~/.aix/config.json` (mode 600) or `AIX_SECRET_KEY` / `AIX_API_URL`.
Templates are read from the repo's `templates/` (set `AIX_TEMPLATES_DIR`; bundle them before publishing the CLI).
