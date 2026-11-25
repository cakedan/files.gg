"""Accounts for the async API (contract milestone-6 §2, §3): loading users with their premium flag, the
user object, sessions, email links, rate limits and claiming anonymous uploads."""

import time

from datetime import datetime, timedelta, timezone

from db.models import User, columns, epoch, from_row, width
from utils import credentials, errors
from utils.account_settings import account_settings
from utils.generators import Snowflake

USER_COLUMNS = columns(User, 'u')
# §9.1: premium = an unrevoked, unexpired `premium` entitlement
PREMIUM_SQL = ("EXISTS (SELECT 1 FROM user_entitlements e WHERE e.user_id = u.id AND e.kind = 'premium' AND "
               "e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now()))")
PREMIUM_EXPIRY_SQL = ("(SELECT e.expires_at FROM user_entitlements e WHERE e.user_id = u.id AND e.kind = 'premium' AND "
                      "e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now()) LIMIT 1)")
USER_FIELDS = '{}, {}, {}'.format(USER_COLUMNS, PREMIUM_SQL, PREMIUM_EXPIRY_SQL)
USER_SELECT = 'SELECT ' + USER_FIELDS + ' FROM users u'
USER_WIDTH = width(User) + 2
DISCORD_CDN = 'https://cdn.discordapp.com'
SESSION_COLUMNS = ('id', 'user_id', 'method', 'created_at', 'authenticated_at', 'last_used_at', 'expires_at',
                   'max_expires_at')


def utcnow():
    return datetime.now(timezone.utc)


def user_from_row(row, offset=0):
    user = from_row(User, row, offset)
    user.premium = bool(row[offset + width(User)])
    user.premium_expires_at = row[offset + width(User) + 1]
    return user


async def _one(conn, sql, params=()):
    cursor = await conn.execute(sql, params)
    return await cursor.fetchone()


async def _all(conn, sql, params=()):
    cursor = await conn.execute(sql, params)
    return await cursor.fetchall()


async def load_user(conn, user_id, include_deleted=False):
    sql = USER_SELECT + ' WHERE u.id = %s'
    if not include_deleted:
        sql += ' AND u.deleted_at IS NULL'
    row = await _one(conn, sql, (user_id,))
    return user_from_row(row) if row else None


async def user_by_email(conn, email):
    """Accounts that aren't permanently deleted, by lower(email)."""
    row = await _one(conn, USER_SELECT + ' WHERE lower(u.email) = lower(%s) AND u.deleted_at IS NULL', (email,))
    return user_from_row(row) if row else None


async def email_in_use(conn, email, except_user=None):
    row = await _one(conn, 'SELECT 1 FROM users WHERE lower(email) = lower(%s) AND id IS DISTINCT FROM %s',
                     (email, except_user))
    return row is not None


async def username_available(conn, username, user_id=None):
    """Free for `user_id`: nobody else has it, and it isn't held for someone else (§2.2)."""
    row = await _one(conn, 'SELECT 1 FROM users WHERE username = %s AND id IS DISTINCT FROM %s', (username, user_id))
    if row is not None:
        return False
    row = await _one(conn, 'SELECT user_id FROM username_holds WHERE username = %s AND held_until > now()', (username,))
    return row is None or (user_id is not None and row[0] == user_id)


# --- the user object (§2.1) -------------------------------------------------------------------------------------

def avatar_url(discord_id, avatar):
    if avatar:
        url = '{}/avatars/{}/{}.webp?size=64'.format(DISCORD_CDN, discord_id, avatar)
        return url + '&animated=true' if avatar.startswith('a_') else url
    try:
        index = (int(discord_id) >> 22) % 6
    except (TypeError, ValueError):
        index = 0
    return '{}/embed/avatars/{}.png'.format(DISCORD_CDN, index)


def identity_dict(row):
    """(provider, provider_user_id, username, display_name, avatar, created_at, last_used_at)."""
    provider, provider_user_id, username, display_name, avatar, created_at, last_used_at = row
    return {'provider': provider, 'username': username, 'display_name': display_name,
            'avatar_url': avatar_url(provider_user_id, avatar), 'created_at': epoch(created_at),
            'last_used_at': epoch(last_used_at)}


IDENTITY_COLUMNS = 'provider, provider_user_id, username, display_name, avatar, created_at, last_used_at'


async def identities(conn, user_id):
    return [identity_dict(r) for r in await _all(
        conn, 'SELECT {} FROM user_identities WHERE user_id = %s ORDER BY id'.format(IDENTITY_COLUMNS), (user_id,))]


def username_change_available_at(user, settings=None):
    settings = settings or account_settings()
    if user.needs_username or user.username_changed_at is None:
        return None
    at = user.username_changed_at + timedelta(days=settings.username_cooldown_days)
    return None if at <= utcnow() else epoch(at)


