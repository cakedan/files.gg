"""The Settings API (contract milestone-6 §8): username, login methods, sessions, email, password, data
export and account deletion. Website only: the session cookie, never an upload key, with the CSRF header on
writes. Suspension and pending deletion limit these (utils/standing.py).

    PUT    /users/@me/username                 { username }
    GET    /users/@me/username/check?username= (signed out too)
    GET    /users/@me/identities
    DELETE /users/@me/identities/discord
    GET    /users/@me/sessions
    DELETE /users/@me/sessions                 sign out everywhere
    DELETE /users/@me/sessions/<id>
    POST   /users/@me/email                    { email }
    DELETE /users/@me/email/pending
    PUT    /users/@me/password                 { current_password?, new_password }
    POST   /users/@me/delete                   { confirm_username }
    POST   /users/@me/delete/cancel
    POST   /users/@me/exports
    GET    /users/@me/exports
    GET    /users/@me/exports/<id>/download
"""

import re

from datetime import timedelta
from functools import wraps

from psycopg import errors as pg_errors
from sanic import Blueprint
from sanic.exceptions import NotFound
from sanic.response import HTTPResponse

import db
import jobs
from db.models import epoch
from utils import accounts, auth as auth_module, errors, mail, params, passwords, usernames
from utils.account_settings import account_settings
from utils.email_domain import domain_accepts_mail
from utils.generators import Snowflake
from utils.responses import ApiResponse
from utils.wrappers import route

import utils.parameters as parameters

account = Blueprint('account', url_prefix='/users/<me:str>')


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


def _id(value, error):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise error()


# --- username (§2.2) --------------------------------------------------------------------------------------------

@route(account, '/username', ['PUT'])
@only_me
async def change_username(request):
    user, _ = auth_module.require_session(request)
    settings = account_settings()
    name, reason = usernames.check(body_of(request).get('username'))
    if reason:
        raise errors.username_invalid(reason, usernames.REASON_MESSAGES[reason])
    available_at = accounts.username_change_available_at(user, settings)
    if available_at is not None:
        raise errors.username_cooldown(available_at)
    async with db.connection() as conn:
        if name == user.username:
            await conn.execute('UPDATE users SET needs_username = false WHERE id = %s', (user.id,))
            return ApiResponse(await accounts.user_object(conn, await accounts.load_user(conn, user.id)))
        if not await accounts.username_available(conn, name, user.id):
            raise errors.username_taken()
        try:
            async with conn.transaction():
                await conn.execute('DELETE FROM username_holds WHERE username = %s AND user_id = %s', (name, user.id))
                await conn.execute(
                    'INSERT INTO username_holds (username, user_id, held_until) VALUES (%s, %s, now() + '
                    'make_interval(days => %s)) ON CONFLICT (username) DO UPDATE SET user_id = EXCLUDED.user_id, '
                    'released_at = now(), held_until = EXCLUDED.held_until',
                    (user.username, user.id, settings.username_hold_days))
                await conn.execute('UPDATE users SET username = %s, username_changed_at = now(), needs_username = false '
                                   'WHERE id = %s', (name, user.id))
        except pg_errors.UniqueViolation:
            raise errors.username_taken()
        return ApiResponse(await accounts.user_object(conn, await accounts.load_user(conn, user.id)))


@route(account, '/username/check', ['GET'])
@only_me
async def check_username(request):
    """Signed out too, so the register form can check as you type: 60 an hour per IP (no Turnstile)."""
    settings = account_settings()
    name, reason = usernames.check(request.get_args().get('username'))
    current = auth_module.auth_of(request)
    user_id = current.user.id if current.kind == 'session' else None
    async with db.connection() as conn:
        ip, _ = accounts.ip_key(request)
        await accounts.rate_limited(conn, 'username_check', ip, settings.rate('username_check'))
        if reason is None and not await accounts.username_available(conn, name, user_id):
            reason = 'taken'
    body = {'username': name, 'available': reason is None}
    if reason:
        body['reason'] = reason
    return ApiResponse(body)


# --- login methods (§5.6) -----------------------------------------------------------------------------------------

