"""Signing in (contract milestone-6 §2-§5). The website calls these same-origin as `files.gg/api/auth/…`;
a successful sign-in sets the HttpOnly session cookie and never returns the token. Every POST here needs
the CSRF header (utils/auth.py).

    GET  /auth/config                 { discord }
    GET  /auth/guest                  { guest }: an anonymous guest token
    GET  /auth/session                { user | null }, never 401
    POST /auth/login                  { email, password, turnstile_token }
    POST /auth/register               { email, username, password, display_name?, turnstile_token }
    POST /auth/logout
    POST /auth/verify                 { token }
    POST /auth/verify/resend
    POST /auth/forgot                 { email, turnstile_token }                  always 204
    POST /auth/forgot/reset           { token, password, turnstile_token }
    POST /auth/reauth                 { password }
    POST /auth/discord/authorize      { purpose, code_challenge }
    POST /auth/discord/callback       { code, state, code_verifier, turnstile_token? }
    POST /auth/discord/signup         { signup_token, username, display_name?, turnstile_token }
"""

import time

from datetime import timedelta

from psycopg import errors as pg_errors
from sanic import Blueprint

import db
from db.models import epoch
from utils import accounts, auth as auth_module, credentials, discord, errors, mail, params, passwords, standing
from utils import usernames
from utils.account_settings import account_settings
from utils.email_domain import domain_accepts_mail
from utils.generators import Snowflake
from utils.helpers import client_ip
from utils.ratelimit import email_key, ip_hash, ip_key, limiter, user_key
from utils.responses import ApiResponse
from utils.tokens import GuestToken
from utils.turnstile import Turnstile
from utils.wrappers import route

import utils.parameters as parameters

auth = Blueprint('auth', url_prefix='/auth')

PURPOSES = ('login', 'link', 'reauth')
STATE_SECONDS = 600
SIGNUP_SECONDS = 900


def body_of(request):
    """The JSON body, or a form body (the old clients sent forms)."""
    body = params.request_json(request)
    if body is None and request.form:
        body = {k: v[0] if isinstance(v, list) and len(v) == 1 else v for k, v in request.form.items()}
    return body if isinstance(body, dict) else {}


def text(body, name):
    value = body.get(name)
    return value if isinstance(value, str) else None


async def verify_captcha(request, token, action):
    if not await Turnstile.verify(token, action, client_ip(request)):
        raise errors.captcha_invalid()


def check_email_syntax(value):
    try:
        email = parameters.email(value)
    except ValueError as error:
        return None, str(error)
    return email.strip(), None


# --- config, guest, session ---------------------------------------------------------------------------------

@route(auth, '/config', ['GET'])
async def auth_config(request):
    return ApiResponse({'discord': account_settings().discord_enabled})


@route(auth, '/guest', ['GET'])
@limiter.limit('30 per minute', scope='guest', key=ip_key)
async def auth_guest(request):
    """A guest token for anonymous uploads (milestone-5 §20.1): the caller's own re-signed, or a new id. A user id
    is never a guest id (milestone-6 §4.2): ids and guest ids are separate Snowflakes, so there's nothing to check."""
    guest_id = auth_module.guest_of(request)
    if guest_id is None:
        guest_id = Snowflake.generate()
    return ApiResponse({'guest': GuestToken.generate(guest_id)})


@route(auth, '/session', ['GET'])
async def auth_session(request):
    """§3.4: `{ user }` for a live session, `{ user: null }` otherwise (a dead cookie is cleared)."""
    current = auth_module.auth_of(request)
    if current.kind != 'session':
        return ApiResponse({'user': None})
    async with db.connection() as conn:
        return ApiResponse({'user': await accounts.user_object(conn, current.user)})


# --- email and password (§4) -------------------------------------------------------------------------------------

async def end_current_session(conn, request):
    """One browser, one session: a sign-in first ends the session it replaces."""
    current = auth_module.auth_of(request)
    if current.kind == 'session':
        await accounts.revoke_sessions(conn, current.user.id, 'logout', only=current.session.id)


