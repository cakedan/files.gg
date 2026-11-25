#!/usr/bin/env bash
# Backup restore drill (docs/redesign/contracts/milestone-7.md §5.3): restores the newest restic snapshot of the
# database (backup/, `backup-db`) into a throwaway Postgres container, then checks
# - the snapshot is recent (the daily backup ran);
# - pg_restore loads it without an error;
# - the migration history in it matches api/migrations (versions, names and checksums);
# - the row counts of the main tables, next to the live database's when it runs here;
# and reports. Nothing touches the live database or the repository's snapshots. Run it before launch and monthly.
#
#   ops/restore-drill.sh [--env-file .env] [--snapshot latest] [--compose-project filesgg] [--max-age-hours 26]
#
# The repository and its keys come from the same names backup-db uses (docker-compose.yml, backup/README.md):
# S3_ENDPOINT, S3_BUCKET_DB_BACKUP, S3_BACKUP_ACCESS_KEY_ID, S3_BACKUP_SECRET_ACCESS_KEY and DB_BACKUP_RESTIC_PASSWORD,
# from the environment or the env file. RESTIC_REPOSITORY in the environment overrides the location; a local path
# (a repository on disk, for trying the drill without B2) is mounted into the container.
#
# It runs the backup image (`filesgg-backup-db`, which `docker compose build backup-db` makes from backup/Dockerfile;
# built here only when it's missing): its `restore` script fetches the snapshot,
# and the same image (Postgres 19, the server's version) is the throwaway database. The unencrypted dump lives in a
# temporary directory that is deleted at the end, with the container. Needs Docker; exit 0 when the drill passed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
SNAPSHOT=latest
PROJECT=filesgg
MAX_AGE_HOURS=26
IMAGE=filesgg-backup-db
# backup.sh's fixed restic host
HOST=filesgg
# the tables whose counts are reported; a missing one fails the drill
MAIN_TABLES=(users sessions staff upload_keys user_entitlements custom_domains files file_hashes albums album_files
	conversions moderation_cases moderation_actions reports user_warnings blocked_hashes mimetypes jobs schema_migrations)
# filled by the migrations themselves, so never empty in a good backup
SEEDED_TABLES=(mimetypes schema_migrations)

usage() {
	echo "usage: ops/restore-drill.sh [--env-file <file>] [--snapshot <id|latest>] [--compose-project <name>] [--max-age-hours <n>]" >&2
	exit 2
}
while (($#)); do
	case "$1" in
		--env-file) ENV_FILE="${2:?}"; shift 2 ;;
		--snapshot) SNAPSHOT="${2:?}"; shift 2 ;;
		--compose-project) PROJECT="${2:?}"; shift 2 ;;
		--max-age-hours) MAX_AGE_HOURS="${2:?}"; shift 2 ;;
		-h|--help) usage ;;
		*) usage ;;
	esac
