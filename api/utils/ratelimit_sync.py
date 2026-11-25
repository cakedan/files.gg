"""Rate limits on Redis from synchronous code (contract milestone-5 §18.1): the domain and report rules run in a
thread. The same moving windows, scopes, keys, failure modes and codes as `utils/ratelimit.py`, on the sync client
(`utils/redis.get_sync()`, opened lazily in a process that isn't the API)."""

import threading

from redis.exceptions import RedisError

from utils import redis as redis_clients
from utils.ratelimit import (
    MOVING_WINDOW_LUA, limit_for, read_hits, resolve, script_input, settle, unavailable,
)

_script = {'client': None, 'script': None}
_lock = threading.Lock()


def _script_for(client):
    with _lock:
        if _script['client'] is not client:
            # EVALSHA, reloading the script if Redis lost it
            _script['script'] = client.register_script(MOVING_WINDOW_LUA)
            _script['client'] = client
        return _script['script']


def check(checks, record=True, quiet=False):
    """Every `(Limit, key)` in one round trip; see `Limiter.check`."""
    if not checks:
        return []
    client = redis_clients.get_sync()
    keys, args = script_input(checks, record)
    try:
        result = _script_for(client)(keys=keys, args=args)
    except RedisError as error:
        return unavailable(checks, error, 'sync')
    return settle(read_hits(checks, result), quiet)


def hit(scope, key, text=None, fail=None):
    """Count one against `scope` for `key`: its RatelimitHit (None when Redis failed and the limit fails open).
    Refused → its code (§18.3)."""
    hits = check([(limit_for(scope, text, fail), key)])
    return hits[0] if hits else None


def hit_many(pairs, record=True, quiet=False):
    """`hit` for several `(scope, key)` in one round trip."""
    return check(resolve(pairs), record=record, quiet=quiet)
