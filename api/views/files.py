import time

from datetime import timedelta
from typing import Annotated, Optional

from sanic import Blueprint

import db
from db import queries
from utils import access, access_token, errors, limits as limits_module, params, passwords, payloads, storage as storage_module
from utils import uploading, view_hash
from utils.cdn_signing import Grant
from utils.generators import Snowflake
from utils.params import Arg, Args
from utils.responses import ApiResponse
from utils.turnstile import Turnstile
from utils.vanity import (
    MAX_VANITY_ATTEMPTS, MAX_VANITY_LENGTH, MIN_VANITY_LENGTH, generate_vanity, vanity_length_ok,
)
from utils.wrappers import parse_args, route

from safety import ip as abuse_ip, scan as safety_scan, uploads as safety_uploads
from safety.settings import safety_settings
from utils import standing

import utils.helpers as helpers
import utils.parameters as parameters

files = Blueprint('files', url_prefix='/files')


Authorization = Annotated[Optional[str], Arg('authorization', location='headers')]
Fingerprint = Annotated[Optional[int], Arg('x-fingerprint', location='headers', type=parameters.fingerprint)]


# --- POST /files: single-request upload ------------------------------------------------

class CreateFileArgs(Args):
    filename: Annotated[Optional[str], Arg(location='values')] = None
    vanity: Annotated[Optional[str], Arg(location='values')] = ''
    type: Annotated[Optional[str], Arg(location='values', choices=('multipart', 'raw'),
                                       help='Invalid Upload Type')] = 'multipart'
    authorization: Authorization = None
    fingerprint: Fingerprint = None
    # Milestone 2 (contract §6)
    expires_in: Annotated[Optional[int], Arg(location='values', type=uploading.positive_int)] = None
    visibility: Annotated[Optional[str], Arg(location='values', choices=uploading.VISIBILITIES)] = None
    password: Annotated[Optional[str], Arg(location='values', type=passwords.validate, trim=False)] = None
    generate_password: Annotated[Optional[bool], Arg(location='values', type=uploading.boolean)] = False
    unlock_ttl: Annotated[Optional[int], Arg(location='values', type=uploading.unlock_ttl)] = None
    password_expires_in: Annotated[Optional[int], Arg(location='values', type=uploading.positive_int)] = None
    turnstile_token: Annotated[Optional[str], Arg(location='values')] = None
    # Milestone 3: append the file to one of your albums (by its vanity)
    album: Annotated[Optional[str], Arg(location='values')] = None
    # Milestone 4 (§4.3): the uploader marks it as adult content; signed in only
    nsfw: Annotated[Optional[bool], Arg(location='values', type=uploading.boolean)] = False


async def create_file(request):
    """Multipart or raw. The body streams to a temp file while it is hashed
    (multipart is parsed as it arrives), then goes to B2; the FileHash row is
    written only once the blob is stored."""
    content_mimetype = uploading.mimetype_of(request.content_type)

    user = None
    authorization = request.headers.get('authorization')
    if authorization is not None:
        async with db.connection() as conn:
            user = await helpers.get_user(conn, authorization)
    limit = limits_module.get_limits(user).max_file_size_single
    # milestone-4 §2.5 step 5: bans and restrictions, before reading the body
    raw_fingerprint = request.headers.get('x-fingerprint')
    async with db.connection() as conn:
        await standing.check_uploader(
            conn, user, parameters.fingerprint(raw_fingerprint) if raw_fingerprint else None,
            abuse_ip.abuse_ip_hash(helpers.client_ip(request), safety_settings().abuse_hash_secret))

    # Content-Length first, before reading anything
    try:
        declared = int(request.headers.get('content-length'))
    except (TypeError, ValueError):
        declared = None
    slack = uploading.MULTIPART_SLACK if content_mimetype == 'multipart/form-data' else 0
    if declared is not None and declared > limit + slack:
        raise limits_module.file_too_large(limit)

    form, upload = False, None
    try:
        if content_mimetype == 'multipart/form-data':
            form, upload = await uploading.read_multipart(request, limit)
        elif content_mimetype == 'application/x-www-form-urlencoded':
            form = await uploading.read_urlencoded(request)
    except uploading.TooLarge:
        raise limits_module.file_too_large(limit)
    try:
        args = params.parse(request, CreateFileArgs, form=form)
        return await _create_file(request, args, user, upload, declared)
    finally:
        if upload is not None:
            upload.discard()


