CREATE TYPE "public"."account_kind" AS ENUM('wallet_available', 'wallet_held', 'developer_payable', 'platform_revenue', 'stripe_clearing', 'refunds_payable');--> statement-breakpoint
CREATE TYPE "public"."app_status" AS ENUM('draft', 'in_review', 'published', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."app_type" AS ENUM('prompt', 'server', 'local', 'web');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired', 'used');--> statement-breakpoint
CREATE TYPE "public"."catalog_mode" AS ENUM('open', 'approved_only');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('held', 'captured', 'released', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."limit_period" AS ENUM('daily', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."limit_scope" AS ENUM('user', 'org_member', 'app');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'billing', 'member');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('not_started', 'pending', 'enabled', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."price_interval" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TYPE "public"."price_kind" AS ENUM('free', 'one_time', 'subscription', 'metered');--> statement-breakpoint
CREATE TYPE "public"."tx_kind" AS ENUM('topup', 'hold', 'capture', 'release', 'refund', 'subscription_payment', 'payout', 'card_refund', 'seed');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"developer_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "app_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"package_path" text NOT NULL,
	"package_sha256" text NOT NULL,
	"package_size" integer NOT NULL,
	"signature" text,
	"status" "version_status" DEFAULT 'submitted' NOT NULL,
	"review_notes" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"app_id" text NOT NULL,
	"price_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"manifest_id" text NOT NULL,
	"name" text NOT NULL,
	"developer_id" text NOT NULL,
	"type" "app_type" NOT NULL,
	"status" "app_status" DEFAULT 'draft' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"commission_bps" integer DEFAULT 2000 NOT NULL,
	"current_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_slug_unique" UNIQUE("slug"),
	CONSTRAINT "apps_manifest_id_unique" UNIQUE("manifest_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"actor_type" text NOT NULL,
	"org_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"price_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"free_units" integer DEFAULT 0 NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"developer_cents" bigint,
	"platform_cents" bigint,
	"idempotency_key" text NOT NULL,
	"run_id" text,
	"status" charge_status NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"failure_reason" text,
	"captured_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_nonneg" CHECK ("charges"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "developers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"org_id" text,
	"display_name" text NOT NULL,
	"stripe_connect_account_id" text,
	"payout_status" "payout_status" DEFAULT 'not_started' NOT NULL,
	"webhook_url" text,
	"webhook_secret_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"app_id" text NOT NULL,
	"app_version_id" text NOT NULL,
	"granted_permissions" jsonb NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"period" text NOT NULL,
	"total_cents" bigint NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"lines" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "account_kind" NOT NULL,
	"wallet_id" text,
	"developer_id" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"account_id" text NOT NULL,
	"direction" "direction" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_positive" CHECK ("ledger_entries"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "tx_kind" NOT NULL,
	"currency" text NOT NULL,
	"charge_id" text,
	"external_ref" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"redirect_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"secret_hash" text,
	"developer_id" text,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text,
	"redirect_uri" text,
	"code_challenge" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_grants_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "org_app_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"app_id" text NOT NULL,
	"allowed" boolean NOT NULL,
	"allowed_roles" text[] DEFAULT '{owner,admin,billing,member}' NOT NULL,
	"max_permissions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"catalog_mode" "catalog_mode" DEFAULT 'open' NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"developer_id" text NOT NULL,
	"period" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"stripe_transfer_id" text,
	"status" text NOT NULL,
	"statement" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"lookup_key" text,
	"kind" "price_kind" NOT NULL,
	"unit" text DEFAULT 'run' NOT NULL,
	"unit_amount_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"interval" "price_interval",
	"included_units" integer DEFAULT 0 NOT NULL,
	"stripe_price_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_nonneg" CHECK ("prices"."unit_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_range" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" "limit_scope" NOT NULL,
	"user_id" text,
	"org_id" text,
	"app_id" text,
	"period" "limit_period" NOT NULL,
	"cap_cents" bigint,
	"auto_approve_threshold_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"user_id" text NOT NULL,
	"price_id" text NOT NULL,
	"stripe_subscription_id" text,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"price_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"charge_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"owner_org_id" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_single_owner" CHECK (("wallets"."owner_user_id" is null) <> ("wallets"."owner_org_id" is null))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_developer_id_developers_id_fk" FOREIGN KEY ("developer_id") REFERENCES "public"."developers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_developer_id_developers_id_fk" FOREIGN KEY ("developer_id") REFERENCES "public"."developers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developers" ADD CONSTRAINT "developers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developers" ADD CONSTRAINT "developers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_app_version_id_app_versions_id_fk" FOREIGN KEY ("app_version_id") REFERENCES "public"."app_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_app_policies" ADD CONSTRAINT "org_app_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_app_policies" ADD CONSTRAINT "org_app_policies_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_developer_id_developers_id_fk" FOREIGN KEY ("developer_id") REFERENCES "public"."developers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_limits" ADD CONSTRAINT "spend_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_limits" ADD CONSTRAINT "spend_limits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_limits" ADD CONSTRAINT "spend_limits_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_owner_org_id_organizations_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_versions_app_version" ON "app_versions" USING btree ("app_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_app_idem" ON "approval_requests" USING btree ("app_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "audit_org_time" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_actor" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_uid" ON "auth_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "charges_app_idem" ON "charges" USING btree ("app_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "charges_wallet" ON "charges" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "charges_run" ON "charges" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "installs_user" ON "installs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "installs_app" ON "installs" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_wallet_period" ON "invoices" USING btree ("wallet_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_wallet_kind" ON "ledger_accounts" USING btree ("wallet_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_dev_kind" ON "ledger_accounts" USING btree ("developer_id","kind");--> statement-breakpoint
CREATE INDEX "ledger_entries_account" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_tx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_tx_kind_external_ref" ON "ledger_transactions" USING btree ("kind","external_ref");--> statement-breakpoint
CREATE INDEX "ledger_tx_charge" ON "ledger_transactions" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_user" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_app_policies_org_app" ON "org_app_policies" USING btree ("org_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_pk" ON "org_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "org_members_user" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_dev_period" ON "payouts" USING btree ("developer_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_app_lookup" ON "prices" USING btree ("app_id","lookup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_app_user" ON "reviews" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_app_idem" ON "usage_records" USING btree ("app_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user" ON "wallets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_org" ON "wallets" USING btree ("owner_org_id");