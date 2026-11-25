"""Rate limits on Redis (contract milestone-5 §18): a port of notsobot.api's limiter (`utilities/tools/ratelimit.py`,
`app_limiter.py`), with the files.gg changes of §18.1.

    limiter.init_app(app)                         the global limit and route limits, as request middleware
    @limiter.limit('30 per minute')               a route's own limit (under the route's decorator; stack for more)
    await limiter.hit(request, scope, key)        a handler's limit, keyed by something other than the caller (§18.3)
    await limiter.peek(request, scope, key)       the same without recording, for limits that count failures only

Every limit is a moving window: one Redis list per limit and key, the hits' timestamps (ms, newest first), trimmed to
the limit's size and expiring with its window. One Lua script checks every limit of a request in one round trip, on
Redis's own clock. A refused hit isn't recorded, so it doesn't push the window back.

Keys are ids and hashes only (`user:<hex id>`, `key:<hex id>`, `ip:<abuse IP hash>`, `acct:<email hash>`, ...): no
raw IP or email ever reaches Redis. When Redis is down, a `fail='open'` limit lets the request through (notsobot's
behaviour) and a `fail='closed'` one answers 503 RATE_LIMIT_UNAVAILABLE, so an outage never switches off
brute-force protection.

`utils/ratelimit_sync.py` is the same for synchronous code, on the sync client.
"""

import json
import logging
import os
import re

from dataclasses import dataclass
from functools import lru_cache

from redis.exceptions import RedisError

from utils import errors, redis as redis_clients

log = logging.getLogger(__name__)

# a route's own limits, on its handler (`functools.wraps` copies it to every wrapper above it)
HANDLER_ATTRIBUTE = '__ratelimits__'
# after `authenticate` (80): the keys come from the session and the upload key (§18.1)
MIDDLEWARE_PRIORITY = 70
GLOBAL_SCOPE = 'global'

REGEX_LIMIT = re.compile(r'(\d+)\s+per\s+(?:(\d+)\s+)?(second|minute|hour|day)s?', re.IGNORECASE)
UNIT_SECONDS = {'second': 1, 'minute': 60, 'hour': 60 * 60, 'day': 24 * 60 * 60}

# §18.2 and §18.3: each scope's limit, overridable with RATE_LIMITS (JSON `{"<scope>": "<limit text>"}`). A route
# limit's default is its decorator's text (`guest`, `file_upload`, `chunked_upload`, ...); `report`,
# `report_message` and `upload_key` default to REPORT_RATE_PER_HOUR, REPORT_MESSAGE_RATE_PER_HOUR and
# UPLOAD_KEY_RATE_PER_HOUR (`default_text`).
DEFAULTS = {
    GLOBAL_SCOPE: '50 per second',
    'login_ip': '30 per hour',
    'login_account': '10 per hour',
    'reauth': '10 per hour',
    'register': '5 per hour',
    'forgot_ip': '10 per hour',
    'forgot_account': '3 per hour',
    'verify_resend': '5 per hour',
    'discord': '30 per hour',
    'username_check': '60 per hour',
    'unlock': '5 per minute',
    'access': '30 per minute',
    'domain_add': '10 per day',
    'domain_check': '1 per minute',
}
# §18.3: the brute-force limits fail closed; everything else (the global and route limits too) fails open
CLOSED_SCOPES = frozenset(('login_ip', 'login_account', 'reauth', 'register', 'forgot_ip', 'forgot_account', 'unlock',
                           'report', 'report_message'))
FAIL_MODES = ('open', 'closed')

