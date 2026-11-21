# Web app template — Quick Notes

A plain web app that uses **Sign in with AIX** (OAuth 2.1 authorization code + PKCE) and charges the
user's AIX wallet **server-side** with `@aix/sdk`.

1. In the developer portal → your app → **OAuth client**, create a client with redirect URI
   `http://localhost:4300/callback`. Put the id/secret in `AIX_OAUTH_CLIENT_ID` / `AIX_OAUTH_CLIENT_SECRET`.
2. Create a price: `aix prices create --app <slug> --kind metered --unit summary --amount 20 --lookup summary`.
3. `AIX_SECRET_KEY=… npm run dev`
