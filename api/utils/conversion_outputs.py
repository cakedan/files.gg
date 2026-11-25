"""Storing a conversion's output as a normal file (contract milestone-5 §4.4, §4.5, §4.6). Synchronous psycopg: the
converter's work horses call `store_output` and `store_pages`, and the API runs `store_cached` for cache hits in an
executor thread on a sync connection, so every output takes one path.

Each output is hashed and de-duplicated against `file_hashes`, its blob goes to the files bucket under the normal key
(only when new), and the File is created with the normal insert `finalize` uses (db/file_rows.py) in one
transaction under the owner's quota lock, with:
- the caller as owner, no upload key, `derived_from_file_id` and `conversion_id`;
- the access, expiry and name fixed when the conversion was created (`conversions.output_settings`, §1.3, §5.3,
  §5.5), and the source's effective NSFW as `nsfw_marked` (§5.4);
- the storage quota checked (STORAGE_LIMIT_REACHED, no file);
- a new hash's `scan` on the Postgres queue (the normal pipeline: scan -> probe -> derive). A de-duplicated hash
  keeps its scan state; a blocked one is FILE_BLOCKED and no file.
The same transaction marks the conversion `succeeded` (output, output size, progress 1) and, for single-source
single-output recipes, writes `conversion_cache`. A conversion that isn't queued or running any more (cancelled
meanwhile) stores nothing.

Refusals raise ApiError with the contract's codes (§12); the converter saves them as the conversion's error.
"""

import logging
import os
import tempfile
import zipfile

from datetime import timedelta

from db import file_rows, queries
from db.models import Album, columns, from_row
from media import formats
from safety import states
from utils import errors, limits as limits_module, storage as storage_module
from utils.generators import Snowflake
from utils.uploading import Hasher, quota_lock_keys, snowflake_since, ROLLING_WINDOW, utcnow

log = logging.getLogger(__name__)

READ_CHUNK = 1024 * 1024
LIVE_STATUSES = ('queued', 'running')
_s3 = None


class CacheMiss(Exception):
    """A cache hit whose output hash is blocked, held or gone (§4.5): ignore it."""


def s3():
    global _s3
    if _s3 is None:
        _s3 = storage_module.sync_client()
    return _s3


def bucket():
    return storage_module.S3Settings.from_env().bucket


# --- the conversion and its source ----------------------------------------------------------------------------

def _conversion(conn, conversion_id, lock=False):
    from utils.conversions import SELECT, row_dict
    return row_dict(conn.execute('{} WHERE c.id = %s{}'.format(SELECT, ' FOR UPDATE' if lock else ''),
                                 (conversion_id,)).fetchone())


def _source_files(conn, conversion):
    """[(file id, nsfw_override, nsfw_override_source, nsfw_marked, nsfw_auto)] of the sources, in order."""
    if conversion['source_kind'] == formats.IMAGES:
        return conn.execute(
            'SELECT f.id, f.nsfw_override, f.nsfw_override_source, f.nsfw_marked, h.nsfw_auto FROM conversion_sources s '
            'JOIN files f ON f.id = s.file_id JOIN file_hashes h ON h.id = f.hash_id WHERE s.conversion_id = %s '
            'ORDER BY s.position', (conversion['id'],)).fetchall()
    if conversion['source_file_id'] is None:
        return []
    return conn.execute('SELECT f.id, f.nsfw_override, f.nsfw_override_source, f.nsfw_marked, h.nsfw_auto FROM files f '
                        'JOIN file_hashes h ON h.id = f.hash_id WHERE f.id = %s',
                        (conversion['source_file_id'],)).fetchall()


def provenance(conn, conversion):
    """(derived_from_file_id, nsfw_marked): the source (for several, the first) and whether any source is NSFW in
    effect: the uploader's mark, a staff or report override, or `nsfw_auto` (§5.4)."""
    sources = _source_files(conn, conversion)
    nsfw = any(states.file_nsfw(override, source, marked, bool(auto))[0]
               for _, override, source, marked, auto in sources)
    return (sources[0][0] if sources else conversion['source_file_id']), nsfw


# --- quota and blobs -------------------------------------------------------------------------------------------

def _owner_user(conn, conversion):
    from utils.conversions import load_owner
    return load_owner(conn, conversion['owner_user_id']) if conversion['owner_user_id'] is not None else None


def _ip_hashes(settings):
    return [bytes.fromhex(h) for h in settings.get('upload_ip_hashes') or ()]