# KEYS: one list per limit. ARGV: `record` (1, or 0 to peek), then `amount, window (ms)` for each key.
# Per key a hit is only recorded when the window has room, so a refused request doesn't push the reset back.
# Returns Redis's time (ms), then `allowed, remaining, reset (ms)` for each key.
MOVING_WINDOW_LUA = '''
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local record = ARGV[1] == '1'
local results = {now}
for i, key in ipairs(KEYS) do
    local amount = tonumber(ARGV[i * 2])
    local window = tonumber(ARGV[i * 2 + 1])
    local count = 0
    local oldest = now
    for _, entry in ipairs(redis.call('LRANGE', key, 0, amount - 1)) do
        local timestamp = tonumber(entry)
        if timestamp <= now - window then
            break
        end
        count = count + 1
        oldest = timestamp
    end
    local allowed = 0
    if count < amount then
        allowed = 1
        if record then
            count = count + 1
            redis.call('LPUSH', key, now)
            redis.call('LTRIM', key, 0, amount - 1)
            redis.call('PEXPIRE', key, window)
        end
    end
    table.insert(results, allowed)
    table.insert(results, amount - count)
    table.insert(results, oldest + window)
end
return results
'''


@dataclass(frozen=True, slots=True)
class Limit:
    amount: int
    seconds: int
    scope: str
    text: str
    fail: str = 'open'

    @classmethod
    def parse(cls, text, scope, fail='open'):
        """`<amount> per [<n>] <second|minute|hour|day>`: `50 per second`, `3 per 2 hours`, `10 per day`."""
        match = REGEX_LIMIT.fullmatch(str(text).strip())
        if not match or fail not in FAIL_MODES:
            raise ValueError('Invalid rate limit `{}`'.format(text))
        amount, multiple, unit = match.groups()
        limit = cls(int(amount), int(multiple or 1) * UNIT_SECONDS[unit.lower()], scope, str(text).strip(), fail)
        if limit.amount < 1 or limit.seconds < 1:
            raise ValueError('Invalid rate limit `{}`'.format(text))
        return limit

    def redis_key(self, key):
        return 'ratelimit:{}:{}:{}/{}'.format(self.scope, key, self.amount, self.seconds)


@dataclass(frozen=True, slots=True)
class RatelimitHit:
    limit: Limit
    key: str
    allowed: bool
    remaining: int
    # unix seconds when the window's oldest hit drops out (and a refused request could go through)
    reset: float
    reset_after: float


# --- configuration (§18.2, §18.3, §14 RATE_LIMITS) -------------------------------------------------------------

@lru_cache(maxsize=8)
def _overrides(raw):
    data = json.loads(raw) if raw else {}
    if not isinstance(data, dict):
        raise ValueError('RATE_LIMITS must be a JSON object of `{"<scope>": "<limit text>"}`')
    return {str(scope): str(text) for scope, text in data.items()}


def overrides():
    return _overrides(os.getenv('RATE_LIMITS') or '')


@lru_cache(maxsize=1024)
def _parsed(text, scope, fail):
    return Limit.parse(text, scope, fail)


def default_text(scope):
    if scope == 'report':
        from safety.settings import safety_settings
        return '{} per hour'.format(safety_settings().report_rate_per_hour)
    if scope == 'report_message':
        from safety.settings import safety_settings
        return '{} per hour'.format(safety_settings().report_message_rate_per_hour)
    if scope == 'upload_key':
        from utils.account_settings import account_settings
        return '{} per hour'.format(account_settings().upload_key_rate_per_hour)
    return DEFAULTS[scope]


def limit_for(scope, text=None, fail=None):
    """The scope's limit right now: RATE_LIMITS, else `text`, else its default. Closed for the §18.3 brute-force
    scopes unless `fail` says otherwise."""
    text = overrides().get(scope) or text or default_text(scope)
    return _parsed(text, scope, fail or ('closed' if scope in CLOSED_SCOPES else 'open'))


def check_config():
    """Boot check: RATE_LIMITS is a JSON object of valid limit texts."""
    try:
        for scope, text in overrides().items():
            Limit.parse(text, scope)
    except ValueError as error:
        raise RuntimeError('Refusing to start: RATE_LIMITS is invalid ({})'.format(error))


# --- keys (§18.1) ------------------------------------------------------------------------------------------------

def ip_hash(request):
    """The abuse IP hash of the caller (milestone-4 §1, IPv6 grouped by /64), or None without an address."""
    from safety import ip as abuse_ip
    from safety.settings import safety_settings
    from utils.helpers import client_ip
    return abuse_ip.abuse_ip_hash(client_ip(request), safety_settings().abuse_hash_secret)