create_file.__params_model__ = CreateFileArgs
route(files, '', ['POST'], stream=True)(create_file)


async def _create_file(request, args, user, upload, declared):
    fingerprint = args.fingerprint if user is None else None
    owner = uploading.Owner(user, fingerprint, helpers.client_ip(request), request.app.ctx.view_hash_secret)
    limits = owner.limits

    if not vanity_length_ok(args.vanity):
        raise errors.invalid_vanity(MIN_VANITY_LENGTH, MAX_VANITY_LENGTH)

    filename = args.filename
    fextension = None
    if args.type == 'multipart':
        if upload is None:
            raise errors.file_required()
        if filename is None:
            filename = upload.filename
        elif upload.filename and '.' in upload.filename:
            fextension = upload.filename.split('.')[-1]
        mimetype = uploading.mimetype_of(upload.content_type)
    elif args.type == 'raw':
        mimetype = uploading.mimetype_of(request.content_type)
    else:
        raise errors.invalid_upload_type()

    expires_in = limits_module.resolve_expiry(limits, args.expires_in)
    if args.visibility == 'private' and user is None:
        raise uploading.private_requires_account()
    if args.nsfw and user is None:
        raise errors.nsfw_requires_account()

    async with db.connection() as conn:
        name, extension, mimetype = await uploading.resolve_name(conn, filename, fextension, mimetype)
        # pre-check the quota with what we know before reading the body
        await owner.check(conn, upload.size if upload is not None else (declared or 0))
        # an unknown or foreign album fails before anything is stored
        album_id = await uploading.resolve_album(conn, user, args.album)

    if user is None and not await Turnstile.verify(args.turnstile_token, 'upload', helpers.client_ip(request)):
        raise errors.captcha_invalid()

    access_columns, generated = await uploading.resolve_access(
        user, args.visibility, args.password, args.generate_password, args.unlock_ttl, args.password_expires_in)

    spooled = upload
    if spooled is None:
        try:
            spooled = await uploading.spool_body(request, limits.max_file_size_single)
        except uploading.TooLarge:
            raise limits_module.file_too_large(limits.max_file_size_single)
    try:
        if spooled.size > limits.max_file_size_single:
            raise limits_module.file_too_large(limits.max_file_size_single)
        # the name and type passed resolve_name; the bytes themselves must not be a program, nor
        # sniff as a blocked type (milestone-4 §5.1)
        spooled.hasher.check_content()
        if await safety_uploads.sniff_blocked_async(spooled.hasher.head):
            raise errors.file_type_not_allowed()
        await refuse_known_content(request, spooled.hasher, owner, args.nsfw, name, extension, mimetype)
        fobj = await store_upload(request, owner, spooled, name, extension, mimetype, expires_in, access_columns,
                                  args.vanity, album_id=album_id, nsfw_marked=bool(args.nsfw))
    finally:
        if spooled is not upload:
            spooled.discard()
    # the uploader owns it: a protected file's URLs are signed for 1 h; milestone-4 §6.2 adds `safety`
    body = payloads.with_safety(payloads.public_file(fobj, grant=Grant.owner_file(fobj)), fobj)
    return ApiResponse(payloads.with_password(body, fobj, generated))


