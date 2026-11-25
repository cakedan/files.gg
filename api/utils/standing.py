"""An account's or uploader's standing (contract milestone-4 §8.4, §9.3), for the async API:
bans, upload restrictions and suspension."""

from db.models import epoch
from utils import errors

ACTIVE = 'lifted_at IS NULL AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())'
# What a suspended account can still do (milestone-4 §8.4, amended by milestone-6 §11.1): sign in and recover
# the account, read itself, its badges and its notices, its sessions and password, and its data exports.
# (method or None for any, exact path or prefix ending in '*')
SUSPENDED_ALLOWED = (
    ('GET', '/auth/session'), ('GET', '/auth/config'), ('GET', '/auth/fingerprint'), ('POST', '/auth/login'),
    ('POST', '/auth/discord/authorize'), ('POST', '/auth/discord/callback'), ('POST', '/auth/logout'),
    ('POST', '/auth/forgot'), ('POST', '/auth/forgot/reset'), ('POST', '/auth/verify'),
    ('POST', '/auth/verify/resend'), ('POST', '/auth/reauth'),
    ('GET', '/users/@me'), ('GET', '/users/@me/badges'), (None, '/users/@me/warnings*'),
    ('GET', '/users/@me/sessions*'), ('DELETE', '/users/@me/sessions*'), ('PUT', '/users/@me/password'),
    ('POST', '/users/@me/exports*'), ('GET', '/users/@me/exports*'),
)
# What an account with a pending deletion can still do (milestone-6 §8.8): sign in (and recover), sign out,
# read itself, cancel the deletion, manage its sessions and take its data.
PENDING_DELETION_ALLOWED = (
    ('GET', '/auth/session'), ('GET', '/auth/config'), ('GET', '/auth/fingerprint'), ('POST', '/auth/login'),
    ('POST', '/auth/discord/authorize'), ('POST', '/auth/discord/callback'), ('POST', '/auth/logout'),
    ('POST', '/auth/forgot'), ('POST', '/auth/forgot/reset'), ('POST', '/auth/verify'), ('POST', '/auth/reauth'),
    ('GET', '/users/@me'), ('POST', '/users/@me/delete'), ('POST', '/users/@me/delete/cancel'),
    ('GET', '/users/@me/sessions*'), ('DELETE', '/users/@me/sessions*'),
    ('POST', '/users/@me/exports*'), ('GET', '/users/@me/exports*'),
)
# The account's own endpoints, where those rules apply. Public reads (files, albums, /access/...) aren't
# account actions: a suspended or locked account reads them like anyone else (its own content is offline).
ACCOUNT_PATHS = ('/users/', '/uploads', '/reports', '/auth/')


async def _all(conn, sql, params=()):
    cursor = await conn.execute(sql, params)
    return await cursor.fetchall()


async def restrictions(conn, user_id):
    """[(id, kind, rule, ends_at, warning_id)] in force now."""
    return await _all(conn, 'SELECT id, kind, rule, ends_at, warning_id FROM user_restrictions WHERE user_id = %s AND '
                      + ACTIVE + ' ORDER BY id', (user_id,))


async def suspension(conn, user_id):
    for row in await restrictions(conn, user_id):
        if row[1] == 'suspended':
            return row
    return None


async def banned(conn, fingerprint=None, ip_hash=None):
    clauses, params = [], []
    if fingerprint is not None:
        clauses.append('fingerprint = %s')
        params.append(fingerprint)
    if ip_hash is not None:
        clauses.append('abuse_ip_hash = %s')
        params.append(ip_hash)
    if not clauses:
        return False
    rows = await _all(conn, 'SELECT 1 FROM bans WHERE ({}) AND lifted_at IS NULL AND (expires_at IS NULL OR '
                            'expires_at > now()) LIMIT 1'.format(' OR '.join(clauses)), params)
    return bool(rows)


async def check_uploader(conn, user=None, fingerprint=None, ip_hash=None):
    """403 BANNED, ACCOUNT_SUSPENDED or UPLOADS_RESTRICTED { until } (§2.5 step 5). Restricted
    means no uploads at all, and no album creation."""
    if await banned(conn, fingerprint if user is None else None, ip_hash):
        raise errors.banned()
    if user is None:
        return
    rows = await restrictions(conn, user.id)
    for _, kind, _, ends_at, _ in rows:
        if kind == 'suspended':
            raise errors.account_suspended(epoch(ends_at))
    for _, kind, _, ends_at, _ in rows:
        if kind == 'uploads':
            raise errors.uploads_restricted(epoch(ends_at))


async def check_not_suspended(conn, user):
    row = await suspension(conn, user.id)
    if row is not None:
        raise errors.account_suspended(epoch(row[3]))


def _matches(rules, method, path):
    path = path.rstrip('/') or '/'
    method = 'GET' if method == 'HEAD' else method
    for rule_method, rule_path in rules:
        if rule_method is not None and rule_method != method:
            continue
        if rule_path.endswith('*'):
            if path == rule_path[:-1] or path.startswith(rule_path[:-1] + '/'):
                return True
        elif path == rule_path:
            return True
    return False


def suspended_may(path, method='GET'):
    return _matches(SUSPENDED_ALLOWED, method, path)


def pending_deletion_may(path, method='GET'):
    return _matches(PENDING_DELETION_ALLOWED, method, path)


def account_request(request):
    path = request.path
    if request.method == 'POST' and (path.rstrip('/') == '/files'):
        return True
    return path.startswith(ACCOUNT_PATHS) or path == '/uploads'


async def check_request(request):
    """The account-standing middleware: a signed-in (or key) request to the account's own endpoints, from
    a suspended account or one with a pending deletion, outside its allowlist. /admin/* answers for itself
    (its plain 404, milestone-4 §9.1)."""
    from utils.auth import auth_of
    if request.method == 'OPTIONS':
        return None
    current = auth_of(request)
    user = current.user
    if user is None or not account_request(request):
        return None
    if user.state == 'pending_deletion' and not pending_deletion_may(request.path, request.method):
        return errors.account_pending_deletion(epoch(user.deletion_scheduled_for)).response
    if suspended_may(request.path, request.method):
        return None
    import db
    async with db.connection() as conn:
        row = await suspension(conn, user.id)
    if row is not None:
        return errors.account_suspended(epoch(row[3])).response
    return None
