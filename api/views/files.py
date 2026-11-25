import time

from datetime import timedelta
from typing import Annotated, Optional

from sanic import Blueprint

import db
from db import queries
from utils import access, access_token, errors, limits as limits_module, params, passwords, payloads, storage as storage_module
from utils import uploading, view_hash
from utils.errors import UnknownFile
from utils.generators import Snowflake
from utils.params import Arg, Args
from utils.responses import ApiError, ApiResponse
from utils.turnstile import Turnstile
from utils.vanity import (  # noqa: F401  (re-exported for older imports)
    MAX_VANITY_LENGTH, MIN_VANITY_LENGTH, blacklisted_ids, generate_id, generate_vanity, parse_vanity_part,
    vanity_length_ok,
)
from utils.wrappers import authenticate, parse_args, route

import utils.helpers as helpers
import utils.parameters as parameters

files = Blueprint('files', url_prefix='/files')


Authorization = Annotated[Optional[str], Arg('authorization', location='headers')]
Fingerprint = Annotated[Optional[int], Arg('x-fingerprint', location='headers', type=parameters.fingerprint)]


class FetchFilesArgs(Args):
    authorization: Authorization = None
    fingerprint: Fingerprint = None
    limit: Annotated[Optional[int], Arg(type=int, choices=range(1, 101),
                                        help='Must be at least or in between 1 and 100')] = 100
    after: Annotated[Optional[int], Arg(location='args', type=parameters.snowflake)] = None
    before: Annotated[Optional[int], Arg(location='args', type=parameters.snowflake)] = None
    mimetype: Annotated[Optional[str], Arg(location='args')] = None
    type: Annotated[Optional[str], Arg(location='args')] = None


@route(files, '', ['GET'])
@parse_args(FetchFilesArgs)
async def fetch_files(request, args):
    if args.authorization is None and args.fingerprint is None:
        raise ApiError(status=401)

    if args.after is not None and args.before is not None:
        raise ApiError('Choose between before or after, not both')

    if args.mimetype is not None and args.type is not None:
        raise ApiError('Choose Mimetype or Type, not both')

    async with db.connection() as conn:
        if args.type is not None:
            if not await queries.mimetype_type_exists(conn, args.type):
                raise ApiError(metadata={'errors': {'type': 'Invalid Type'}})

        if args.mimetype is not None:
            if await queries.get_mimetype(conn, args.mimetype) is None:
                raise ApiError(metadata={'errors': {'mimetype': 'Invalid Mimetype'}})

        user_id = fingerprint = None
        if args.authorization is not None:
            user = await helpers.get_user(conn, args.authorization)
            user_id = user.id
        else:
            fingerprint = args.fingerprint

        total, items = await queries.list_files(
            conn, user_id=user_id, fingerprint=fingerprint, type_id=args.type,
            mimetype_id=args.mimetype, after=args.after, before=args.before, limit=args.limit,
        )

    return ApiResponse({
        'total': total,
        'files': [x.to_dict() for x in items],
    })


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


async def create_file(request):
    """Multipart or raw. The body streams to a temp file while it is hashed
    (multipart is parsed as it arrives), then goes to B2; the FileHash row is
    written only once the blob is stored."""
    content_mimetype = uploading.mimetype_of(request.content_type)

    user = None
    authorization = request.headers.get('authorization')
    if authorization is not None:
        async with db.connection() as conn:
            try:
                user = await helpers.get_user(conn, authorization)
            except Exception:
                raise ApiError('Invalid Authentication')
    limit = limits_module.get_limits(user).max_file_size_single

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
        raise ApiError('Vanity has to be at least or in between {} and {} characters long'.format(
            MIN_VANITY_LENGTH, MAX_VANITY_LENGTH))

    filename = args.filename
    fextension = None
    if args.type == 'multipart':
        if upload is None:
            raise ApiError('A file must be uploaded')
        if filename is None:
            filename = upload.filename
        elif upload.filename and '.' in upload.filename:
            fextension = upload.filename.split('.')[-1]
        mimetype = uploading.mimetype_of(upload.content_type)
    elif args.type == 'raw':
        mimetype = uploading.mimetype_of(request.content_type)
    else:
        raise ApiError('Invalid Upload Type')

    expires_in = limits_module.resolve_expiry(limits, args.expires_in)
    if args.visibility == 'private' and user is None:
        raise uploading.private_requires_account()

    async with db.connection() as conn:
        name, extension, mimetype = await uploading.resolve_name(conn, filename, fextension, mimetype)
        # pre-check the quota with what we know before reading the body
        await owner.check(conn, upload.size if upload is not None else (declared or 0))

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
        fobj = await store_upload(request, owner, spooled, name, extension, mimetype, expires_in, access_columns,
                                  args.vanity)
    finally:
        if spooled is not upload:
            spooled.discard()
    return ApiResponse(payloads.upload_dict(fobj, password=generated))


