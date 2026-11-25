import re

from functools import wraps
from typing import Annotated, Optional

from sanic import Blueprint
from sanic.exceptions import NotFound

import db
import jobs.media as media_jobs
import media as media_rules
from db import albums as album_queries
from db import queries
from utils import access, access_settings, access_token, errors, limits as limits_module, passwords, payloads
from utils import albums as album_rules
from utils import uploading, urls
from utils.generators import Snowflake
from utils.owner import Caller, caller_of
from utils.params import Arg, Args
from utils.responses import ApiResponse
from utils.vanity import MAX_VANITY_ATTEMPTS, generate_id
from utils.wrappers import authenticate, parse_args, route
from db.models import epoch
from safety import ip as abuse_ip, scan as safety_scan
from safety.settings import safety_settings
from utils import standing

import utils.helpers as helpers
import utils.parameters as parameters


# Sanic URL-encodes static route segments ('@' -> '%40') but matches the raw
# request path, so '/users/@me' is routed as '/users/<me>' and anything other
# than '@me' is a 404. GET /users/@me itself is dispatched by views.users.
me = Blueprint('me', url_prefix='/users/<me:str>')


def only_me(func):
    @wraps(func)
    async def wrapper(request, *args, me, **kwargs):
        if me != '@me':
            raise NotFound('Not Found')
        return await func(request, *args, **kwargs)
    return wrapper


@authenticate()
async def fetch_me(request, user):
    """The user object (milestone-6 §2.1), with Milestone 4's `staff` and `restrictions`."""
    from utils import accounts
    async with db.connection() as conn:
        return ApiResponse(await accounts.user_object(conn, user))


# --- Milestone 2 -------------------------------------------------------------------------

@route(me, '/limits', ['GET'])
@only_me
async def fetch_me_limits(request):
    """Signed in: the user's limits and storage use. Anonymous (X-Fingerprint): the anonymous limits, with
    `storage.limit` null (their files expire). Milestone 6 (§9.2) adds premium, the configured single-request
    limit, and the custom domain and upload key counts."""
    from utils.auth import auth_of
    current = auth_of(request)
    if current.dead:
        raise errors.unauthorized()
    user = current.user if current.kind == 'session' else None
    async with db.connection() as conn:
        fingerprint = parameters.fingerprint(request.headers.get('x-fingerprint')) \
            if request.headers.get('x-fingerprint') else None
        if user is None and fingerprint is None:
            raise errors.unauthorized()
        owner = uploading.Owner(user, fingerprint, helpers.client_ip(request), request.app.ctx.view_hash_secret)
        used = await owner.usage(conn)
        domains_used = keys_used = 0
        if user is not None:
            cursor = await conn.execute(
                "SELECT (SELECT count(*) FROM custom_domains WHERE user_id = %s AND deleted_at IS NULL AND "
                "status <> 'disabled'), (SELECT count(*) FROM upload_keys WHERE user_id = %s AND revoked_at IS NULL "
                'AND (expires_at IS NULL OR expires_at > now()))', (user.id, user.id))
            domains_used, keys_used = await cursor.fetchone()
    limits = owner.limits
    body = {
        'storage': {'used': used, 'limit': limits.storage_bytes},
        'max_file_size_single': limits.max_file_size_single,
        'max_file_size_single_configured': limits.max_file_size_single_configured,
        'max_file_size_chunked': limits.max_file_size_chunked,
        'max_expiry': limits.max_expiry,
        'allow_no_expiry': limits.allow_no_expiry,
        'anonymous': limits.anonymous,
        'premium': limits.premium,
        'custom_domains': {'used': domains_used, 'limit': limits.custom_domains},
        'upload_keys': {'used': keys_used, 'limit': limits.upload_keys_max},
        'domain_only_allowed': limits.domain_only_allowed,
    }
    if limits.anonymous:
        # extra: the rolling 24 h cap that applies instead of a storage limit
        body['daily'] = {'used': used, 'limit': limits.daily_bytes}
    # Milestone 3: album limits
    body['album_max_files'] = limits.album_max_files
    body['albums_max'] = limits.albums_max
    # Milestone 4 (§13): adult content needs an account in good standing
    restricted = False
    if user is not None:
        from utils import standing
        async with db.connection() as conn:
            restricted = bool(await standing.restrictions(conn, user.id))
    body['nsfw_allowed'] = user is not None and not restricted
    return ApiResponse(body)


def epoch_or_null(value):
    if value is None:
        return None
    number = int(value)
    if number <= 0:
        raise ValueError('Must be a positive epoch time in seconds, or null')
    return number


def id_list(limit):
    """A JSON list of ids (strings or numbers), at most `limit`, duplicates dropped."""
    def parse(value):
        if not isinstance(value, (list, tuple)):
            raise ValueError('Must be a list of ids')
        if len(value) > limit:
            raise ValueError('Must have {} ids or fewer'.format(limit))
        out = []
        for item in value:
            if isinstance(item, bool):
                raise ValueError('Must be a list of ids')
            number = parameters.snowflake(item)
            if number not in out:
                out.append(number)
        return out
    return parse