@route(account, '/identities', ['GET'])
@only_me
async def list_identities(request):
    user, _ = auth_module.require_session(request)
    async with db.connection() as conn:
        return ApiResponse({'items': await accounts.identities(conn, user.id)})


@route(account, '/identities/<provider:str>', ['DELETE'])
@only_me
async def unlink_identity(request, provider):
    user, _ = auth_module.require_session(request)
    async with db.connection() as conn:
        row = await accounts._one(conn, 'SELECT id FROM user_identities WHERE user_id = %s AND provider = %s',
                                  (user.id, provider))
        if row is None:
            raise errors.unknown_identity()
        # never the last way in: a password and a verified email must remain
        if not user.password_hash or not user.email or not user.email_verified:
            raise errors.last_login_method()
        await auth_module.require_fresh(request, conn)
        await conn.execute('DELETE FROM user_identities WHERE id = %s', (row[0],))
    return ApiResponse(status=204)


# --- sessions (§8.3) ----------------------------------------------------------------------------------------------

BROWSERS = (('Edg/', 'Edge'), ('OPR/', 'Opera'), ('Firefox/', 'Firefox'), ('FxiOS/', 'Firefox'),
            ('CriOS/', 'Chrome'), ('Chrome/', 'Chrome'), ('Safari/', 'Safari'))
SYSTEMS = (('Windows', 'Windows'), ('iPhone', 'iOS'), ('iPad', 'iPadOS'), ('Android', 'Android'),
           ('CrOS', 'ChromeOS'), ('Mac OS X', 'macOS'), ('Macintosh', 'macOS'), ('Linux', 'Linux'))


def device_of(agent):
    """"Firefox on macOS" from a user agent, with a small fixed table; else "Unknown device"."""
    agent = agent or ''
    browser = next((name for needle, name in BROWSERS if needle in agent), None)
    system = next((name for needle, name in SYSTEMS if needle in agent), None)
    if browser and system:
        return '{} on {}'.format(browser, system)
    return browser or system or 'Unknown device'


@route(account, '/sessions', ['GET'])
@only_me
async def list_sessions(request):
    user, current = auth_module.require_session(request)
    async with db.connection() as conn:
        rows = await accounts._all(conn, (
            'SELECT id, method, created_at, last_used_at, expires_at, user_agent, last_country, country FROM sessions '
            'WHERE user_id = %s AND revoked_at IS NULL AND expires_at > now() AND max_expires_at > now() '
            'ORDER BY last_used_at DESC, id DESC'), (user.id,))
    return ApiResponse({'items': [{
        'id': str(r[0]), 'current': r[0] == current.id, 'method': r[1], 'created_at': epoch(r[2]),
        'last_used_at': epoch(r[3]), 'expires_at': epoch(r[4]), 'device': device_of(r[5]), 'country': r[6] or r[7],
    } for r in rows]})


@route(account, '/sessions', ['DELETE'])
@only_me
async def sign_out_everywhere(request):
    user, _ = auth_module.require_session(request)
    async with db.connection() as conn:
        count = await accounts.revoke_sessions(conn, user.id, 'everywhere')
    request.ctx.clear_cookie = True
    return ApiResponse({'revoked': count})


@route(account, '/sessions/<session_id:str>', ['DELETE'])
@only_me
async def sign_out_session(request, session_id):
    user, current = auth_module.require_session(request)
    session_id = _id(session_id, errors.unknown_session)
    async with db.connection() as conn:
        if not await accounts.revoke_sessions(conn, user.id, 'logout' if session_id == current.id else 'user',
                                              only=session_id):
            raise errors.unknown_session()
    if session_id == current.id:
        request.ctx.clear_cookie = True
    return ApiResponse(status=204)


# --- email (§8.4) ---------------------------------------------------------------------------------------------------