async def refuse_known_content(request, hasher, owner, nsfw, name, extension, mimetype):
    """Milestone-4 §2.5 steps 1-4: blocked hashes (a `csam` entry also runs §3.6's uploader
    steps), blocked hashes' scan results, and anonymous uploads of NSFW or encrypted content."""
    blake2b, md5, sha1 = hasher.digests()
    async with db.connection() as conn:
        code, csam = await safety_uploads.known_content_async(conn, blake2b, md5, sha1, owner.user is None,
                                                                nsfw=bool(nsfw))
    if code is None:
        return
    if csam:
        await csam_reupload(request, owner, blake2b, md5, sha1, hasher.size, name, extension, mimetype)
    raise errors.upload_rejection(code)


async def csam_reupload(request, owner, blake2b, md5, sha1, size, name, extension, mimetype):
    from safety import csam
    from safety.run import in_thread
    settings = safety_settings()
    ip_hash = abuse_ip.abuse_ip_hash(helpers.client_ip(request), settings.abuse_hash_secret)
    async with db.connection() as conn:
        cursor = await conn.execute('SELECT id FROM blocked_hashes WHERE blake2b = %s AND md5 = %s AND sha1 = %s',
                                    (blake2b, md5, sha1))
        row = await cursor.fetchone()
    attempt = {'filename': name + ('.' + extension if extension else ''), 'mimetype': mimetype, 'size': size,
               'signed_in': owner.user is not None, 'at': access.now()}
    await in_thread(csam.reupload, row[0] if row else None, owner.user.id if owner.user else None,
                    owner.fingerprint, ip_hash, attempt)


async def store_upload(request, owner, spooled, name, extension, mimetype, expires_in, access_columns, vanity='',
                       album_id=None, nsfw_marked=False):
    """Blob to B2 (unless de-duplicated), then FileHash and File in one
    transaction under the owner's quota lock. A new hash gets its `probe` job, and
    with `album_id` the file joins that album."""
    storage = request.app.ctx.storage
    hblake2b, hmd5, hsha1 = spooled.hasher.digests()
    size = spooled.size
    # milestone-4 §1: the stable abuse IP hash, and the raw IP sealed to the offline evidence key
    abuse_hash, sealed_ip = abuse_ip.for_request(helpers.client_ip(request), safety_settings())

    async with db.connection() as conn:
        existing = await queries.get_file_hash(conn, hblake2b, hmd5, hsha1)

    uploaded_key = None
    if existing is None:
        hash_id = Snowflake.generate()
        uploaded_key = storage_module.blob_key(hash_id)
        await storage.upload_file(uploaded_key, spooled.path, size)

    orphan = None
    try:
        async with db.connection() as conn:
            async with conn.transaction():
                await owner.check(conn, size, lock=True)
                if existing is None:
                    fhash, created = await queries.insert_file_hash(conn, hash_id, hblake2b, hmd5, hsha1, size)
                    if not created:
                        orphan = uploaded_key  # the same content was stored meanwhile
                    else:
                        # milestone-4 §2.1: every new hash is scanned before anything else reads it
                        await safety_scan.queue_scan_async(conn, fhash.id)
                else:
                    fhash = existing
                expires_at = uploading.utcnow() + timedelta(seconds=expires_in) if expires_in else None
                fobj = None
                for _ in range(MAX_VANITY_ATTEMPTS):
                    fvanity = generate_vanity(vanity)
                    if await queries.vanity_exists(conn, fvanity):
                        continue
                    fobj = await queries.create_file(
                        conn, id=Snowflake.generate(), vanity=fvanity, mimetype_id=mimetype, extension=extension,
                        filename=name, fhash=fhash, user=owner.user, fingerprint=owner.fingerprint, size=size,
                        expires_at=expires_at, uploader_ip_hash=owner.ip_hash, nsfw_marked=nsfw_marked,
                        uploader_abuse_ip_hash=abuse_hash, uploader_ip_sealed=sealed_ip, **access_columns,
                    )
                    if fobj is not None:
                        break
                if fobj is None:
                    # a small or fixed pattern (`1/1`, `3`) can run out: fail instead of spinning
                    # inside the transaction with the quota lock held
                    raise errors.vanity_exhausted()
                if album_id is not None:
                    await uploading.append_to_album(conn, album_id, fobj.id, owner.limits.album_max_files)
    except BaseException:
        if uploaded_key is not None:
            orphan = uploaded_key
        raise
    finally:
        if orphan is not None:
            try:
                await storage.delete(orphan)
            except Exception:
                pass
    return fobj