def new_filename(value):
    name = re.sub(uploading.FILENAME_REGEX, '_', str(value)).strip()
    if not name:
        raise ValueError('Must not be empty')
    if len(name) > 128:
        raise ValueError('Must be 128 characters or fewer')
    return name


class PatchFileArgs(Args):
    visibility: Annotated[Optional[str], Arg(choices=uploading.VISIBILITIES)] = None
    password: Annotated[Optional[str], Arg(type=passwords.validate, trim=False)] = None
    generate_password: Annotated[Optional[bool], Arg(type=uploading.boolean)] = False
    unlock_ttl: Annotated[Optional[int], Arg(type=uploading.unlock_ttl)] = None
    password_expires_at: Annotated[Optional[int], Arg(type=epoch_or_null)] = None
    password_expires_in: Annotated[Optional[int], Arg(type=uploading.positive_int)] = None
    show_name_when_locked: Annotated[Optional[bool], Arg(type=uploading.boolean)] = None
    expires_at: Annotated[Optional[int], Arg(type=epoch_or_null)] = None
    expires_in: Annotated[Optional[int], Arg(type=uploading.positive_int)] = None
    # Milestone 3: renames the name only; the extension stays
    filename: Annotated[Optional[str], Arg(type=new_filename)] = None
    # Milestone 4 (§4.5): the uploader's own NSFW mark
    nsfw: Annotated[Optional[bool], Arg(type=uploading.boolean)] = None


def _owned_file_id(file_id):
    try:
        return parameters.snowflake(file_id)
    except ValueError:
        raise errors.unknown_file()


def _expiry_seconds(caller, seconds):
    """`expires_in` seconds (None = keep forever) checked against the caller's limits."""
    if seconds is None:
        if not caller.limits.allow_no_expiry:
            raise limits_module.expiry_not_allowed(caller.limits)
        return None
    if seconds < limits_module.MIN_EXPIRY or (
            caller.limits.max_expiry is not None and seconds > caller.limits.max_expiry):
        raise limits_module.expiry_not_allowed(caller.limits)
    return seconds


async def _owner_files(conn, caller, file_ids):
    """The caller's live files among `file_ids`, in that order, as owner files."""
    if not file_ids:
        return []
    owner_sql, owner_params = caller.file_filter()
    files = await queries.files_where(conn, 'f.id = ANY(%s) AND ' + owner_sql, [list(file_ids)] + owner_params)
    await album_queries.attach_albums(conn, files)
    order = {fid: i for i, fid in enumerate(file_ids)}
    return sorted(files, key=lambda f: order.get(f.id, 0))


async def _owner_file(conn, caller, file_id):
    files = await _owner_files(conn, caller, [_owned_file_id(file_id)])
    if not files:
        raise errors.unknown_file()
    return files[0]


@route(me, '/files/<file_id:str>', ['PATCH'])
@only_me
@parse_args(PatchFileArgs)
async def patch_file(request, args, file_id):
    """Access, expiry and the name. Changing the visibility or the password, or
    shortening unlock_ttl or password_expires_at, bumps access_version, which
    revokes every outstanding token and #pw= link."""
    sent = access_settings.sent_fields(request)
    now = access.now()
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        fobj = await _owner_file(conn, caller, file_id)
        password = await access_settings.NewPassword.from_args(args)
        changes, _ = access_settings.access_changes(fobj, args, sent, now, password, anonymous=caller.anonymous)

        if args.expires_in is not None or 'expires_at' in sent:
            if args.expires_in is not None:
                seconds = args.expires_in
            elif args.expires_at is None:
                seconds = None
            else:
                seconds = args.expires_at - now
            seconds = _expiry_seconds(caller, seconds)
            changes['expires_at'] = uploading.from_epoch(now + seconds) if seconds is not None else None

        if args.filename is not None:
            name = args.filename
            if fobj.extension and name.lower().endswith('.' + fobj.extension.lower()) and \
                    len(name) > len(fobj.extension) + 1:
                name = name[:-(len(fobj.extension) + 1)]
            if name != fobj.filename:
                changes['filename'] = name

        if args.nsfw is not None:
            changes.update(nsfw_change(caller, fobj, args.nsfw))

        if changes:
            async with conn.transaction():
                await queries.update_file(conn, fobj.id, **changes)
                if 'expires_at' in changes:
                    await album_queries.anonymous_album_expiry(conn, [a[0] for a in fobj.albums or ()])
                if 'visibility' in changes:
                    for album_id, _, _ in fobj.albums or ():
                        await media_jobs.queue_collage_async(conn, album_id)
            fobj = await _owner_file(conn, caller, fobj.id)
    body = payloads.owner_dict(fobj)
    if password.generated:
        payloads.with_password(body, fobj, password.plain)
    return ApiResponse(body)


