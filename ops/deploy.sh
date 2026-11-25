#!/usr/bin/env bash
# Deploys the whole stack without downtime (docs/redesign/contracts/milestone-7.md §3), a port of notsobot.api's
# deploy-api.sh. Run on the server, from the checkout, as the deploy user (in the docker group).
#
#   ops/deploy.sh                    pull the branch (DEPLOY_BRANCH, default master), build, migrate, roll everything
#   ops/deploy.sh --ref <commit>     the same for a given commit: a rollback (migrations don't roll back, they're
#                                    expand-only, so the old code works on the new schema)
#   ops/deploy.sh --no-pull          deploy the checkout as it is
#   ops/deploy.sh --no-build         roll over to the images that are already built
#   ops/deploy.sh --no-worker        skip the website build and the Cloudflare Worker
#   ops/deploy.sh --no-smoke         skip the post-deploy smoke check
#   ops/deploy.sh --status           what's deployed, whether a deploy is running, the containers
#
# Steps (§3.1): ops/check-env.sh; git; pull the pinned images and build ours; `migrate` (while the old API serves);
# the API rollover: a second api container next to the old one, ready when every Sanic worker has logged
# `[api] worker <pid> ready`, then the old one gets SIGTERM and drains (nginx resolves `api` through Docker's DNS, so
# both get requests meanwhile); if the new one never gets ready it's removed and the old one keeps serving. Then the
# Postgres-queue workers and the converters are recreated with SIGTERM (each finishes its job first, up to its
# stop_grace_period; new jobs wait in the queue), the monitoring and backup services, an nginx reload, the website and
# the Worker (after the API, so a new route never reaches an API that lacks it), and `node ops/smoke.mjs --quick`.
#
# postgres, redis and clamav are started when they're missing but never recreated here (that's an outage); the end of
# the run says when their definition changed, to `docker compose up -d <service>` them at a quiet moment.
#
# Environment: ENV_FILE (default .env), READY_TIMEOUT (seconds for the new API's workers, default 180), STOP_TIMEOUT
# (seconds for the old API to drain, default 70: Sanic's 50 s graceful timeout and some), DEPLOY_BRANCH. Compose's own
# COMPOSE_PROJECT_NAME and COMPOSE_FILE are honoured.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=ops/env.sh
. ops/env.sh

READY_TIMEOUT=${READY_TIMEOUT:-180}
STOP_TIMEOUT=${STOP_TIMEOUT:-70}
SETTLE=11 # seconds between the new API being ready and stopping the old one: nginx's resolver `valid` and fail_timeout
DEPLOY_BRANCH=${DEPLOY_BRANCH:-master}
READY_MARKER='^\[api\] worker [0-9]+ ready$' # printed by each Sanic worker once it's serving (api/app.py)
STATE_DIR=.deploy
LOCK=$STATE_DIR/lock
DEPLOYED=$STATE_DIR/deployed
HISTORY=$STATE_DIR/history.log

QUEUE_WORKERS='worker scanner rescanner'
CONVERTERS='converter-premium converter converter-previews'
SIDE_SERVICES='prometheus grafana exporter-node exporter-postgres exporter-redis cadvisor backup-db scheduler-ofelia'
INFRA='postgres redis clamav'

log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "$*"; exit 1; }
compose() { docker compose --env-file "$ENV_FILE" "$@"; }
# images are built in step 1 only (or not at all with --no-build), never as a side effect of starting a container
up() { compose up -d --no-build --quiet-pull "$@"; }

usage() { sed -n '5,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

ref=
pull=1
build=1
worker=1
smoke=1
status=
while [ $# -gt 0 ]; do
  case $1 in
    --ref) [ $# -ge 2 ] || usage; ref=$2; shift ;;
    --no-pull) pull= ;;
    --no-build) build= ;;
    --no-worker) worker= ;;
    --no-smoke) smoke= ;;
    --status) status=1 ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
  shift
done

lock_field() { sed -n "s/^$1=//p" "$LOCK/info" 2>/dev/null; }

show_status() {
  if [ -d "$LOCK" ]; then
    echo "deploy running: pid $(lock_field pid) by $(lock_field user) since $(lock_field started), to $(lock_field target)"
  else
    echo "no deploy running"
  fi
  if [ -f "$DEPLOYED" ]; then
    echo "deployed: $(cat "$DEPLOYED")"
  else
    echo "deployed: nothing recorded yet"
  fi
  echo "checkout: $(git rev-parse --short HEAD) ($(git log -1 --format='%s' HEAD))"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "checkout has uncommitted changes"
  fi
  echo
  compose ps --format 'table {{.Service}}\t{{.Name}}\t{{.Status}}\t{{.RunningFor}}'
}

if [ -n "$status" ]; then
  show_status
  exit 0
fi

# --- one deploy at a time --------------------------------------------------------------------------------------------
mkdir -p "$STATE_DIR"
if ! mkdir "$LOCK" 2>/dev/null; then
  pid=$(lock_field pid)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    die "another deploy is running (pid $pid since $(lock_field started), to $(lock_field target)); see --status"
  fi
  log "removing a stale lock (pid ${pid:-?} isn't running)"
  rm -rf "$LOCK"
  mkdir "$LOCK"
