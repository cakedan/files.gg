"""Storing a blob and inserting a File, synchronously: the one implementation shared by `finalize_upload`
(jobs/finalize.py) and conversion outputs (utils/conversion_outputs.py, milestone-5 §4.4).

`stored_hash` de-duplicates against `file_hashes` and stores the blob under the normal key only when the content
is new; `insert_file` creates the File with a fresh vanity. Both take a sync psycopg connection; `insert_file`
runs inside the caller's transaction.
"""

from utils import errors
from utils import storage as storage_module
from utils.generators import Snowflake
from utils.vanity import MAX_VANITY_ATTEMPTS, generate_vanity

HASH_SQL = 'SELECT id FROM file_hashes WHERE blake2b = %s AND md5 = %s AND sha1 = %s'
FILE_COLUMNS = ('id', 'vanity', 'mimetype_id', 'extension', 'filename', 'hash_id', 'user_id', 'guest_id',
                'view_count', 'size', 'expires_at', 'visibility', 'password_hash', 'unlock_ttl', 'password_expires_at',
                'uploader_ip_hash', 'nsfw_marked', 'uploader_abuse_ip_hash', 'uploader_ip_sealed', 'upload_key_id',
                'view_limit', 'view_limit_action', 'derived_from_file_id', 'conversion_id')
INSERT_FILE_SQL = 'INSERT INTO files ({}) VALUES ({}) ON CONFLICT (vanity) DO NOTHING RETURNING id'.format(
    ', '.join(FILE_COLUMNS), ', '.join(['%s'] * len(FILE_COLUMNS)))


def stored_hash(conn, client, bucket, digests, size, store):
    """(hash_id, new): the existing FileHash with these digests, or a new one whose blob `store(key)` wrote to
    `files/<hash_id>` first (the row is inserted only after the blob is stored). If the same content was stored
    meanwhile, our copy is deleted and theirs used."""
    blake2b, md5, sha1 = digests
    row = conn.execute(HASH_SQL, (blake2b, md5, sha1)).fetchone()
    if row is not None:
        return row[0], False
    hash_id = Snowflake.generate()
    key = storage_module.blob_key(hash_id)
    store(key)
    inserted = conn.execute(
        'INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (%s, %s, %s, %s, %s) '
        'ON CONFLICT (blake2b, sha1, md5) DO NOTHING RETURNING id', (hash_id, blake2b, sha1, md5, size)).fetchone()
    if inserted is not None:
        return hash_id, True
    client.delete_object(Bucket=bucket, Key=key)
    return conn.execute(HASH_SQL, (blake2b, md5, sha1)).fetchone()[0], False


def insert_file(conn, *, hash_id, mimetype_id, extension, filename, size, user_id=None, guest_id=None,
                expires_at=None, visibility='link', password_hash=None, unlock_ttl=3600, password_expires_at=None,
                uploader_ip_hash=None, nsfw_marked=False, uploader_abuse_ip_hash=None, uploader_ip_sealed=None,
                upload_key_id=None, view_limit=None, view_limit_action='expire', derived_from_file_id=None,
                conversion_id=None):
    """Insert a File with a random vanity. Returns (file id, vanity). VANITY_EXHAUSTED if no vanity is free after
    MAX_VANITY_ATTEMPTS (the default pattern can't realistically run out)."""
    file_id = Snowflake.generate()
    for _ in range(MAX_VANITY_ATTEMPTS):
        vanity = generate_vanity()
        created = conn.execute(INSERT_FILE_SQL, (
            file_id, vanity, mimetype_id, extension, filename, hash_id, user_id, guest_id, 0, size, expires_at,
            visibility, password_hash, unlock_ttl, password_expires_at, uploader_ip_hash, nsfw_marked,
            uploader_abuse_ip_hash, uploader_ip_sealed, upload_key_id, view_limit, view_limit_action,
            derived_from_file_id, conversion_id)).fetchone()
        if created is not None:
            return file_id, vanity
    raise errors.vanity_exhausted()


def needs_scan(conn, hash_id, new):
    """A new hash is scanned first (milestone-4 §2.1); an existing one still pending gets its (deduplicated) scan
    too, in case a crash came between the hash row and the file."""
    if new:
        return True
    row = conn.execute("SELECT scan_state = 'pending' AND scan_stuck_at IS NULL FROM file_hashes WHERE id = %s",
                       (hash_id,)).fetchone()
    return bool(row and row[0])
