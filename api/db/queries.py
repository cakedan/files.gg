"""Async queries for the API. Each takes a psycopg `AsyncConnection`.

Read queries mirror the SQL Peewee generated (joins, filters and ordering),
so result sets and their order are unchanged.
"""

import time

from datetime import datetime, timezone

from db.models import (
    File, FileHash, FileHashAsset, Mimetype, MimetypeExtension, UploadPart, UploadSession, User, columns, from_row,
    width,
)

USER_COLUMNS = columns(User)
FILE_COLUMNS = columns(File, 'f')
HASH_COLUMNS = columns(FileHash, 'h')
MIMETYPE_COLUMNS = columns(Mimetype, 'm')
EXTENSION_COLUMNS = columns(MimetypeExtension)
SESSION_COLUMNS = columns(UploadSession)

# Deleted and expired files are gone at read time, whatever the reaper has done.
LIVE = '(f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > now()))'


async def _one(conn, sql, params=()):
    cursor = await conn.execute(sql, params)
    return await cursor.fetchone()


async def _all(conn, sql, params=()):
    cursor = await conn.execute(sql, params)
    return await cursor.fetchall()


# --- users ------------------------------------------------------------------

async def get_user(conn, user_id, bot=None):
    sql = 'SELECT {} FROM users WHERE id = %s'.format(USER_COLUMNS)
    params = [user_id]
    if bot is not None:
        sql += ' AND bot = %s'
        params.append(bot)
    row = await _one(conn, sql + ' LIMIT 1', params)
    return row and from_row(User, row)


async def get_user_by_email(conn, email):
    row = await _one(conn, 'SELECT {} FROM users WHERE email = %s LIMIT 1'.format(USER_COLUMNS), (email,))
    return row and from_row(User, row)


async def user_exists(conn, username, discriminator):
    row = await _one(conn, 'SELECT 1 FROM users WHERE username = %s AND discriminator = %s LIMIT 1',
                     (username, discriminator))
    return row is not None


async def get_users(conn, user_ids):
    if not user_ids:
        return {}
    rows = await _all(conn, 'SELECT {} FROM users WHERE id = ANY(%s)'.format(USER_COLUMNS), (list(user_ids),))
    return {row[0]: from_row(User, row) for row in rows}


def _timestamp(seconds):
    """(timestamptz, legacy unix seconds) for the same whole second. Token
    checks compare whole seconds, as they did with the old BIGINT columns."""
    return datetime.fromtimestamp(seconds, timezone.utc), seconds


# The *_at columns are the ones the code reads. The legacy unix-seconds columns
# are dual-written so servers still on the previous release (which read them)
# see the same values during a rolling deploy; pending/0004 drops them.

async def create_user(conn, id, email, username, discriminator, password):
    # Peewee's TimestampField default (datetime.now) was stored truncated to seconds
    at, seconds = _timestamp(int(time.time()))
    row = await _one(
        conn,
        'INSERT INTO users (id, email, bot, username, discriminator, password, flags, verified, '
        'last_email_reset_at, last_password_reset_at, last_email_reset, last_password_reset) '
        'VALUES (%s, %s, false, %s, %s, %s, 0, false, %s, %s, %s, %s) '
        'RETURNING {}'.format(USER_COLUMNS),
        (id, email, username, discriminator, password, at, at, seconds, seconds),
    )
    return from_row(User, row)


async def mark_email_verified(conn, user_id, email):
    # an explicit time.time() was stored rounded by Peewee
    at, seconds = _timestamp(int(round(time.time())))
    await conn.execute(
        'UPDATE users SET email = %s, last_email_reset_at = %s, last_email_reset = %s, verified = true '
        'WHERE id = %s',
        (email, at, seconds, user_id),
    )


async def set_password(conn, user_id, password_hash):
    at, seconds = _timestamp(int(round(time.time())))
    await conn.execute(
        'UPDATE users SET password = %s, last_password_reset_at = %s, last_password_reset = %s WHERE id = %s',
        (password_hash, at, seconds, user_id),
    )


async def claim_fingerprint_files(conn, user_id, fingerprint):
    """Anonymous files uploaded with this fingerprint now belong to the user."""
    await conn.execute(
        'UPDATE files SET user_id = %s, fingerprint = NULL WHERE fingerprint = %s',
        (user_id, fingerprint),
    )


