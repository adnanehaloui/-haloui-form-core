import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { exportJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from "jose";

/**
 * One Ed25519 platform key signs: OAuth access tokens, short-lived AIX user tokens for developer
 * servers, and approved app packages. Public half is published at /.well-known/jwks.json.
 */
export interface Signer {
  kid: string;
  jwks(): Promise<{ keys: JWK[] }>;
  signJwt(payload: JWTPayload, opts: { audience: string | string[]; issuer: string; expiresInSec: number; subject: string }): Promise<string>;
  verifyJwt(token: string, opts: { audience: string | string[]; issuer: string }): Promise<JWTPayload>;
  signBytes(data: Buffer): string;
  verifyBytes(data: Buffer, signatureB64: string): boolean;
}

export function createSigner(pem: string | undefined, warn: (m: string) => void = () => {}): Signer {
  let priv: KeyObject;
  if (pem) {
    priv = createPrivateKey(pem.replace(/\\n/g, "\n"));
  } else {
    warn("AIX_SIGNING_PRIVATE_KEY not set — using an ephemeral key (tokens break on restart). Run `pnpm --filter @aix/api keys:generate`.");
    priv = generateKeyPairSync("ed25519").privateKey;
  }
  const pub = createPublicKey(priv);
  const kid = "aix-" + Buffer.from(pub.export({ format: "der", type: "spki" })).subarray(-8).toString("hex");
  return {
    kid,
    async jwks() {
      const jwk = await exportJWK(pub);
      return { keys: [{ ...jwk, kid, alg: "EdDSA", use: "sig" }] };
    },
    signJwt(payload, o) {
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "EdDSA", kid })
        .setIssuer(o.issuer)
        .setAudience(o.audience)
        .setSubject(o.subject)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + o.expiresInSec)
        .sign(priv);
    },
    async verifyJwt(token, o) {
      const { payload } = await jwtVerify(token, pub, { audience: o.audience, issuer: o.issuer, algorithms: ["EdDSA"] });
      return payload;
    },
    signBytes: (data) => sign(null, data, priv).toString("base64"),
    verifyBytes: (data, sig) => {
      try {
        return verify(null, data, pub, Buffer.from(sig, "base64"));
      } catch {
        return false;
      }
    },
  };
}

export function generateSigningKeyPem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}
