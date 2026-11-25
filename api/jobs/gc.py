"""Deleting files and garbage-collecting blobs (PLAN.md "Delete and blob garbage
collection", contract milestone-3 §1 and §6).

1. A delete is a soft delete (`deleted_at`). In the same transaction the file leaves every
   album (its `album_files` rows go, and it stops being a cover), and when it was the
   hash's last live file, `delete_blob` is queued to run after BLOB_GC_GRACE (48 h by
   default: a database restored from yesterday's backup never points at deleted blobs).
2. `delete_blob` checks again that no live file uses the hash, then deletes the blob, every
   derived object (`file_hash_assets`), and finally the rows: the soft-deleted files and
   the hash (its asset rows cascade). Objects go first, inside the transaction, so a failed
   delete leaves the rows for the retry.

The SQL here is shared by the API (async) and the worker (sync).
"""

import json
import logging
import os

import db
from jobs.queue import register
from utils import storage as storage_module

log = logging.getLogger(__name__)

DEFAULT_GRACE = 48 * 3600


def grace_seconds():
    return int(os.getenv('BLOB_GC_GRACE', DEFAULT_GRACE))


# --- step 1: what a delete does besides setting deleted_at (in the deleting transaction) ------------

# albums losing items: a cover that was one of them goes back to automatic
CLEAR_COVERS_SQL = 'UPDATE albums SET cover_file_id = NULL WHERE cover_file_id = ANY(%s)'
LEAVE_ALBUMS_SQL = 'DELETE FROM album_files WHERE file_id = ANY(%s) RETURNING album_id'
# hashes among these with no live file left
ORPHANED_SQL = ('SELECT h FROM unnest(%s::bigint[]) AS h WHERE NOT EXISTS '
                '(SELECT 1 FROM files WHERE hash_id = h AND deleted_at IS NULL)')
ENQUEUE_DELETE_SQL = (
    "INSERT INTO jobs (kind, payload, run_at, max_attempts, queue) "
    "SELECT 'delete_blob', %s::jsonb, now() + make_interval(secs => %s::float8), 5, 'default' "
    "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'delete_blob' AND payload->>'hash_id' = %s "
    "AND done_at IS NULL AND failed_at IS NULL)")


def _delete_params(hash_id):
    return (json.dumps({'hash_id': str(hash_id)}), grace_seconds(), str(hash_id))


def after_delete(conn, file_ids, hash_ids):
    """Sync (worker): run in the transaction that soft-deleted `file_ids`. Returns the
    albums that lost items."""
    from jobs.media import queue_collage
    file_ids, hash_ids = list(file_ids), list(set(hash_ids))
    if not file_ids:
        return set()
    conn.execute(CLEAR_COVERS_SQL, (file_ids,))
    albums = {r[0] for r in conn.execute(LEAVE_ALBUMS_SQL, (file_ids,)).fetchall()}
    for album_id in albums:
        queue_collage(conn, album_id)
    for (hash_id,) in conn.execute(ORPHANED_SQL, (hash_ids,)).fetchall():
        conn.execute(ENQUEUE_DELETE_SQL, _delete_params(hash_id))
    return albums


async def after_delete_async(conn, file_ids, hash_ids):
    """`after_delete` for the API's async connections."""
    from jobs.media import queue_collage_async
    file_ids, hash_ids = list(file_ids), list(set(hash_ids))
    if not file_ids:
        return set()
    await conn.execute(CLEAR_COVERS_SQL, (file_ids,))
    cursor = await conn.execute(LEAVE_ALBUMS_SQL, (file_ids,))
    albums = {r[0] for r in await cursor.fetchall()}
    for album_id in albums:
        await queue_collage_async(conn, album_id)
    cursor = await conn.execute(ORPHANED_SQL, (hash_ids,))
    for (hash_id,) in await cursor.fetchall():
        await conn.execute(ENQUEUE_DELETE_SQL, _delete_params(hash_id))
    return albums


# --- step 2: delete_blob -----------------------------------------------------------------------------

def delete_blob(hash_id, client=None, conn=None):
    """Returns 'deleted', 'kept' (a live file uses it again) or None (already gone)."""
    from jobs.media import bucket, s3
    client = client or s3()
    with (db.connect() if conn is None else _Borrowed(conn)) as conn:
        with conn.transaction():
            row = conn.execute('SELECT id FROM file_hashes WHERE id = %s FOR UPDATE', (hash_id,)).fetchone()
            if row is None:
                return None
            if conn.execute('SELECT 1 FROM files WHERE hash_id = %s AND deleted_at IS NULL LIMIT 1',
                            (hash_id,)).fetchone():
                return 'kept'
            derived = [r[0] for r in conn.execute('SELECT storage_key FROM file_hash_assets WHERE hash_id = %s',
                                                  (hash_id,)).fetchall()]
            keys = derived + [storage_module.blob_key(hash_id)]
            for key in keys:
                client.delete_object(Bucket=bucket(), Key=key)
            if conn.execute("SELECT to_regclass('file_views')").fetchone()[0] is not None:
                # the legacy view rows have no cascade (dropped by pending/drop_legacy.sql)
                conn.execute('DELETE FROM file_views WHERE file_id IN (SELECT id FROM files WHERE hash_id = %s)',
                             (hash_id,))
            conn.execute('DELETE FROM files WHERE hash_id = %s', (hash_id,))
            conn.execute('DELETE FROM file_hashes WHERE id = %s', (hash_id,))
    log.info('deleted blob %s and %d derived object(s)', hash_id, len(derived))
    return 'deleted'


class _Borrowed:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, *exc):
        return False


@register('delete_blob')
def delete_blob_job(payload, job):
    delete_blob(int(payload['hash_id']))