def check_quota(conn, conversion, adding):
    """The owner's storage limit (signed in) or rolling 24 h cap per guest and per IP (anonymous), under the
    same quota lock uploads take, until the transaction ends. STORAGE_LIMIT_REACHED."""
    settings = conversion['output_settings']
    user = _owner_user(conn, conversion)
    limits = limits_module.get_limits(user)
    ip_hashes = _ip_hashes(settings)
    for key in sorted(set(quota_lock_keys(user.id if user else None, conversion['owner_guest_id'],
                                          ip_hashes[0] if ip_hashes else None))):
        conn.execute(queries.LOCK_QUOTA_SQL, ('quota:' + key,))
    if user is not None:
        used = int(conn.execute(queries.USER_USAGE_SQL, (user.id, user.id)).fetchone()[0])
        limit = limits.storage_bytes
    else:
        since = snowflake_since(ROLLING_WINDOW)
        guest_id = conversion['owner_guest_id']
        by_guest = int(conn.execute(queries.GUEST_USAGE_SQL, (guest_id, since, guest_id))
                             .fetchone()[0])
        by_ip = int(conn.execute(queries.IP_USAGE_SQL, (ip_hashes, since, ip_hashes)).fetchone()[0]) \
            if ip_hashes else 0
        used = max(by_guest, by_ip)
        limit = limits.daily_bytes
    if limit is not None and used + adding > limit:
        raise limits_module.storage_limit_reached(limit, used)


def hash_file(path):
    hasher = Hasher()
    with open(path, 'rb') as handle:
        for piece in iter(lambda: handle.read(READ_CHUNK), b''):
            hasher.update(piece)
    return hasher


def refuse_known(conn, conversion, hasher):
    """A blocked output (a hash-list entry, or a de-duplicated hash that's blocked) is FILE_BLOCKED and stores
    nothing; a CSAM entry also runs the uploader steps of milestone-4 §3.6, as an upload's would."""
    from safety import uploads as safety_uploads
    blake2b, md5, sha1 = hasher.digests()
    code, csam = safety_uploads.known_content(conn, blake2b, md5, sha1, anonymous=False)
    if code is None:
        return
    if csam:
        from safety import csam as csam_rules
        with conn.transaction():
            entry = conn.execute('SELECT id FROM blocked_hashes WHERE blake2b = %s AND md5 = %s AND sha1 = %s',
                                 (blake2b, md5, sha1)).fetchone()
            settings = conversion['output_settings']
            attempt = {'filename': settings.get('name'), 'mimetype': settings.get('mimetype'), 'size': hasher.size,
                       'signed_in': conversion['owner_user_id'] is not None, 'conversion_id': str(conversion['id'])}
            csam_rules.reupload(conn, entry[0] if entry else None, conversion['owner_user_id'],
                                conversion['owner_guest_id'], conversion['owner_ip_hash'], attempt)
    raise errors.file_blocked()


def store_blob(conn, path, hasher):
    """(hash_id, new): de-duplicated, or uploaded to `files/<hash_id>` before its row is inserted."""
    client, name = s3(), bucket()
    return file_rows.stored_hash(conn, client, name, hasher.digests(), hasher.size,
                                 lambda key: client.upload_file(path, name, key))


# --- the File -----------------------------------------------------------------------------------------------------------

def create_file(conn, conversion, hash_id, new_hash, size, name, extension, mimetype, derived_from, nsfw):
    """The output File with the conversion's access, expiry and owner, in the caller's transaction. Returns its id."""
    from safety import scan as safety_scan
    settings = conversion['output_settings']
    ip_hashes = _ip_hashes(settings)
    sealed = settings.get('ip_sealed')
    expires_in = settings.get('expires_in')
    file_id, _ = file_rows.insert_file(
        conn, hash_id=hash_id, mimetype_id=mimetype, extension=extension, filename=name, size=size,
        user_id=conversion['owner_user_id'], guest_id=conversion['owner_guest_id'],
        expires_at=utcnow() + timedelta(seconds=expires_in) if expires_in else None,
        visibility=settings.get('visibility', 'link'), password_hash=settings.get('password_hash'),
        unlock_ttl=settings.get('unlock_ttl') or 3600, uploader_ip_hash=ip_hashes[0] if ip_hashes else None,
        nsfw_marked=nsfw, uploader_abuse_ip_hash=conversion['owner_ip_hash'],
        uploader_ip_sealed=bytes.fromhex(sealed) if sealed else None, view_limit=settings.get('view_limit'),
        view_limit_action=settings.get('view_limit_action') or 'expire', derived_from_file_id=derived_from,
        conversion_id=conversion['id'])
    if file_rows.needs_scan(conn, hash_id, new_hash):
        safety_scan.queue_scan(conn, hash_id)
    return file_id