fi
trap 'rm -rf "$LOCK"' EXIT
if [ -n "$ref" ]; then
  target=$ref
elif [ -n "$pull" ]; then
  target=$DEPLOY_BRANCH
else
  target="the checkout ($(git rev-parse --short HEAD))"
fi
printf 'pid=%s\nuser=%s\nstarted=%s\ntarget=%s\n' "$$" "$(id -un)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$target" > "$LOCK/info"

# --- 1. configuration, code, images ----------------------------------------------------------------------------------
ops/check-env.sh

previous=$(cut -d ' ' -f 1 "$DEPLOYED" 2>/dev/null || true)
if [ -n "$pull" ] || [ -n "$ref" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    die "the checkout has uncommitted changes, refusing to pull over them (or deploy it as it is with --no-pull)"
  fi
  git fetch --quiet origin
  if [ -n "$ref" ]; then
    log "checking out $ref"
    git checkout --quiet --detach "$ref"
  else
    log "pulling $DEPLOY_BRANCH"
    git checkout --quiet "$DEPLOY_BRANCH"
    git pull --quiet --ff-only origin "$DEPLOY_BRANCH"
  fi
fi
commit=$(git rev-parse HEAD)
log "deploying $(git rev-parse --short HEAD): $(git log -1 --format='%s' HEAD)"

if [ -n "$build" ]; then
  log "pulling the pinned images"
  compose pull --quiet --ignore-buildable --policy missing
  log "building"
  compose build --quiet
fi

# --- 2. migrate, with the old API still serving (decision 6) ---------------------------------------------------------
# start whatever infrastructure is missing (the first deploy), never recreate it
up --no-recreate --wait postgres redis
up --no-recreate clamav
log "migrating"
compose run --rm --no-deps --quiet-pull migrate

# --- 3. the API rollover ---------------------------------------------------------------------------------------------
container_name() { docker inspect -f '{{.Name}}' "$1" | sed 's#^/##'; }

# every Sanic worker prints the marker once; the count is the container's own `--workers`
wait_ready() {
  local id=$1 name workers ready deadline
  name=$(container_name "$id")
  workers=$(docker inspect -f '{{range .Config.Cmd}}{{.}} {{end}}' "$id" | sed -nE 's/.*--workers[= ]([0-9]+).*/\1/p')
  workers=${workers:-1}
  log "waiting for $workers workers in $name"
  deadline=$((SECONDS + READY_TIMEOUT))
  while :; do
    ready=$(docker logs "$id" 2>&1 | grep -cE "$READY_MARKER" || true)
    [ "$ready" -ge "$workers" ] && return 0
    if [ "$SECONDS" -ge "$deadline" ] || [ "$(docker inspect -f '{{.State.Running}}' "$id")" != true ]; then
      log "$name has $ready/$workers workers ready after $((SECONDS - deadline + READY_TIMEOUT))s:"
      docker logs --tail 40 "$id" 2>&1 | sed 's/^/    /'
      return 1
    fi
    sleep 1
  done
}

running=$(compose ps -q api)
if [ "$(printf '%s\n' "$running" | grep -c .)" -gt 1 ]; then
  compose ps api
  die "more than one api container is running, a deploy didn't finish: stop the stale one first"
fi
old=$running

if [ -z "$old" ]; then
  log "no api container running, starting one"
  up --no-deps api
  wait_ready "$(compose ps -q api)" || die "the api never got ready"
else
  log "starting the new api container next to $(container_name "$old")"
  up --no-deps --no-recreate --scale api=2 api
  new=$(compose ps -q api | grep -vx "$old" || true)
  [ -n "$new" ] || die "compose didn't start a second api container"
  if ! wait_ready "$new"; then
    log "removing $(container_name "$new"), the old one keeps serving"
    docker update --restart=no "$new" >/dev/null
    docker stop -t 30 "$new" >/dev/null || true
    docker rm -f "$new" >/dev/null
    die "deploy failed at the api rollover; nothing else was changed (the migrations stay, they're expand-only)"
  fi
  log "$(container_name "$new") is serving"
  # nginx re-resolves `api` every 5 s, and takes out for 10 s a container that refused a connection (the new one,
  # before it listened): wait until it sends the new one requests for sure, or stopping the old one leaves none
  sleep "$SETTLE"

  # no restart policy first, or docker brings the old container back the moment it exits
  log "draining $(container_name "$old") (up to ${STOP_TIMEOUT}s)"
  docker update --restart=no "$old" >/dev/null
  docker kill -s TERM "$old" >/dev/null
  deadline=$((SECONDS + STOP_TIMEOUT))
  while [ "$(docker inspect -f '{{.State.Running}}' "$old" 2>/dev/null)" = true ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      log "the old api didn't exit in ${STOP_TIMEOUT}s, killing it"
      docker kill "$old" >/dev/null || true
      break
    fi
    sleep 1
  done
  docker rm -f "$old" >/dev/null
  # back to one replica in compose's eyes; only the new container is left, so nothing else changes
  up --no-deps --no-recreate --scale api=1 api
  log "the api is $(container_name "$new")"
fi

# --- 4. workers and converters (SIGTERM, each finishes its job first) ------------------------------------------------
# true when a service's container is missing or runs another image or definition than the checkout's (what makes
# `compose up` recreate it)
outdated() {
  local service=$1 id
  id=$(compose ps -a -q "$service" | head -n 1)
  [ -n "$id" ] || return 0
  [ "$(docker inspect -f '{{.State.Running}}' "$id")" = true ] || return 0
  [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$id")" = \
    "$(compose config --hash "$service" | awk '{print $2}')" ] || return 0
  # the tag it was started from now names another image (a new build)
  [ "$(docker inspect -f '{{.Image}}' "$id")" != \
    "$(docker image inspect -f '{{.Id}}' "$(docker inspect -f '{{.Config.Image}}' "$id")" 2>/dev/null)" ]
}

log "recreating the Postgres-queue workers where they changed (each finishes its current job)"
# shellcheck disable=SC2086
up --no-deps $QUEUE_WORKERS

# office is recreated only while the converters are stopped, so no document is cut off mid-conversion
converters_outdated=
for service in office $CONVERTERS; do
  if outdated "$service"; then
    converters_outdated=1
  fi
done
if [ -n "$converters_outdated" ]; then
  log "stopping the converters (each waits for its running jobs: up to 31 min for premium)"
  # shellcheck disable=SC2086
  compose stop $CONVERTERS
  up --no-deps --wait office
  # shellcheck disable=SC2086
  up --no-deps $CONVERTERS
else
  log "the converters and office are up to date"
fi

# --- 5. monitoring, backups, nginx -----------------------------------------------------------------------------------
# shellcheck disable=SC2086
up --no-deps $SIDE_SERVICES
if [ -z "$previous" ] || ! git diff --quiet "$previous" -- monitoring/ 2>/dev/null; then
  log "monitoring/ changed, restarting prometheus and grafana"
  compose restart prometheus grafana
fi

up --no-deps nginx
compose exec -T nginx nginx -c /etc/nginx/filesgg/nginx.conf -t -q || die "nginx's configuration is invalid, nginx keeps the running one"
compose kill -s HUP nginx >/dev/null
log "nginx reloaded"

# --- 6. the website and the Cloudflare Worker ------------------------------------------------------------------------
if [ -n "$worker" ]; then
  log "building the website and deploying the Worker"
  endpoint=$(env_value S3_ENDPOINT)
  case $endpoint in *://*) ;; *) endpoint=https://$endpoint ;; esac
  token=$(env_value WORKER_DEPLOY_API_TOKEN)
  account=$(env_value CLOUDFLARE_ACCOUNT_ID)
  # empty: the production Worker (wrangler.toml's top level); `staging` for the staging run's .env
  worker_env=$(env_value WORKER_ENV)
  (
    cd cf-worker
    npm ci --no-audit --no-fund --silent
    # the production build refuses the legal pages' placeholders (milestone-5 §19.6; check-env refuses the override)
    VITE_TURNSTILE_SITE_KEY=$(env_value VITE_TURNSTILE_SITE_KEY) npm run build:web
    # the deploying user's `wrangler login` unless a token is configured; never the API's CLOUDFLARE_API_TOKEN
    unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
    if [ -n "$token" ]; then export CLOUDFLARE_API_TOKEN=$token; fi
    if [ -n "$account" ]; then export CLOUDFLARE_ACCOUNT_ID=$account; fi
    npx wrangler deploy ${worker_env:+--env "$worker_env"} \
      --var "S3_ENDPOINT:$endpoint" \
      --var "S3_REGION:$(env_value S3_REGION)" \
      --var "S3_BUCKET_FILES:$(env_value S3_BUCKET_FILES)"
  ) || die "the website or the Worker failed to deploy; the stack itself is on $(git rev-parse --short HEAD)"
else
  log "skipping the website and the Worker (--no-worker)"
fi

# --- done ------------------------------------------------------------------------------------------------------------
printf '%s %s\n' "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEPLOYED"
printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" "$(id -un)" >> "$HISTORY"

for service in $INFRA; do
  if outdated "$service"; then
    log "note: $service's definition changed; recreate it at a quiet moment with: docker compose up -d $service"
  fi
done

if [ -z "$smoke" ]; then
  log "skipping the smoke check (--no-smoke)"
elif [ ! -f ops/smoke.mjs ] || ! command -v node >/dev/null; then
  log "warning: ops/smoke.mjs or node is missing, no smoke check"
else
  base=$(env_value PUBLIC_URL)
  base=${base:-https://files.gg}
  log "smoke check: $base"
  node ops/smoke.mjs "$base" --quick || die "the smoke check failed; to roll back: ops/deploy.sh --ref ${previous:-<previous commit>}"
fi
log "deployed $(git rev-parse --short HEAD)"
