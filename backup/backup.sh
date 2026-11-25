#!/usr/bin/env bash
# encrypted, deduplicated backups of files.gg's postgres into a restic repository (RESTIC_REPOSITORY, on backblaze).
# restic encrypts everything before it leaves the server, so the bucket only ever holds ciphertext. same design as
# notsobot.api's backup/backup.sh. scheduler-ofelia runs `backup all` daily and `backup check` weekly (backup-db's
# labels in docker-compose.yml), or by hand:
#   docker compose exec backup-db backup [all|postgres|check]
# restoring is restore.sh, see backup/README.md
set -uo pipefail

# fixed so retention and restic's parent snapshot lookups don't depend on the container's hostname
HOST=filesgg
TARGETS=(postgres)
# how many daily/weekly/monthly/yearly snapshots restic forget keeps (DB_BACKUP_KEEP_* in .env), a number or `unlimited`
KEEP=(
	--keep-daily "${DB_BACKUP_KEEP_DAILY:-14}"
	--keep-weekly "${DB_BACKUP_KEEP_WEEKLY:-52}"
	--keep-monthly "${DB_BACKUP_KEEP_MONTHLY:-0}"
	--keep-yearly "${DB_BACKUP_KEEP_YEARLY:-0}"
)

log() {
	echo "[$(date -u +%FT%TZ)] $*"
}

# optional healthchecks.io style monitor: DB_BACKUP_HEALTHCHECK_URL, /start, /fail
ping() {
	[ -n "${DB_BACKUP_HEALTHCHECK_URL:-}" ] || return 0
	curl -fsS -m 10 --retry 3 -o /dev/null "${DB_BACKUP_HEALTHCHECK_URL}$1" || log "healthcheck ping failed"
}

backup_postgres() {
	local connection=(-h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER")
	# streamed straight into restic, nothing is written to disk. -Z0 because restic compresses (zstd) and dedupes
	# against the previous days, which an already compressed dump would defeat. --stdin-from-command fails the
	# snapshot if pg_dump fails, instead of saving a truncated dump
	PGPASSWORD="$PG_PASSWORD" restic backup --host "$HOST" --tag postgres --stdin-filename "$PG_DATABASE.dump" \
		--stdin-from-command -- pg_dump "${connection[@]}" -d "$PG_DATABASE" -Fc -Z0 &&
	PGPASSWORD="$PG_PASSWORD" restic backup --host "$HOST" --tag postgres-roles --stdin-filename roles.sql \
		--stdin-from-command -- pg_dumpall "${connection[@]}" -l "$PG_DATABASE" --roles-only
}

# opens the repository once up front, so a problem is one clear error instead of every restic call after it failing.
# `check_repository create` (backups) creates it when the location is empty, i.e. the first run on a new bucket. check
# and restore never create one, for them an empty location means the bucket or credentials are wrong
check_repository() {
	local create="${1:-}" output status
	output="$(restic cat config 2>&1 >/dev/null)" && return 0
	status=$?
	case $status in
		10)
			if [ "$create" = create ]; then
				log "no restic repository at $RESTIC_REPOSITORY yet, creating it"
				restic init && return 0
			else
				log "no restic repository at $RESTIC_REPOSITORY"
			fi
			;;
		12) log "DB_BACKUP_RESTIC_PASSWORD doesn't match the repository at $RESTIC_REPOSITORY" ;;
		*) log "can't open the repository at $RESTIC_REPOSITORY: $output" ;;
	esac
	return 1
}

run_backups() {
	local target failed=()
	ping /start
	check_repository create || { ping /fail; return 1; }
	# only clears locks left by a run that was killed, a live run's lock stays
	restic unlock
	for target in "$@"; do
		log "backing up $target"
		if "backup_${target//-/_}"; then
			log "$target done"
		else
			log "$target FAILED"
			failed+=("$target")
		fi
	done
	# keep-daily counts days that have a snapshot, so a failed run doesn't push an older good one out
	log "applying retention"
	restic forget --host "$HOST" --group-by host,tags "${KEEP[@]}" --prune || failed+=(retention)
	if ((${#failed[@]})); then
		log "failed: ${failed[*]}"
		ping /fail
		return 1
	fi
	log "all done"
	ping ""
}

case "${1:-all}" in
	all)
		run_backups "${TARGETS[@]}"
		;;
	postgres)
		run_backups "$1"
		;;
	check)
		# rereads a random 5% of the stored data each week, so corruption shows up without downloading everything
		check_repository || { ping /fail; exit 1; }
		restic check --read-data-subset="${2:-5%}" || { ping /fail; exit 1; }
		;;
	*)
		echo "usage: backup [all|postgres|check [subset]]" >&2
		exit 2
		;;
esac