@route(auth, '/login', ['POST'])
async def auth_login(request):
    body = body_of(request)
    email, password = text(body, 'email'), text(body, 'password')
    problems = {}
    if not email:
        problems['email'] = 'Missing required parameter in the JSON body or the post body or the query string'
    if password is None:
        problems['password'] = 'Missing required parameter in the JSON body or the post body or the query string'
    if problems:
        raise errors.invalid_parameters(problems)
    settings = account_settings()
    # milestone-5 §18.3: failures only, per network and per account (closed): checked first, recorded on failure
    limits = (('login_ip', ip_key(request)), ('login_account', email_key(email)))
    await limiter.hit_many(request, limits, record=False)
    await verify_captcha(request, text(body, 'turnstile_token'), 'login')
    async with db.connection() as conn:
        user = await accounts.user_by_email(conn, email.strip())
    ok = await passwords.verify_account(user.password_hash if user else None, password)
    if not ok or user is None:
        await limiter.hit_many(request, limits, quiet=True)
        raise errors.invalid_credentials()
    new_hash = None
    if passwords.needs_rehash(user.password_hash):
        new_hash = await passwords.hash(password)
    async with db.connection() as conn:
        async with conn.transaction():
            if new_hash:
                await conn.execute('UPDATE users SET password_hash = %s WHERE id = %s', (new_hash, user.id))
            await end_current_session(conn, request)
            await accounts.claim_guest(conn, user, auth_module.guest_of(request))
            expires_at = await accounts.create_session(conn, request, user.id, 'password', settings)
        return ApiResponse(await accounts.signed_in_body(conn, user.id, expires_at))


def validate_new_account(body, need_email=True):
    """Field checks for register and Discord sign-up, reported together (§4.3): one problem is its own
    code (USERNAME_INVALID, DISPLAY_NAME_INVALID, INVALID_PASSWORD), several are INVALID_PARAMETERS with
    `errors` and `reasons`."""
    found = []
    email = None
    if need_email:
        email, problem = check_email_syntax(text(body, 'email') or '')
        if problem:
            found.append(('email', errors.invalid_parameters({'email': problem}), None))
    username, reason = usernames.check(text(body, 'username'))
    if reason:
        found.append(('username', errors.username_invalid(reason, usernames.REASON_MESSAGES[reason]), reason))
    display_name = usernames.clean_display_name(text(body, 'display_name'))
    reason = usernames.display_name_reason(display_name)
    if reason:
        found.append(('display_name', errors.display_name_invalid(reason), reason))
    if need_email:
        password = text(body, 'password')
        reason = passwords.account_password_reason(password, username, email)
        if reason:
            found.append(('password', errors.invalid_password(reason), reason))
    if len(found) == 1:
        raise found[0][1]
    if found:
        error = errors.invalid_parameters({f: e.data['errors'][f] for f, e, _ in found})
        error.data['reasons'] = {f: r for f, _, r in found if r}
        raise error
    return email, username, display_name


async def check_bans(conn, request):
    """§11.3: a banned guest or IP can't create an account."""
    if await standing.banned(conn, auth_module.guest_of(request), ip_hash(request)):
        raise errors.banned()


@route(auth, '/register', ['POST'])
async def auth_register(request):
    body = body_of(request)
    settings = account_settings()
    await limiter.hit(request, 'register', ip_key(request))
    async with db.connection() as conn:
        await check_bans(conn, request)
    email, username, display_name = validate_new_account(body)
    await verify_captcha(request, text(body, 'turnstile_token'), 'register')
    # Postmark has no mailbox check: refuse domains that can't receive mail (keeps bounces low)
    if not await domain_accepts_mail(email):
        raise errors.invalid_email()
    password_hash = await passwords.hash(text(body, 'password'))
    user_id = Snowflake.generate()
    async with db.connection() as conn:
        if await accounts.email_in_use(conn, email):
            raise errors.email_taken()
        if not await accounts.username_available(conn, username):
            raise errors.username_taken()
        try:
            async with conn.transaction():
                await conn.execute(
                    'INSERT INTO users (id, email, username, display_name, password_hash) VALUES (%s, %s, %s, %s, %s)',
                    (user_id, email, username, display_name, password_hash))
                user = await accounts.load_user(conn, user_id)
                await accounts.claim_guest(conn, user, auth_module.guest_of(request))
                expires_at = await accounts.create_session(conn, request, user_id, 'register', settings)
                token = await accounts.create_account_token(conn, user_id, 'verify_email', email,
                                                            timedelta(hours=settings.verify_token_hours))
        except pg_errors.UniqueViolation as error:
            raise errors.username_taken() if 'username' in str(error) else errors.email_taken()
        response = await accounts.signed_in_body(conn, user_id, expires_at)
    # the account works at once; a failed send can be retried with /auth/verify/resend
    await mail.send([mail.verify_email(email, username, token)])
    return ApiResponse(response, status=201)


