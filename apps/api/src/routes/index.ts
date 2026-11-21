import type { App, Deps } from "../context.js";
import { authRoutes } from "./auth.js";
import { orgRoutes } from "./orgs.js";
import { walletRoutes } from "./wallet.js";
import { v1Routes } from "./v1.js";
import { approvalRoutes } from "./approvals.js";
import { webhookRoutes } from "./webhooks.js";
import { devRoutes } from "./dev.js";
import { developerRoutes } from "./developer.js";
import { adminRoutes } from "./admin.js";
import { storeRoutes } from "./store.js";

export async function registerRoutes(app: App, deps: Deps) {
  await authRoutes(app, deps);
  await orgRoutes(app, deps);
  await walletRoutes(app, deps);
  await v1Routes(app, deps);
  await approvalRoutes(app, deps);
  await webhookRoutes(app, deps);
  await developerRoutes(app, deps);
  await adminRoutes(app, deps);
  await storeRoutes(app, deps);
  if (deps.config.AIX_DEV_ENDPOINTS) await devRoutes(app, deps);
}