# --- mimetypes --------------------------------------------------------------

async def mimetype_type_exists(conn, type_id):
    return await _one(conn, 'SELECT id FROM mimetype_types WHERE id = %s LIMIT 1', (type_id,)) is not None


async def get_mimetype(conn, mimetype_id, with_extensions=False):
    row = await _one(conn, 'SELECT {} FROM mimetypes AS m WHERE m.id = %s LIMIT 1'.format(MIMETYPE_COLUMNS),
                     (mimetype_id,))
    if row is None:
        return None
    mimetype = from_row(Mimetype, row)
    if with_extensions:
        rows = await _all(conn, 'SELECT {} FROM mimetype_extensions WHERE mimetype_id = %s ORDER BY ctid'.format(EXTENSION_COLUMNS),
                          (mimetype_id,))
        mimetype.extensions = [from_row(MimetypeExtension, r) for r in rows]
    return mimetype


async def _prefetch(conn, from_where, params, order='m.ctid'):
    """Peewee's prefetch(): run the mimetype query, then all their extensions
    (`WHERE mimetype_id IN (<same query>)`), and attach them in row order.
    Peewee's queries had no ORDER BY and Postgres answered them with sequential
    scans, i.e. in physical (ctid) order; that order is now explicit, so new
    indexes can't change the responses."""
    mimetypes = [from_row(Mimetype, row) for row in await _all(
        conn, 'SELECT {} {} ORDER BY {}'.format(MIMETYPE_COLUMNS, from_where, order), params)]
    rows = await _all(
        conn,
        'SELECT {} FROM mimetype_extensions WHERE mimetype_id IN (SELECT m.id {}) ORDER BY ctid'.format(
            EXTENSION_COLUMNS, from_where),
        params,
    )
    by_id = {}
    for mimetype in mimetypes:
        by_id.setdefault(mimetype.id, []).append(mimetype)
    for row in rows:
        extension = from_row(MimetypeExtension, row)
        for mimetype in by_id.get(extension.mimetype_id, ()):
            mimetype.extensions.append(extension)
    return mimetypes


async def list_mimetypes(conn, type_id=None):
    if type_id is None:
        return await _prefetch(conn, 'FROM mimetypes AS m', ())
    return await _prefetch(conn, 'FROM mimetypes AS m WHERE m.type_id = %s', (type_id,))


async def get_extension(conn, extension, mimetype_id=None):
    sql = 'SELECT {} FROM mimetype_extensions WHERE extension = %s'.format(EXTENSION_COLUMNS)
    params = [extension]
    if mimetype_id is not None:
        sql = 'SELECT {} FROM mimetype_extensions WHERE mimetype_id = %s AND extension = %s'.format(EXTENSION_COLUMNS)
        params = [mimetype_id, extension]
    row = await _one(conn, sql + ' LIMIT 1', params)
    return row and from_row(MimetypeExtension, row)


async def get_top_extension(conn, mimetype_id):
    row = await _one(
        conn,
        'SELECT {} FROM mimetype_extensions WHERE mimetype_id = %s ORDER BY priority DESC LIMIT 1'.format(EXTENSION_COLUMNS),
        (mimetype_id,),
    )
    return row and from_row(MimetypeExtension, row)


# --- files ------------------------------------------------------------------

async def _attach_users(conn, files):
    users = await get_users(conn, {f.user_id for f in files if f.user_id is not None})
    for f in files:
        f.user = users.get(f.user_id)
    return files


async def attach_assets(conn, files):
    """Load each file's previews (file_hash_assets) onto `file.hash.assets`."""
    hashes = {f.hash.id: f.hash for f in files if f.hash is not None}
    if not hashes:
        return files
    rows = await _all(conn, 'SELECT {} FROM file_hash_assets WHERE hash_id = ANY(%s) ORDER BY kind'.format(
        columns(FileHashAsset)), (list(hashes),))
    for fhash in hashes.values():
        fhash.assets = []
    for row in rows:
        asset = from_row(FileHashAsset, row)
        hashes[asset.hash_id].assets.append(asset)
    # files sharing a hash share its row object only when loaded together; copy across
    for f in files:
        if f.hash is not None and f.hash is not hashes[f.hash.id]:
            f.hash.assets = hashes[f.hash.id].assets
    return files


