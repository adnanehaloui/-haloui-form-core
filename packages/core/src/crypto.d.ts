/** Prefixed random id, e.g. newId("chg") → "chg_3f9a…". 128 bits of randomness. */
export declare function newId(prefix: string): string;
/** Random URL-safe secret token. */
export declare function randomToken(bytes?: number): string;
export declare function sha256Hex(input: string | Buffer): string;
export declare function safeEqual(a: string, b: string): boolean;
/** Encrypt → "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export declare function encryptSecret(plaintext: string, keyB64: string): string;
export declare function decryptSecret(payload: string, keyB64: string): string;
/** Header value: "t=<unix seconds>,v1=<hex hmac-sha256 of `${t}.${body}`>". */
export declare function signWebhook(body: string, secret: string, timestamp?: number): string;
export declare function verifyWebhookSignature(body: string, header: string, secret: string, toleranceSec?: number, now?: number): boolean;
/** Redact anything that looks like a secret before it reaches a log. */
export declare function redact(value: string): string;
