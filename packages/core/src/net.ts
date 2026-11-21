import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** True for loopback, private, link-local, CGNAT, unspecified, multicast and IPv6 ULA/link-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true;
}

export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

/**
 * SSRF guard for server-side requests to user-supplied URLs: https only (unless allowed), and every
 * address the host resolves to must be public. Pair with `redirect: "error"` on the fetch.
 */
export async function assertPublicUrl(raw: string, opts: { allowInsecureLocal?: boolean } = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (opts.allowInsecureLocal && local && (u.protocol === "http:" || u.protocol === "https:")) return u;
  if (u.protocol !== "https:") throw new UnsafeUrlError("only https URLs are allowed");
  if (u.username || u.password) throw new UnsafeUrlError("credentials in URLs are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new UnsafeUrlError("host does not resolve");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError("URL points to a private or local address");
  return u;
}

/** fetch() a user-supplied URL safely: guard, no redirects, timeout, and a response size cap. */
export async function safeFetchText(raw: string, opts: { maxBytes?: number; timeoutMs?: number; allowInsecureLocal?: boolean; init?: RequestInit } = {}) {
  await assertPublicUrl(raw, opts);
  const res = await fetch(raw, { ...(opts.init ?? {}), redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
  const max = opts.maxBytes ?? 64 * 1024;
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new UnsafeUrlError("response too large");
      }
      chunks.push(value);
    }
  }
  return { status: res.status, ok: res.ok, text: Buffer.concat(chunks).toString("utf8") };
}