def nsfw_change(caller, fobj, nsfw):
    """Milestone-4 §4.5: signed-in uploaders mark and unmark their own files; unmarking only when
    the source is `uploader` and nothing else would keep it marked (NSFW_LOCKED)."""
    from safety import states
    if caller.anonymous:
        raise errors.nsfw_requires_account()
    if nsfw:
        return {'nsfw_marked': True} if not fobj.nsfw_marked else {}
    nsfw_now, _ = payloads.nsfw_of(fobj)
    if nsfw_now and states.nsfw_locked(fobj.nsfw_override, fobj.hash.nsfw_auto if fobj.hash else False):
        raise errors.nsfw_locked()
    return {'nsfw_marked': False} if fobj.nsfw_marked else {}


@route(me, '/files/<file_id:str>', ['GET'])
@only_me
async def fetch_my_file(request, file_id):
    """The owner file (milestone-4 §6.2). A file deleted with an upload-rejection code answers
    410 UPLOAD_REJECTED { reason } for 24 hours, then 404 UNKNOWN_FILE."""
    from safety.states import UPLOAD_REJECTIONS
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        file_id = _owned_file_id(file_id)
        files = await _owner_files(conn, caller, [file_id])
        if files:
            return ApiResponse(payloads.owner_dict(files[0]))
        owner_sql, owner_params = caller.file_filter()
        cursor = await conn.execute(
            "SELECT f.deleted_reason FROM files f WHERE f.id = %s AND {} AND f.deleted_reason = ANY(%s) "
            "AND f.deleted_at > now() - interval '24 hours'".format(owner_sql),
            [file_id] + owner_params + [list(UPLOAD_REJECTIONS)])
        row = await cursor.fetchone()
    if row is not None:
        raise errors.upload_rejected(row[0])
    raise errors.unknown_file()


class BulkNsfwArgs(Args):
    file_ids: Annotated[list, Arg(type=id_list(100))]
    nsfw: Annotated[bool, Arg(type=uploading.boolean)]


@route(me, '/files/nsfw', ['POST'])
@only_me
@parse_args(BulkNsfwArgs)
async def bulk_nsfw(request, args):
    """Up to 100 ids; ids you don't own, or can't unmark, are skipped (milestone-4 §6.2)."""
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        if caller.anonymous:
            raise errors.nsfw_requires_account()
        files = await _owner_files(conn, caller, args.file_ids)
        done, skipped = [], [fid for fid in args.file_ids if fid not in {f.id for f in files}]
        async with conn.transaction():
            for fobj in files:
                try:
                    changes = nsfw_change(caller, fobj, args.nsfw)
                except Exception:
                    skipped.append(fobj.id)
                    continue
                if changes:
                    await queries.update_file(conn, fobj.id, **changes)
                done.append(fobj.id)
        files = await _owner_files(conn, caller, done)
    return ApiResponse({'items': [payloads.owner_dict(f) for f in files], 'skipped': [str(x) for x in skipped]})


class NsfwReviewArgs(Args):
    message: Annotated[Optional[str], Arg(type=str, trim=False)] = None


@route(me, '/files/<file_id:str>/nsfw-review', ['POST'])
@only_me
@parse_args(NsfwReviewArgs)
async def nsfw_review(request, args, file_id):
    """An auto-marked file's uploader asks for review: a P3 case (content_flags.source = owner),
    once per file (409 APPEAL_NOT_ALLOWED after)."""
    from safety import core
    from safety.reports import clean_text
    from safety.run import in_thread
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        if caller.anonymous:
            raise errors.nsfw_requires_account()
        fobj = await _owner_file(conn, caller, file_id)
    _, source = payloads.nsfw_of(fobj)
    if source != 'auto':
        raise errors.appeal_not_allowed()
    message = clean_text(args.message, field='message')

    def ask(sync_conn):
        if sync_conn.execute("SELECT 1 FROM content_flags WHERE file_id = %s AND source = 'owner'",
                             (fobj.id,)).fetchone():
            raise errors.appeal_not_allowed()
        case_id = core.open_case(sync_conn, 'file', 3, fobj.id)
        core.add_flag(sync_conn, 'owner', 'nsfw_review', case_id=case_id, file_id=fobj.id, hash_id=fobj.hash_id,
                      details={'message': message} if message else None)
    await in_thread(ask)
    return ApiResponse({'status': 'open'}, status=202)


# --- the library (contract milestone-3 §6) ---------------------------------------------------------

SORTS = {
    '-created': 'f.id DESC',
    'created': 'f.id ASC',
    '-size': 'f.size DESC NULLS LAST, f.id DESC',
    'size': 'f.size ASC NULLS FIRST, f.id ASC',
    'name': 'lower(f.filename) ASC, f.id ASC',
    '-name': 'lower(f.filename) DESC, f.id DESC',
}
TYPES = ('image', 'video', 'audio', 'text', 'pdf', 'other')


