"""`finalize_upload` (PLAN.md "Chunked, resumable uploads"), run by `python -m worker`.

1. Read `staging/<upload_id>` back from B2 once, as a stream, computing blake2b,
   md5 and sha1 (hashes are always computed here, never trusted from a client).
2. If the hash matches an existing FileHash, point the new File at that blob.
3. Otherwise server-side copy the object to `files/<hash_id>` and insert the
   FileHash, only after the copy succeeded, and queue its `scan` (milestone-4 §2.1).
4. Delete the staging object, create the File, and mark the session complete.

Idempotent: a session that is no longer `processing` is left alone. Problems
with the upload itself (missing object, wrong size) fail the session at once;
other errors are retried by the job queue, and the session is marked failed
when the last attempt fails.
"""

import logging

from datetime import datetime, timedelta, timezone

import db
import jobs.media as media_jobs
from db import file_rows
from db.models import UploadSession, columns, from_row
from jobs.queue import register
from safety import scan as safety_scan, uploads as safety_uploads
from utils import filetypes
from utils import storage as storage_module
from utils.uploading import Hasher

log = logging.getLogger(__name__)

READ_CHUNK = 1024 * 1024
_s3 = None


def s3():
    global _s3
    if _s3 is None:
        _s3 = storage_module.sync_client()
    return _s3


def bucket():
    return storage_module.S3Settings.from_env().bucket


