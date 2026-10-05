#!/usr/bin/env bash
# Harvest restore: put a backup made by scripts/backup.sh back at
# $CONFIG_DIR/db/harvest.db. STOP THE APP FIRST; restoring under a live process
# can corrupt the database. The current database (and its -wal/-shm files) is
# moved to $CONFIG_DIR/pre-restore-<ts>/ rather than deleted.
# Usage: scripts/restore.sh /config/backups/harvest-YYYYMMDD-HHMMSS.db
set -euo pipefail

ARCHIVE="${1:-}"
CONFIG_DIR="${CONFIG_DIR:-/config}"
DB="$CONFIG_DIR/db/harvest.db"

[ -n "$ARCHIVE" ] || { echo "usage: $0 <path-to-harvest-*.db>" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "error: sqlite3 not found on PATH" >&2; exit 1; }
[ -f "$ARCHIVE" ] || { echo "error: backup not found: $ARCHIVE" >&2; exit 1; }

INTEGRITY="$(sqlite3 "$ARCHIVE" "PRAGMA integrity_check;")"
[ "$INTEGRITY" = "ok" ] || { echo "error: backup failed integrity check: $INTEGRITY" >&2; exit 1; }

mkdir -p "$CONFIG_DIR/db"
if [ -f "$DB" ]; then
  ASIDE="$CONFIG_DIR/pre-restore-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$ASIDE"
  for f in "$DB" "$DB-wal" "$DB-shm"; do [ -f "$f" ] && mv "$f" "$ASIDE/"; done
  echo "existing database moved to $ASIDE"
fi

cp "$ARCHIVE" "$DB"
echo "restore complete: $DB"
