-- Ledger guards (defence in depth, see docs/decisions.md D8).

-- 1. Ledger rows are append-only: no UPDATE / DELETE, ever.
CREATE OR REPLACE FUNCTION aix_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger tables are append-only (% on %)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION aix_ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION aix_ledger_append_only();
--> statement-breakpoint
-- 2. Every transaction must balance (Σ debit = Σ credit), checked at COMMIT.
CREATE OR REPLACE FUNCTION aix_ledger_check_balanced() RETURNS trigger AS $$
DECLARE
  d bigint;
  c bigint;
BEGIN
  SELECT coalesce(sum(amount_cents) FILTER (WHERE direction = 'debit'), 0),
         coalesce(sum(amount_cents) FILTER (WHERE direction = 'credit'), 0)
    INTO d, c
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF d <> c THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %: debits % <> credits %', NEW.transaction_id, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aix_ledger_check_balanced();
--> statement-breakpoint
-- 3. Entries must use the transaction's currency and the account's currency.
CREATE OR REPLACE FUNCTION aix_ledger_check_currency() RETURNS trigger AS $$
BEGIN
  IF (SELECT currency FROM ledger_transactions WHERE id = NEW.transaction_id)
     IS DISTINCT FROM (SELECT currency FROM ledger_accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'currency mismatch between transaction and account';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_currency BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION aix_ledger_check_currency();
--> statement-breakpoint
-- 4. Platform singleton accounts.
INSERT INTO ledger_accounts (id, kind, currency) VALUES
  ('acct_platform_revenue_eur', 'platform_revenue', 'EUR'),
  ('acct_stripe_clearing_eur', 'stripe_clearing', 'EUR'),
  ('acct_refunds_payable_eur', 'refunds_payable', 'EUR');