done
[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || usage

FAILURES=()
fail() {
	FAILURES+=("$1")
	echo "  FAIL  $1"
}
ok() {
	echo "  ok    $1"
}

# A variable from the environment, else from the env file (read, never sourced: values may hold shell characters).
env_value() {
	local name="$1" line
	if [ -n "${!name:-}" ]; then
		printf '%s' "${!name}"
	elif [ -f "$ENV_FILE" ] && line="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1)"; then
		line="${line#*=}"
		line="${line%\"}"; line="${line#\"}"
		line="${line%\'}"; line="${line#\'}"
		printf '%s' "$line"
	fi
}

RESTIC_PASSWORD="$(env_value DB_BACKUP_RESTIC_PASSWORD)"
[ -n "$RESTIC_PASSWORD" ] || { echo "DB_BACKUP_RESTIC_PASSWORD isn't set (environment or $ENV_FILE)" >&2; exit 2; }
DOCKER_ARGS=(-e RESTIC_PASSWORD -e RESTIC_REPOSITORY)
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
	REPOSITORY="$RESTIC_REPOSITORY"
else
	endpoint="$(env_value S3_ENDPOINT)"
	[ -n "$endpoint" ] || { echo "S3_ENDPOINT isn't set (environment or $ENV_FILE), and neither is RESTIC_REPOSITORY" >&2; exit 2; }
	bucket="$(env_value S3_BUCKET_DB_BACKUP)"
	REPOSITORY="s3:${endpoint}/${bucket:-filesgg-db-backups}/restic"
fi
if [[ "$REPOSITORY" == /* ]]; then
	[ -d "$REPOSITORY" ] || { echo "no repository directory at $REPOSITORY" >&2; exit 2; }
	DOCKER_ARGS+=(-v "$REPOSITORY:/repo")
	RESTIC_REPOSITORY=/repo
else
	RESTIC_REPOSITORY="$REPOSITORY"
	AWS_ACCESS_KEY_ID="$(env_value S3_BACKUP_ACCESS_KEY_ID)"
	AWS_SECRET_ACCESS_KEY="$(env_value S3_BACKUP_SECRET_ACCESS_KEY)"
	export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
	DOCKER_ARGS+=(-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY)
fi
export RESTIC_PASSWORD RESTIC_REPOSITORY

WORK="$(mktemp -d "${TMPDIR:-/tmp}/filesgg-restore-drill.XXXXXX")"
NAME="filesgg-restore-drill-$(basename "$WORK" | cut -d. -f2 | tr '[:upper:]' '[:lower:]')"
cleanup() {
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	# the dump is unencrypted
	rm -rf "$WORK"
}
trap cleanup EXIT

echo "files.gg restore drill: $REPOSITORY, snapshot $SNAPSHOT"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" "$ROOT/backup" >/dev/null

# 1. the snapshot: which one, how old, and the dump on disk (backup/restore.sh)
started=$(date +%s)
info="$(docker run --rm "${DOCKER_ARGS[@]}" -e SNAPSHOT="$SNAPSHOT" -e HOST="$HOST" -v "$WORK:/restore" "$IMAGE" bash -c '
	set -euo pipefail
	json="$(restic snapshots "$SNAPSHOT" --host "$HOST" --tag postgres --json)"
	time="$(grep -o "\"time\":\"[^\"]*\"" <<<"$json" | tail -n 1 | cut -d\" -f4)"
	id="$(grep -o "\"short_id\":\"[^\"]*\"" <<<"$json" | tail -n 1 | cut -d\" -f4)"
	[ -n "$id" ] || { echo "no postgres snapshot matches $SNAPSHOT" >&2; exit 1; }
	restore postgres "$id" >&2
	echo "$id $time $(( $(date +%s) - $(date -d "$time" +%s) ))"
')" || { echo "restoring the snapshot failed" >&2; exit 1; }
read -r SNAPSHOT_ID SNAPSHOT_TIME AGE <<<"$info"
DUMP="$(cd "$WORK" && ls -- *.dump | head -n 1)"
echo "snapshot $SNAPSHOT_ID from $SNAPSHOT_TIME ($((AGE / 3600)) h $((AGE % 3600 / 60)) min old), $DUMP: $(du -h "$WORK/$DUMP" | cut -f1)"
echo
if ((AGE <= MAX_AGE_HOURS * 3600)); then
	ok "the snapshot is under $MAX_AGE_HOURS hours old"
else
	fail "the snapshot is $((AGE / 3600)) hours old (over $MAX_AGE_HOURS): the daily backup isn't running"
fi

# 2. a throwaway Postgres, no network, with the restore directory read-only
docker run -d --name "$NAME" --network none -e POSTGRES_USER=filesgg -e POSTGRES_DB=filesgg \
	-e POSTGRES_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
	-v "$WORK:/restore:ro" --entrypoint docker-entrypoint.sh "$IMAGE" postgres >/dev/null
# over TCP: the entrypoint's first, socket-only server doesn't count
for _ in $(seq 1 120); do
	docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U filesgg -d filesgg && break
	sleep 0.5
done
docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U filesgg -d filesgg || { echo "the throwaway Postgres didn't start" >&2; exit 1; }
restored_sql() {
	docker exec -i "$NAME" psql -h 127.0.0.1 -U filesgg -d filesgg -v ON_ERROR_STOP=1 -tA -F ' ' -c "$1"
}

# roles first (the main role exists already, so its CREATE ROLE fails harmlessly, as backup/README.md says)
if [ -f "$WORK/roles.sql" ]; then
	docker exec "$NAME" psql -h 127.0.0.1 -U filesgg -d filesgg -q -f /restore/roles.sql >/dev/null 2>&1 || true
fi
if docker exec "$NAME" pg_restore -h 127.0.0.1 -U filesgg -d filesgg --exit-on-error -j 4 "/restore/$DUMP" 2>"$WORK/pg_restore.log"; then
	ok "pg_restore loaded the dump without an error ($(($(date +%s) - started)) s from the repository)"
else
	fail "pg_restore failed: $(head -c 400 "$WORK/pg_restore.log")"
fi

# 3. the migration history against api/migrations
sha256() {
	if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
expected=""
for file in "$ROOT"/api/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
	base="$(basename "$file" .sql)"
	expected+="${base:0:4} ${base:5} $(sha256 "$file")"$'\n'
done
recorded="$(restored_sql 'SELECT version, name, checksum FROM schema_migrations ORDER BY version' 2>/dev/null || true)"
pending=()
problems=()
while read -r version name checksum; do
	[ -n "$version" ] || continue
	line="$(grep -E "^$version " <<<"$recorded" || true)"
	if [ -z "$line" ]; then
		pending+=("${version}_$name")
	elif [ "$line" != "$version $name $checksum" ]; then
		problems+=("$version: the backup has '$line', api/migrations has '${version}_$name' (sha256 $checksum)")
	fi
done <<<"$expected"
while read -r version name _; do
	[ -n "$version" ] || continue
	grep -qE "^$version " <<<"$expected" || problems+=("${version}_$name is in the backup but not in api/migrations")
done <<<"$recorded"
if [ -z "$recorded" ]; then
	fail "the backup has no schema_migrations rows"
elif ((${#problems[@]})); then
	fail "the migration history doesn't match api/migrations: ${problems[*]}"
else
	ok "the migration history matches api/migrations ($(wc -l <<<"$recorded" | tr -d ' ') applied, names and checksums)"
fi
if ((${#pending[@]})); then
	echo "        newer than the backup (applied by a later deploy): ${pending[*]}"
fi

# 4. row counts, next to the live database's when this project's postgres runs here
LIVE="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=postgres | head -n 1)"
live_count() {
	[ -n "$LIVE" ] || { echo "-"; return; }
	docker exec "$LIVE" psql -U filesgg -d filesgg -tA -c "SELECT count(*) FROM $1" 2>/dev/null || echo "-"
}
echo
printf '  %-20s %12s %12s\n' table restored "live (now)"
missing=()
empty=()
for table in "${MAIN_TABLES[@]}"; do
	if ! count="$(restored_sql "SELECT count(*) FROM $table" 2>/dev/null)"; then
		missing+=("$table")
		count=missing
	fi
	live="$(live_count "$table")"
	printf '  %-20s %12s %12s\n' "$table" "$count" "$live"
	if [ "$count" = 0 ] && { [[ " ${SEEDED_TABLES[*]} " == *" $table "* ]] || { [ "$live" != "-" ] && [ "$live" != 0 ]; }; }; then
		empty+=("$table")
	fi
done
echo
if [ -z "$LIVE" ]; then
	echo "        (no running postgres in the compose project $PROJECT: live counts not compared)"
fi
((${#missing[@]})) && fail "tables missing from the backup: ${missing[*]}" || ok "every main table is in the backup"
((${#empty[@]})) && fail "empty in the backup but not live (or seeded): ${empty[*]}" || ok "no main table is empty that shouldn't be"

echo
if ((${#FAILURES[@]})); then
	echo "RESTORE DRILL FAILED (${#FAILURES[@]}): snapshot $SNAPSHOT_ID"
	exit 1
fi
echo "RESTORE DRILL PASSED: snapshot $SNAPSHOT_ID from $SNAPSHOT_TIME restores, with a matching migration history"