def deletion_dict(user):
    if user.deletion_requested_at is None:
        return None
    return {'requested_at': epoch(user.deletion_requested_at), 'scheduled_for': epoch(user.deletion_scheduled_for)}


async def user_object(conn, user):
    from utils import standing
    staff = await _one(conn, 'SELECT role, child_safety FROM staff WHERE user_id = %s', (user.id,))
    rows = await standing.restrictions(conn, user.id)
    return {
        'id': str(user.id),
        'username': user.username,
        'display_name': user.display_name,
        'email': user.email,
        'email_verified': user.email_verified,
        'pending_email': user.pending_email,
        'has_password': user.password_hash is not None,
        'needs_username': user.needs_username,
        'created_at': epoch(user.created_at),
        'username_changed_at': epoch(user.username_changed_at),
        'username_change_available_at': username_change_available_at(user),
        'identities': await identities(conn, user.id),
        'settings': {'show_name_on_albums': user.show_name_on_albums, 'domain_only': user.domain_only},
        'premium': {'active': user.premium, 'expires_at': epoch(user.premium_expires_at)},
        'deletion': deletion_dict(user),
        'staff': {'role': staff[0], 'child_safety': staff[1]} if staff else None,
        'restrictions': [{'kind': kind, 'until': epoch(ends_at), 'notice_id': str(notice) if notice else None}
                         for _, kind, _, ends_at, notice in rows],
    }


async def login_methods(conn, user):
    methods = []
    if user.password_hash:
        methods.append('password')
    if await _one(conn, "SELECT 1 FROM user_identities WHERE user_id = %s AND provider = 'discord'", (user.id,)):
        methods.append('discord')
    return methods


# --- sessions (§3) ---------------------------------------------------------------------------------------------------

class Session:
    def __init__(self, row):
        for name, value in zip(SESSION_COLUMNS, row):
            setattr(self, name, value)

    def fresh(self, settings=None):
        settings = settings or account_settings()
        return self.authenticated_at >= utcnow() - timedelta(seconds=settings.reauth_seconds)


async def load_session(conn, token):
    """(user, session) for a live session token, else None (§3.4 step 4)."""
    row = await _one(conn, (
        'SELECT {}, {} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = %s '
        'AND s.revoked_at IS NULL AND s.expires_at > now() AND s.max_expires_at > now() AND u.deleted_at IS NULL'
    ).format(', '.join('s.' + c for c in SESSION_COLUMNS), USER_FIELDS), (credentials.token_hash(token),))
    if row is None:
        return None
    return user_from_row(row, len(SESSION_COLUMNS)), Session(row[:len(SESSION_COLUMNS)])


async def touch_session(conn, session, country=None, settings=None):
    """§3.4 step 5: at most every 10 minutes, record the use and slide the idle expiry."""
    settings = settings or account_settings()
    if session.last_used_at > utcnow() - timedelta(minutes=10):
        return
    await conn.execute(
        'UPDATE sessions SET last_used_at = now(), last_country = COALESCE(%s, last_country), '
        'expires_at = least(now() + make_interval(days => %s), max_expires_at) WHERE id = %s',
        (country, settings.session_idle_days, session.id))


def country_of(request):
    """CF-IPCountry as the Worker forwarded it: two letters, or None (XX is unknown, T1 is Tor)."""
    if not getattr(request.ctx, 'from_worker', False):
        return None
    value = (request.headers.get('cf-ipcountry') or '').strip().upper()
    return value if len(value) == 2 and value.isalpha() and value != 'XX' else None


async def create_session(conn, request, user_id, method, settings=None):
    """A new session row; the response sets its cookie (request.ctx.set_cookie). The 51st sign-in ends
    the least recently used session (`limit`). Returns the idle expiry (epoch s)."""
    settings = settings or account_settings()
    token = credentials.generate(credentials.SESSION_PREFIX)
    now = utcnow()
    expires = now + timedelta(days=settings.session_idle_days)
    max_expires = now + timedelta(days=settings.session_max_days)
    if expires > max_expires:
        expires = max_expires
    agent = (request.headers.get('user-agent') or '')[:256] or None
    country = country_of(request)
    await conn.execute(
        'INSERT INTO sessions (id, user_id, token_hash, method, created_at, authenticated_at, last_used_at, '
        'expires_at, max_expires_at, user_agent, country, last_country) '
        'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)',
        (Snowflake.generate(), user_id, credentials.token_hash(token), method, now, now, now, expires, max_expires,
         agent, country, country))
    await conn.execute(
        "UPDATE sessions SET revoked_at = now(), revoked_reason = 'limit' WHERE id IN (SELECT id FROM sessions "
        'WHERE user_id = %s AND revoked_at IS NULL ORDER BY last_used_at DESC, id DESC OFFSET %s)',
        (user_id, settings.sessions_max))
    request.ctx.set_cookie = (token, int((max_expires - now).total_seconds()))
    return epoch(expires)


