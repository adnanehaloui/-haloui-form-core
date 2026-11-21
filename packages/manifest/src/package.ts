import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * `.aixpkg` = gzip(JSON { format: "aixpkg/1", files: [{ path, base64 }] }).
 * Deliberately simple (no tar dependency). Max 10 MB unpacked.
 */
export interface PackageFile { path: string; content: Buffer }
const MAX_UNPACKED = 10 * 1024 * 1024;

function safePath(p: string) {
  if (!p || p.startsWith("/") || p.includes("\\") || p.split("/").some((s) => s === ".." || s === "")) throw new Error(`unsafe path in package: ${p}`);
  return p;
}

export function packFiles(files: PackageFile[]): Buffer {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const json = JSON.stringify({ format: "aixpkg/1", files: sorted.map((f) => ({ path: safePath(f.path), base64: f.content.toString("base64") })) });
  return gzipSync(Buffer.from(json), { level: 9 });
}

export function unpackFiles(pkg: Buffer): PackageFile[] {
  const raw = gunzipSync(pkg, { maxOutputLength: MAX_UNPACKED * 2 });
  const parsed = JSON.parse(raw.toString("utf8")) as { format?: string; files?: { path: string; base64: string }[] };
  if (parsed.format !== "aixpkg/1" || !Array.isArray(parsed.files)) throw new Error("not an aixpkg/1 package");
  let total = 0;
  return parsed.files.map((f) => {
    const content = Buffer.from(f.base64, "base64");
    total += content.length;
    if (total > MAX_UNPACKED) throw new Error("package too large");
    return { path: safePath(f.path), content };
  });
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** What the platform signs when a version is approved. */
export function signingPayload(appId: string, version: string, packageSha256: string): Buffer {
  return Buffer.from(`aixpkg/1:${appId}:${version}:${packageSha256}`);
}
