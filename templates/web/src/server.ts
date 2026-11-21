/**
 * Quick Notes — sample AIX web app.
 * - "Sign in with AIX": OAuth 2.1 authorization code + PKCE against the AIX API.
 * - Charges €0.20 per summary from the user's AIX wallet, server-side only, with @aix/sdk.
 *
 * Env: AIX_API_URL, AIX_SECRET_KEY, AIX_OAUTH_CLIENT_ID, AIX_OAUTH_CLIENT_SECRET (from the developer portal), PORT.
 */
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AIX, NeedsUserApproval } from "@aix/sdk";

const PORT = Number(process.env.PORT ?? 4300);
const API = (process.env.AIX_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const BASE = `http://localhost:${PORT}`;
const aix = new AIX();
const sessions = new Map<string, { userId: string; email?: string; name?: string }>();
const pending = new Map<string, string>(); // state → code_verifier

const b64url = (b: Buffer) => b.toString("base64url");
const cookie = (h: string | undefined, k: string) => h?.split(";").map((s) => s.trim().split("=")).find(([n]) => n === k)?.[1];
const page = (body: string) => `<!doctype html><meta charset="utf-8"><title>Quick Notes</title><body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">${body}</body>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const sid = cookie(req.headers.cookie, "qn_sid");
  const me = sid ? sessions.get(sid) : undefined;

  if (url.pathname === "/login") {
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    pending.set(state, verifier);
    const auth = new URL(`${API}/oauth/authorize`);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id: process.env.AIX_OAUTH_CLIENT_ID ?? "",
      redirect_uri: `${BASE}/callback`,
      scope: "openid email profile",
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();
    return void res.writeHead(302, { location: auth.toString() }).end();
  }

  if (url.pathname === "/callback") {
    const state = url.searchParams.get("state") ?? "";
    const verifier = pending.get(state);
    pending.delete(state);
    if (!verifier) return void res.writeHead(400).end("bad state");
    const tok = await fetch(`${API}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: url.searchParams.get("code") ?? "",
        redirect_uri: `${BASE}/callback`,
        client_id: process.env.AIX_OAUTH_CLIENT_ID ?? "",
        client_secret: process.env.AIX_OAUTH_CLIENT_SECRET ?? "",
        code_verifier: verifier,
      }),
    }).then((r) => r.json());
    const info = await fetch(`${API}/oauth/userinfo`, { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
    const id = randomUUID();
    sessions.set(id, { userId: info.sub, email: info.email, name: info.name });
    return void res.writeHead(302, { location: "/", "set-cookie": `qn_sid=${id}; HttpOnly; SameSite=Lax; Path=/` }).end();
  }

  if (url.pathname === "/summarize" && req.method === "POST" && me) {
    try {
      // Server-side charge with the secret key — never from the browser.
      const { charge } = await aix.wallet.run({ userId: me.userId, priceId: "summary", idempotencyKey: randomUUID() }, async () => "summary");
      return void res.writeHead(200, { "content-type": "text/html" }).end(page(`<p>Summary done — charged ${charge.display}.</p><a href="/">Back</a>`));
    } catch (e) {
      if (e instanceof NeedsUserApproval) return void res.writeHead(200, { "content-type": "text/html" }).end(page(`<p>This costs ${e.display}. <a href="${e.approvalUrl}">Approve on AIX</a>, then try again.</p>`));
      return void res.writeHead(402, { "content-type": "text/html" }).end(page(`<p>${(e as Error).message}</p>`));
    }
  }

  res.writeHead(200, { "content-type": "text/html" }).end(
    page(me ? `<h1>Hi ${me.name ?? me.email ?? "there"}</h1><form method="post" action="/summarize"><button>Summarize my notes (€0.20)</button></form>` : `<h1>Quick Notes</h1><a href="/login">Sign in with AIX</a>`),
  );
}).listen(PORT, () => console.log(`Quick Notes on ${BASE}`));