@route(auth, '/logout', ['POST'])
async def auth_logout(request):
    """Ends the current session and clears the cookie; idempotent (§4.5)."""
    current = auth_module.auth_of(request)
    if current.kind == 'session':
        async with db.connection() as conn:
            await accounts.revoke_sessions(conn, current.user.id, 'logout', only=current.session.id)
    request.ctx.clear_cookie = True
    return ApiResponse(status=204)


@route(auth, '/verify', ['POST'])
async def auth_verify(request):
    """The link is the proof (§2.5): no session, no Turnstile, and it doesn't sign anyone in. A pending email
    change whose address was taken meanwhile is dropped (409 EMAIL_TAKEN), and the link is used up."""
    token = text(body_of(request), 'token')
    sent, taken = [], False
    async with db.connection() as conn:
        async with conn.transaction():
            row = await accounts.take_account_token(conn, token, 'verify_email')
            if row is None:
                raise errors.invalid_token()
            token_id, user_id, address = row
            user = await accounts.load_user(conn, user_id)
            if user is None:
                raise errors.invalid_token()
            if user.email is not None and user.email.lower() == address.lower():
                await conn.execute('UPDATE users SET email_verified = true WHERE id = %s', (user_id,))
            elif user.pending_email is not None and user.pending_email.lower() == address.lower():
                if await accounts.email_in_use(conn, user.pending_email, except_user=user_id):
                    await conn.execute('UPDATE users SET pending_email = NULL WHERE id = %s', (user_id,))
                    taken = True
                else:
                    await conn.execute('UPDATE users SET email = pending_email, email_verified = true, '
                                       'pending_email = NULL WHERE id = %s', (user_id,))
                    if user.email:
                        sent.append(mail.email_changed(user.email, user.username, user.pending_email))
            else:
                # the account's email changed since the link was sent
                raise errors.invalid_token()
            await conn.execute('UPDATE account_tokens SET used_at = now() WHERE id = %s', (token_id,))
    if taken:
        raise errors.email_taken()
    await mail.send(sent)
    return ApiResponse(status=204)


@route(auth, '/verify/resend', ['POST'])
async def auth_verify_resend(request):
    user, _ = auth_module.require_session(request)
    settings = account_settings()
    address = user.pending_email or (user.email if user.email and not user.email_verified else None)
    if address is None:
        raise errors.nothing_to_verify()
    await limiter.hit(request, 'verify_resend', user_key(user.id))
    async with db.connection() as conn:
        token = await accounts.create_account_token(conn, user.id, 'verify_email', address,
                                                    timedelta(hours=settings.verify_token_hours))
    await mail.send([mail.verify_email(address, user.username, token)], raise_errors=True)
    return ApiResponse(status=204)


@route(auth, '/forgot', ['POST'])
async def auth_forgot(request):
    """Always 204 (§4.4): unknown emails and rate-limited sends look the same."""
    body = body_of(request)
    await verify_captcha(request, text(body, 'turnstile_token'), 'forgot')
    email = (text(body, 'email') or '').strip()
    settings = account_settings()
    sent = []
    if email:
        # milestone-5 §18.3: closed, and silent: over either limit sends nothing, with the same answer
        hits = await limiter.hit_many(request, (('forgot_ip', ip_key(request)), ('forgot_account', email_key(email))),
                                      quiet=True)
        async with db.connection() as conn:
            user = await accounts.user_by_email(conn, email)
            if user is not None and all(hit.allowed for hit in hits):
                token = await accounts.create_account_token(conn, user.id, 'reset_password', user.email,
                                                            timedelta(minutes=settings.reset_token_minutes))
                sent.append(mail.reset_password(user.email, user.username, token))
    await mail.send(sent)
    return ApiResponse(status=204)


