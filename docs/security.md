# Security

## Model
- **Money:** only developer secret keys (`aixsk_…`, hashed, scoped, revocable) can hold/capture/release.
  Prices come from the server catalog. Integer cents. Every charge idempotent per (app, key). Double-entry ledger,
  append-only and balanced enforced by database triggers. Per-user advisory lock + per-wallet row lock make holds
  race-free (load-tested: 2000 concurrent charges, exact).
- **Identity:** HttpOnly SameSite=Lax session cookies (hashed in DB); AIX OAuth 2.1 with PKCE S256, exact redirect
  URIs, single-use codes, rotating refresh tokens (reuse revokes the family), EdDSA JWTs with audiences.
- **Gateway trust:** AI hosts hold tokens for the gateway audience. The API honours them only on requests
  carrying `x-aix-gateway-secret` — a host can't call the API directly with its token.
- **Approvals in AI hosts:** charges above the user's threshold need a click in the AIX approval panel.
  The panel's single-use nonce is delivered only in `_meta` of model-only tools and is verified and consumed by
  the API itself (atomic delete). Approvals are bound to user + price + quantity + idempotency key.
- **Tenancy:** every org route checks membership/role; members join only by invitation (email must match);
  only owners can change or remove owners.
- **SSRF:** client-ID metadata documents, developer webhooks and (in production) gateway → app calls require
  https and public IPs, refuse redirects, cap body size; negative results cached.
- **Content:** packages hash-verified and platform-signed; listing assets served only if declared, SVG under
  `CSP: sandbox`; panels escape all data; skill names validated before the CLI writes files.
- **Abuse:** rate limits per IP (people) and per secret key (developer servers); magic links 3/10 min per email;
  top-up velocity limits; reports, hidden reviews, bans.
- **Secrets:** never logged (headers, cookies, and token-shaped strings in URLs redacted); third-party secrets
  AES-256-GCM encrypted; production refuses to start without required keys, refuses `sk_live_` until the legal
  questions are answered.

## Independent review (Nov 2026) — all findings fixed, with regression tests (`apps/api/test/security.test.ts`)
| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | A malicious app panel could fetch the approval/install nonce and approve its own charge | Nonce-issuing tools model-only; nonce verified + consumed by the API |
| 2 | High | Approval keyed by (app, idempotency key) only → reusable for another user | Bound to user, price, quantity; new unique index |
| 3 | Medium | Any connected client could call approval/install APIs with its token | Gateway service secret; API-side nonce |
| 4 | Medium | Org admins could add any email as member (and DoS their apps); demote owners | Invitations only; owner protections |
| 5 | Medium | SSRF via client-ID metadata documents | `safeFetchText` guard, no redirects, size cap, negative cache |
| 6 | Medium | Rate limits bypassable via spoofed X-Forwarded-For | `AIX_TRUST_PROXY` hops; per-email magic-link limit |
| 7 | Low/Med | SSRF via developer webhook URLs / manifest entries | https + public IP (prod), re-checked at send |
| 8 | Low | Refund re-credited if settlement failed after Stripe succeeded | Roll back only when Stripe refused |
| 9 | Low | Invite tokens in request logs | Redaction of `aixinv_/aixit_/aixcs_` tokens |
| — | Hardening | Gateway body size, refresh-token family revoke, per-user cap race | 1 MB limit, family revoke, per-user advisory lock |

## Known residual risks
- **App panels share the AIX connector:** an installed app's MCP Apps panel can ask the host to call *other*
  installed apps' tools in the user's name (hosts don't tell the server which panel called). Charges above the
  threshold still need the user's click; caps still apply. Mitigation: review queue for apps with UI panels.
- **DNS rebinding** between the SSRF check and the request is possible in theory; production should also run
  the gateway/API with egress rules that block private ranges.
- Live payments, tax and the e-money question are intentionally blocked until decided (see open-questions.md).
