import { eq } from "drizzle-orm";
import { developers } from "@aix/db";
import { decryptSecret, newId, signWebhook } from "@aix/core";
import type { Deps } from "../context.js";

/**
 * Fire-and-forget signed webhook to the developer (verify with @aix/sdk `aix.webhooks.verify`).
 * MVP: single attempt, no retry queue (see docs/decisions.md D5).
 */
export function notifyDeveloper(deps: Deps, developerId: string, type: string, data: unknown) {
  void (async () => {
    const [dev] = await deps.db.select().from(developers).where(eq(developers.id, developerId));
    if (!dev?.webhookUrl || !dev.webhookSecretEnc || !deps.config.AIX_ENCRYPTION_KEY) return;
    const secret = decryptSecret(dev.webhookSecretEnc, deps.config.AIX_ENCRYPTION_KEY);
    const body = JSON.stringify({ id: newId("evt"), type, createdAt: deps.now().toISOString(), data });
    await fetch(dev.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "aix-signature": signWebhook(body, secret) },
      body,
      signal: AbortSignal.timeout(5000),
    });
  })().catch(() => {});
}