@route(account, '/email', ['POST'])
@only_me
async def change_email(request):
    user, _ = auth_module.require_session(request)
    settings = account_settings()
    raw = body_of(request).get('email')
    try:
        address = parameters.email(raw if isinstance(raw, str) else '').strip()
    except ValueError as error:
        raise errors.invalid_parameters({'email': str(error)})
    await auth_module.require_fresh(request)
    if user.email and user.email.lower() == address.lower():
        raise errors.invalid_parameters({'email': "That's already your email"})
    if not await domain_accepts_mail(address):
        raise errors.invalid_email()
    async with db.connection() as conn:
        if await accounts.email_in_use(conn, address, except_user=user.id):
            raise errors.email_taken()
        try:
            async with conn.transaction():
                if user.email is None:
                    # nothing to keep: the new address is the email at once, unverified
                    await conn.execute('UPDATE users SET email = %s, email_verified = false, pending_email = NULL '
                                       'WHERE id = %s', (address, user.id))
                else:
                    await conn.execute('UPDATE users SET pending_email = %s WHERE id = %s', (address, user.id))
                token = await accounts.create_account_token(conn, user.id, 'verify_email', address,
                                                            timedelta(hours=settings.verify_token_hours))
        except pg_errors.UniqueViolation:
            raise errors.email_taken()
    await mail.send([mail.verify_email(address, user.username, token)])
    return ApiResponse({'pending_email': address if user.email is not None else None,
                        'email': user.email if user.email is not None else address}, status=202)


@route(account, '/email/pending', ['DELETE'])
@only_me
async def cancel_email_change(request):
    user, _ = auth_module.require_session(request)
    async with db.connection() as conn:
        await conn.execute('UPDATE users SET pending_email = NULL WHERE id = %s', (user.id,))
    return ApiResponse(status=204)


# --- password (§8.5) ------------------------------------------------------------------------------------------------

@route(account, '/password', ['PUT'])
@only_me
async def change_password(request):
    user, session = auth_module.require_session(request)
    body = body_of(request)
    new_password = body.get('new_password') if isinstance(body.get('new_password'), str) else None
    if user.password_hash:
        current = body.get('current_password')
        if not isinstance(current, str) or not await passwords.verify_account(user.password_hash, current):
            raise errors.invalid_credentials()
    else:
        await auth_module.require_fresh(request)
        if not user.email or not user.email_verified:
            raise errors.email_not_verified()
    reason = passwords.account_password_reason(new_password, user.username, user.email)
    if reason:
        raise errors.invalid_password(reason, field='new_password')
    if user.password_hash and await passwords.verify_account(user.password_hash, new_password):
        raise errors.same_password()
    password_hash = await passwords.hash(new_password)
    async with db.connection() as conn:
        async with conn.transaction():
            await conn.execute('UPDATE users SET password_hash = %s WHERE id = %s', (password_hash, user.id))
            # the current password proved who this is
            await conn.execute('UPDATE sessions SET authenticated_at = now() WHERE id = %s', (session.id,))
            await accounts.revoke_sessions(conn, user.id, 'password_change', keep=session.id)
    if user.email:
        await mail.send([mail.password_changed(user.email, user.username)])
    return ApiResponse(status=204)


# --- deleting the account (§8.8) ---------------------------------------------------------------------------------

@route(account, '/delete', ['POST'])
@only_me
async def request_deletion(request):
    user, session = auth_module.require_session(request)
    settings = account_settings()
    if user.state == 'pending_deletion':
        raise errors.account_delete_not_allowed('pending')
    async with db.connection() as conn:
        if await accounts._one(conn, 'SELECT 1 FROM staff WHERE user_id = %s', (user.id,)):
            raise errors.account_delete_not_allowed('staff')
        await auth_module.require_fresh(request, conn)
        if body_of(request).get('confirm_username') != user.username:
            raise errors.invalid_parameters({'confirm_username': 'Type your username to confirm'})
        async with conn.transaction():
            row = await accounts._one(conn, (
                'UPDATE users SET deletion_requested_at = now(), deletion_scheduled_for = now() + '
                'make_interval(days => %s) WHERE id = %s AND deletion_requested_at IS NULL '
                'RETURNING deletion_requested_at, deletion_scheduled_for'), (settings.deletion_grace_days, user.id))
            if row is None:
                raise errors.account_delete_not_allowed('pending')
            await accounts.revoke_sessions(conn, user.id, 'deletion_requested', keep=session.id)
    if user.email and user.email_verified:
        await mail.send([mail.deletion_requested(user.email, user.username, mail.date_text(row[1]))])
    return ApiResponse({'deletion': {'requested_at': epoch(row[0]), 'scheduled_for': epoch(row[1])}}, status=202)


