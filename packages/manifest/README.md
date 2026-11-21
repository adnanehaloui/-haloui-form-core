# @aix/manifest

Zod schema + validator for `aix.json` (`validateManifest`, `describePermissions`, `manifestJsonSchema`) and the
`aixpkg/1` package format (`packFiles`, `unpackFiles`, `sha256`, `signingPayload`).
Rules: reverse-DNS ids, semver, https entries (http only for localhost), server entry origins must be declared in
`permissions.network`, prompt apps can't run code. `displayPrice` is listing-only.