def file_from_row(row):
    fobj = from_row(File, row)
    fobj.hash = from_row(FileHash, row, width(File))
    return fobj


async def files_where(conn, where, params, order='f.id DESC', limit=None, offset=None, live=True):
    """Files (with hash, user and assets) matching `where`."""
    sql = 'SELECT {}, {} FROM files AS f INNER JOIN file_hashes AS h ON (f.hash_id = h.id) WHERE {}{} ORDER BY {}'.format(
        FILE_COLUMNS, HASH_COLUMNS, where, (' AND ' + LIVE) if live else '', order)
    params = list(params)
    if limit is not None:
        sql += ' LIMIT %s'
        params.append(limit)
    if offset:
        sql += ' OFFSET %s'
        params.append(offset)
    files = [file_from_row(row) for row in await _all(conn, sql, params)]
    await _attach_users(conn, files)
    await attach_assets(conn, files)
    return files


async def _get_file(conn, where, params):
    row = await _one(
        conn,
        'SELECT {}, {} FROM files AS f INNER JOIN file_hashes AS h ON (f.hash_id = h.id) '
        'WHERE {} AND {} LIMIT 1'.format(FILE_COLUMNS, HASH_COLUMNS, where, LIVE),
        params,
    )
    if row is None:
        return None
    fobj = file_from_row(row)
    await _attach_users(conn, [fobj])
    await attach_assets(conn, [fobj])
    return fobj


async def get_file_by_vanity(conn, vanity):
    """A live file (not deleted, not expired) by vanity, else None."""
    return await _get_file(conn, 'f.vanity = %s', (vanity,))


async def get_owned_file(conn, file_id, user_id):
    return await _get_file(conn, 'f.id = %s AND f.user_id = %s', (file_id, user_id))


async def vanity_exists(conn, vanity):
    return await _one(conn, 'SELECT 1 FROM files WHERE vanity = %s LIMIT 1', (vanity,)) is not None


async def record_view(conn, fobj, ip_hash, day):
    """Count a view (one transaction): every view bumps file_view_days.views; the
    first view from this IP hash on this UTC day also bumps unique_views and the
    file's cached view_count. Updates fobj.view_count. Returns True if unique."""
    async with conn.transaction():
        unique = await _one(
            conn,
            'INSERT INTO file_view_seen (file_id, day, ip_hash) VALUES (%s, %s, %s) '
            'ON CONFLICT DO NOTHING RETURNING 1',
            (fobj.id, day, ip_hash),
        ) is not None
        await conn.execute(
            'INSERT INTO file_view_days AS d (file_id, day, views, unique_views) VALUES (%s, %s, 1, %s) '
            'ON CONFLICT (file_id, day) DO UPDATE '
            'SET views = d.views + 1, unique_views = d.unique_views + EXCLUDED.unique_views',
            (fobj.id, day, 1 if unique else 0),
        )
        if unique:
            row = await _one(conn, 'UPDATE files SET view_count = view_count + 1 WHERE id = %s RETURNING view_count',
                             (fobj.id,))
            fobj.view_count = row[0]
        return unique


async def get_file_hash(conn, blake2b, md5, sha1):
    row = await _one(
        conn,
        'SELECT {} FROM file_hashes AS h WHERE h.blake2b = %s AND h.md5 = %s AND h.sha1 = %s LIMIT 1'.format(HASH_COLUMNS),
        (blake2b, md5, sha1),
    )
    return row and from_row(FileHash, row)


async def create_file_hash(conn, id, blake2b, md5, sha1, size):
    """Insert a hash row; if the same content raced in first, return that one.
    Returns (FileHash, created)."""
    row = await _one(
        conn,
        'INSERT INTO file_hashes AS h (id, blake2b, sha1, md5, size) VALUES (%s, %s, %s, %s, %s) '
        'ON CONFLICT (blake2b, sha1, md5) DO NOTHING RETURNING {}'.format(HASH_COLUMNS),
        (id, blake2b, sha1, md5, size),
    )
    if row is not None:
        return from_row(FileHash, row), True
    return await get_file_hash(conn, blake2b, md5, sha1), False