def kind_sql():
    """payloads.viewer_kind() in SQL, with 'other' for `file`."""
    browser = ', '.join("'{}'".format(m) for m in sorted(payloads.BROWSER_IMAGES))
    excluded = ', '.join("'{}'".format(m) for m in sorted(media_rules.TEXT_EXCLUDED))
    mime = 'lower(f.mimetype_id)'
    return (
        "CASE WHEN {m} IN ({browser}) THEN 'image' "
        "WHEN {m} = 'application/pdf' THEN 'pdf' "
        "WHEN {m} LIKE 'video/%%' THEN 'video' "
        "WHEN {m} LIKE 'audio/%%' THEN 'audio' "
        "WHEN {m} LIKE 'text/%%' AND {m} NOT IN ({excluded}) THEN 'text' "
        "WHEN ({m} LIKE 'image/%%' AND {m} <> 'image/svg+xml' OR {m} IN ('application/x-photoshop', "
        "'application/photoshop', 'application/psd')) AND EXISTS (SELECT 1 FROM file_hash_assets a "
        "WHERE a.hash_id = f.hash_id AND a.kind = 'display') THEN 'image' "
        "ELSE 'other' END").format(m=mime, browser=browser, excluded=excluded)


class ListFilesArgs(Args):
    query: Annotated[Optional[str], Arg(location='args')] = None
    sort_by: Annotated[Optional[str], Arg(location='args', choices=tuple(SORTS))] = '-created'
    type: Annotated[Optional[str], Arg(location='args', choices=TYPES)] = None
    visibility: Annotated[Optional[str], Arg(location='args', choices=uploading.VISIBILITIES)] = None
    temporary: Annotated[Optional[bool], Arg(location='args', type=uploading.boolean)] = False
    offset: Annotated[Optional[int], Arg(location='args', type=int, choices=range(0, 10 ** 9),
                                         help='Must be 0 or more')] = 0
    limit: Annotated[Optional[int], Arg(location='args', type=int, choices=range(1, 101),
                                        help='Must be at least or in between 1 and 100')] = 25


@route(me, '/files', ['GET'])
@only_me
@parse_args(ListFilesArgs)
async def list_my_files(request, args):
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        owner_sql, owner_params = caller.file_filter()
        where, params = [owner_sql], list(owner_params)
        if args.query:
            pattern = album_queries.like_pattern(args.query)
            where.append("(lower(f.filename) LIKE %s OR lower(f.filename || '.' || coalesce(f.extension, '')) "
                         "LIKE %s)")
            params += [pattern, pattern]
        if args.type:
            where.append('({}) = %s'.format(kind_sql()))
            params.append(args.type)
        if args.visibility:
            where.append('f.visibility = %s')
            params.append(args.visibility)
        if args.temporary:
            where.append('f.expires_at IS NOT NULL')
        where_sql = ' AND '.join(where)
        count, size = await queries.count_where(conn, where_sql, params)
        total_count, total_size = await queries.count_where(conn, owner_sql, owner_params)
        files = await queries.files_where(conn, where_sql, params, order=SORTS[args.sort_by or '-created'],
                                          limit=args.limit or 25, offset=args.offset or 0)
        await album_queries.attach_albums(conn, files)
    return ApiResponse({
        'count': count,
        'items': [payloads.owner_dict(f) for f in files],
        'size': size,
        'total': {'count': total_count, 'size': total_size},
    })


@route(me, '/files/<file_id:str>', ['DELETE'])
@only_me
async def delete_my_file(request, file_id):
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        owner_sql, owner_params = caller.file_filter()
        async with conn.transaction():
            deleted = await queries.soft_delete_files(
                conn, 'f.id = %s AND {} AND {}'.format(owner_sql, queries.LIVE),
                [_owned_file_id(file_id)] + owner_params)
    if not deleted:
        raise errors.unknown_file()
    return ApiResponse(status=204)


BULK_LIMIT = 100


class BulkDeleteArgs(Args):
    file_ids: Annotated[list, Arg(type=id_list(BULK_LIMIT))]


@route(me, '/files/delete', ['POST'])
@only_me
@parse_args(BulkDeleteArgs)
async def bulk_delete(request, args):
    """Up to 100 ids; ids you don't own are skipped."""
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        owner_sql, owner_params = caller.file_filter()
        async with conn.transaction():
            deleted = await queries.soft_delete_files(
                conn, 'f.id = ANY(%s) AND {} AND {}'.format(owner_sql, queries.LIVE),
                [list(args.file_ids)] + owner_params)
    order = {fid: i for i, fid in enumerate(args.file_ids)}
    return ApiResponse({'deleted': [str(x) for x in sorted(deleted, key=order.get)]})


def _nullable_seconds(value):
    return None if value is None else uploading.positive_int(value)


