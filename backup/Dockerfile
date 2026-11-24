# encrypted backups of files.gg's postgres into a restic repository on backblaze (backup.sh). same setup as
# notsobot.api's backup/, trimmed to the one database. the postgres image is the base so pg_dump is the exact
# version the server runs (keep it in step with the postgres service in docker-compose.yml)
FROM postgres:19.0@sha256:aaa10f7ba7328b4a221a6c3184d83eef885bd16bf1f6de864757863156b0a4d1
# 2026.11.24

# bumping the version means updating its checksums too (restic's SHA256SUMS)
ARG RESTIC_VERSION=0.20.0
RUN export DEBIAN_FRONTEND=noninteractive && \
	apt-get update && \
	apt-get install -y --no-install-recommends bzip2 ca-certificates curl && \
	rm -rf /var/lib/apt/lists/* && \
	ARCH="$(dpkg --print-architecture)" && \
	case "$ARCH" in \
		amd64) RESTIC_SHA256=0ccd9fa7885074a24603b051e01bf9bd8b5e45d6a1791e9d9887e9e9372107f7 ;; \
		arm64) RESTIC_SHA256=1188daded239bccb5952a01d2ad33e77a0d3dc34f9d9fc1e7fdda618d44938ef ;; \
		*) echo "unsupported architecture: $ARCH" && exit 1 ;; \
	esac && \
	curl -fsSL -o /tmp/restic.bz2 \
		"https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${ARCH}.bz2" && \
	echo "${RESTIC_SHA256}  /tmp/restic.bz2" | sha256sum -c - && \
	bunzip2 -c /tmp/restic.bz2 > /usr/local/bin/restic && \
	chmod 755 /usr/local/bin/restic && \
	rm -f /tmp/restic.bz2 && \
	restic version

COPY backup.sh /usr/local/bin/backup
COPY restore.sh /usr/local/bin/restore
RUN chmod 755 /usr/local/bin/backup /usr/local/bin/restore

# stays up so scheduler-ofelia can exec the jobs into it (docker-compose.yml)
ENTRYPOINT []
CMD ["sleep", "infinity"]
