"""Job handlers and scheduled tasks registered by the worker.

Jobs: a no-op `ping`, `finalize_upload` (jobs/finalize.py), and (Milestone 3) `probe`,
`derive` and `album_collage` on the `media` queue (jobs/media.py) and `delete_blob`
(jobs/gc.py). Scheduled: the snowflake_nodes lease cleanup, the file_view_seen cleanup,
(Milestone 2) the expiry reaper and the abandoned-upload reaper, (Milestone 3) the album reaper,
and (Milestone 4) `scan`, `rescan`, `pdq_sweep`, `album_text_scan` and `delete_objects` (safety/scan.py)
with their scheduled tasks (safety/tasks.py), (Milestone 6) `domain_delete` and `account_export` with the
account tasks (jobs/accounts.py), and (Milestone 5) `moderation_cascade` (safety/cascade.py) with `convert_sweep`
(every minute: conversions and document previews on RQ, decision 17) and `conversion_cleanup` (hourly).
"""

import logging

from datetime import timedelta

import jobs.finalize  # noqa: F401  registers finalize_upload
import jobs.gc  # noqa: F401  registers delete_blob
import jobs.media  # noqa: F401  registers probe, derive, album_collage
import safety.scan  # noqa: F401  registers scan, rescan, pdq_sweep, album_text_scan, delete_objects
import jobs.accounts as account_jobs  # registers domain_delete, account_export (Milestone 6)
import safety.cascade  # noqa: F401  registers moderation_cascade (Milestone 5)
from safety import tasks as safety_tasks
from jobs.queue import register
from utils import snowflake_nodes, storage as storage_module
from utils.uploading import snowflake_since
from utils.view_hash import utc_today

log = logging.getLogger(__name__)

SNOWFLAKE_CLEANUP_INTERVAL = 15 * 60
VIEW_SEEN_CLEANUP_INTERVAL = 60 * 60
VIEW_SEEN_KEEP_DAYS = 2
EXPIRY_REAPER_INTERVAL = 10 * 60
UPLOAD_REAPER_INTERVAL = 10 * 60
ALBUM_REAPER_INTERVAL = 10 * 60
# albums with no live items are soft-deleted after this long (contract §6 "Reaper")
EMPTY_ALBUM_DAYS = 7
REAPER_BATCH = 1000
# uploader IP hashes are only needed for the rolling 24 h anonymous cap
UPLOADER_IP_KEEP_SECONDS = 2 * 24 * 3600
JOBS_PURGE_INTERVAL = 60 * 60
# milestone-5 §3.3: the sweeper runs every minute; usage rows and expired upload IP hashes go hourly (§2.5)
CONVERT_SWEEP_INTERVAL = 60
CONVERSION_CLEANUP_INTERVAL = 60 * 60
# done jobs are kept this long (failed ones stay for inspection)
DONE_JOBS_KEEP_DAYS = 7


@register('ping')
def ping(payload, job):
    log.info('ping %r', payload)


def register_scheduled(scheduler):
    conn = scheduler.conn

    @scheduler.register('snowflake_nodes_cleanup', SNOWFLAKE_CLEANUP_INTERVAL)
    def snowflake_nodes_cleanup():
        deleted = snowflake_nodes.cleanup_expired(conn)
        log.info('snowflake_nodes cleanup removed %d expired lease(s)', deleted)

    @scheduler.register('file_view_seen_cleanup', VIEW_SEEN_CLEANUP_INTERVAL)
    def file_view_seen_cleanup():
        deleted = cleanup_view_seen(conn)
        log.info('file_view_seen cleanup removed %d row(s)', deleted)

    @scheduler.register('expiry_reaper', EXPIRY_REAPER_INTERVAL)
    def expiry_reaper():
        deleted, scrubbed = reap_expired(conn)
        log.info('expiry reaper soft-deleted %d file(s), cleared %d uploader IP hash(es)', deleted, scrubbed)

    @scheduler.register('upload_reaper', UPLOAD_REAPER_INTERVAL)
    def upload_reaper():
        log.info('upload reaper removed %d expired upload session(s)', reap_uploads(conn))

    @scheduler.register('jobs_purge', JOBS_PURGE_INTERVAL)
    def jobs_purge():
        log.info('jobs purge removed %d done job(s)', purge_done_jobs(conn))

    @scheduler.register('album_reaper', ALBUM_REAPER_INTERVAL)
    def album_reaper():
        expired, emptied = reap_albums(conn)
        log.info('album reaper soft-deleted %d expired and %d empty album(s)', expired, emptied)

    @scheduler.register('convert_sweep', CONVERT_SWEEP_INTERVAL)
    def convert_sweep():
        from utils import conversions
        log.info('convert sweep: %r', conversions.sweep(conn))

    @scheduler.register('conversion_cleanup', CONVERSION_CLEANUP_INTERVAL)
    def conversion_cleanup():
        from utils import conversions
        usage, scrubbed = conversions.cleanup(conn)
        log.info('conversion cleanup removed %d usage row(s), cleared %d upload IP hash list(s)', usage, scrubbed)

    safety_tasks.register(scheduler)
    account_jobs.register_scheduled(scheduler)
    return scheduler


def _batched(conn, sql, params=()):
    total = 0
    while True:
        count = conn.execute(sql, params).rowcount
        total += count
        if count < REAPER_BATCH:
            return total


