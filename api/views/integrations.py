"""Integrations and domains (contract milestone-6 §7.3, §10.5). Website only: the session cookie, never an
upload key.

    GET    /users/@me/upload-keys
    POST   /users/@me/upload-keys          { name?, scopes?, domain_id?, expires_in?, sharex? }
    PATCH  /users/@me/upload-keys/<id>     { name?, domain_id? }
    DELETE /users/@me/upload-keys/<id>

    GET    /users/@me/domains
    POST   /users/@me/domains              { hostname }
    POST   /users/@me/domains/<id>/verify
    POST   /users/@me/domains/<id>/retry
    PATCH  /users/@me/domains/<id>         { default?, scope?, confirm? }
    DELETE /users/@me/domains/<id>
    PUT    /users/@me/domain-only          { enabled, confirm? }
    GET    /users/@me/domain-only/preview
"""

from functools import wraps

from sanic import Blueprint
from sanic.exceptions import NotFound

import db
from safety.run import in_thread
from utils import accounts, credentials, domains, errors, mail, params, upload_keys, usernames
from utils.account_settings import account_settings
from utils.auth import require_session
from utils.generators import Snowflake
from utils.responses import ApiResponse
from utils.wrappers import route

integrations = Blueprint('integrations', url_prefix='/users/<me:str>')


def only_me(func):
    @wraps(func)
    async def wrapper(request, *args, me, **kwargs):
        if me != '@me':
            raise NotFound('Not Found')
        return await func(request, *args, **kwargs)
    return wrapper


def body_of(request):
    body = params.request_json(request)
    return body if isinstance(body, dict) else {}


# --- upload keys (§7.3) ------------------------------------------------------------------------------------------

def key_name(value):
    if value is None:
        return 'Upload key'
    if not isinstance(value, str):
        raise errors.invalid_parameters({'name': 'Use 1 to 64 characters'})
    name = usernames.clean_display_name(value)
    if name is None or len(name) > 64:
        raise errors.invalid_parameters({'name': 'Use 1 to 64 characters'})
    return name


async def own_domain(conn, user, value):
    """A key's pinned domain: one of the caller's non-deleted domains (it may be pending)."""
    if value is None:
        return None
    try:
        domain_id = int(value)
    except (TypeError, ValueError):
        raise errors.unknown_domain()
    row = await accounts._one(conn, 'SELECT id, hostname FROM custom_domains WHERE id = %s AND user_id = %s AND '
                                    'deleted_at IS NULL', (domain_id, user.id))
    if row is None:
        raise errors.unknown_domain()
    return row


async def key_with_domain(conn, key_id):
    row = await accounts._one(conn, 'SELECT {}, d.hostname FROM upload_keys k LEFT JOIN custom_domains d ON d.id = '
                                    'k.domain_id AND d.deleted_at IS NULL WHERE k.id = %s'.format(upload_keys.select()),
                              (key_id,))
    key = upload_keys.UploadKey(row)
    return upload_keys.key_dict(key, (key.domain_id, row[-1]) if row[-1] else None)


@route(integrations, '/upload-keys', ['GET'])
@only_me
async def list_keys(request):
    user, _ = require_session(request)
    async with db.connection() as conn:
        rows = await accounts._all(conn, (
            'SELECT {}, d.hostname FROM upload_keys k LEFT JOIN custom_domains d ON d.id = k.domain_id AND '
            'd.deleted_at IS NULL WHERE k.user_id = %s AND (k.revoked_at IS NULL OR k.revoked_at > now() - '
            'make_interval(days => %s)) AND (k.expires_at IS NULL OR k.expires_at > now() - make_interval(days => %s)) '
            'ORDER BY k.id DESC').format(upload_keys.select()),
            (user.id, upload_keys.LISTED_DAYS, upload_keys.LISTED_DAYS))
    items = []
    for row in rows:
        key = upload_keys.UploadKey(row)
        items.append(upload_keys.key_dict(key, (key.domain_id, row[-1]) if row[-1] else None))
    return ApiResponse({'items': items, 'limit': account_settings().upload_keys_max})