def ip_key(request):
    digest = ip_hash(request)
    return 'ip:' + digest.hex() if digest else 'ip:0'


def email_key(email):
    """`acct:<hex>`, the keyed email hash (milestone-6 §4.7)."""
    from safety.settings import safety_settings
    from utils import credentials
    return credentials.email_key(safety_settings().abuse_hash_secret, email)


def user_key(user_id):
    return 'user:{:x}'.format(user_id)


def client_key(request):
    """The session's user, else the upload key, else the abuse IP hash: never the guest id (the browser
    picks it). None for the Worker's internal lookups, which skips every limit."""
    if getattr(request.ctx, 'internal_lookup', False):
        return None
    from utils.auth import auth_of
    current = auth_of(request)
    if current.kind == 'session':
        return user_key(current.user.id)
    if current.kind == 'key':
        return 'key:{:x}'.format(current.key.id)
    return ip_key(request)


# --- the script's answer -------------------------------------------------------------------------------------------

def script_input(checks, record):
    """(keys, args) for MOVING_WINDOW_LUA, from `[(Limit, key), ...]`."""
    keys = [limit.redis_key(key) for limit, key in checks]
    args = [1 if record else 0]
    for limit, _ in checks:
        args.extend((limit.amount, limit.seconds * 1000))
    return keys, args


def read_hits(checks, result):
    now, *rest = result
    hits = []
    for index, (limit, key) in enumerate(checks):
        allowed, remaining, reset = rest[index * 3:index * 3 + 3]
        hits.append(RatelimitHit(limit=limit, key=key, allowed=bool(allowed), remaining=int(remaining),
                                 reset=int(reset) / 1000, reset_after=max(int(reset) - int(now), 0) / 1000))
    return hits


def retry_after(hits):
    """Seconds (3 decimals) until every refused limit has room again."""
    return round(max((hit.reset_after for hit in hits if not hit.allowed), default=0.0), 3)


# §18.3: the codes the existing limits keep (they gain `Retry-After`, app.py); everything else is RATE_LIMITED
REFUSALS = {
    'upload_key': lambda limit, wait: errors.too_many_key_uploads(limit.amount, wait),
    'domain_check': lambda limit, wait: errors.domain_check_rate_limited(wait),
    'report': lambda limit, wait: errors.max_reports(wait),
    'report_message': lambda limit, wait: errors.max_messages(wait),
}
ATTEMPT_SCOPES = frozenset(('login_ip', 'login_account', 'reauth', 'register', 'forgot_ip', 'forgot_account',
                            'verify_resend', 'discord', 'username_check', 'unlock', 'access', 'domain_add'))


def refusal(hits):
    """The error for a refused check: the first refused limit's code, with the longest wait."""
    limit = next(hit.limit for hit in hits if not hit.allowed)
    wait = retry_after(hits)
    if limit.scope in REFUSALS:
        return REFUSALS[limit.scope](limit, wait)
    if limit.scope in ATTEMPT_SCOPES:
        return errors.too_many_attempts(wait)
    return errors.rate_limited(wait)


def settle(hits, quiet):
    if not quiet and not all(hit.allowed for hit in hits):
        raise refusal(hits)
    return hits


def unavailable(checks, error, where):
    """Redis failed: 503 RATE_LIMIT_UNAVAILABLE when any of the limits fails closed, else let it through."""
    scopes = ', '.join(sorted({limit.scope for limit, _ in checks}))
    if any(limit.fail == 'closed' for limit, _ in checks):
        log.warning('rate limit check failed, refusing (%s) - %s - %r', scopes, where, error)
        raise errors.rate_limit_unavailable()
    log.warning('rate limit check failed, letting it through (%s) - %s - %r', scopes, where, error)
    return []


def resolve(pairs):
    return [(limit_for(scope), key) for scope, key in pairs]


# --- the limiter ---------------------------------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class RouteLimit:
    scope: str
    text: str
    fail: str
    # the key for this limit (None skips it); `client_key` when not given
    key: object = None