# --- reading a file ------------------------------------------------------------------------

class FileArgs(Args):
    vanity: Annotated[Optional[str], Arg(location='view_args')] = None


def view_ip(request):
    return helpers.client_ip(request)


async def _visible_file(conn, request, vanity):
    """(file, full, grant): `full` when the caller may see everything, and the CDN grant
    their URLs are signed with (None for `link` files). Private files are unknown to
    everyone but their owner."""
    fobj = await queries.get_file_by_vanity(conn, vanity)
    if fobj is None:
        return None, False, None
    if fobj.visibility == 'link':
        return fobj, True, None
    user = await access.optional_user(conn, request)
    fingerprint = parameters.fingerprint(request.headers.get('x-fingerprint')) if request.headers.get(
        'x-fingerprint') else None
    if access.is_owner(fobj, user, fingerprint):
        return fobj, True, Grant.owner_file(fobj)
    claims, album = await access.file_or_album_claims(conn, request, fobj, request.ctx.access_token)
    grant = access.grant_for(fobj, claims, album) if claims is not None else None
    if fobj.visibility == 'private':
        # only an owner pass or an album token opens a private file here
        return (fobj, True, grant) if claims is not None else (None, False, None)
    return fobj, claims is not None, grant


def check_state(fobj):
    """Milestone-4 §2.4 for the public API, after access: blocked is unknown, pending is
    409 FILE_PENDING, hidden and removed are 410 FILE_REMOVED { reason }."""
    state = payloads.file_state(fobj)
    if state == 'blocked':
        raise errors.unknown_file()
    if state == 'pending':
        raise errors.file_pending()
    if state in ('hidden', 'removed'):
        raise errors.file_removed(payloads.lookup_safety(fobj)['reason'])


def file_payload(fobj, grant, album_item=False):
    return payloads.public_file(fobj, grant=grant, album_item=album_item)


@route(files, '/<vanity:path>', ['GET'])
@parse_args(FileArgs)
async def fetch_file(request, args):
    """The file payload. A protected file's URLs are signed for the caller: its owner
    (1 h), or the unlock or album token in X-Filesgg-Access (until it expires)."""
    vanity = args.vanity.split('.').pop(0)
    async with db.connection() as conn:
        fobj, full, grant = await _visible_file(conn, request, vanity)
        if fobj is None:
            raise errors.unknown_file()
        check_state(fobj)
        if not full:
            # a password file, locked: no content, no view counted
            return ApiResponse(payloads.locked_file(fobj, access.password_has_expired(fobj)))
        day = view_hash.utc_today()
        await queries.record_view(conn, fobj, view_hash.ip_hash(request.app.ctx.view_hash_secret, day, view_ip(request)), day)

    return ApiResponse(file_payload(fobj, grant, album_item=grant is not None and grant.album_vanity is not None))


# --- unlocking (contract §5) -------------------------------------------------------------------

class UnlockArgs(Args):
    password: Annotated[Optional[str], Arg(trim=False)] = None
    turnstile_token: Annotated[Optional[str], Arg()] = None


class RefreshArgs(Args):
    token: Annotated[Optional[str], Arg(trim=False)] = None


async def _protected_file(conn, vanity):
    fobj = await queries.get_file_by_vanity(conn, vanity.split('.').pop(0))
    if fobj is None or fobj.visibility == 'private':
        raise errors.unknown_file()
    return fobj