@route(integrations, '/upload-keys', ['POST'])
@only_me
async def create_key(request):
    user, _ = require_session(request)
    settings = account_settings()
    body = body_of(request)
    name = key_name(body.get('name'))
    scopes = body.get('scopes', ['files:upload'])
    if not isinstance(scopes, list) or not all(s in upload_keys.SCOPES for s in scopes):
        raise errors.invalid_parameters({'scopes': 'files:upload, and optionally albums:append'})
    scopes = [s for s in upload_keys.SCOPES if s in scopes or s == 'files:upload']
    expires_in = body.get('expires_in')
    if expires_in is not None and (isinstance(expires_in, bool) or expires_in not in upload_keys.EXPIRIES):
        raise errors.invalid_parameters({'expires_in': 'null, or 30, 90 or 365 days in seconds'})
    secret = credentials.generate(credentials.KEY_PREFIX)
    key_id = Snowflake.generate()
    async with db.connection() as conn:
        async with conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('upload-keys:{}'.format(user.id),))
            domain = await own_domain(conn, user, body.get('domain_id'))
            active = (await accounts._one(conn, 'SELECT count(*) FROM upload_keys WHERE user_id = %s AND revoked_at '
                                                'IS NULL AND (expires_at IS NULL OR expires_at > now())', (user.id,)))[0]
            if active >= settings.upload_keys_max:
                raise errors.upload_key_limit(settings.upload_keys_max)
            await conn.execute(
                'INSERT INTO upload_keys (id, user_id, name, prefix, key_hash, scopes, domain_id, expires_at) '
                'VALUES (%s, %s, %s, %s, %s, %s, %s, CASE WHEN %s::int IS NULL THEN NULL ELSE now() + '
                'make_interval(secs => %s) END)',
                (key_id, user.id, name, credentials.display_prefix(secret), credentials.token_hash(secret), scopes,
                 domain[0] if domain else None, expires_in, expires_in))
        key = await key_with_domain(conn, key_id)
    arguments = upload_keys.sharex_arguments(body.get('sharex'), scopes)
    # the only time the secret is ever returned
    return ApiResponse({'key': key, 'secret': secret, 'sharex': upload_keys.sharex(name, secret, arguments, settings),
                        'curl': upload_keys.curl(secret, arguments, settings)}, status=201)


def _key_id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise errors.unknown_upload_key()


@route(integrations, '/upload-keys/<key_id:str>', ['PATCH'])
@only_me
async def patch_key(request, key_id):
    user, _ = require_session(request)
    key_id = _key_id(key_id)
    body = body_of(request)
    async with db.connection() as conn:
        if await accounts._one(conn, 'SELECT 1 FROM upload_keys WHERE id = %s AND user_id = %s',
                               (key_id, user.id)) is None:
            raise errors.unknown_upload_key()
        if 'name' in body:
            await conn.execute('UPDATE upload_keys SET name = %s WHERE id = %s', (key_name(body['name']), key_id))
        if 'domain_id' in body:
            domain = await own_domain(conn, user, body['domain_id'])
            await conn.execute('UPDATE upload_keys SET domain_id = %s WHERE id = %s',
                               (domain[0] if domain else None, key_id))
        return ApiResponse(await key_with_domain(conn, key_id))


@route(integrations, '/upload-keys/<key_id:str>', ['DELETE'])
@only_me
async def revoke_key(request, key_id):
    user, _ = require_session(request)
    key_id = _key_id(key_id)
    async with db.connection() as conn:
        cursor = await conn.execute("UPDATE upload_keys SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = "
                                    "COALESCE(revoked_reason, 'owner') WHERE id = %s AND user_id = %s",
                                    (key_id, user.id))
        if cursor.rowcount == 0:
            raise errors.unknown_upload_key()
    return ApiResponse(status=204)


# --- domains (§10.5) ---------------------------------------------------------------------------------------------------

@route(integrations, '/domains', ['GET'])
@only_me
async def list_domains(request):
    user, _ = require_session(request)
    return ApiResponse(await in_thread(domains.listing, user))


@route(integrations, '/domains', ['POST'])
@only_me
async def add_domain(request):
    user, _ = require_session(request)
    hostname = body_of(request).get('hostname')
    return ApiResponse(await in_thread(domains.add, user, hostname, transaction=False), status=201)


@route(integrations, '/domains/<domain_id:str>/verify', ['POST'])
@only_me
async def verify_domain(request, domain_id):
    user, _ = require_session(request)
    body, mails = await in_thread(domains.verify_now, user, domain_id, transaction=False)
    await mail.send(mails)
    return ApiResponse(body)


@route(integrations, '/domains/<domain_id:str>/retry', ['POST'])
@only_me
async def retry_domain(request, domain_id):
    user, _ = require_session(request)
    return ApiResponse(await in_thread(domains.retry, user, domain_id, transaction=False))


@route(integrations, '/domains/<domain_id:str>', ['PATCH'])
@only_me
async def patch_domain(request, domain_id):
    user, _ = require_session(request)
    return ApiResponse(await in_thread(domains.patch, user, domain_id, body_of(request), transaction=False))


@route(integrations, '/domains/<domain_id:str>', ['DELETE'])
@only_me
async def delete_domain(request, domain_id):
    user, _ = require_session(request)
    await mail.send(await in_thread(domains.remove, user, domain_id, transaction=False))
    return ApiResponse(status=204)


@route(integrations, '/domain-only', ['PUT'])
@only_me
async def put_domain_only(request):
    user, _ = require_session(request)
    return ApiResponse(await in_thread(domains.set_domain_only, user, body_of(request), transaction=False))


@route(integrations, '/domain-only/preview', ['GET'])
@only_me
async def domain_only_preview(request):
    user, _ = require_session(request)
    return ApiResponse(await in_thread(domains.affected, user.id))