class Limiter:
    def __init__(self, key_func, global_scopes=(GLOBAL_SCOPE,)):
        # `key_func` returning None skips every limit for the request
        self.key_func = key_func
        self.global_scopes = tuple(global_scopes)
        self._script = None
        self._script_client = None

    def init_app(self, app):
        app.on_request(self.check_request, priority=MIDDLEWARE_PRIORITY)

    def limit(self, text, scope=None, key=None, fail='open'):
        """A limit on just this route, on top of the global one; stack it for more than one. `scope` (the RATE_LIMITS
        name) defaults to `<module>.<handler>` without `views.`, `key` (a function of the request) to `client_key`."""
        def decorator(func):
            name = scope or '{}.{}'.format(func.__module__.rpartition('.')[2], func.__qualname__)
            Limit.parse(text, name, fail)
            setattr(func, HANDLER_ATTRIBUTE, (*getattr(func, HANDLER_ATTRIBUTE, ()), RouteLimit(name, text, fail, key)))
            return func
        return decorator

    async def check_request(self, request):
        """The global limit on every routed request (404s aren't limited) and the route's own limits, keyed by
        `client_key`. `ctx_ratelimit_own=True` routes limit themselves in their handler, so none apply to them."""
        route = request.route
        if route is None or getattr(route.ctx, 'ratelimit_own', False):
            return
        key = self.key_func(request)
        if key is None:
            return
        checks = [(limit_for(scope), key) for scope in self.global_scopes]
        # a preflight shares its path's first handler, so it only counts against the global limit
        if request.method != 'OPTIONS':
            for route_limit in getattr(route.handler, HANDLER_ATTRIBUTE, ()):
                limit_key = route_limit.key(request) if route_limit.key is not None else key
                if limit_key is not None:
                    checks.append((limit_for(route_limit.scope, route_limit.text, route_limit.fail), limit_key))
        hits = await self.check(request, checks, record=True, quiet=True)
        if not all(hit.allowed for hit in hits):
            # staff skip the global and route limits (not the §18.3 ones). Asked only once a limit refuses, so a
            # signed-in request doesn't pay a staff lookup every time.
            if await is_staff(request):
                return
            raise refusal(hits)

    async def check(self, request, checks, record=True, quiet=False):
        """Every `(Limit, key)` in one round trip: a list of RatelimitHit (empty when Redis failed and every limit
        fails open). Refused → the first refused limit's code, unless `quiet`."""
        if not checks:
            return []
        client = redis_clients.get_async()
        if self._script is None or self._script_client is not client:
            # EVALSHA, reloading the script if Redis lost it
            self._script = client.register_script(MOVING_WINDOW_LUA)
            self._script_client = client
        keys, args = script_input(checks, record)
        try:
            result = await self._script(keys=keys, args=args)
        except RedisError as error:
            return unavailable(checks, error, '{} {}'.format(request.method, request.path))
        return settle(read_hits(checks, result), quiet)

    async def hit(self, request, scope, key, text=None, fail=None):
        """Count one against `scope` for `key` (a handler's own limit, §18.3): its RatelimitHit (None when Redis
        failed and the limit fails open). Refused → its code."""
        hits = await self.check(request, [(limit_for(scope, text, fail), key)])
        return hits[0] if hits else None

    async def peek(self, request, scope, key, text=None, fail=None):
        """Whether `scope` has room for `key`, recording nothing; refused → its code. For limits that count failures
        only: `peek` before the attempt, `hit` after it fails."""
        hits = await self.check(request, [(limit_for(scope, text, fail), key)], record=False)
        return hits[0] if hits else None

    async def hit_many(self, request, pairs, record=True, quiet=False):
        """`hit` (or with record=False `peek`) for several `(scope, key)` in one round trip."""
        return await self.check(request, resolve(pairs), record=record, quiet=quiet)


async def is_staff(request):
    from utils.auth import auth_of
    current = auth_of(request)
    if current.kind != 'session':
        return False
    import db
    from utils.view_limits import is_staff as staff_member
    async with db.connection() as conn:
        return await staff_member(conn, current.user)


limiter = Limiter(key_func=client_key)
