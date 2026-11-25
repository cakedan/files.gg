#!/usr/bin/env bash
# Stops the local stack started by e2e/up.sh and deletes its data: the wrangler dev process, the
# Docker containers and their named volumes (Postgres, MinIO), and e2e/.local (secrets, web build,
# logs). The API image (filesgg-api:e2e) is kept as a build cache.
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="$E2E_DIR/.local"

"$E2E_DIR/scripts/stop-worker.sh" "$LOCAL/wrangler.pid"

# compose needs the variables to parse the file; any value will do for `down`
env_file="$LOCAL/.env"
if [ ! -f "$env_file" ]; then
  env_file="$(mktemp)"
  printf 'POSTGRES_PASSWORD=x\nSECRET_KEY=x\nRPC_KEY=x\nORIGIN_SHARED_SECRET=x\nVIEW_HASH_SECRET=x\nCDN_TOKEN_SECRET=x\nMINIO_ROOT_PASSWORD=x\n' > "$env_file"
fi
docker compose -f "$E2E_DIR/docker-compose.e2e.yml" --env-file "$env_file" down --volumes --remove-orphans

rm -rf "$LOCAL"
echo "files.gg e2e stack stopped; its volumes and e2e/.local are deleted."
