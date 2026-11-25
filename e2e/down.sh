#!/usr/bin/env bash
# Stops the local stack started by e2e/up.sh and deletes its data: the wrangler dev process, the
# Docker containers and their named volumes (Postgres, MinIO), and e2e/.local (secrets, web build,
# logs). The API image (filesgg-api:e2e) is kept as a build cache.
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="$E2E_DIR/.local"

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
echo "files.gg e2e stack stopped; its volumes and e2e/.local are deleted."
