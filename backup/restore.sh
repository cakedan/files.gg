#!/usr/bin/env bash
# pulls a backup out of restic onto local disk. it never touches a running database, loading it back in is a separate
# step (backup/README.md)
#   restore postgres [snapshot]  -> /restore/<database>.dump and /restore/roles.sql (.restore/ on the host)
# snapshot defaults to the latest, `restic snapshots` lists them
set -euo pipefail

HOST=filesgg

target="${1:-}"
snapshot="${2:-latest}"

case "$target" in
	postgres)
		restic restore "$snapshot" --host "$HOST" --tag postgres --target /restore
		# roles barely change, the latest is used whichever snapshot the dump came from
		restic restore latest --host "$HOST" --tag postgres-roles --target /restore
		ls -lh /restore
		;;
	*)
		echo "usage: restore postgres [snapshot]" >&2
		exit 2
		;;
esac