def reap_expired(conn):
    """Soft-delete expired files in batches (reads already treat them as gone), as a
    delete does: they leave their albums, and blobs left without a live file get their
    `delete_blob` (jobs/gc.py). Also clear uploader IP hashes older than 2 days."""
    deleted = 0
    while True:
        with conn.transaction():
            rows = conn.execute(
                'UPDATE files SET deleted_at = now() WHERE id IN (SELECT id FROM files WHERE expires_at <= now() '
                'AND deleted_at IS NULL LIMIT {} FOR UPDATE SKIP LOCKED) RETURNING id, hash_id'.format(
                    REAPER_BATCH)).fetchall()
            jobs.gc.after_delete(conn, [r[0] for r in rows], [r[1] for r in rows])
        deleted += len(rows)
        if len(rows) < REAPER_BATCH:
            break
    scrubbed = _batched(
        conn,
        'UPDATE files SET uploader_ip_hash = NULL WHERE id IN (SELECT id FROM files WHERE uploader_ip_hash IS NOT NULL '
        'AND id < %s LIMIT {})'.format(REAPER_BATCH),
        (snowflake_since(UPLOADER_IP_KEEP_SECONDS),))
    return deleted, scrubbed


def reap_albums(conn):
    """Expired albums (anonymous ones expire with their last file) are soft-deleted at
    once; albums with no live items are marked `empty_since` and soft-deleted 7 days later."""
    expired = _batched(
        conn,
        'UPDATE albums SET deleted_at = now() WHERE id IN (SELECT id FROM albums WHERE expires_at <= now() '
        'AND deleted_at IS NULL LIMIT {})'.format(REAPER_BATCH))
    live_item = ('EXISTS (SELECT 1 FROM album_files af JOIN files f ON f.id = af.file_id WHERE af.album_id = a.id '
                 'AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > now()))')
    conn.execute('UPDATE albums a SET empty_since = NULL WHERE empty_since IS NOT NULL AND deleted_at IS NULL '
                 'AND ' + live_item)
    conn.execute('UPDATE albums a SET empty_since = now() WHERE empty_since IS NULL AND deleted_at IS NULL '
                 'AND NOT ' + live_item)
    emptied = conn.execute(
        "UPDATE albums SET deleted_at = now() WHERE deleted_at IS NULL AND empty_since <= now() - "
        "make_interval(days => %s)", (EMPTY_ALBUM_DAYS,)).rowcount
    return expired, emptied


def reap_uploads(conn, client=None):
    """Sessions past their 24 h: abort the B2 multipart upload, delete any staging object, and
    delete the rows (parts cascade). Failed sessions don't wait for that: their multipart upload
    (and staging object) is removed on the next run. A refused abort keeps the row, failed, for
    the next run (an hour later for an expired one, so it can't hold up the batch)."""
    client = client or jobs.finalize.s3()
    bucket = storage_module.S3Settings.from_env().bucket
    rows = conn.execute(
        'SELECT id, status, storage_key, b2_upload_id FROM upload_sessions WHERE expires_at <= now() '
        'ORDER BY expires_at LIMIT {}'.format(REAPER_BATCH)).fetchall()
    removed = 0
    for upload_id, status, key, b2_upload_id in rows:
        if status in ('open', 'failed') and b2_upload_id and \
                not storage_module.abort_multipart_sync(client, bucket, key, b2_upload_id):
            conn.execute("UPDATE upload_sessions SET status = 'failed', error = COALESCE(error, 'EXPIRED'), "
                         "expires_at = now() + interval '1 hour' WHERE id = %s", (upload_id,))
            continue
        if status != 'complete':
            try:
                client.delete_object(Bucket=bucket, Key=key)
            except Exception:
                pass
        conn.execute('DELETE FROM upload_sessions WHERE id = %s', (upload_id,))
        removed += 1
    failed = conn.execute(
        "SELECT id, storage_key, b2_upload_id FROM upload_sessions WHERE status = 'failed' "
        'AND b2_upload_id IS NOT NULL AND expires_at > now() LIMIT {}'.format(REAPER_BATCH)).fetchall()
    for upload_id, key, b2_upload_id in failed:
        if not storage_module.abort_multipart_sync(client, bucket, key, b2_upload_id):
            continue
        try:
            client.delete_object(Bucket=bucket, Key=key)
        except Exception:
            continue
        conn.execute("UPDATE upload_sessions SET b2_upload_id = NULL WHERE id = %s AND status = 'failed'",
                     (upload_id,))
    return removed


def purge_done_jobs(conn, keep_days=DONE_JOBS_KEEP_DAYS):
    """Delete jobs done more than `keep_days` ago, in batches. Scheduler markers (queue
    'scheduler', whose done_at is the last run) always stay."""
    return _batched(
        conn,
        "DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE done_at < now() - make_interval(days => %s) "
        "AND queue <> 'scheduler' LIMIT {})".format(REAPER_BATCH), (keep_days,))


def cleanup_view_seen(conn, today=None):
    """Delete unique-view hashes older than VIEW_SEEN_KEEP_DAYS (UTC days)."""
    cutoff = (today or utc_today()) - timedelta(days=VIEW_SEEN_KEEP_DAYS)
    return conn.execute('DELETE FROM file_view_seen WHERE day < %s', (cutoff,)).rowcount
