#!/usr/bin/env bash
# Harvest backup: a consistent snapshot of the SQLite database (online
# `sqlite3 .backup`, WAL-safe, safe while the app runs) written as a timestamped
# file under $CONFIG_DIR/backups. Retention keeps the newest BACKUP_KEEP files
# (default 14; 0 = keep all). Run inside the container:
#   docker exec harvest /app/scripts/backup.sh
# Download targets are not backed up; only /config state is.
set -euo pipefail

CONFIG_DIR="${CONFIG_DIR:-/config}"
DB="$CONFIG_DIR/db/harvest.db"
BACKUP_DIR="${BACKUP_DIR:-$CONFIG_DIR/backups}"
KEEP="${BACKUP_KEEP:-14}"

command -v sqlite3 >/dev/null 2>&1 || { echo "error: sqlite3 not found on PATH" >&2; exit 1; }
[ -f "$DB" ] || { echo "error: database not found at $DB" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/harvest-$TS.db"

sqlite3 "$DB" ".backup '$OUT'"
[ "$(sqlite3 "$OUT" 'PRAGMA integrity_check;')" = "ok" ] || { echo "error: backup failed integrity check" >&2; rm -f "$OUT"; exit 1; }

if [ "$KEEP" -gt 0 ]; then
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/harvest-*.db 2>/dev/null | tail -n "+$((KEEP + 1))" | while IFS= read -r f; do rm -f "$f"; done
fi

echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