@route(account, '/delete/cancel', ['POST'])
@only_me
async def cancel_deletion(request):
    """Keep my account: content, keys and domains work again (domains are re-checked at once)."""
    user, _ = auth_module.require_session(request)
    async with db.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute('UPDATE users SET deletion_requested_at = NULL, deletion_scheduled_for = NULL '
                                        'WHERE id = %s AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL',
                                        (user.id,))
            cancelled = cursor.rowcount > 0
            if cancelled:
                await conn.execute("UPDATE custom_domains SET next_check_at = now() WHERE user_id = %s AND "
                                   "deleted_at IS NULL AND status NOT IN ('failed', 'paused', 'disabled')", (user.id,))
        body = await accounts.user_object(conn, await accounts.load_user(conn, user.id))
    if cancelled and user.email and user.email_verified:
        await mail.send([mail.deletion_cancelled(user.email, user.username)])
    return ApiResponse(body)


# --- data export (§8.7) ------------------------------------------------------------------------------------------------

EXPORT_COLUMNS = 'id, status, created_at, ready_at, expires_at, size, storage_key'


def export_dict(row):
    status = row[1]
    if status == 'ready' and row[4] is not None and row[4] <= accounts.utcnow():
        status = 'expired'
    return {'id': str(row[0]), 'status': status, 'created_at': epoch(row[2]), 'ready_at': epoch(row[3]),
            'expires_at': epoch(row[4]), 'size': row[5]}


@route(account, '/exports', ['POST'])
@only_me
async def request_export(request):
    user, _ = auth_module.require_session(request)
    export_id = Snowflake.generate()
    async with db.connection() as conn:
        async with conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('export:{}'.format(user.id),))
            last = await accounts._one(conn, "SELECT ceil(extract(epoch FROM (created_at + interval '24 hours' - "
                                             "now())))::int FROM data_exports WHERE user_id = %s AND created_at > "
                                             "now() - interval '24 hours' ORDER BY id DESC LIMIT 1", (user.id,))
            if last is not None:
                raise errors.export_limit(max(1, last[0]))
            await conn.execute("INSERT INTO data_exports (id, user_id, status) VALUES (%s, %s, 'queued')",
                               (export_id, user.id))
            await jobs.enqueue_async('account_export', {'export_id': str(export_id)}, conn=conn)
        row = await accounts._one(conn, 'SELECT {} FROM data_exports WHERE id = %s'.format(EXPORT_COLUMNS),
                                  (export_id,))
    return ApiResponse({'export': export_dict(row)}, status=202)


@route(account, '/exports', ['GET'])
@only_me
async def list_exports(request):
    user, _ = auth_module.require_session(request)
    async with db.connection() as conn:
        rows = await accounts._all(conn, 'SELECT {} FROM data_exports WHERE user_id = %s ORDER BY id DESC '
                                         'LIMIT 20'.format(EXPORT_COLUMNS), (user.id,))
    return ApiResponse({'items': [export_dict(r) for r in rows]})


@route(account, '/exports/<export_id:str>/download', ['GET'])
@only_me
async def download_export(request, export_id):
    user, _ = auth_module.require_session(request)
    export_id = _id(export_id, errors.unknown_export)
    async with db.connection() as conn:
        row = await accounts._one(conn, 'SELECT {} FROM data_exports WHERE id = %s AND user_id = %s'.format(
            EXPORT_COLUMNS), (export_id, user.id))
    if row is None:
        raise errors.unknown_export()
    data = export_dict(row)
    if data['status'] == 'expired':
        raise errors.unknown_export()
    if data['status'] != 'ready':
        raise errors.export_not_ready()
    storage = request.app.ctx.storage
    try:
        response = await storage.client.get_object(Bucket=storage.bucket, Key=row[6])
        async with response['Body'] as stream:
            content = await stream.read()
    except Exception:
        raise errors.unknown_export()
    day = row[3].strftime('%Y-%m-%d') if row[3] is not None else 'export'
    filename = 'filesgg-export-{}-{}.zip'.format(re.sub(r'[^a-z0-9_.]', '_', user.username), day)
    return HTTPResponse(content, status=200, headers={
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="{}"'.format(filename),
        'cache-control': 'private, no-store',
    })