class BulkExpiryArgs(Args):
    file_ids: Annotated[list, Arg(type=id_list(BULK_LIMIT))]
    # required, and null means "keep forever"
    expires_in: Annotated[Optional[int], Arg(type=_nullable_seconds)]


@route(me, '/files/expiry', ['POST'])
@only_me
@parse_args(BulkExpiryArgs)
async def bulk_expiry(request, args):
    now = access.now()
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        seconds = _expiry_seconds(caller, args.expires_in)
        expires_at = uploading.from_epoch(now + seconds) if seconds is not None else None
        files = await _owner_files(conn, caller, args.file_ids)
        async with conn.transaction():
            for fobj in files:
                await queries.update_file(conn, fobj.id, expires_at=expires_at)
            await album_queries.anonymous_album_expiry(conn, {a[0] for f in files for a in f.albums or ()})
        files = await _owner_files(conn, caller, [f.id for f in files])
    return ApiResponse({'items': [payloads.owner_dict(f) for f in files]})


class BulkAccessArgs(Args):
    file_ids: Annotated[list, Arg(type=id_list(BULK_LIMIT))]
    visibility: Annotated[str, Arg(choices=uploading.VISIBILITIES)]
    password: Annotated[Optional[str], Arg(type=passwords.validate, trim=False)] = None
    generate_password: Annotated[Optional[bool], Arg(type=uploading.boolean)] = False
    unlock_ttl: Annotated[Optional[int], Arg(type=uploading.unlock_ttl)] = None
    password_expires_at: Annotated[Optional[int], Arg(type=epoch_or_null)] = None
    password_expires_in: Annotated[Optional[int], Arg(type=uploading.positive_int)] = None
    show_name_when_locked: Annotated[Optional[bool], Arg(type=uploading.boolean)] = None


@route(me, '/files/access', ['POST'])
@only_me
@parse_args(BulkAccessArgs)
async def bulk_access(request, args):
    """The same rules as a file's PATCH, for many files; one generated password is
    shared by the batch and returned once."""
    sent = access_settings.sent_fields(request)
    now = access.now()
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        files = await _owner_files(conn, caller, args.file_ids)
        password = await access_settings.NewPassword.from_args(args)
        planned = [(f, access_settings.access_changes(f, args, sent, now, password, anonymous=caller.anonymous)[0])
                   for f in files]
        async with conn.transaction():
            for fobj, changes in planned:
                if changes:
                    await queries.update_file(conn, fobj.id, **changes)
                    if 'visibility' in changes:
                        for album_id, _, _ in fobj.albums or ():
                            await media_jobs.queue_collage_async(conn, album_id)
        files = await _owner_files(conn, caller, [f.id for f in files])
    body = {'items': [payloads.owner_dict(f) for f in files]}
    if password.generated:
        body['password'] = password.plain
    return ApiResponse(body)


@route(me, '/files/<file_id:str>/pass', ['POST'])
@only_me
@authenticate()
async def file_owner_pass(request, file_id, user):
    """A 1 h owner token (contract §5): opens the owner's own file anywhere."""
    async with db.connection() as conn:
        fobj = await queries.get_owned_file(conn, _owned_file_id(file_id), user.id)
    if fobj is None:
        raise errors.unknown_file()
    now = access.now()
    expires_at = now + access_token.OWNER_PASS_SECONDS
    token = access.mint(request, fobj, 'owner', now, expires_at)
    return ApiResponse({'token': token, 'expires_at': expires_at,
                        'url': urls.public_url('/{}#t={}'.format(fobj.vanity, token))})


# --- albums (contract milestone-3 §6) ------------------------------------------------------------------

# parsed generously; the album limits answer with ALBUM_FULL / ANONYMOUS_ALBUM_NOT_ALLOWED
ALBUM_IDS_PARSE_LIMIT = 5000
ANONYMOUS_ALBUM_WINDOW = 3600
ALBUM_SORTS = {
    '-created': 'al.id DESC',
    'created': 'al.id ASC',
    '-updated': 'al.updated_at DESC, al.id DESC',
    'updated': 'al.updated_at ASC, al.id ASC',
    'title': "lower(coalesce(al.title, '')) ASC, al.id ASC",
    '-title': "lower(coalesce(al.title, '')) DESC, al.id DESC",
}


def _text(limit, field):
    def parse(value):
        return album_rules.clean_text(value, limit, field)
    return parse


def _optional_id(value):
    return None if value is None or value == '' else parameters.snowflake(value)


def _album_id(album_id):
    try:
        return parameters.snowflake(album_id)
    except ValueError:
        raise errors.unknown_album()


class CreateAlbumArgs(Args):
    title: Annotated[Optional[str], Arg(type=_text(album_rules.TITLE_MAX, 'Title'), trim=False)] = None
    description: Annotated[Optional[str], Arg(type=_text(album_rules.DESCRIPTION_MAX, 'Description'),
                                              trim=False)] = None
    layout: Annotated[Optional[str], Arg(choices=album_rules.LAYOUTS)] = None
    file_ids: Annotated[Optional[list], Arg(type=id_list(ALBUM_IDS_PARSE_LIMIT))] = None
    cover_file_id: Annotated[Optional[int], Arg(type=_optional_id)] = None