def succeed(conn, conversion_id, output_size, file_id=None, album_id=None, cached=False):
    """`succeeded`, in the output's transaction; False when it isn't queued or running any more."""
    return conn.execute(
        "UPDATE conversions SET status = 'succeeded', output_file_id = %s, output_album_id = %s, output_size = %s, "
        'progress = 1, stage = NULL, cached = cached OR %s, error = NULL, finished_at = now() '
        "WHERE id = %s AND status IN ('queued', 'running') RETURNING id",
        (file_id, album_id, output_size, cached, conversion_id)).fetchone() is not None


def remember(conn, conversion, output_hash_id):
    """§4.4: (source hash, recipe) -> output hash, for single-source single-output recipes."""
    if not formats.cacheable(conversion['source_kind']) or conversion['source_hash_id'] is None:
        return
    conn.execute('INSERT INTO conversion_cache (source_hash_id, recipe_hash, output_hash_id) VALUES (%s, %s, %s) '
                 'ON CONFLICT (source_hash_id, recipe_hash) DO UPDATE SET output_hash_id = EXCLUDED.output_hash_id, '
                 'created_at = now()', (conversion['source_hash_id'], conversion['recipe_hash'], output_hash_id))


def _store_one(conn, conversion, path, name, extension, mimetype):
    conversion_id = conversion['id']
    hasher = hash_file(path)
    if hasher.size == 0:
        raise errors.conversion_failed('empty_output')
    refuse_known(conn, conversion, hasher)
    derived_from, nsfw = provenance(conn, conversion)
    hash_id, new_hash = store_blob(conn, path, hasher)
    with conn.transaction():
        conversion = _conversion(conn, conversion_id, lock=True)
        if conversion is None or conversion['status'] not in LIVE_STATUSES:
            return
        check_quota(conn, conversion, hasher.size)
        file_id = create_file(conn, conversion, hash_id, new_hash, hasher.size, name, extension, mimetype,
                              derived_from, nsfw)
        succeed(conn, conversion_id, hasher.size, file_id=file_id)
        remember(conn, conversion, hash_id)


def store_output(conn, conversion_id, path, mimetype, filename):
    """A single output (§4.4). `mimetype` must be the target's (else CONVERSION_FAILED `bad_output`); the output's
    name and extension are the ones resolved when the conversion was created (§1.3), so `filename` is only the
    converter's own record of it. Returns nothing; raises ApiError (FILE_BLOCKED, STORAGE_LIMIT_REACHED,
    CONVERSION_FAILED) on refusal."""
    log.debug('storing %s for conversion %s', filename, conversion_id)
    conversion = _conversion(conn, conversion_id)
    if conversion is None or conversion['status'] not in LIVE_STATUSES:
        return
    settings = conversion['output_settings']
    if mimetype != settings['mimetype']:
        raise errors.conversion_failed('bad_output')
    _store_one(conn, conversion, path, settings['name'], settings['extension'], settings['mimetype'])


def store_cached(conn, conversion_id, output_hash_id):
    """A cache hit (§4.5): the File over the cached output hash, without a job. CacheMiss when the hash is blocked,
    held or gone (the caller deletes the cache row and converts). Raises ApiError like `store_output`."""
    conversion = _conversion(conn, conversion_id)
    if conversion is None or conversion['status'] not in LIVE_STATUSES:
        return
    settings = conversion['output_settings']
    derived_from, nsfw = provenance(conn, conversion)
    with conn.transaction():
        row = conn.execute("SELECT size, scan_state FROM file_hashes WHERE id = %s FOR SHARE",
                           (output_hash_id,)).fetchone()
        if row is None or row[1] in ('blocked', 'held'):
            raise CacheMiss()
        conversion = _conversion(conn, conversion_id, lock=True)
        if conversion is None or conversion['status'] not in LIVE_STATUSES:
            return
        check_quota(conn, conversion, row[0])
        file_id = create_file(conn, conversion, output_hash_id, False, row[0], settings['name'],
                              settings['extension'], settings['mimetype'], derived_from, nsfw)
        succeed(conn, conversion_id, row[0], file_id=file_id, cached=True)


# --- PDF -> images (§4.6) -----------------------------------------------------------------------------------------------

