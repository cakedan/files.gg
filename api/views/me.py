from functools import wraps
from typing import Annotated, Optional

from sanic import Blueprint
from sanic.exceptions import NotFound

import db
from db import queries
from db.models import epoch
from utils import access, access_token, errors, limits as limits_module, passwords, payloads, uploading, urls
from utils.params import Arg, Args, request_json
from utils.responses import ApiError, ApiResponse
from utils.wrappers import authenticate, parse_args, route

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
    return ApiResponse(user.to_dict(me=True))


@route(me, '/mimetypes', ['GET'])
@only_me
@authenticate()
async def fetch_me_mimetypes(request, user):
    async with db.connection() as conn:
        group = await queries.list_user_mimetypes(conn, user.id)
    return ApiResponse([x.to_dict() for x in group])


class FileCountArgs(Args):
    authorization: Annotated[Optional[str], Arg('authorization', location='headers')] = None
    fingerprint: Annotated[Optional[int], Arg('x-fingerprint', location='headers', type=parameters.fingerprint)] = None
    mimetype: Annotated[Optional[str], Arg(location='args')] = None
    type: Annotated[Optional[str], Arg(location='args')] = None


@route(me, '/file-count', ['GET'])
@only_me
@parse_args(FileCountArgs)
async def fetch_me_file_count(request, args):
    if args.authorization is None and args.fingerprint is None:
        raise ApiError(status=401)

    if args.mimetype is not None and args.type is not None:
        raise ApiError('Choose Mimetype or Type, not both')

    async with db.connection() as conn:
        if args.type is not None:
            if not await queries.mimetype_type_exists(conn, args.type):
                raise ApiError(metadata={'errors': {'type': 'Invalid Type'}})

        if args.mimetype is not None:
            if await queries.get_mimetype(conn, args.mimetype) is None:
                raise ApiError(metadata={'errors': {'mimetype': 'Invalid Mimetype'}})

        if args.authorization is not None:
            user = await helpers.get_user(conn, args.authorization)
            count = await queries.count_files(conn, user_id=user.id, type_id=args.type, mimetype_id=args.mimetype)
        else:
            count = await queries.count_files(conn, fingerprint=args.fingerprint, type_id=args.type,
                                              mimetype_id=args.mimetype)

    return ApiResponse({'count': count})


# --- Milestone 2 -------------------------------------------------------------------------

@route(me, '/limits', ['GET'])
@only_me
async def fetch_me_limits(request):
    """Signed in: the user's limits and storage use. Anonymous (X-Fingerprint):
    the anonymous limits, with `storage.limit` null (their files expire)."""
    async with db.connection() as conn:
        user = None
        if request.headers.get('authorization') is not None:
            user = await helpers.get_user(conn, request.headers.get('authorization'))
        fingerprint = parameters.fingerprint(request.headers.get('x-fingerprint')) \
            if request.headers.get('x-fingerprint') else None
        if user is None and fingerprint is None:
            raise ApiError(status=401)
        owner = uploading.Owner(user, fingerprint, helpers.client_ip(request), request.app.ctx.view_hash_secret)
        used = await owner.usage(conn)
    limits = owner.limits
    body = {
        'storage': {'used': used, 'limit': limits.storage_bytes},
        'max_file_size_single': limits.max_file_size_single,
        'max_file_size_chunked': limits.max_file_size_chunked,
        'max_expiry': limits.max_expiry,
        'allow_no_expiry': limits.allow_no_expiry,
        'anonymous': limits.anonymous,
    }
    if limits.anonymous:
        # extra: the rolling 24 h cap that applies instead of a storage limit
        body['daily'] = {'used': used, 'limit': limits.daily_bytes}
    return ApiResponse(body)


def epoch_or_null(value):
    if value is None:
        return None
    number = int(value)
    if number <= 0:
        raise ValueError('Must be a positive epoch time in seconds, or null')
    return number


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


def _owned_file_id(file_id):
    try:
        return int(file_id)
    except ValueError:
        raise errors.unknown_file()


@route(me, '/files/<file_id:str>', ['PATCH'])
@only_me
@parse_args(PatchFileArgs)
@authenticate()
async def patch_file(request, args, file_id, user):
    """Access and expiry settings. Changing the visibility or the password, or
    shortening unlock_ttl or password_expires_at, bumps access_version, which
    revokes every outstanding token and #pw= link."""
    sent = request_json(request) or {}
    sent = set(sent) | set(request.get_args(keep_blank_values=True)) | set(request.form or {})
    now = access.now()
    async with db.connection() as conn:
        fobj = await queries.get_owned_file(conn, _owned_file_id(file_id), user.id)
        if fobj is None:
            raise errors.unknown_file()
        changes, bump, generated = {}, False, None

        visibility = args.visibility
        if visibility is None and (args.password is not None or args.generate_password):
            visibility = 'password'
        visibility = visibility or fobj.visibility
        if visibility != fobj.visibility:
            changes['visibility'] = visibility
            bump = True
        if visibility == 'password':
            password = args.password
            if args.generate_password:
                password = generated = passwords.generate_passphrase()
            if password is not None:
                changes['password_hash'] = await passwords.hash(password)
                bump = True
            elif fobj.password_hash is None:
                raise ApiError(metadata={'errors': {'password': 'A password is required for password visibility'}})
        elif fobj.password_hash is not None:
            changes['password_hash'] = None

        if args.unlock_ttl is not None and args.unlock_ttl != fobj.unlock_ttl:
            changes['unlock_ttl'] = args.unlock_ttl
            bump = bump or args.unlock_ttl < fobj.unlock_ttl

        new_password_expiry = epoch(fobj.password_expires_at)
        if args.password_expires_in is not None:
            new_password_expiry = now + args.password_expires_in
        elif 'password_expires_at' in sent:
            new_password_expiry = args.password_expires_at
        if new_password_expiry != epoch(fobj.password_expires_at):
            changes['password_expires_at'] = (
                uploading.from_epoch(new_password_expiry) if new_password_expiry is not None else None)
            old = epoch(fobj.password_expires_at)
            bump = bump or (new_password_expiry is not None and (old is None or new_password_expiry < old))

        if args.show_name_when_locked is not None and args.show_name_when_locked != fobj.show_name_when_locked:
            changes['show_name_when_locked'] = args.show_name_when_locked

        limits = limits_module.get_limits(user)
        if args.expires_in is not None or 'expires_at' in sent:
            if args.expires_in is not None:
                seconds = args.expires_in
            elif args.expires_at is None:
                seconds = None
            else:
                seconds = args.expires_at - now
            if seconds is None and not limits.allow_no_expiry:
                raise limits_module.expiry_not_allowed(limits)
            if seconds is not None:
                limits_module.resolve_expiry(limits, seconds)
            changes['expires_at'] = uploading.from_epoch(now + seconds) if seconds is not None else None

        if bump:
            changes['access_version'] = fobj.access_version + 1
        if changes:
            updated = await queries.update_file(conn, fobj.id, **changes)
            updated.hash, updated.user = fobj.hash, fobj.user
            fobj = updated
    body = payloads.owner_dict(fobj)
    if generated is not None:
        body['password'] = generated
        body['url_with_password'] = urls.public_url('/{}#pw={}'.format(fobj.vanity, generated))
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


@route(me, '/albums/<album_id:str>/pass', ['POST'])
@only_me
@authenticate()
async def album_owner_pass(request, album_id, user):
    # albums arrive in Milestone 3
    raise errors.unknown_album()