@route(auth, '/forgot/reset', ['POST'])
async def auth_forgot_reset(request):
    body = body_of(request)
    await verify_captcha(request, text(body, 'turnstile_token'), 'reset')
    settings = account_settings()
    password = text(body, 'password')
    async with db.connection() as conn:
        async with conn.transaction():
            row = await accounts.take_account_token(conn, text(body, 'token'), 'reset_password')
            if row is None:
                raise errors.invalid_token()
            token_id, user_id, address = row
            user = await accounts.load_user(conn, user_id)
            if user is None or user.email is None or user.email.lower() != address.lower():
                raise errors.invalid_token()
            reason = passwords.account_password_reason(password, user.username, user.email)
            if reason:
                raise errors.invalid_password(reason)
            if user.password_hash and await passwords.verify_account(user.password_hash, password):
                raise errors.same_password()
            await conn.execute('UPDATE users SET password_hash = %s, email_verified = true WHERE id = %s',
                               (await passwords.hash(password), user_id))
            await conn.execute('UPDATE account_tokens SET used_at = now() WHERE id = %s', (token_id,))
            await accounts.revoke_sessions(conn, user_id, 'password_reset')
            expires_at = await accounts.create_session(conn, request, user_id, 'reset', settings)
        response = await accounts.signed_in_body(conn, user_id, expires_at)
    await mail.send([mail.password_changed(user.email, user.username)])
    return ApiResponse(response)


@route(auth, '/reauth', ['POST'])
async def auth_reauth(request):
    user, session = auth_module.require_session(request)
    # milestone-5 §18.3: failures only (closed): checked first, recorded on failure
    await limiter.peek(request, 'reauth', user_key(user.id))
    if not user.password_hash or not await passwords.verify_account(user.password_hash,
                                                                     text(body_of(request), 'password')):
        await limiter.hit_many(request, (('reauth', user_key(user.id)),), quiet=True)
        raise errors.invalid_credentials()
    async with db.connection() as conn:
        await conn.execute('UPDATE sessions SET authenticated_at = now() WHERE id = %s', (session.id,))
    return ApiResponse(status=204)


# --- Discord (§5) ---------------------------------------------------------------------------------------------------

def require_discord():
    settings = account_settings()
    if not settings.discord_enabled:
        raise errors.discord_unavailable()
    return settings


async def require_active_for_link(request, user):
    """Linking is an account change: not while suspended or pending deletion (§8.8, §11.1)."""
    if user.state == 'pending_deletion':
        raise errors.account_pending_deletion(epoch(user.deletion_scheduled_for))
    async with db.connection() as conn:
        await standing.check_not_suspended(conn, user)


@route(auth, '/discord/authorize', ['POST'])
async def discord_authorize(request):
    settings = require_discord()
    body = body_of(request)
    purpose = body.get('purpose')
    challenge = body.get('code_challenge')
    if purpose not in PURPOSES:
        raise errors.invalid_parameters({'purpose': 'login, link or reauth'})
    if not credentials.valid_challenge(challenge):
        raise errors.invalid_parameters({'code_challenge': 'An S256 code challenge (43 characters)'})
    user_id = None
    if purpose in ('link', 'reauth'):
        user, _ = auth_module.require_session(request)
        if purpose == 'link':
            await require_active_for_link(request, user)
        user_id = str(user.id)
    now = int(time.time())
    state = credentials.sign({'p': purpose, 'c': challenge, 'n': credentials.nonce(), 'u': user_id, 'i': now,
                              'e': now + STATE_SECONDS}, credentials.STATE_LABEL, request.app.ctx.access_secret)
    return ApiResponse({'url': discord.authorize_url(state, challenge, purpose, settings), 'state': state})