def page_names(conn, conversion, count):
    """`<name>-p<page>.<ext>` for each output page, the page zero-padded to the page count's width (§1.3)."""
    settings = conversion['output_settings']
    total = None
    if conversion['source_hash_id'] is not None:
        media = conn.execute('SELECT media FROM file_hashes WHERE id = %s', (conversion['source_hash_id'],)).fetchone()
        total = (media[0] or {}).get('pages') if media else None
    numbers = formats.page_numbers(conversion['options'].get('pages'), total) if isinstance(total, int) else []
    if len(numbers) != count:
        numbers = list(range(1, count + 1))
    width = len(str(max(total or 0, numbers[-1] if numbers else 1)))
    names = []
    for number in numbers:
        suffix = '-p{}'.format(str(number).zfill(width))
        names.append(settings['name'][:128 - len(suffix)] + suffix)
    return names


def store_pages(conn, conversion_id, paths):
    """PDF -> images (§4.6): signed in, a new `grid` album titled after the source with one File per page in order,
    the album and every page with the conversion's access and expiry; anonymous, one ZIP of the pages (stored
    entries, as the album download ZIP) as the output File. Returns nothing; raises ApiError like `store_output`."""
    conversion = _conversion(conn, conversion_id)
    if conversion is None or conversion['status'] not in LIVE_STATUSES:
        return
    if not paths:
        raise errors.conversion_failed('empty_output')
    names = page_names(conn, conversion, len(paths))
    settings = conversion['output_settings']
    if conversion['owner_user_id'] is None:
        _store_zip(conn, conversion, paths, names)
        return
    pages = []
    for path in paths:
        hasher = hash_file(path)
        if hasher.size == 0:
            raise errors.conversion_failed('empty_output')
        refuse_known(conn, conversion, hasher)
        pages.append((path, hasher))
    derived_from, nsfw = provenance(conn, conversion)
    stored = [store_blob(conn, path, hasher) + (hasher.size,) for path, hasher in pages]
    with conn.transaction():
        conversion = _conversion(conn, conversion_id, lock=True)
        if conversion is None or conversion['status'] not in LIVE_STATUSES:
            return
        total = sum(size for _, _, size in stored)
        check_quota(conn, conversion, total)
        album_id = create_album(conn, conversion)
        for position, ((hash_id, new_hash, size), name) in enumerate(zip(stored, names)):
            file_id = create_file(conn, conversion, hash_id, new_hash, size, name, settings['extension'],
                                  settings['mimetype'], derived_from, nsfw)
            conn.execute('INSERT INTO album_files (album_id, file_id, position) VALUES (%s, %s, %s)',
                         (album_id, file_id, position))
        from jobs.media import queue_collage
        queue_collage(conn, album_id)
        succeed(conn, conversion_id, total, album_id=album_id)


def create_album(conn, conversion):
    """The signed-in caller's new album for PDF pages: titled after the source, layout `grid`, with the output's
    access and expiry."""
    from utils.albums import ALBUM_VANITY_LENGTH, TITLE_MAX
    from utils.vanity import MAX_VANITY_ATTEMPTS, generate_id
    settings = conversion['output_settings']
    expires_in = settings.get('expires_in')
    for _ in range(MAX_VANITY_ATTEMPTS):
        row = conn.execute(
            'INSERT INTO albums (id, vanity, owner_user_id, title, layout, visibility, password_hash, unlock_ttl, '
            "expires_at) VALUES (%s, %s, %s, %s, 'grid', %s, %s, %s, %s) ON CONFLICT (vanity) DO NOTHING "
            'RETURNING {}'.format(columns(Album)),
            (Snowflake.generate(), generate_id(ALBUM_VANITY_LENGTH), conversion['owner_user_id'],
             (settings.get('title') or settings['name'])[:TITLE_MAX], settings.get('visibility', 'link'),
             settings.get('password_hash'), settings.get('unlock_ttl') or 3600,
             utcnow() + timedelta(seconds=expires_in) if expires_in else None)).fetchone()
        if row is not None:
            return from_row(Album, row).id
    raise errors.vanity_exhausted()


def _store_zip(conn, conversion, paths, names):
    settings = conversion['output_settings']
    extension = settings['extension']
    handle, archive = tempfile.mkstemp(prefix='pages-', suffix='.zip', dir=os.path.dirname(paths[0]) or None)
    os.close(handle)
    try:
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as out:
            for path, name in zip(paths, names):
                out.write(path, '{}.{}'.format(name, extension))
        suffix = '-pages'
        _store_one(conn, conversion, archive, settings['name'][:128 - len(suffix)] + suffix, formats.ZIP_EXTENSION,
                   formats.ZIP_MIMETYPE)
    finally:
        try:
            os.unlink(archive)
        except FileNotFoundError:
            pass