async def _owner_album_body(conn, album):
    items = await album_queries.owner_items(conn, album.id)
    await album_queries.attach_albums(conn, [f for f, _, _ in items])
    cursor = await conn.execute("SELECT id FROM user_warnings WHERE target->>'kind' = 'album' AND target->>'id' = %s "
                                'ORDER BY id DESC LIMIT 1', (str(album.id),))
    notice = await cursor.fetchone()
    return album_rules.owner_album(album, items, notice_id=str(notice[0]) if notice else None)


async def _check_files(conn, caller, file_ids):
    """Only your own, live files: else INVALID_ALBUM_FILES with the offending ids."""
    found = {f.id for f in await _owner_files(conn, caller, file_ids)}
    missing = [fid for fid in file_ids if fid not in found]
    if missing:
        raise errors.invalid_album_files(missing)


async def _album_changed(conn, album_id, **changes):
    album = await album_queries.update_album(conn, album_id, **changes)
    await media_jobs.queue_collage_async(conn, album_id)
    return album


@route(me, '/albums', ['POST'])
@only_me
@parse_args(CreateAlbumArgs)
async def create_album(request, args):
    file_ids = list(args.file_ids or [])
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        # milestone-4 §9.3: bans and upload restrictions also stop album creation
        await standing.check_uploader(conn, caller.user, caller.fingerprint, abuse_ip.abuse_ip_hash(
            helpers.client_ip(request), safety_settings().abuse_hash_secret))
        limits = caller.limits
        expires_at = None
        if caller.anonymous:
            # only right after an upload batch: <= 50 files, all this fingerprint's, from the last hour
            if not file_ids or len(file_ids) > limits.album_max_files:
                raise errors.anonymous_album_not_allowed()
            files = await _owner_files(conn, caller, file_ids)
            since = uploading.snowflake_since(ANONYMOUS_ALBUM_WINDOW)
            if len(files) != len(file_ids) or any(f.id < since for f in files):
                raise errors.anonymous_album_not_allowed()
            expiries = [f.expires_at for f in files]
            expires_at = None if any(e is None for e in expiries) else max(expiries)
        else:
            if limits.albums_max is not None and \
                    await album_queries.count_owned_albums(conn, caller) >= limits.albums_max:
                raise errors.album_limit_reached(limits.albums_max)
            if len(file_ids) > limits.album_max_files:
                raise errors.album_full(limits.album_max_files)
            await _check_files(conn, caller, file_ids)
        if args.cover_file_id is not None and args.cover_file_id not in file_ids:
            raise errors.invalid_album_files([args.cover_file_id])
        async with conn.transaction():
            album = None
            for _ in range(MAX_VANITY_ATTEMPTS):
                vanity = generate_id(album_rules.ALBUM_VANITY_LENGTH)
                album = await album_queries.create_album(
                    conn, id=Snowflake.generate(), vanity=vanity,
                    owner_user_id=caller.user.id if caller.user else None, owner_fingerprint=caller.fingerprint,
                    title=args.title, description=args.description, layout=args.layout or 'auto',
                    cover_file_id=args.cover_file_id, expires_at=expires_at)
                if album is not None:
                    break
            if album is None:
                raise errors.vanity_exhausted()
            await album_queries.set_entries(conn, album.id, [(fid, None) for fid in file_ids])
            await media_jobs.queue_collage_async(conn, album.id)
            if args.title or args.description:
                await safety_scan.queue_album_text_async(conn, album.id)
        body = await _owner_album_body(conn, album)
    return ApiResponse(body, status=201)


class ListAlbumsArgs(Args):
    query: Annotated[Optional[str], Arg(location='args')] = None
    sort_by: Annotated[Optional[str], Arg(location='args', choices=tuple(ALBUM_SORTS))] = '-created'
    offset: Annotated[Optional[int], Arg(location='args', type=int, choices=range(0, 10 ** 9),
                                         help='Must be 0 or more')] = 0
    limit: Annotated[Optional[int], Arg(location='args', type=int, choices=range(1, 101),
                                        help='Must be at least or in between 1 and 100')] = 25


@route(me, '/albums', ['GET'])
@only_me
@parse_args(ListAlbumsArgs)
async def list_my_albums(request, args):
    async with db.connection() as conn:
        caller = await caller_of(conn, request)
        count, albums = await album_queries.list_owned_albums(
            conn, caller, args.query, ALBUM_SORTS[args.sort_by or '-created'], args.offset or 0, args.limit or 25)
        counts = await album_queries.shown_counts(conn, [a.id for a in albums])
        items = []
        for album in albums:
            shown, _ = await album_queries.shown_items(conn, album, limit=album_rules.PAGE_SIZE)
            items.append(album_rules.owner_summary(album, counts.get(album.id, 0), [f for f, _, _ in shown]))
    return ApiResponse({'count': count, 'items': items})


