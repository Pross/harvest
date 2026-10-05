#!/bin/bash
# Test double for rclone. The engine gives children a CLEAN env, so scenarios are read from files under
# $HOME/fake-rclone (HOME is the engine's tmpDir):
#   <cmd>.out    bytes written to stdout        <cmd>.err    text written to stderr
#   <cmd>.code   exit code (default 0)          <cmd>.sleep  seconds to sleep after output (exec, so the pid is the sleeper)
# Every call records calls/<id>.argv (one arg per line), .env, .pid, .cfg (RCLONE_CONFIG existed) and .stdin.
d="$HOME/fake-rclone"; mkdir -p "$d/calls"
id="$$-$RANDOM"
printf '%s\n' "$@" > "$d/calls/$id.argv"
env | sort > "$d/calls/$id.env"
echo $$ > "$d/calls/$id.pid"
[ -f "${RCLONE_CONFIG:-}" ] && echo yes > "$d/calls/$id.cfg"
cmd="$1"
if [ "$cmd" = obscure ]; then
  pw=$(cat); printf '%s' "$pw" > "$d/calls/$id.stdin"; echo "obscured:$pw"; exit 0
fi
[ -f "$d/$cmd.out" ] && cat "$d/$cmd.out"
[ -f "$d/$cmd.err" ] && cat "$d/$cmd.err" >&2
[ -f "$d/$cmd.sleep" ] && exec sleep "$(cat "$d/$cmd.sleep")"
exit "$(cat "$d/$cmd.code" 2>/dev/null || echo 0)"
