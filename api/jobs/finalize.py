"""`finalize_upload` (PLAN.md "Chunked, resumable uploads"), run by `python -m worker`.

1. Read `staging/<upload_id>` back from B2 once, as a stream, computing blake2b,
   md5 and sha1 (hashes are always computed here, never trusted from a client).
2. If the hash matches an existing FileHash, point the new File at that blob.
3. Otherwise server-side copy the object to `files/<hash_id>` and insert the
   FileHash, only after the copy succeeded.
4. Delete the staging object, create the File, and mark the session complete.

Idempotent: a session that is no longer `processing` is left alone. Problems
with the upload itself (missing object, wrong size) fail the session at once;
other errors are retried by the job queue, and the session is marked failed
when the last attempt fails.
"""

import logging

from datetime import datetime, timedelta, timezone

import db
from db.models import UploadSession, columns, from_row
from jobs.queue import register
from utils import storage as storage_module
from utils.generators import Snowflake
from utils.uploading import Hasher
from utils.vanity import generate_vanity

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
        except UploadProblem as problem:
            _fail(conn, upload_id, problem.code)
            return None

        blake2b, md5, sha1 = hasher.digests()
        row = conn.execute('SELECT id FROM file_hashes WHERE blake2b = %s AND md5 = %s AND sha1 = %s',
                           (blake2b, md5, sha1)).fetchone()
        if row is not None:
            hash_id = row[0]
        else:
            hash_id = Snowflake.generate()
            key = storage_module.blob_key(hash_id)
            client.copy({'Bucket': name, 'Key': session.storage_key}, name, key)
            inserted = conn.execute(
                'INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (%s, %s, %s, %s, %s) '
                'ON CONFLICT (blake2b, sha1, md5) DO NOTHING RETURNING id',
                (hash_id, blake2b, sha1, md5, hasher.size)).fetchone()
            if inserted is None:
                # the same content was stored meanwhile: use it, drop our copy
                client.delete_object(Bucket=name, Key=key)
                hash_id = conn.execute('SELECT id FROM file_hashes WHERE blake2b = %s AND md5 = %s AND sha1 = %s',
                                       (blake2b, md5, sha1)).fetchone()[0]

        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=session.expires_in) if session.expires_in else None
        with conn.transaction():
            session = _session(conn, upload_id, lock=True)
            if session is None or session.status != 'processing':
                return None
            file_id = Snowflake.generate()
            while True:
                vanity = generate_vanity()
                created = conn.execute(
                    'INSERT INTO files (id, vanity, mimetype_id, extension, filename, hash_id, user_id, fingerprint, '
                    'view_count, size, expires_at, visibility, password_hash, unlock_ttl, password_expires_at, '
                    'uploader_ip_hash) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, %s, %s, %s, %s) '
                    'ON CONFLICT (vanity) DO NOTHING RETURNING id',
                    (file_id, vanity, session.mimetype_id, session.extension, session.name, hash_id,
                     session.owner_user_id, session.owner_fingerprint, session.size, expires_at, session.visibility,
                     session.password_hash, session.unlock_ttl, session.password_expires_at,
                     session.owner_ip_hash)).fetchone()
                if created is not None:
                    break
            conn.execute("UPDATE upload_sessions SET status = 'complete', file_id = %s WHERE id = %s",
                         (file_id, upload_id))
        try:
            client.delete_object(Bucket=name, Key=session.storage_key)
        except Exception:
            log.warning('could not delete staging object %s; the upload reaper will retry', session.storage_key)
        return file_id


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
