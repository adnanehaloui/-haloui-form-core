import type { Db } from "@aix/db";
import type { Config } from "./config.js";
import type { Mailer } from "./lib/mailer.js";
import type { Payments } from "./lib/payments.js";
import type { Signer } from "./lib/keys.js";
import type { Storage } from "./lib/storage.js";

/** Everything a route or service needs. Built once in buildApp, injectable in tests. */
export interface Deps {
  db: Db;
  config: Config;
  mailer: Mailer;
  /** null when Stripe keys are not configured. */
  payments: Payments | null;
  signer: Signer;
  storage: Storage;
  now: () => Date;
}

import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
export type App = FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, FastifyBaseLogger, ZodTypeProvider>;
