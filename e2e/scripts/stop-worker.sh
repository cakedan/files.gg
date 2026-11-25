#!/usr/bin/env bash
# Stops the wrangler dev started by e2e/up.sh (and the workerd it spawned). Usage: stop-worker.sh <pid file>
set -uo pipefail
pidfile="$1"
[ -f "$pidfile" ] || exit 0
pid="$(cat "$pidfile")"
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  children="$(pgrep -P "$pid" || true)"
  kill "$pid" $children 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -9 "$pid" $children 2>/dev/null || true
fi
rm -f "$pidfile"
