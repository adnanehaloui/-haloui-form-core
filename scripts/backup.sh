#!/usr/bin/env bash
# Daily Postgres backup (custom format, compressed) with retention.
#   DATABASE_URL=postgres://… BACKUP_DIR=/backups RETENTION_DAYS=14 scripts/backup.sh
# Optional off-site copy: set BACKUP_S3_URI (e.g. s3://bucket/aix) and have the aws CLI configured.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/aix-$(date -u +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$file.partial" "$DATABASE_URL"
mv "$file.partial" "$file"
# Verify the archive is readable before trusting it.
pg_restore --list "$file" > /dev/null
echo "backup ok: $file ($(du -h "$file" | cut -f1))"
if [ -n "${BACKUP_S3_URI:-}" ]; then aws s3 cp "$file" "$BACKUP_S3_URI/$(basename "$file")"; fi
find "$BACKUP_DIR" -name 'aix-*.dump' -mtime +"$RETENTION_DAYS" -print -delete
