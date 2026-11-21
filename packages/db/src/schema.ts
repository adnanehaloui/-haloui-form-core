/**
 * AIX database schema. Ids are prefixed random text ids (see @aix/core newId).
 * Money columns are bigint cents (mode "number", guarded as safe integers in @aix/core) + currency.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const cents = (name: string) => bigint(name, { mode: "number" });

// ---- Enums -----------------------------------------------------------------------------------
export const orgRole = pgEnum("org_role", ["owner", "admin", "billing", "member"]);
export const accountKind = pgEnum("account_kind", [
  "wallet_available",
  "wallet_held",
  "developer_payable",
  "platform_revenue",
  "stripe_clearing",
  "refunds_payable",
]);
export const direction = pgEnum("direction", ["debit", "credit"]);
export const txKind = pgEnum("tx_kind", [
  "topup",
  "hold",
  "capture",
  "release",
  "refund",
  "subscription_payment",
  "payout",
  "card_refund",
  "seed",
]);
export const appType = pgEnum("app_type", ["prompt", "server", "local", "web"]);
export const appStatus = pgEnum("app_status", ["draft", "in_review", "published", "suspended"]);
export const versionStatus = pgEnum("version_status", ["submitted", "approved", "rejected"]);
export const priceKind = pgEnum("price_kind", ["free", "one_time", "subscription", "metered"]);
export const priceInterval = pgEnum("price_interval", ["month", "year"]);
export const chargeStatus = pgEnum("charge_status", ["held", "captured", "released", "refunded", "failed"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "denied", "expired", "used"]);
export const limitScope = pgEnum("limit_scope", ["user", "org_member", "app"]);
export const limitPeriod = pgEnum("limit_period", ["daily", "monthly"]);
export const payoutStatus = pgEnum("payout_status", ["not_started", "pending", "enabled", "restricted"]);
export const catalogMode = pgEnum("catalog_mode", ["open", "approved_only"]);

// ---- Identity --------------------------------------------------------------------------------
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: createdAt(),
});

/** Linked login methods (google). Email magic link needs no identity row. */
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("auth_identities_provider_uid").on(t.provider, t.providerUserId)],
);

/** Sessions: only the SHA-256 of the cookie token is stored. */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256(token)
  userId: text("user_id").notNull().references(() => users.id),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

export const magicLinkTokens = pgTable("magic_link_tokens", {
  id: text("id").primaryKey(), // sha256(token)
  email: text("email").notNull(),
  redirectTo: text("redirect_to"),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

// ---- Organizations ---------------------------------------------------------------------------
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  catalogMode: catalogMode("catalog_mode").notNull().default("open"),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: createdAt(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: text("org_id").notNull().references(() => organizations.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: orgRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("org_members_pk").on(t.orgId, t.userId), index("org_members_user").on(t.userId)],
);

// ---- Wallets & ledger ------------------------------------------------------------------------
export const wallets = pgTable(
  "wallets",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").references(() => users.id),
    ownerOrgId: text("owner_org_id").references(() => organizations.id),
    currency: text("currency").notNull().default("EUR"),
    createdAt: createdAt(),
  },
  (t) => [
    check("wallet_single_owner", sql`(${t.ownerUserId} is null) <> (${t.ownerOrgId} is null)`),
    uniqueIndex("wallets_user").on(t.ownerUserId),
    uniqueIndex("wallets_org").on(t.ownerOrgId),
  ],
);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: text("id").primaryKey(),
    kind: accountKind("kind").notNull(),
    walletId: text("wallet_id").references(() => wallets.id),
    developerId: text("developer_id"),
    currency: text("currency").notNull().default("EUR"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ledger_accounts_wallet_kind").on(t.walletId, t.kind),
    uniqueIndex("ledger_accounts_dev_kind").on(t.developerId, t.kind),
  ],
);

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: text("id").primaryKey(),
    kind: txKind("kind").notNull(),
    currency: text("currency").notNull(),
    chargeId: text("charge_id"),
    externalRef: text("external_ref"), // e.g. Stripe checkout session / invoice / transfer id
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ledger_tx_kind_external_ref").on(t.kind, t.externalRef), index("ledger_tx_charge").on(t.chargeId)],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id").notNull().references(() => ledgerTransactions.id),
    accountId: text("account_id").notNull().references(() => ledgerAccounts.id),
    direction: direction("direction").notNull(),
    amountCents: cents("amount_cents").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("ledger_entry_positive", sql`${t.amountCents} > 0`),
    index("ledger_entries_account").on(t.accountId),
    index("ledger_entries_tx").on(t.transactionId),
  ],
);

