/**
 * M2 demo: charge €0.50 through the public API with @aix/sdk, exactly like a developer server would.
 *   pnpm seed && pnpm --filter @aix/api demo:charge
 * Reads AIX_SECRET_KEY and AIX_DEMO_USER_ID from .env.seed.
 */
import { randomUUID } from "node:crypto";
import { AIX, NeedsUserApproval } from "@aix/sdk";

const aix = new AIX({ secretKey: process.env.AIX_SECRET_KEY, apiUrl: process.env.AIX_API_URL ?? "http://localhost:4000" });
const userId = process.env.AIX_DEMO_USER_ID ?? process.argv[2];
if (!userId) throw new Error("set AIX_DEMO_USER_ID (see .env.seed) or pass a user id");
const runId = randomUUID();
try {
  const hold = await aix.wallet.hold({ userId, priceId: "render", quantity: 1, idempotencyKey: runId, runId });
  console.log(`held ${hold.display} (${hold.id}, free units used: ${hold.freeUnits})`);
  const charge = await aix.wallet.capture(hold.id);
  console.log(`captured ${charge.display} — check the wallet history at http://localhost:3000/wallet`);
} catch (e) {
  if (e instanceof NeedsUserApproval) console.log(`needs approval: ${e.display} → ${e.approvalUrl}`);
  else throw e;
}