async def _my_album(conn, request, album_id, edit=False, for_update=False):
    caller = await caller_of(conn, request)
    if edit and caller.anonymous:
        raise errors.anonymous_album_not_allowed()
    album = await album_queries.get_owned_album(conn, _album_id(album_id), caller, for_update=for_update)
    if album is None:
        raise errors.unknown_album()
    return caller, album


@route(me, '/albums/<album_id:str>', ['GET'])
@only_me
async def fetch_my_album(request, album_id):
    async with db.connection() as conn:
        _, album = await _my_album(conn, request, album_id)
        return ApiResponse(await _owner_album_body(conn, album))


class PatchAlbumArgs(Args):
    title: Annotated[Optional[str], Arg(type=_text(album_rules.TITLE_MAX, 'Title'), trim=False)] = None
    description: Annotated[Optional[str], Arg(type=_text(album_rules.DESCRIPTION_MAX, 'Description'),
                                              trim=False)] = None
    layout: Annotated[Optional[str], Arg(choices=album_rules.LAYOUTS)] = None
    cover_file_id: Annotated[Optional[int], Arg(type=_optional_id)] = None
    visibility: Annotated[Optional[str], Arg(choices=uploading.VISIBILITIES)] = None
    password: Annotated[Optional[str], Arg(type=passwords.validate, trim=False)] = None
    generate_password: Annotated[Optional[bool], Arg(type=uploading.boolean)] = False
    unlock_ttl: Annotated[Optional[int], Arg(type=uploading.unlock_ttl)] = None
    password_expires_at: Annotated[Optional[int], Arg(type=epoch_or_null)] = None
    password_expires_in: Annotated[Optional[int], Arg(type=uploading.positive_int)] = None
    show_name_when_locked: Annotated[Optional[bool], Arg(type=uploading.boolean)] = None
    # Milestone 4 (§4.5): the album's own NSFW mark
    nsfw: Annotated[Optional[bool], Arg(type=uploading.boolean)] = None


@route(me, '/albums/<album_id:str>', ['PATCH'])
@only_me
@parse_args(PatchAlbumArgs)
async def patch_my_album(request, args, album_id):
    sent = access_settings.sent_fields(request)
    now = access.now()
    async with db.connection() as conn:
        caller, album = await _my_album(conn, request, album_id, edit=True)
        password = await access_settings.NewPassword.from_args(args)
        changes, _ = access_settings.access_changes(album, args, sent, now, password, anonymous=caller.anonymous)
        for field in ('title', 'description'):
            if field in sent:
                changes[field] = getattr(args, field)
        if args.layout is not None:
            changes['layout'] = args.layout
        if args.nsfw is not None:
            if args.nsfw and not album.nsfw:
                changes.update(nsfw=True, nsfw_source='owner')
            elif not args.nsfw and album.nsfw:
                if album.nsfw_source == 'moderator':
                    raise errors.nsfw_locked()
                changes.update(nsfw=False, nsfw_source=None)
        if 'cover_file_id' in sent:
            if args.cover_file_id is not None and args.cover_file_id not in {
                    fid for fid, _, _ in await album_queries.album_entries(conn, album.id)}:
                raise errors.invalid_album_files([args.cover_file_id])
            changes['cover_file_id'] = args.cover_file_id
        async with conn.transaction():
            album = await _album_changed(conn, album.id, **changes)
            if 'title' in changes or 'description' in changes:
                await safety_scan.queue_album_text_async(conn, album.id)
        body = await _owner_album_body(conn, album)
    if password.generated:
        body['password'] = password.plain
        body['url_with_password'] = urls.public_url('/a/{}#pw={}'.format(album.vanity, password.plain))
    return ApiResponse(body)


class DeleteAlbumArgs(Args):
    delete_files: Annotated[Optional[bool], Arg(location='args', type=uploading.boolean)] = False


@route(me, '/albums/<album_id:str>', ['DELETE'])
@only_me
@parse_args(DeleteAlbumArgs, form=False)
async def delete_my_album(request, args, album_id):
    """Deleting an album never deletes its files, unless `delete_files=true`."""
    async with db.connection() as conn:
        caller, album = await _my_album(conn, request, album_id, edit=True)
        async with conn.transaction():
            if args.delete_files:
                owner_sql, owner_params = caller.file_filter()
                await queries.soft_delete_files(
                    conn, 'f.id IN (SELECT file_id FROM album_files WHERE album_id = %s) AND {} AND {}'.format(
                        owner_sql, queries.LIVE), [album.id] + owner_params)
            await album_queries.update_album(conn, album.id, deleted_at=uploading.utcnow())
    return ApiResponse(status=204)


