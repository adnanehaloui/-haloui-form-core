import { eq } from "drizzle-orm";
import { developers } from "@aix/db";
import { decryptSecret, newId, signWebhook } from "@aix/core";
import type { Deps } from "../context.js";

const RETRY_DELAYS_MS = [0, 1_000, 5_000, 30_000];

/**
 * Signed webhook to the developer (verify with `@aix/sdk` webhooks.verify, header `aix-signature`).
 * Fire-and-forget with up to 4 attempts and backoff; each attempt is re-signed with a fresh timestamp,
 * and the event id stays the same so receivers can dedupe. Returns a promise for tests.
 */
export function notifyDeveloper(deps: Deps, developerId: string, type: string, data: unknown, delays = RETRY_DELAYS_MS): Promise<boolean> {
  const run = async () => {
    const [dev] = await deps.db.select().from(developers).where(eq(developers.id, developerId));
    if (!dev?.webhookUrl || !dev.webhookSecretEnc || !deps.config.AIX_ENCRYPTION_KEY) return false;
    const secret = decryptSecret(dev.webhookSecretEnc, deps.config.AIX_ENCRYPTION_KEY);
    const body = JSON.stringify({ id: newId("evt"), type, createdAt: deps.now().toISOString(), data });
    for (const delay of delays) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await fetch(dev.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "aix-signature": signWebhook(body, secret) },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return true;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return false; // receiver rejected it
      } catch {
        // network error → retry
      }
    }
    return false;
  };
  const p = run().catch(() => false);
  return p;
}
