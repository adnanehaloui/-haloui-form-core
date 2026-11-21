# @aix/manifest

Zod schema + validator for `aix.json` (`validateManifest`, `describePermissions`, `manifestJsonSchema`) and the
`aixpkg/1` package format (`packFiles`, `unpackFiles`, `sha256`, `signingPayload`).
Rules: reverse-DNS ids, semver, https entries (http only for localhost), server entry origins must be declared in
`permissions.network`, prompt apps can't run code. `displayPrice` is listing-only.

## Store listing fields (optional, strongly recommended)

```json
"tagline": "Turn a script into a video storyboard",
"icon": "assets/icon.svg",
"color": "#7c3aed",
"screenshots": ["assets/screen-1.png"],
"showcase": [
  { "title": "Product launch video", "input": "Make an 18s launch video for our shoe", "kind": "image", "output": "assets/storyboard.svg", "caption": "6 shots · €0.50" },
  { "title": "Shot list", "input": "Shot list for a 15s coffee ad", "kind": "list", "output": ["Macro pour", "Barista smile"] }
]
```
`showcase` entries are example results shown on the store ("See what it makes", the home "See what people make" wall,
and the "How it runs in your AI" chat preview). Kinds: `text`, `image` (package path or https URL), `table`
(rows, first row = header), `list`. Images are served from the signed package, only if declared here.