// ---- Developers & apps -----------------------------------------------------------------------
export const developers = pgTable("developers", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  orgId: text("org_id").references(() => organizations.id),
  displayName: text("display_name").notNull(),
  stripeConnectAccountId: text("stripe_connect_account_id"),
  payoutStatus: payoutStatus("payout_status").notNull().default("not_started"),
  webhookUrl: text("webhook_url"),
  /** AES-GCM encrypted webhook signing secret (see @aix/core encryptSecret). */
  webhookSecretEnc: text("webhook_secret_enc"),
  createdAt: createdAt(),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  developerId: text("developer_id").notNull().references(() => developers.id),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(), // first chars, safe to display
  hash: text("hash").notNull().unique(), // sha256(secret)
  scopes: text("scopes").array().notNull(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
});

export const apps = pgTable("apps", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  manifestId: text("manifest_id").notNull().unique(), // reverse-DNS id from aix.json
  name: text("name").notNull(),
  developerId: text("developer_id").notNull().references(() => developers.id),
  type: appType("type").notNull(),
  status: appStatus("status").notNull().default("draft"),
  category: text("category").notNull().default("other"),
  description: text("description").notNull().default(""),
  commissionBps: integer("commission_bps").notNull().default(2000),
  currentVersionId: text("current_version_id"),
  createdAt: createdAt(),
});

export const appVersions = pgTable(
  "app_versions",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull().references(() => apps.id),
    version: text("version").notNull(),
    manifest: jsonb("manifest").notNull(),
    packagePath: text("package_path").notNull(),
    packageSha256: text("package_sha256").notNull(),
    packageSize: integer("package_size").notNull(),
    signature: text("signature"), // platform Ed25519 signature, set on approval
    status: versionStatus("status").notNull().default("submitted"),
    reviewNotes: text("review_notes"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: ts("reviewed_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("app_versions_app_version").on(t.appId, t.version)],
);

export const prices = pgTable("prices", {
  id: text("id").primaryKey(),
  appId: text("app_id").notNull().references(() => apps.id),
  lookupKey: text("lookup_key"), // developer-chosen alias, e.g. "pro" or "render"
  kind: priceKind("kind").notNull(),
  unit: text("unit").notNull().default("run"),
  unitAmountCents: cents("unit_amount_cents").notNull().default(0),
  currency: text("currency").notNull().default("EUR"),
  interval: priceInterval("interval"),
  includedUnits: integer("included_units").notNull().default(0),
  stripePriceId: text("stripe_price_id"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("prices_app_lookup").on(t.appId, t.lookupKey), check("price_nonneg", sql`${t.unitAmountCents} >= 0`)]);

export const installs = pgTable(
  "installs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    /** If set, the app was installed "for" this org: the org wallet pays, org policies + member budgets apply. */
    orgId: text("org_id").references(() => organizations.id),
    appId: text("app_id").notNull().references(() => apps.id),
    appVersionId: text("app_version_id").notNull().references(() => appVersions.id),
    grantedPermissions: jsonb("granted_permissions").notNull(),
    uninstalledAt: ts("uninstalled_at"),
    createdAt: createdAt(),
  },
  (t) => [index("installs_user").on(t.userId), index("installs_app").on(t.appId)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull().references(() => apps.id),
    userId: text("user_id").notNull().references(() => users.id),
    rating: integer("rating").notNull(),
    body: text("body").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reviews_app_user").on(t.appId, t.userId), check("rating_range", sql`${t.rating} between 1 and 5`)],
);

export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id").notNull().references(() => wallets.id),
  userId: text("user_id").notNull().references(() => users.id),
  priceId: text("price_id").notNull().references(() => prices.id),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  status: text("status").notNull(),
  currentPeriodEnd: ts("current_period_end"),
  createdAt: createdAt(),
});

// ---- Charges & approvals ---------------------------------------------------------------------
export const charges = pgTable(
  "charges",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull().references(() => apps.id),
    walletId: text("wallet_id").notNull().references(() => wallets.id),
    userId: text("user_id").notNull().references(() => users.id), // who triggered it
    orgId: text("org_id"),
    priceId: text("price_id").notNull().references(() => prices.id),
    quantity: integer("quantity").notNull(),
    freeUnits: integer("free_units").notNull().default(0),
    amountCents: cents("amount_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    developerCents: cents("developer_cents"),
    platformCents: cents("platform_cents"),
    idempotencyKey: text("idempotency_key").notNull(),
    runId: text("run_id"),
    status: chargeStatus("status").notNull(),
    holdExpiresAt: ts("hold_expires_at"),
    failureReason: text("failure_reason"),
    capturedAt: ts("captured_at"),
    releasedAt: ts("released_at"),
    refundedAt: ts("refunded_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("charges_app_idem").on(t.appId, t.idempotencyKey),
    index("charges_wallet").on(t.walletId, t.createdAt),
    index("charges_run").on(t.runId),
    check("charge_nonneg", sql`${t.amountCents} >= 0`),
  ],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    appId: text("app_id").notNull().references(() => apps.id),
    priceId: text("price_id").notNull().references(() => prices.id),
    quantity: integer("quantity").notNull(),
    amountCents: cents("amount_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("approvals_app_idem").on(t.appId, t.idempotencyKey)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull().references(() => apps.id),
    userId: text("user_id").notNull().references(() => users.id),
    priceId: text("price_id").notNull().references(() => prices.id),
    quantity: integer("quantity").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    chargeId: text("charge_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("usage_app_idem").on(t.appId, t.idempotencyKey)],
);

export const spendLimits = pgTable("spend_limits", {
  id: text("id").primaryKey(),
  scope: limitScope("scope").notNull(),
  userId: text("user_id").references(() => users.id),
  orgId: text("org_id").references(() => organizations.id),
  appId: text("app_id").references(() => apps.id),
  period: limitPeriod("period").notNull(),
  capCents: cents("cap_cents"),
  autoApproveThresholdCents: cents("auto_approve_threshold_cents"),
  createdAt: createdAt(),
});

// ---- OAuth (AIX as provider) -----------------------------------------------------------------
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(), // client_id
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  secretHash: text("secret_hash"), // null = public client (PKCE only)
  developerId: text("developer_id"),
  scopes: text("scopes").array().notNull(),
  createdAt: createdAt(),
});

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => oauthClients.id),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(), // "code" | "refresh"
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    resource: text("resource"),
    redirectUri: text("redirect_uri"),
    codeChallenge: text("code_challenge"),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_grants_user").on(t.userId)],
);

