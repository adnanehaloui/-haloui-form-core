import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { createDb } from "@aix/db";
import { redact } from "@aix/core";
import { loadConfig, type Config } from "./config.js";
import type { App, Deps } from "./context.js";
import { ApiError } from "./lib/errors.js";
import { createSigner } from "./lib/keys.js";
import { memoryMailer, smtpMailer } from "./lib/mailer.js";
import { FakePayments, stripePayments } from "./lib/payments.js";
import { fsStorage } from "./lib/storage.js";
import { PaymentsUnavailableError } from "./lib/payments.js";
import { registerRoutes } from "./routes/index.js";



export function buildDeps(config: Config = loadConfig(), overrides: Partial<Deps> = {}): Deps & { close: () => Promise<void> } {
  const { db, close } = overrides.db ? { db: overrides.db, close: async () => {} } : createDb(config.DATABASE_URL);
  const deps: Deps = {
    db,
    config,
    mailer: config.AIX_MAILER === "memory" ? memoryMailer() : smtpMailer(config.SMTP_URL, config.MAIL_FROM),
    payments: config.STRIPE_SECRET_KEY
      ? stripePayments(config.STRIPE_SECRET_KEY, config.STRIPE_WEBHOOK_SECRET)
      : config.AIX_DEV_ENDPOINTS
        ? new FakePayments(`${config.AIX_WEB_URL}/dev-checkout`)
        : null,
    signer: createSigner(config.AIX_SIGNING_PRIVATE_KEY, (m) => console.warn(`[aix] ${m}`)),
    storage: fsStorage(config.AIX_STORAGE_DIR),
    now: () => new Date(),
    ...overrides,
  };
  return { ...deps, close };
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: "info",
          // Secrets never appear in logs (hard rule 7).
          redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["stripe-signature"]', 'res.headers["set-cookie"]'], censor: "[REDACTED]" },
          serializers: { req: (r) => ({ method: r.method, url: redact(r.url.replace(/([?&](token|code|code_verifier|refresh_token)=)[^&]+/g, "$1[REDACTED]")) }) },
        }
      : false,
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(formbody);
  await app.register(rateLimit, { max: deps.config.NODE_ENV === "test" ? 10_000 : 300, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: { title: "AIX API", version: "0.1.0", description: "AIX marketplace API. Money is integer cents." },
      components: {
        securitySchemes: {
          secretKey: { type: "http", scheme: "bearer", description: "Developer secret key (aixsk_…), server-side only" },
          session: { type: "apiKey", in: "cookie", name: "aix_session" },
          oauth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: "bad_request", message: "invalid request", details: { issues: err.validation } } });
    }
    if (err instanceof PaymentsUnavailableError) {
      return reply.status(503).send({ error: { code: "payments_unavailable", message: err.message } });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: "rate_limited", message: "too many requests" } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: "bad_request", message: err.message } });
    req.log.error({ err: { message: redact(String(err.message)), stack: err.stack } }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "internal error" } });
  });

  app.get("/health", { schema: { hide: true } }, async () => ({ ok: true }));
  await registerRoutes(app as App, deps);
  return app;
}
