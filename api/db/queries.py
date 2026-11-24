"""Async queries for the API. Each takes a psycopg `AsyncConnection`.

Read queries mirror the SQL Peewee generated (joins, filters and ordering),
so result sets and their order are unchanged.
"""

import time

from datetime import datetime, timezone

from db.models import File, FileHash, Mimetype, MimetypeExtension, User, columns, from_row, width

USER_COLUMNS = columns(User)
FILE_COLUMNS = columns(File, 'f')
HASH_COLUMNS = columns(FileHash, 'h')
MIMETYPE_COLUMNS = columns(Mimetype, 'm')
EXTENSION_COLUMNS = columns(MimetypeExtension)


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
        rows = await _all(conn, 'SELECT {} FROM mimetype_extensions WHERE mimetype_id = %s'.format(EXTENSION_COLUMNS),
                          (mimetype_id,))
        mimetype.extensions = [from_row(MimetypeExtension, r) for r in rows]
    return mimetype


async def _prefetch(conn, from_where, params):
    """Peewee's prefetch(): run the mimetype query, then all their extensions
    (`WHERE mimetype_id IN (<same query>)`), and attach them in row order."""
    mimetypes = [from_row(Mimetype, row) for row in await _all(
        conn, 'SELECT {} {}'.format(MIMETYPE_COLUMNS, from_where), params)]
    rows = await _all(
        conn,
        'SELECT {} FROM mimetype_extensions WHERE mimetype_id IN (SELECT m.id {})'.format(EXTENSION_COLUMNS, from_where),
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


async def list_user_mimetypes(conn, user_id):
    # one row per file, as the Peewee query returned (duplicates included)
    return await _prefetch(
        conn, 'FROM mimetypes AS m RIGHT OUTER JOIN files AS f ON (f.mimetype_id = m.id) WHERE (f.user_id = %s)',
        (user_id,))


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

def _owner_filter(user_id, fingerprint):
    if user_id is not None:
        return 'f.user_id = %s', user_id
    return 'f.fingerprint = %s', fingerprint


def _type_join(type_id):
    # Peewee joined with RIGHT OUTER JOINs; with the WHERE on the type they
    # behave as inner joins, and are kept as they were.
    if type_id is None:
        return '', []
    return ((' RIGHT OUTER JOIN mimetypes AS m ON (m.id = f.mimetype_id)'
             ' RIGHT OUTER JOIN mimetype_types AS t ON (t.id = m.type_id)'),
            ['t.id = %s'])


async def _attach_users(conn, files):
    users = await get_users(conn, {f.user_id for f in files if f.user_id is not None})
    for f in files:
        f.user = users.get(f.user_id)
    return files


async def list_files(conn, user_id=None, fingerprint=None, type_id=None, mimetype_id=None,
                     after=None, before=None, limit=100):
    owner_sql, owner_param = _owner_filter(user_id, fingerprint)
    join_sql, type_where = _type_join(type_id)
    where, params = [owner_sql] + type_where, [owner_param] + ([type_id] if type_id is not None else [])
    if mimetype_id is not None:
        where.append('f.mimetype_id = %s')
        params.append(mimetype_id)
    count_where, count_params = list(where), list(params)
    if after is not None:
        where.append('f.id > %s')
        params.append(after)
    elif before is not None:
        where.append('f.id < %s')
        params.append(before)

    rows = await _all(
        conn,
        'SELECT {}, {} FROM files AS f INNER JOIN file_hashes AS h ON (f.hash_id = h.id){} WHERE {} '
        'ORDER BY f.id DESC LIMIT %s'.format(FILE_COLUMNS, HASH_COLUMNS, join_sql, ' AND '.join(where)),
        params + [limit],
    )
    files = []
    for row in rows:
        fobj = from_row(File, row)
        fobj.hash = from_row(FileHash, row, width(File))
        files.append(fobj)
    await _attach_users(conn, files)

    total = (await _one(
        conn,
        'SELECT COUNT(f.id) FROM files AS f{} WHERE {}'.format(join_sql, ' AND '.join(count_where)),
        count_params,
    ))[0]
    return total, files


async def count_files(conn, user_id=None, fingerprint=None, type_id=None, mimetype_id=None):
    owner_sql, owner_param = _owner_filter(user_id, fingerprint)
    join_sql, type_where = _type_join(type_id)
    where, params = [owner_sql] + type_where, [owner_param] + ([type_id] if type_id is not None else [])
    if mimetype_id is not None:
        where.append('f.mimetype_id = %s')
        params.append(mimetype_id)
    row = await _one(conn, 'SELECT COUNT(1) FROM files AS f{} WHERE {}'.format(join_sql, ' AND '.join(where)), params)
    return row[0]


async def get_file_by_vanity(conn, vanity):
    row = await _one(
        conn,
        'SELECT {}, {} FROM files AS f INNER JOIN file_hashes AS h ON (f.hash_id = h.id) '
        'WHERE f.vanity = %s LIMIT 1'.format(FILE_COLUMNS, HASH_COLUMNS),
        (vanity,),
    )
    if row is None:
        return None
    fobj = from_row(File, row)
    fobj.hash = from_row(FileHash, row, width(File))
    await _attach_users(conn, [fobj])
    return fobj


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


async def create_file(conn, id, vanity, mimetype_id, extension, filename, fhash, user, fingerprint):
    """Insert a file; returns None if the vanity was taken meanwhile."""
    row = await _one(
        conn,
        'INSERT INTO files AS f (id, vanity, mimetype_id, extension, filename, hash_id, user_id, fingerprint, view_count) '
        'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0) ON CONFLICT (vanity) DO NOTHING RETURNING {}'.format(FILE_COLUMNS),
        (id, vanity, mimetype_id, extension, filename, fhash.id, user.id if user else None, fingerprint),
    )
    if row is None:
        return None
    fobj = from_row(File, row)
    fobj.hash = fhash
    fobj.user = user
    return fobj