def check_state(request, state, verifier):
    """§5.2 step 5.2-5.3: signature, expiry and purpose; the session's user for link and reauth; and the
    PKCE verifier against the challenge the state carries."""
    claims = credentials.unsign(state, credentials.STATE_LABEL, request.app.ctx.access_secret)
    if claims is None or claims.get('p') not in PURPOSES or not credentials.valid_challenge(claims.get('c')):
        raise errors.invalid_oauth_state()
    if claims['p'] in ('link', 'reauth'):
        current = auth_module.auth_of(request)
        if current.kind != 'session' or claims.get('u') != str(current.user.id):
            raise errors.invalid_oauth_state()
    if not credentials.valid_verifier(verifier) or credentials.code_challenge(verifier) != claims['c']:
        raise errors.invalid_oauth_state()
    return claims


async def suggested_username(conn, discord_username):
    for candidate in usernames.suggestions(discord_username):
        name, reason = usernames.check(candidate)
        if reason is None and await accounts.username_available(conn, name):
            return name
    return 'user_{:06d}'.format(Snowflake.generate() % 10 ** 6)


@route(auth, '/discord/callback', ['POST'])
async def discord_callback(request):
    settings = require_discord()
    body = body_of(request)
    await limiter.hit(request, 'discord', ip_key(request))
    claims = check_state(request, text(body, 'state'), text(body, 'code_verifier'))
    purpose = claims['p']
    if purpose == 'login':
        await verify_captcha(request, text(body, 'turnstile_token'), 'login')
    code = text(body, 'code')
    if not code or len(code) > 512:
        raise errors.discord_code_invalid()
    token = await discord.exchange(code, text(body, 'code_verifier'), settings)
    try:
        me = await discord.current_user(token, settings)
    finally:
        # never stored, and revoked as soon as /users/@me is read
        await discord.revoke(token, settings)
    if purpose == 'login':
        return await discord_login(request, me, settings)
    user, session = auth_module.require_session(request)
    if purpose == 'reauth':
        async with db.connection() as conn:
            row = await accounts._one(conn, "SELECT provider_user_id FROM user_identities WHERE user_id = %s AND "
                                            "provider = 'discord'", (user.id,))
            if row is None or row[0] != me['id']:
                raise errors.identity_mismatch()
            await conn.execute('UPDATE sessions SET authenticated_at = now() WHERE id = %s', (session.id,))
            await conn.execute("UPDATE user_identities SET last_used_at = now() WHERE user_id = %s AND "
                               "provider = 'discord'", (user.id,))
        return ApiResponse({'status': 'reauthenticated'})
    return await discord_link(request, user, me)


async def discord_login(request, me, settings):
    async with db.connection() as conn:
        row = await accounts._one(conn, (
            "SELECT i.user_id FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'discord' "
            'AND i.provider_user_id = %s AND u.deleted_at IS NULL'), (me['id'],))
        if row is not None:
            user = await accounts.load_user(conn, row[0])
            async with conn.transaction():
                await conn.execute(
                    "UPDATE user_identities SET username = %s, display_name = %s, avatar = %s, last_used_at = now() "
                    "WHERE provider = 'discord' AND provider_user_id = %s",
                    (me['username'], me['global_name'], me['avatar'], me['id']))
                await end_current_session(conn, request)
                await accounts.claim_guest(conn, user, auth_module.guest_of(request))
                expires_at = await accounts.create_session(conn, request, user.id, 'discord', settings)
            body = await accounts.signed_in_body(conn, user.id, expires_at)
            return ApiResponse(dict(body, status='signed_in'))
        email = {'address': me['email'], 'usable': False, 'reason': None}
        if not me['email']:
            email['reason'] = 'missing'
        elif not me['verified']:
            email['reason'] = 'unverified'
        elif await accounts.email_in_use(conn, me['email']):
            email['reason'] = 'in_use'
        else:
            email['usable'] = True
        suggestion = await suggested_username(conn, me['username'])
    now = int(time.time())
    signup = credentials.sign({'d': me['id'], 'n': me['username'], 'g': me['global_name'], 'a': me['avatar'],
                               'm': me['email'], 'mv': me['verified'], 'e': now + SIGNUP_SECONDS},
                              credentials.SIGNUP_LABEL, request.app.ctx.access_secret)
    return ApiResponse({
        'status': 'signup_required',
        'signup_token': signup,
        'suggested_username': suggestion,
        'discord': {'id': me['id'], 'username': me['username'], 'display_name': me['global_name'],
                    'avatar_url': accounts.avatar_url(me['id'], me['avatar'])},
        'email': email,
    })


