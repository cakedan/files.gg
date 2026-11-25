# backup-db

Daily encrypted backups of files.gg's `postgres` into a [restic](https://restic.net) repository at
`s3:${S3_ENDPOINT}/${S3_BUCKET_DB_BACKUP}/restic` (Backblaze B2, US). This is the same setup as NotSoBot's
`notsobot.api/backup/`, trimmed to one database.

- **Encrypted before upload.** restic encrypts everything with `DB_BACKUP_RESTIC_PASSWORD` (AES-256), so the bucket
  only holds ciphertext. Without the password nobody can read the backups, including you, so keep a copy off the
  server.
- **Incremental.** restic dedupes against what's already uploaded. The dump is uncompressed (`-Z0`), so tables that
  didn't change dedupe.
- **Schedule** (`scheduler-ofelia`, from `backup-db`'s labels in `docker-compose.yml`): `backup all` at 02:00 every
  day, and `backup check` (rereads 5% of the stored data) at 05:00 every Sunday.
- **Retention:** by default the last 14 days, plus one snapshot per week for a year (52), applied after every run.
  The Privacy Policy states this period; change both together. To change
  it, set `DB_BACKUP_KEEP_DAILY`, `_WEEKLY`, `_MONTHLY` and `_YEARLY` in `.env` to a number, or to `unlimited` to keep
  that period forever (0 keeps none).
- **Monitoring:** set `DB_BACKUP_HEALTHCHECK_URL` to a [healthchecks.io](https://healthchecks.io)-style check to be
  alerted when a run fails or doesn't happen. Logs are in `docker compose logs scheduler-ofelia`.
- **Bucket separation:** use a separate bucket (`S3_BUCKET_DB_BACKUP`) and a separate application key from the one the
  API uses for files. The API never needs to read or delete backups.

Each run makes these snapshots, all with the host `filesgg`:

| tag | contents |
|---|---|
| `postgres` | `<database>.dump`, `pg_dump -Fc` |
| `postgres-roles` | `roles.sql`, `pg_dumpall --roles-only` |

## Setup

1. Set `S3_ENDPOINT`, `S3_BUCKET_DB_BACKUP`, `S3_BACKUP_ACCESS_KEY_ID`, `S3_BACKUP_SECRET_ACCESS_KEY` and
   `DB_BACKUP_RESTIC_PASSWORD` in `.env`. Generate the password with `openssl rand -hex 32` and save it in a password
   manager.
2. In Backblaze, set the bucket's lifecycle to **Keep only the last version**. B2 keeps every deleted file as a hidden
   old version by default, so restic's pruning would never free any space.
3. Start it:
   ```bash
   docker compose up -d --build backup-db scheduler-ofelia
   ```
4. Run the first backup by hand. It creates the repository (logged as `no restic repository ... yet, creating it`) and
   uploads everything, so it takes the longest:
   ```bash
   docker compose exec backup-db backup all
   ```

## Commands

Everything runs inside the container, as `docker compose exec backup-db <command>`:

| command | what it does |
|---|---|
| `backup all` / `backup postgres` | back up, then apply retention |
| `backup check [subset]` | verify the repository, rereading `subset` of the data (default `5%`, `100%` for all) |
| `restic snapshots` | list snapshots |
| `restic stats --mode raw-data` | how much the repository stores after dedupe and compression |
| `restore postgres [snapshot]` | pull a backup onto local disk (see below). `snapshot` defaults to the latest |

## Restoring

`restore` only fetches a backup onto local disk. Loading it into a database is a separate step, so nothing is
overwritten until you run that.

```bash
docker compose exec backup-db restore postgres
```

This writes `<database>.dump` and `roles.sql` to `.restore/`. Stop everything that writes to the database (`api`,
`worker`), then load it, replacing what's there:

```bash
docker compose exec backup-db sh -c 'PGPASSWORD="$PG_PASSWORD" pg_restore -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" --clean --if-exists -j 4 "/restore/$PG_DATABASE.dump"'
```

On a fresh server, load the roles first:

```bash
docker compose exec backup-db sh -c 'PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -f /restore/roles.sql'
```

The main user already exists there, so its `CREATE ROLE` fails harmlessly. Delete `.restore/` afterwards: it holds
the unencrypted dump.

**Stored files aren't in this backup.** Files live in the B2 files bucket, and the database only points at them. A
restore brings back the database as of the snapshot, up to 24 hours old. Blob garbage collection must therefore wait
longer than that before deleting a blob nothing references (`BLOB_GC_GRACE`, at least 48 hours; see
`docs/redesign/PLAN.md`), so a restored database never points at blobs that were already deleted.

### On a new server

Copy over `.env` (the `S3_*`, `DB_BACKUP_RESTIC_PASSWORD` and `POSTGRES_PASSWORD` values), start `postgres` and
`backup-db`, then follow the steps above. Restoring never creates a repository, so if it says there isn't one, `.env`
points at the wrong bucket.