class AlbumFilesArgs(Args):
    file_ids: Annotated[list, Arg(type=id_list(ALBUM_IDS_PARSE_LIMIT))]
    position: Annotated[Optional[int], Arg(type=int)] = None


async def _entries_changed(conn, album, entries):
    """Write the new item list; a cover that left the album goes back to automatic."""
    await album_queries.set_entries(conn, album.id, entries)
    changes = {'empty_since': None} if entries else {}
    if album.cover_file_id is not None and album.cover_file_id not in {fid for fid, _ in entries}:
        changes['cover_file_id'] = None
    return await _album_changed(conn, album.id, **changes)


@route(me, '/albums/<album_id:str>/files', ['PUT'])
@only_me
@parse_args(AlbumFilesArgs)
async def set_album_files(request, args, album_id):
    """The exact list and order: adds, removes and reorders in one call."""
    async with db.connection() as conn:
        caller, album = await _my_album(conn, request, album_id, edit=True)
        file_ids = list(args.file_ids)
        if len(file_ids) > caller.limits.album_max_files:
            raise errors.album_full(caller.limits.album_max_files)
        await _check_files(conn, caller, file_ids)
        async with conn.transaction():
            album = await album_queries.get_owned_album(conn, album.id, caller, for_update=True)
            captions = {fid: caption for fid, _, caption in await album_queries.album_entries(conn, album.id)}
            album = await _entries_changed(conn, album, [(fid, captions.get(fid)) for fid in file_ids])
        return ApiResponse(await _owner_album_body(conn, album))


@route(me, '/albums/<album_id:str>/files', ['POST'])
@only_me
@parse_args(AlbumFilesArgs)
async def add_album_files(request, args, album_id):
    """Append, or insert at `position`; files already in the album are skipped."""
    async with db.connection() as conn:
        caller, album = await _my_album(conn, request, album_id, edit=True)
        async with conn.transaction():
            album = await album_queries.get_owned_album(conn, album.id, caller, for_update=True)
            entries = [(fid, caption) for fid, _, caption in await album_queries.album_entries(conn, album.id)]
            present = {fid for fid, _ in entries}
            new = [fid for fid in args.file_ids if fid not in present]
            if len(entries) + len(new) > caller.limits.album_max_files:
                raise errors.album_full(caller.limits.album_max_files)
            await _check_files(conn, caller, new)
            at = len(entries) if args.position is None else max(0, min(args.position, len(entries)))
            entries = entries[:at] + [(fid, None) for fid in new] + entries[at:]
            album = await _entries_changed(conn, album, entries)
        return ApiResponse(await _owner_album_body(conn, album))


def _item_id(file_id):
    try:
        return parameters.snowflake(file_id)
    except ValueError:
        raise errors.unknown_file()


@route(me, '/albums/<album_id:str>/files/<file_id:str>', ['DELETE'])
@only_me
async def remove_album_file(request, album_id, file_id):
    async with db.connection() as conn:
        caller, album = await _my_album(conn, request, album_id, edit=True)
        file_id = _item_id(file_id)
        async with conn.transaction():
            album = await album_queries.get_owned_album(conn, album.id, caller, for_update=True)
            entries = [(fid, caption) for fid, _, caption in await album_queries.album_entries(conn, album.id)]
            if any(fid == file_id for fid, _ in entries):
                album = await _entries_changed(conn, album, [e for e in entries if e[0] != file_id])
        return ApiResponse(await _owner_album_body(conn, album))


class CaptionArgs(Args):
    caption: Annotated[Optional[str], Arg(type=_text(album_rules.CAPTION_MAX, 'Caption'), trim=False)] = None


@route(me, '/albums/<album_id:str>/files/<file_id:str>', ['PATCH'])
@only_me
@parse_args(CaptionArgs)
async def caption_album_file(request, args, album_id, file_id):
    async with db.connection() as conn:
        _, album = await _my_album(conn, request, album_id, edit=True)
        async with conn.transaction():
            if not await album_queries.set_caption(conn, album.id, _item_id(file_id), args.caption):
                raise errors.unknown_file()
            await safety_scan.queue_album_text_async(conn, album.id)
            album = await album_queries.update_album(conn, album.id)
        return ApiResponse(await _owner_album_body(conn, album))


@route(me, '/albums/<album_id:str>/pass', ['POST'])
@only_me
@authenticate()
async def album_owner_pass(request, album_id, user):
    """A 1 h owner token for the album (contract milestone-2 §5)."""
    async with db.connection() as conn:
        album = await album_queries.get_owned_album(conn, _album_id(album_id), Caller(user, None))
    if album is None:
        raise errors.unknown_album()
    now = access.now()
    expires_at = now + access_token.OWNER_PASS_SECONDS
    token = access.mint(request, album, 'owner', now, expires_at, kind='album')
    return ApiResponse({'token': token, 'expires_at': expires_at,
                        'url': urls.public_url('/a/{}#t={}'.format(album.vanity, token))})