async def revoke_sessions(conn, user_id, reason, keep=None, only=None):
    sql = 'UPDATE sessions SET revoked_at = now(), revoked_reason = %s WHERE user_id = %s AND revoked_at IS NULL'
    params = [reason, user_id]
    if keep is not None:
        sql += ' AND id <> %s'
        params.append(keep)
    if only is not None:
        sql += ' AND id = %s'
        params.append(only)
    cursor = await conn.execute(sql, params)
    return cursor.rowcount


async def signed_in_body(conn, user_id, expires_at):
    user = await load_user(conn, user_id)
    return {'expires_at': expires_at, 'user': await user_object(conn, user)}


# --- email links (§2.5, §4.4) -------------------------------------------------------------------------------------

async def create_account_token(conn, user_id, purpose, email, lifetime):
    token = credentials.email_token()
    await conn.execute(
        'INSERT INTO account_tokens (id, user_id, purpose, email, token_hash, expires_at) '
        'VALUES (%s, %s, %s, %s, %s, now() + %s)',
        (Snowflake.generate(), user_id, purpose, email, credentials.email_token_hash(token), lifetime))
    return token


async def take_account_token(conn, token, purpose):
    """(token id, user_id, email) of an unused, unexpired link, locked for this transaction; else None."""
    digest = credentials.email_token_hash(token)
    if digest is None:
        return None
    return await _one(conn, 'SELECT id, user_id, email FROM account_tokens WHERE token_hash = %s AND purpose = %s '
                            'AND used_at IS NULL AND expires_at > now() FOR UPDATE', (digest, purpose))


# --- rate limits (§4.7), in safety_rate_limits ---------------------------------------------------------------------

WINDOWS = {'minute': 60, 'hour': 3600, 'day': 86400}


async def rate_hit(conn, scope, key, window='hour'):
    """Count one in the current window. Returns (count, seconds until the window ends)."""
    row = await _one(conn, (
        'INSERT INTO safety_rate_limits AS r (scope, key, window_start, count) '
        'VALUES (%s, %s, date_trunc(%s, now()), 1) '
        'ON CONFLICT (scope, key, window_start) DO UPDATE SET count = r.count + 1 '
        'RETURNING count, ceil(extract(epoch FROM (window_start + make_interval(secs => %s) - now())))::int'),
        (scope, key, window, WINDOWS[window]))
    return row[0], max(1, row[1])


async def rate_peek(conn, scope, key, window='hour'):
    row = await _one(conn, (
        'SELECT count, ceil(extract(epoch FROM (window_start + make_interval(secs => %s) - now())))::int FROM '
        'safety_rate_limits WHERE scope = %s AND key = %s AND window_start = date_trunc(%s, now())'),
        (WINDOWS[window], scope, key, window))
    return (row[0], max(1, row[1])) if row else (0, 0)


async def rate_limited(conn, scope, key, limit, window='hour'):
    """Count one; 429 TOO_MANY_ATTEMPTS { retry_after } when that goes over the limit."""
    count, retry_after = await rate_hit(conn, scope, key, window)
    if count > limit:
        raise errors.too_many_attempts(retry_after)


def ip_key(request):
    from safety import ip as abuse_ip
    from safety.settings import safety_settings
    from utils.helpers import client_ip
    digest = abuse_ip.abuse_ip_hash(client_ip(request), safety_settings().abuse_hash_secret)
    return ('ip:' + digest.hex()) if digest else 'ip:0', digest


def email_key(email):
    from safety.settings import safety_settings
    return credentials.email_key(safety_settings().abuse_hash_secret, email)


# --- claiming anonymous uploads (§4.2) ------------------------------------------------------------------------------

async def claim_fingerprint(conn, user, fingerprint):
    """Live files and albums made with this fingerprint move to the account (never into one with a pending
    deletion). Open upload sessions are left to finish as anonymous."""
    if fingerprint is None or user is None or user.state != 'active':
        return
    await conn.execute('UPDATE files SET user_id = %s, fingerprint = NULL WHERE fingerprint = %s AND user_id IS NULL '
                       'AND deleted_at IS NULL', (user.id, fingerprint))
    await conn.execute('UPDATE albums SET owner_user_id = %s, owner_fingerprint = NULL WHERE owner_fingerprint = %s '
                       'AND owner_user_id IS NULL AND deleted_at IS NULL', (user.id, fingerprint))


def now():
    return int(time.time())
