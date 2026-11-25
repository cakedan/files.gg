"""Async album queries (contract milestone-3 §4 and §6). Each takes a psycopg
`AsyncConnection`."""

from db import queries
from db.models import Album, AlbumFile, columns, from_row
from utils.albums import ALBUM_LIVE_SQL, PAGE_SIZE, SHOWN_SQL

ALBUM_COLUMNS = columns(Album, 'al')
ALBUM_FILE_COLUMNS = columns(AlbumFile, 'af')


async def _one(conn, sql, params=()):
    cursor = await conn.execute(sql, params)
    return await cursor.fetchone()


async def _all(conn, sql, params=()):
    cursor = await conn.execute(sql, params)
    return await cursor.fetchall()


# --- albums ----------------------------------------------------------------------------------------

async def get_album_by_vanity(conn, vanity):
    """A live album (not deleted, expired or hidden by moderation), else None."""
    row = await _one(conn, 'SELECT {} FROM albums AS al WHERE al.vanity = %s AND {}'.format(
        ALBUM_COLUMNS, ALBUM_LIVE_SQL), (vanity,))
    return row and from_row(Album, row)


async def get_owned_album(conn, album_id, caller, for_update=False):
    owner_sql, owner_params = caller.album_filter('al')
    row = await _one(conn, 'SELECT {} FROM albums AS al WHERE al.id = %s AND {} AND {}{}'.format(
        ALBUM_COLUMNS, owner_sql, ALBUM_LIVE_SQL, ' FOR UPDATE' if for_update else ''),
        [album_id] + owner_params)
    return row and from_row(Album, row)


async def vanity_exists(conn, vanity):
    return await _one(conn, 'SELECT 1 FROM albums WHERE vanity = %s', (vanity,)) is not None


async def create_album(conn, **values):
    names = list(values)
    row = await _one(conn, 'INSERT INTO albums AS al ({}) VALUES ({}) ON CONFLICT (vanity) DO NOTHING RETURNING {}'.format(
        ', '.join('"{}"'.format(n) for n in names), ', '.join(['%s'] * len(names)), ALBUM_COLUMNS),
        [values[n] for n in names])
    return row and from_row(Album, row)


async def update_album(conn, album_id, **changes):
    changes['updated_at'] = _Now
    assignments, params = [], []
    for name, value in changes.items():
        if value is _Now:
            assignments.append('"{}" = now()'.format(name))
        else:
            assignments.append('"{}" = %s'.format(name))
            params.append(value)
    row = await _one(conn, 'UPDATE albums AS al SET {} WHERE id = %s RETURNING {}'.format(
        ', '.join(assignments), ALBUM_COLUMNS), params + [album_id])
    return row and from_row(Album, row)


class _Now:
    pass


async def count_owned_albums(conn, caller):
    owner_sql, owner_params = caller.album_filter('al')
    row = await _one(conn, 'SELECT count(*) FROM albums AS al WHERE {} AND al.deleted_at IS NULL'.format(owner_sql),
                     owner_params)
    return row[0]


async def list_owned_albums(conn, caller, query=None, order='al.id DESC', offset=0, limit=25):
    owner_sql, params = caller.album_filter('al')
    where = [owner_sql, ALBUM_LIVE_SQL]
    if query:
        where.append("lower(coalesce(al.title, '')) LIKE %s")
        params.append(like_pattern(query))
    where_sql = ' AND '.join(where)
    total = (await _one(conn, 'SELECT count(*) FROM albums AS al WHERE ' + where_sql, params))[0]
    rows = await _all(conn, 'SELECT {} FROM albums AS al WHERE {} ORDER BY {} LIMIT %s OFFSET %s'.format(
        ALBUM_COLUMNS, where_sql, order), params + [limit, offset])
    return total, [from_row(Album, r) for r in rows]


def like_pattern(text):
    escaped = text.lower().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return '%' + escaped + '%'


# --- items --------------------------------------------------------------------------------------------

async def album_entries(conn, album_id):
    """[(file_id, position, caption)] of every row, in order."""
    return [tuple(r) for r in await _all(
        conn, 'SELECT file_id, position, caption FROM album_files WHERE album_id = %s ORDER BY position, file_id',
        (album_id,))]


async def owner_items(conn, album_id):
    """Every item with a live-or-not file, for the owner's editor: [(file, position, caption)]."""
    entries = await album_entries(conn, album_id)
    if not entries:
        return []
    files = {f.id: f for f in await queries.files_where(
        conn, 'f.id = ANY(%s)', ([e[0] for e in entries],), live=False)}
    return [(files[fid], position, caption) for fid, position, caption in entries if fid in files]


async def shown_items(conn, album, after=None, limit=PAGE_SIZE):
    """A page of the items the public sees: [(file, position, caption)], and the next cursor."""
    params = [album.id]
    where = 'af.album_id = %s AND ' + SHOWN_SQL
    if after is not None:
        where += ' AND af.position > %s'
        params.append(after)
    rows = await _all(conn, (
        'SELECT af.file_id, af.position, af.caption FROM album_files af JOIN files f ON f.id = af.file_id '
        'JOIN albums al ON al.id = af.album_id WHERE {} ORDER BY af.position, af.file_id LIMIT %s').format(where),
        params + [limit + 1 if limit else None])
    more = limit is not None and len(rows) > limit
    rows = rows[:limit] if limit else rows
    if not rows:
        return [], None
    files = {f.id: f for f in await queries.files_where(conn, 'f.id = ANY(%s)', ([r[0] for r in rows],))}
    items = [(files[fid], position, caption) for fid, position, caption in rows if fid in files]
    return items, (str(rows[-1][1]) if more else None)