async def create_file(conn, id, vanity, mimetype_id, extension, filename, fhash, user, fingerprint, size=None,
                      expires_at=None, visibility='link', password_hash=None, unlock_ttl=3600,
                      password_expires_at=None, uploader_ip_hash=None):
    """Insert a file; returns None if the vanity was taken meanwhile."""
    row = await _one(
        conn,
        'INSERT INTO files AS f (id, vanity, mimetype_id, extension, filename, hash_id, user_id, fingerprint, '
        'view_count, size, expires_at, visibility, password_hash, unlock_ttl, password_expires_at, uploader_ip_hash) '
        'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, %s, %s, %s, %s) '
        'ON CONFLICT (vanity) DO NOTHING RETURNING {}'.format(FILE_COLUMNS),
        (id, vanity, mimetype_id, extension, filename, fhash.id, user.id if user else None, fingerprint,
         fhash.size if size is None else size, expires_at, visibility, password_hash, unlock_ttl,
         password_expires_at, uploader_ip_hash),
    )
    if row is None:
        return None
    fobj = from_row(File, row)
    fobj.hash = fhash
    fobj.user = user
    return fobj


async def insert_file_hash(conn, id, blake2b, md5, sha1, size):
    """Insert a hash row for a blob that is already stored. Returns (FileHash,
    created); on a race with the same content, the existing row and False."""
    return await create_file_hash(conn, id, blake2b, md5, sha1, size)


async def update_file(conn, file_id, **changes):
    """Set columns on a file; returns the new row."""
    if not changes:
        return None
    assignments = ', '.join('"{}" = %s'.format(name) for name in changes)
    row = await _one(conn, 'UPDATE files AS f SET {} WHERE id = %s RETURNING {}'.format(assignments, FILE_COLUMNS),
                     list(changes.values()) + [file_id])
    return row and from_row(File, row)


# --- usage and limits ------------------------------------------------------------

RESERVING = "status IN ('open', 'processing')"


async def lock_quota(conn, *keys):
    """Serialise quota checks for these owners until the transaction ends."""
    for key in sorted(set(keys)):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('quota:' + key,))


async def user_usage(conn, user_id):
    """Bytes of the user's live files, plus open upload sessions (reservations)."""
    row = await _one(
        conn,
        'SELECT (SELECT COALESCE(SUM(f.size), 0) FROM files AS f WHERE f.user_id = %s AND ' + LIVE + ') + '
        '(SELECT COALESCE(SUM(size), 0) FROM upload_sessions WHERE owner_user_id = %s AND ' + RESERVING + ')',
        (user_id, user_id),
    )
    return int(row[0])


async def anonymous_usage(conn, fingerprint, ip_hashes, since_id):
    """Bytes uploaded (plus reserved) in the rolling window: (by fingerprint, by IP)."""
    by_fingerprint = by_ip = 0
    if fingerprint is not None:
        row = await _one(
            conn,
            'SELECT (SELECT COALESCE(SUM(f.size), 0) FROM files AS f WHERE f.fingerprint = %s AND f.id >= %s) + '
            '(SELECT COALESCE(SUM(size), 0) FROM upload_sessions WHERE owner_fingerprint = %s AND ' + RESERVING + ')',
            (fingerprint, since_id, fingerprint),
        )
        by_fingerprint = int(row[0])
    if ip_hashes:
        row = await _one(
            conn,
            'SELECT (SELECT COALESCE(SUM(f.size), 0) FROM files AS f WHERE f.uploader_ip_hash = ANY(%s) '
            'AND f.id >= %s) + (SELECT COALESCE(SUM(size), 0) FROM upload_sessions WHERE owner_ip_hash = ANY(%s) '
            'AND ' + RESERVING + ')',
            (list(ip_hashes), since_id, list(ip_hashes)),
        )
        by_ip = int(row[0])
    return by_fingerprint, by_ip


# --- upload sessions -----------------------------------------------------------------

async def create_session(conn, **values):
    names = list(values)
    row = await _one(
        conn,
        'INSERT INTO upload_sessions ({}) VALUES ({}) RETURNING {}'.format(
            ', '.join('"{}"'.format(n) for n in names), ', '.join(['%s'] * len(names)), SESSION_COLUMNS),
        [values[n] for n in names],
    )
    return from_row(UploadSession, row)


