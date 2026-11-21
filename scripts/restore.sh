#!/usr/bin/env bash
# Restore a backup into an EMPTY database (never over a live one):
#   RESTORE_DATABASE_URL=postgres://…/aix_restore scripts/restore.sh backups/aix-20261121-020000.dump
set -euo pipefail
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
file="${1:?usage: restore.sh <file.dump>}"
tables=$(psql "$RESTORE_DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema='public'")
if [ "$tables" != "0" ]; then echo "refusing: target database is not empty ($tables tables)"; exit 1; fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_DATABASE_URL" "$file"
# Sanity check: the restored ledger must balance.
psql "$RESTORE_DATABASE_URL" -Atc "select case when sum(case when direction='debit' then amount_cents else 0 end) = sum(case when direction='credit' then amount_cents else 0 end) then 'ledger balanced' else 'LEDGER UNBALANCED' end from ledger_entries"