async def store_upload(request, owner, spooled, name, extension, mimetype, expires_in, access_columns, vanity=''):
    """Blob to B2 (unless de-duplicated), then FileHash and File in one
    transaction under the owner's quota lock."""
    storage = request.app.ctx.storage
    hblake2b, hmd5, hsha1 = spooled.hasher.digests()
    size = spooled.size

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
                    fhash = existing
                expires_at = uploading.utcnow() + timedelta(seconds=expires_in) if expires_in else None
                fobj = None
                while fobj is None:
                    fvanity = generate_vanity(vanity)
                    if await queries.vanity_exists(conn, fvanity):
                        continue
                    fobj = await queries.create_file(
                        conn, id=Snowflake.generate(), vanity=fvanity, mimetype_id=mimetype, extension=extension,
                        filename=name, fhash=fhash, user=owner.user, fingerprint=owner.fingerprint, size=size,
                        expires_at=expires_at, uploader_ip_hash=owner.ip_hash, **access_columns,
                    )
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
    """(file, caller may see everything). Private files are unknown to everyone
    but their owner."""
    fobj = await queries.get_file_by_vanity(conn, vanity)
    if fobj is None:
        return None, False
    if fobj.visibility == 'link':
        return fobj, True
    user = await access.optional_user(conn, request)
    fingerprint = parameters.fingerprint(request.headers.get('x-fingerprint')) if request.headers.get(
        'x-fingerprint') else None
    if access.is_owner(fobj, user, fingerprint):
        return fobj, True
    if fobj.visibility == 'private':
        return None, False
    return fobj, access.token_claims(request, fobj, request.ctx.access_token) is not None


@route(files, '/<vanity:path>', ['GET'])
@parse_args(FileArgs)
async def fetch_file(request, args):
    vanity = args.vanity.split('.').pop(0)
    async with db.connection() as conn:
        fobj, full = await _visible_file(conn, request, vanity)
        if fobj is None:
            raise UnknownFile()
        if not full:
            # a password file, locked: no content, no view counted
            return ApiResponse(payloads.locked_file(fobj, access.password_has_expired(fobj)))
        day = view_hash.utc_today()
        await queries.record_view(conn, fobj, view_hash.ip_hash(request.app.ctx.view_hash_secret, day, view_ip(request)), day)

    return ApiResponse(fobj.to_dict())


@route(files, '/<vanity:path>', ['DELETE'])
@parse_args(FileArgs)
@authenticate()
async def delete_file(request, args, user):
    return ApiResponse(args.vanity)


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
        'file': payloads.public_file(fobj),
    })


@route(files, '/<vanity:path>/unlock/refresh', ['POST'])
@parse_args(RefreshArgs)
async def refresh_unlock(request, args, vanity):
    """No Turnstile; keeps `u`. Unlock tokens: e = min(now + 3600, u + unlock_ttl,
    password_expires_at). Owner passes: e = min(now + 3600, u + 43200), 12 h
    from minting. access_version must still match."""
    async with db.connection() as conn:
        fobj = await queries.get_file_by_vanity(conn, vanity.split('.').pop(0))
        if fobj is None:
            raise errors.unknown_file()
        claims = access.token_claims(request, fobj, args.token)
        # a private file is only confirmed to an owner pass
        if fobj.visibility == 'private' and (claims is None or claims['s'] != 'owner'):
            raise errors.unknown_file()
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
    })


@route(files, '/<vanity:path>/view', ['GET'])
async def view_file(request, vanity):
    """The full payload for a valid unlock or owner token in X-Filesgg-Access.
    No Turnstile; rate-limited like /unlock/refresh."""
    async with db.connection() as conn:
        fobj = await queries.get_file_by_vanity(conn, vanity.split('.').pop(0))
        if fobj is None:
            raise errors.unknown_file()
        claims = access.token_claims(request, fobj, request.ctx.access_token)
        if fobj.visibility == 'private' and claims is None:
            raise errors.unknown_file()
        await access.rate_limit(conn, request, fobj, 'access', access.ACCESS_REQUESTS_PER_MINUTE)
    if claims is None:
        raise errors.unlock_expired()
    return ApiResponse({'file': payloads.public_file(fobj), 'expires_at': claims['e']})
