#!/usr/bin/env bash
# Stops the local stack started by e2e/up.sh and deletes its data: the wrangler dev process, the
# Docker containers and their named volumes (Postgres, MinIO), e2e/.local (secrets, logs) and what
# up.sh put in the Worker's folder outside the checkout (web build, config, state; WORKER_DIR in
# up.sh). The API image (filesgg-api:e2e) is kept as a build cache.
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="$E2E_DIR/.local"
WORKER_DIR="${E2E_WORKER_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/filesgg-e2e}"

"$E2E_DIR/scripts/stop-worker.sh" "$LOCAL/wrangler.pid"

# compose needs the variables to parse the file; any value will do for `down`
# By project name, not the compose file: tearing down must never depend on .env having every
# variable the current compose file requires (an old .env from before a secret was renamed
# used to make `down` fail silently and leave the old database volume behind).
if ! docker compose -p filesgg-e2e down --volumes --remove-orphans; then
  echo "e2e/down.sh: docker compose down failed; e2e/.local is kept so you can retry." >&2
  exit 1
fi
leftover="$(docker volume ls -q --filter label=com.docker.compose.project=filesgg-e2e)"
if [ -n "$leftover" ]; then
  echo "e2e/down.sh: volumes are still there: $leftover" >&2
  exit 1
fi

rm -rf "$LOCAL"
# Only what up.sh writes there: E2E_WORKER_DIR can point anywhere.
rm -rf "$WORKER_DIR/web-dist" "$WORKER_DIR/wrangler-state" "$WORKER_DIR/.wrangler" \
  "$WORKER_DIR/wrangler.json" "$WORKER_DIR/.dev.vars"
rmdir "$WORKER_DIR" 2>/dev/null || true
echo "files.gg e2e stack stopped; its volumes, e2e/.local and $WORKER_DIR are deleted."
