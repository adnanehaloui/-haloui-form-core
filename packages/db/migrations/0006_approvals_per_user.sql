DROP INDEX "approvals_app_idem";--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_app_user_idem" ON "approval_requests" USING btree ("app_id","user_id","idempotency_key");