/**
 * Minimal S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2) using
 * AWS Signature V4 over fetch — no SDK dependency. Only PUT and GET are needed.
 */
import { createHash, createHmac } from "node:crypto";
import type { Storage } from "./storage.js";

export interface S3Config { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean }

const sha256 = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
const encodeKey = (k: string) => k.split("/").map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

export function signS3Request(cfg: S3Config, method: string, key: string, body: Buffer | null, now = new Date()) {
  const ep = new URL(cfg.endpoint);
  const host = cfg.forcePathStyle ? ep.host : `${cfg.bucket}.${ep.host}`;
  const path = cfg.forcePathStyle ? `/${cfg.bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? "");
  const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonical = [method, path, "", ...Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`), "", signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return {
    url: `${ep.protocol}//${host}${path}`,
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  };
}

export function s3Storage(cfg: S3Config): Storage {
  return {
    async put(key, data) {
      const r = signS3Request(cfg, "PUT", key, data);
      const res = await fetch(r.url, { method: "PUT", headers: { ...r.headers, "content-type": "application/octet-stream" }, body: new Uint8Array(data) });
      if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
    async get(key) {
      const r = signS3Request(cfg, "GET", key, null);
      const res = await fetch(r.url, { headers: r.headers });
      if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
