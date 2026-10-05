#!/bin/sh
# Unraid (and similar) bind-mount appdata owned by a host user that will not match
# the image's build-time user. Run as root, take ownership of /config ONLY (never
# the download targets under /data), then drop to PUID:PGID (default 99:100 =
# Unraid's nobody:users) with the configured umask. The app never runs as root.
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-002}"
CONFIG_DIR="${CONFIG_DIR:-/config}"

case "$PUID" in ''|*[!0-9]*) echo "error: PUID must be a number, got '$PUID'" >&2; exit 1;; esac
case "$PGID" in ''|*[!0-9]*) echo "error: PGID must be a number, got '$PGID'" >&2; exit 1;; esac
case "$UMASK" in ''|*[!0-7]*) echo "error: UMASK must be octal (e.g. 002), got '$UMASK'" >&2; exit 1;; esac
if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo "error: PUID/PGID must not be 0; Harvest does not run as root" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/tmp"
chown -R "$PUID:$PGID" "$CONFIG_DIR"

# ssh and rsync fail for a uid with no passwd entry, so create one if missing.
# HOME is $CONFIG_DIR/tmp (writable, throwaway). Idempotent on every start.
if ! getent group "$PGID" >/dev/null 2>&1; then
  echo "harvest:x:$PGID:" >> /etc/group
fi
if ! getent passwd "$PUID" >/dev/null 2>&1; then
  NAME=harvest
  getent passwd "$NAME" >/dev/null 2>&1 && NAME="harvest$PUID"
  echo "$NAME:x:$PUID:$PGID:Harvest:$CONFIG_DIR/tmp:/usr/sbin/nologin" >> /etc/passwd
fi
export HOME="$CONFIG_DIR/tmp"

umask "$UMASK"

exec gosu "$PUID:$PGID" "$@"