@route(files, '/<vanity:path>/unlock', ['POST'])
@parse_args(UnlockArgs)
async def unlock_file(request, args, vanity):
    """Turnstile, then the rate limit, then password expiry, then the password."""
    async with db.connection() as conn:
        fobj = await _protected_file(conn, vanity)
    check_state(fobj)
    if not await Turnstile.verify(args.turnstile_token, 'unlock', helpers.client_ip(request)):
        raise errors.captcha_invalid()
    async with db.connection() as conn:
        await access.rate_limit(conn, request, fobj, 'unlock', access.UNLOCK_ATTEMPTS_PER_MINUTE)
    if fobj.visibility == 'password':
        if access.password_has_expired(fobj):
            raise errors.password_expired()
        if not await passwords.verify(fobj.password_hash, args.password):
            raise errors.wrong_password()
    unlocked_at = access.now()
    expires_at = access.unlock_expiry(fobj, unlocked_at)
    return ApiResponse({
        'token': access.mint(request, fobj, 'unlock', unlocked_at, expires_at),
        'expires_at': expires_at,
        'file': file_payload(fobj, Grant.for_file(fobj, expires_at)),
    })


@route(files, '/<vanity:path>/unlock/refresh', ['POST'])
@parse_args(RefreshArgs)
async def refresh_unlock(request, args, vanity):
    """No Turnstile; keeps `u`. Unlock tokens: e = min(now + 3600, u + unlock_ttl,
    password_expires_at). Owner passes: e = min(now + 3600, u + 43200), 12 h
    from minting. access_version must still match. Returns the payload with fresh URLs."""
    async with db.connection() as conn:
        fobj = await queries.get_file_by_vanity(conn, vanity.split('.').pop(0))
        if fobj is None:
            raise errors.unknown_file()
        claims = access.token_claims(request, fobj, args.token)
        # a private file is only confirmed to an owner pass
        if fobj.visibility == 'private' and (claims is None or claims['s'] != 'owner'):
            raise errors.unknown_file()
        check_state(fobj)
        await access.rate_limit(conn, request, fobj, 'access', access.ACCESS_REQUESTS_PER_MINUTE)
    if claims is None:
        raise errors.unlock_expired()
    now = access.now()
    if claims['s'] == 'owner':
        expires_at = min(now + access_token.REFRESH_SECONDS, claims['u'] + access_token.OWNER_PASS_MAX_SECONDS)
    else:
        expires_at = min(now + access_token.REFRESH_SECONDS, access.unlock_expiry(fobj, claims['u']))
    if expires_at <= now:
        raise errors.unlock_expired()
    return ApiResponse({
        'token': access.mint(request, fobj, claims['s'], claims['u'], expires_at),
        'expires_at': expires_at,
        'file': file_payload(fobj, Grant.for_file(fobj, expires_at)),
    })


@route(files, '/<vanity:path>/view', ['GET'])
async def view_file(request, vanity):
    """The full payload for a valid unlock or owner token in X-Filesgg-Access.
    No Turnstile; rate-limited like /unlock/refresh."""
    async with db.connection() as conn:
        fobj = await queries.get_file_by_vanity(conn, vanity.split('.').pop(0))
        if fobj is None:
            raise errors.unknown_file()
        # its own token, or one for an album it's a shown item of (milestone-2 §1 rule 3)
        claims, album = await access.file_or_album_claims(conn, request, fobj, request.ctx.access_token)
        if fobj.visibility == 'private' and claims is None:
            raise errors.unknown_file()
        check_state(fobj)
        await access.rate_limit(conn, request, fobj, 'access', access.ACCESS_REQUESTS_PER_MINUTE)
    if claims is None:
        raise errors.unlock_expired()
    # through an album token, the URLs use the album grant (and carry album=)
    body = file_payload(fobj, access.grant_for(fobj, claims, album), album_item=album is not None)
    return ApiResponse({'file': body, 'expires_at': claims['e']})
