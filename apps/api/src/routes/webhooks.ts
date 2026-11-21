import type { App, Deps } from "../context.js";
import { badRequest } from "../lib/errors.js";
import { PaymentsUnavailableError } from "../lib/payments.js";
import { handleStripeEvent } from "../services/stripe-events.js";

export async function webhookRoutes(app: App, deps: Deps) {
  // Encapsulated so only this route receives the raw body (needed for signature verification).
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/webhooks/stripe", { schema: { tags: ["webhooks"], hide: false } }, async (req, reply) => {
      if (!deps.payments) throw new PaymentsUnavailableError();
      const sig = req.headers["stripe-signature"];
      if (typeof sig !== "string") throw badRequest("missing stripe-signature");
      let event;
      try {
        event = deps.payments.constructWebhookEvent(req.body as Buffer, sig);
      } catch {
        return reply.status(400).send({ error: { code: "bad_request", message: "invalid signature" } });
      }
      const processed = await handleStripeEvent(deps, event);
      return { received: true, duplicate: !processed };
    });
  });
}