async def discord_link(request, user, me):
    await require_active_for_link(request, user)
    sent = []
    async with db.connection() as conn:
        async with conn.transaction():
            row = await accounts._one(conn, "SELECT user_id FROM user_identities WHERE provider = 'discord' AND "
                                            'provider_user_id = %s', (me['id'],))
            if row is not None and row[0] != user.id:
                raise errors.identity_in_use()
            if row is None:
                if await accounts._one(conn, "SELECT 1 FROM user_identities WHERE user_id = %s AND provider = 'discord'",
                                       (user.id,)):
                    raise errors.identity_already_linked()
                try:
                    async with conn.transaction():
                        await conn.execute(
                            'INSERT INTO user_identities (id, user_id, provider, provider_user_id, username, '
                            "display_name, avatar, last_used_at) VALUES (%s, %s, 'discord', %s, %s, %s, %s, now())",
                            (Snowflake.generate(), user.id, me['id'], me['username'], me['global_name'], me['avatar']))
                except pg_errors.UniqueViolation:
                    raise errors.identity_in_use()
                if user.email:
                    sent.append(mail.discord_linked(user.email, user.username, me['username']))
        identity = await accounts._one(conn, 'SELECT {} FROM user_identities WHERE user_id = %s AND provider = '
                                             "'discord'".format(accounts.IDENTITY_COLUMNS), (user.id,))
    await mail.send(sent)
    return ApiResponse({'status': 'linked', 'identity': accounts.identity_dict(identity)})


@route(auth, '/discord/signup', ['POST'])
async def discord_signup(request):
    settings = require_discord()
    body = body_of(request)
    await verify_captcha(request, text(body, 'turnstile_token'), 'register')
    await limiter.hit(request, 'register', ip_key(request))
    async with db.connection() as conn:
        await check_bans(conn, request)
    claims = credentials.unsign(text(body, 'signup_token'), credentials.SIGNUP_LABEL, request.app.ctx.access_secret)
    if claims is None or not isinstance(claims.get('d'), str):
        raise errors.invalid_signup_token()
    _, username, display_name = validate_new_account(body, need_email=False)
    email, verified = None, False
    user_id = Snowflake.generate()
    async with db.connection() as conn:
        if await accounts._one(conn, "SELECT 1 FROM user_identities WHERE provider = 'discord' AND "
                                     'provider_user_id = %s', (claims['d'],)):
            raise errors.identity_in_use()
        if claims.get('m') and claims.get('mv') is True:
            if await accounts.email_in_use(conn, claims['m']):
                raise errors.discord_email_in_use()
            email, verified = claims['m'], True
        if not await accounts.username_available(conn, username):
            raise errors.username_taken()
        try:
            async with conn.transaction():
                await conn.execute('INSERT INTO users (id, email, email_verified, username, display_name) '
                                   'VALUES (%s, %s, %s, %s, %s)', (user_id, email, verified, username, display_name))
                await conn.execute(
                    'INSERT INTO user_identities (id, user_id, provider, provider_user_id, username, display_name, '
                    "avatar, last_used_at) VALUES (%s, %s, 'discord', %s, %s, %s, %s, now())",
                    (Snowflake.generate(), user_id, claims['d'], claims.get('n'), claims.get('g'), claims.get('a')))
                user = await accounts.load_user(conn, user_id)
                await accounts.claim_guest(conn, user, auth_module.guest_of(request))
                expires_at = await accounts.create_session(conn, request, user_id, 'discord', settings)
        except pg_errors.UniqueViolation as error:
            message = str(error)
            if 'user_identities' in message or 'provider' in message:
                raise errors.identity_in_use()
            if 'email' in message:
                raise errors.discord_email_in_use()
            raise errors.username_taken()
        return ApiResponse(await accounts.signed_in_body(conn, user_id, expires_at), status=201)
