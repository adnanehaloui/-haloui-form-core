import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import S3rver from "s3rver";
import { s3Storage, signS3Request, type S3Config } from "../src/lib/s3.js";

const cfg: S3Config = { endpoint: "https://s3.eu-west-1.amazonaws.com", region: "eu-west-1", bucket: "aix-packages", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", forcePathStyle: false };

describe("S3 SigV4 signing", () => {
  for (const [method, key, body] of [["GET", "packages/app_1/1.0.0-abc.aixpkg", null], ["PUT", "packages/app 2/über (1).aixpkg", Buffer.from("hello")]] as const) {
    it(`matches the AWS reference signer for ${method} ${key}`, async () => {
      const now = new Date("2026-11-21T10:00:00Z");
      const mine = signS3Request(cfg, method, key, body, now);
      const u = new URL(mine.url);
      const ref = await new SignatureV4({ service: "s3", region: cfg.region, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }, sha256: Sha256, uriEscapePath: false, applyChecksum: true }).sign(
        { method, protocol: u.protocol, hostname: u.hostname, path: u.pathname, headers: { host: u.host, "x-amz-content-sha256": mine.headers["x-amz-content-sha256"] }, body: body ?? undefined },
        { signingDate: now },
      );
      expect(mine.headers.authorization).toBe(ref.headers.authorization);
    });
  }
});

describe("S3 storage against an S3-compatible server", () => {
  let server: any;
  let store: ReturnType<typeof s3Storage>;
  beforeAll(async () => {
    server = new S3rver({ port: 0, address: "127.0.0.1", silent: true, directory: await mkdtemp(join(tmpdir(), "s3-")), configureBuckets: [{ name: "aix-packages" }] });
    const { port } = await server.run();
    store = s3Storage({ ...cfg, endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", accessKeyId: "S3RVER", secretAccessKey: "S3RVER", forcePathStyle: true });
  });
  afterAll(() => server?.close());

  it("round-trips package bytes", async () => {
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    await store.put("packages/app_1/1.0.0.aixpkg", data);
    expect(Buffer.compare(await store.get("packages/app_1/1.0.0.aixpkg"), data)).toBe(0);
    await expect(store.get("packages/missing")).rejects.toThrow(/404/);
  });
});
