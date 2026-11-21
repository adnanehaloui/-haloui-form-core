import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Prefixed random id, e.g. newId("chg") → "chg_3f9a…". 128 bits of randomness. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** Random URL-safe secret token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---- AES-256-GCM for stored third-party secrets -------------------------------------------

function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("AIX_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

/** Encrypt → "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptSecret(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, keyB64: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("invalid encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(keyB64), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

// ---- Webhook signatures (AIX outbound webhooks) ----------------------------------------------

/** Header value: "t=<unix seconds>,v1=<hex hmac-sha256 of `${t}.${body}`>". */
export function signWebhook(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

export function verifyWebhookSignature(body: string, header: string, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return safeEqual(expected, parts.v1);
}

/** Redact anything that looks like a secret before it reaches a log. */
export function redact(value: string): string {
  return value
    .replace(/\b(sk|rk|whsec|aixsk)_[A-Za-z0-9_]+/g, "$1_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