async def shown_totals(conn, album_id):
    """(count, total bytes) of the items the public sees."""
    row = await _one(conn, 'SELECT count(*), COALESCE(sum(f.size), 0) FROM album_files af '
                           'JOIN files f ON f.id = af.file_id JOIN albums al ON al.id = af.album_id '
                           'WHERE af.album_id = %s AND ' + SHOWN_SQL, (album_id,))
    return int(row[0]), int(row[1])


async def shown_counts(conn, album_ids):
    if not album_ids:
        return {}
    rows = await _all(conn, 'SELECT af.album_id, count(*) FROM album_files af JOIN files f ON f.id = af.file_id '
                            'JOIN albums al ON al.id = af.album_id WHERE af.album_id = ANY(%s) AND ' + SHOWN_SQL +
                            ' GROUP BY af.album_id', (list(album_ids),))
    return {r[0]: r[1] for r in rows}


async def item_count(conn, album_id):
    return (await _one(conn, 'SELECT count(*) FROM album_files WHERE album_id = %s', (album_id,)))[0]


async def set_entries(conn, album_id, entries):
    """Replace the album's rows with [(file_id, caption)], positions 0..n-1."""
    await conn.execute('DELETE FROM album_files WHERE album_id = %s', (album_id,))
    for position, (file_id, caption) in enumerate(entries):
        await conn.execute('INSERT INTO album_files (album_id, file_id, position, caption) VALUES (%s, %s, %s, %s)',
                           (album_id, file_id, position, caption))


async def append_file(conn, album_id, file_id, limit):
    """Append one file at the end, unless it's already there or the album is full."""
    await conn.execute(
        'INSERT INTO album_files (album_id, file_id, position) '
        'SELECT %s, %s, COALESCE(max(position) + 1, 0) FROM album_files WHERE album_id = %s '
        'HAVING count(*) < %s ON CONFLICT DO NOTHING', (album_id, file_id, album_id, limit))
    await conn.execute('UPDATE albums SET updated_at = now(), empty_since = NULL WHERE id = %s', (album_id,))


async def set_caption(conn, album_id, file_id, caption):
    row = await _one(conn, 'UPDATE album_files SET caption = %s WHERE album_id = %s AND file_id = %s RETURNING 1',
                     (caption, album_id, file_id))
    return row is not None


async def file_albums(conn, file_ids):
    """{file id: [(album id, vanity, title)]} of live albums, for owner files."""
    if not file_ids:
        return {}
    rows = await _all(conn, 'SELECT af.file_id, al.id, al.vanity, al.title FROM album_files af '
                            'JOIN albums al ON al.id = af.album_id WHERE af.file_id = ANY(%s) AND {} '
                            'ORDER BY al.id'.format(ALBUM_LIVE_SQL), (list(file_ids),))
    out = {}
    for file_id, album_id, vanity, title in rows:
        out.setdefault(file_id, []).append((album_id, vanity, title))
    return out


async def attach_albums(conn, files):
    by_file = await file_albums(conn, [f.id for f in files])
    for f in files:
        f.albums = by_file.get(f.id, [])
    return files


async def shown_in_albums(conn, file_id):
    """Albums this file is a shown item of (contract milestone-3 §5 `albums`):
    [{"id", "vanity", "access_version"}]. Signed URLs through an album grant work only for these."""
    rows = await _all(conn, 'SELECT al.id, al.vanity, al.access_version FROM album_files af '
                            'JOIN albums al ON al.id = af.album_id JOIN files f ON f.id = af.file_id '
                            'WHERE af.file_id = %s AND {} AND {} ORDER BY al.id'.format(ALBUM_LIVE_SQL, SHOWN_SQL),
                      (file_id,))
    return [{'id': str(r[0]), 'vanity': r[1], 'access_version': r[2]} for r in rows]


async def album_showing(conn, file_id, album_id, access_version):
    """The live album `album_id` at `access_version` when the file is one of its shown items,
    else None (an album token opens only those)."""
    row = await _one(conn, 'SELECT {} FROM album_files af JOIN albums al ON al.id = af.album_id '
                           'JOIN files f ON f.id = af.file_id WHERE af.file_id = %s AND af.album_id = %s '
                           'AND al.access_version = %s AND {} AND {}'.format(ALBUM_COLUMNS, ALBUM_LIVE_SQL, SHOWN_SQL),
                     (file_id, album_id, access_version))
    return row and from_row(Album, row)


async def anonymous_album_expiry(conn, album_ids):
    """Anonymous albums expire when their last file does."""
    if album_ids:
        await conn.execute(
            'UPDATE albums al SET expires_at = (SELECT max(f.expires_at) FROM album_files af JOIN files f '
            'ON f.id = af.file_id WHERE af.album_id = al.id AND f.deleted_at IS NULL) '
            'WHERE al.id = ANY(%s) AND al.owner_user_id IS NULL', (list(album_ids),))
