"""Job handlers and scheduled tasks registered by the worker.

Jobs: a no-op `ping` and `finalize_upload` (jobs/finalize.py). Scheduled: the
snowflake_nodes lease cleanup, the file_view_seen cleanup, and (Milestone 2) the
expiry reaper, the abandoned-upload reaper and the unlock_attempts cleanup. The
media jobs (`probe`, `derive`, `scan`, `delete_blob`) arrive with their features.
"""

import logging

from datetime import timedelta

import jobs.finalize  # noqa: F401  registers finalize_upload
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
UNLOCK_ATTEMPTS_CLEANUP_INTERVAL = 60 * 60
REAPER_BATCH = 1000
# uploader IP hashes are only needed for the rolling 24 h anonymous cap
UPLOADER_IP_KEEP_SECONDS = 2 * 24 * 3600


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

    @scheduler.register('unlock_attempts_cleanup', UNLOCK_ATTEMPTS_CLEANUP_INTERVAL)
    def unlock_attempts_cleanup():
        deleted = conn.execute("DELETE FROM unlock_attempts WHERE window_start < now() - interval '1 hour'").rowcount
        log.info('unlock_attempts cleanup removed %d row(s)', deleted)

    return scheduler


def _batched(conn, sql, params=()):
    total = 0
    while True:
        count = conn.execute(sql, params).rowcount
        total += count
        if count < REAPER_BATCH:
            return total


def reap_expired(conn):
    """Soft-delete expired files in batches (reads already treat them as gone),
    and clear uploader IP hashes older than 2 days."""
    deleted = _batched(
        conn,
        'UPDATE files SET deleted_at = now() WHERE id IN (SELECT id FROM files WHERE expires_at <= now() '
        'AND deleted_at IS NULL LIMIT {})'.format(REAPER_BATCH))
    scrubbed = _batched(
        conn,
        'UPDATE files SET uploader_ip_hash = NULL WHERE id IN (SELECT id FROM files WHERE uploader_ip_hash IS NOT NULL '
        'AND id < %s LIMIT {})'.format(REAPER_BATCH),
        (snowflake_since(UPLOADER_IP_KEEP_SECONDS),))
    return deleted, scrubbed


def reap_uploads(conn, client=None):
    """Sessions past their 24 h: abort the B2 multipart upload, delete any
    staging object, and delete the rows (parts cascade)."""
    rows = conn.execute(
        'SELECT id, status, storage_key, b2_upload_id FROM upload_sessions WHERE expires_at <= now() '
        'LIMIT {}'.format(REAPER_BATCH)).fetchall()
    if not rows:
        return 0
    client = client or jobs.finalize.s3()
    bucket = storage_module.S3Settings.from_env().bucket
    for upload_id, status, key, b2_upload_id in rows:
        if status == 'open' and b2_upload_id:
            try:
                client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=b2_upload_id)
            except Exception:
                log.warning('abort of multipart upload %s failed (already gone?)', upload_id)
        if status != 'complete':
            try:
                client.delete_object(Bucket=bucket, Key=key)
            except Exception:
                pass
        conn.execute('DELETE FROM upload_sessions WHERE id = %s', (upload_id,))
    return len(rows)


def cleanup_view_seen(conn, today=None):
    """Delete unique-view hashes older than VIEW_SEEN_KEEP_DAYS (UTC days)."""
    cutoff = (today or utc_today()) - timedelta(days=VIEW_SEEN_KEEP_DAYS)
    return conn.execute('DELETE FROM file_view_seen WHERE day < %s', (cutoff,)).rowcount