// ---- Org policies ----------------------------------------------------------------------------
export const orgAppPolicies = pgTable(
  "org_app_policies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    appId: text("app_id").notNull().references(() => apps.id),
    allowed: boolean("allowed").notNull(),
    allowedRoles: text("allowed_roles").array().notNull().default(sql`'{owner,admin,billing,member}'`),
    maxPermissions: jsonb("max_permissions"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("org_app_policies_org_app").on(t.orgId, t.appId)],
);

// ---- Stripe, payouts, invoices ---------------------------------------------------------------
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(), // Stripe event id
  type: text("type").notNull(),
  processedAt: ts("processed_at").notNull().defaultNow(),
});

export const payouts = pgTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    developerId: text("developer_id").notNull().references(() => developers.id),
    period: text("period").notNull(), // "YYYY-MM"
    amountCents: cents("amount_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    stripeTransferId: text("stripe_transfer_id"),
    status: text("status").notNull(), // pending | paid | failed | skipped
    statement: jsonb("statement").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("payouts_dev_period").on(t.developerId, t.period)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    walletId: text("wallet_id").notNull().references(() => wallets.id),
    period: text("period").notNull(),
    totalCents: cents("total_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    lines: jsonb("lines").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invoices_wallet_period").on(t.walletId, t.period)],
);

// ---- Audit -----------------------------------------------------------------------------------
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    actorType: text("actor_type").notNull(), // user | developer | admin | system | gateway
    orgId: text("org_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_time").on(t.orgId, t.createdAt), index("audit_actor").on(t.actorUserId)],
);

// ---- Gateway pending actions (approval re-runs, install confirmations) ------------------------
/**
 * Short-lived state shared by all gateway instances. `nonceHash` = sha256 of the nonce that only the
 * MCP Apps panel receives. `payload` (the original tool call) is AES-GCM encrypted when
 * AIX_ENCRYPTION_KEY is set and the row is deleted when consumed or expired.
 */
export const gatewayPending = pgTable(
  "gateway_pending",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(), // "approval" | "install"
    ref: text("ref").notNull(), // approval id or app slug
    payload: text("payload"),
    nonceHash: text("nonce_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("gateway_pending_user_kind_ref").on(t.userId, t.kind, t.ref)],
);