async def get_session(conn, session_id, for_update=False):
    row = await _one(conn, 'SELECT {} FROM upload_sessions WHERE id = %s{}'.format(
        SESSION_COLUMNS, ' FOR UPDATE' if for_update else ''), (session_id,))
    return row and from_row(UploadSession, row)


async def session_part_indexes(conn, session_id):
    return [r[0] for r in await _all(conn, 'SELECT "index" FROM upload_parts WHERE session_id = %s ORDER BY 1',
                                      (session_id,))]


async def session_parts(conn, session_id):
    return [from_row(UploadPart, r) for r in await _all(
        conn, 'SELECT {} FROM upload_parts WHERE session_id = %s ORDER BY "index"'.format(columns(UploadPart)),
        (session_id,))]


async def record_part(conn, session_id, index, etag, size):
    await conn.execute(
        'INSERT INTO upload_parts (session_id, "index", etag, size) VALUES (%s, %s, %s, %s) '
        'ON CONFLICT (session_id, "index") DO UPDATE SET etag = EXCLUDED.etag, size = EXCLUDED.size, '
        'received_at = now()',
        (session_id, index, etag, size),
    )


async def set_session_status(conn, session_id, status, from_status=None, **extra):
    sets = ['status = %s'] + ['"{}" = %s'.format(k) for k in extra]
    params = [status] + list(extra.values()) + [session_id]
    where = 'id = %s'
    if from_status is not None:
        where += ' AND status = %s'
        params.append(from_status)
    row = await _one(conn, 'UPDATE upload_sessions SET {} WHERE {} RETURNING id'.format(', '.join(sets), where), params)
    return row is not None


async def delete_session(conn, session_id):
    await conn.execute('DELETE FROM upload_sessions WHERE id = %s', (session_id,))


async def get_file(conn, file_id):
    """Any file by id (live or not), with hash and user."""
    row = await _one(
        conn,
        'SELECT {}, {} FROM files AS f INNER JOIN file_hashes AS h ON (f.hash_id = h.id) WHERE f.id = %s'.format(
            FILE_COLUMNS, HASH_COLUMNS), (file_id,))
    if row is None:
        return None
    fobj = file_from_row(row)
    await _attach_users(conn, [fobj])
    await attach_assets(conn, [fobj])
    return fobj


# --- unlock rate limiting ----------------------------------------------------------------

async def count_attempt(conn, file_id, scope, ip_hash, window_seconds=60, album_id=None):
    """Count one attempt in the current window, for a file or (album_id) an album.
    Returns (count, seconds left)."""
    column = 'album_id' if album_id is not None else 'file_id'
    row = await _one(
        conn,
        'INSERT INTO unlock_attempts AS a ({0}, scope, ip_hash, window_start, count) '
        "VALUES (%s, %s, %s, to_timestamp(floor(extract(epoch FROM now()) / %s) * %s), 1) "
        'ON CONFLICT ({0}, scope, ip_hash, window_start) DO UPDATE SET count = a.count + 1 '
        'RETURNING count, ceil(extract(epoch FROM (window_start + make_interval(secs => %s::float8) - now())))::int'
        .format(column),
        (album_id if album_id is not None else file_id, scope, ip_hash, window_seconds, window_seconds,
         window_seconds),
    )
    return row[0], max(1, row[1])


# --- the owner's library (contract milestone-3 §6) ---------------------------------------------------

async def count_where(conn, where, params):
    """(count, total bytes) of live files matching `where`."""
    row = await _one(conn, 'SELECT count(*), COALESCE(sum(f.size), 0) FROM files AS f WHERE {} AND {}'.format(
        where, LIVE), params)
    return int(row[0]), int(row[1])


async def soft_delete_files(conn, where, params):
    """Soft-delete the live files matching `where` (in the caller's transaction) and do
    what a delete implies (jobs/gc.py). Returns the deleted ids."""
    from jobs.gc import after_delete_async
    rows = await _all(conn, 'UPDATE files AS f SET deleted_at = now() WHERE {} AND f.deleted_at IS NULL '
                            'RETURNING f.id, f.hash_id'.format(where), params)
    await after_delete_async(conn, [r[0] for r in rows], [r[1] for r in rows])
    return [r[0] for r in rows]
