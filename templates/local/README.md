# Local app template — Repo Stats

`type: local` apps ship code for the user's machine. Everything it touches **must be declared** in
`aix.json → permissions` — users see the full list on the install screen, and the package is
hash-verified and signed by AIX before it can be installed.

```bash
aix app init my-tool --template local
npm run dev          # try it locally
aix app validate && aix app publish
```