class UploadProblem(Exception):
    """The upload itself is unusable: fail the session, don't retry."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _session(conn, upload_id, lock=False):
    row = conn.execute('SELECT {} FROM upload_sessions WHERE id = %s{}'.format(
        columns(UploadSession), ' FOR UPDATE' if lock else ''), (upload_id,)).fetchone()
    return row and from_row(UploadSession, row)


def _fail(conn, upload_id, code):
    conn.execute("UPDATE upload_sessions SET status = 'failed', error = %s WHERE id = %s AND status = 'processing'",
                 (code, upload_id))


def _hash_staging(client, name, key):
    try:
        response = client.get_object(Bucket=name, Key=key)
    except client.exceptions.NoSuchKey:
        raise UploadProblem('UPLOAD_MISSING')
    hasher = Hasher()
    for piece in response['Body'].iter_chunks(READ_CHUNK):
        hasher.update(piece)
    return hasher


def finalize(upload_id, conn=None, client=None):
    """Finalize one session. Returns the new file id, or None if there was nothing to do."""
    client = client or s3()
    name = bucket()
    with (db.connect() if conn is None else _borrowed(conn)) as conn:
        session = _session(conn, upload_id)
        if session is None or session.status != 'processing':
            return None
        try:
            hasher = _hash_staging(client, name, session.storage_key)
            if hasher.size != session.size:
                raise UploadProblem('SIZE_MISMATCH')
            if filetypes.sniff_executable(hasher.head) or safety_uploads.sniff_blocked(hasher.head):
                raise UploadProblem('FILE_TYPE_NOT_ALLOWED')
            # milestone-4 §2.5 steps 1-4: known content fails the session with the code
            blake2b, md5, sha1 = hasher.digests()
            code, csam = safety_uploads.known_content(conn, blake2b, md5, sha1, session.owner_user_id is None,
                                                      nsfw=session.nsfw_marked)
            if code is not None:
                if csam:
                    with conn.transaction():
                        _csam_reupload(conn, session, blake2b, md5, sha1, hasher.size)
                raise UploadProblem(code)
        except UploadProblem as problem:
            _fail(conn, upload_id, problem.code)
            # a refused upload stores nothing: its (completed) staging object goes now
            try:
                client.delete_object(Bucket=name, Key=session.storage_key)
            except Exception:
                log.warning('could not delete staging object %s; the upload reaper will retry', session.storage_key)
            return None

        hash_id, new_hash = file_rows.stored_hash(
            conn, client, name, hasher.digests(), hasher.size,
            lambda key: client.copy({'Bucket': name, 'Key': session.storage_key}, name, key))

        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=session.expires_in) if session.expires_in else None
        with conn.transaction():
            session = _session(conn, upload_id, lock=True)
            if session is None or session.status != 'processing':
                return None
            # VANITY_EXHAUSTED can't realistically happen with the default pattern: the job queue retries it, and
            # the session fails (FINALIZE_FAILED) after the last attempt
            file_id, _ = file_rows.insert_file(
                conn, hash_id=hash_id, mimetype_id=session.mimetype_id, extension=session.extension,
                filename=session.name, size=session.size, user_id=session.owner_user_id,
                guest_id=session.owner_guest_id, expires_at=expires_at, visibility=session.visibility,
                password_hash=session.password_hash, unlock_ttl=session.unlock_ttl,
                password_expires_at=session.password_expires_at, uploader_ip_hash=session.owner_ip_hash,
                nsfw_marked=session.nsfw_marked, uploader_abuse_ip_hash=session.owner_abuse_ip_hash,
                uploader_ip_sealed=session.owner_ip_sealed, upload_key_id=session.upload_key_id,
                view_limit=session.view_limit, view_limit_action=session.view_limit_action)
            conn.execute("UPDATE upload_sessions SET status = 'complete', file_id = %s WHERE id = %s",
                         (file_id, upload_id))
            # every new hash is scanned first (milestone-4 §2.1); `album=` on POST /uploads (Milestone 3).
            # The hash row was inserted before this transaction, so a retry after a crash in between
            # finds it as "existing": any hash still pending gets its (deduplicated) scan here.
            if file_rows.needs_scan(conn, hash_id, new_hash):
                safety_scan.queue_scan(conn, hash_id)
            if session.album_id is not None:
                append_to_album(conn, session.album_id, file_id, session.owner_user_id)
        try:
            client.delete_object(Bucket=name, Key=session.storage_key)
        except Exception:
            log.warning('could not delete staging object %s; the upload reaper will retry', session.storage_key)
        return file_id


def append_to_album(conn, album_id, file_id, owner_user_id):
    """Append the new file to the session's album if it's still the owner's and not full."""
    from utils import limits as limits_module
    limit = limits_module.defaults()['album_files']
    appended = conn.execute(
        'INSERT INTO album_files (album_id, file_id, position) '
        'SELECT %s, %s, COALESCE(max(af.position) + 1, 0) FROM album_files af WHERE af.album_id = %s '
        'HAVING count(*) < %s AND EXISTS (SELECT 1 FROM albums WHERE id = %s AND owner_user_id = %s '
        'AND deleted_at IS NULL) ON CONFLICT DO NOTHING RETURNING 1',
        (album_id, file_id, album_id, limit, album_id, owner_user_id)).fetchone()
    if appended:
        conn.execute('UPDATE albums SET updated_at = now(), empty_since = NULL WHERE id = %s', (album_id,))
        media_jobs.queue_collage(conn, album_id)


def _csam_reupload(conn, session, blake2b, md5, sha1, size):
    from safety import csam
    entry = conn.execute('SELECT id FROM blocked_hashes WHERE blake2b = %s AND md5 = %s AND sha1 = %s',
                         (blake2b, md5, sha1)).fetchone()
    attempt = {'filename': session.filename, 'mimetype': session.mimetype_id, 'size': size,
               'signed_in': session.owner_user_id is not None, 'upload_id': str(session.id)}
    csam.reupload(conn, entry[0] if entry else None, session.owner_user_id, session.owner_guest_id,
                  session.owner_abuse_ip_hash, attempt)


class _borrowed:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, *exc):
        return False


@register('finalize_upload')
def finalize_upload(payload, job):
    upload_id = int(payload['upload_id'])
    try:
        finalize(upload_id)
    except Exception:
        if job.attempts >= job.max_attempts:
            with db.connect() as conn:
                _fail(conn, upload_id, 'FINALIZE_FAILED')
        raise
