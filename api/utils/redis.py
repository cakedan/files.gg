"""The shared Redis clients (contract milestone-5 §3.1, §14, §18), as notsobot.api keeps them: one
`redis.asyncio.Redis` for the API's handlers (`app.ctx.redis`) and one `redis.Redis` for synchronous code
(`app.ctx.redis_sync`: RQ, and `ratelimit_sync` in the threads the domain and report rules run in), both from
`REDIS_URL`.

The API opens them before it serves (`open_clients`) and closes them when it stops (`close_clients`). Any other
process (the Postgres-queue worker, a script) gets them lazily from `get_async()` / `get_sync()`.

A short timeout and a single immediate retry: when Redis is down a rate limit decides at once (it lets the request
through, or answers 503 RATE_LIMIT_UNAVAILABLE, §18.1) instead of backing off for seconds.
"""

import os

import redis
import redis.asyncio
import redis.asyncio.retry
import redis.backoff
import redis.retry

TIMEOUT_SECONDS = 2
_clients = {'async': None, 'sync': None}


def url():
    """REDIS_URL (§14: required, with the password in it)."""
    value = os.getenv('REDIS_URL')
    if not value:
        raise RuntimeError('Refusing to start: REDIS_URL is required (milestone-5 §14)')
    return value


def _options():
    return {'socket_timeout': TIMEOUT_SECONDS, 'socket_connect_timeout': TIMEOUT_SECONDS}


def new_async():
    return redis.asyncio.Redis.from_url(
        url(), retry=redis.asyncio.retry.Retry(redis.backoff.NoBackoff(), 1), **_options())


def new_sync():
    return redis.Redis.from_url(url(), retry=redis.retry.Retry(redis.backoff.NoBackoff(), 1), **_options())


def get_async():
    """This process's `redis.asyncio.Redis` (opened with the API, or on first use)."""
    if _clients['async'] is None:
        _clients['async'] = new_async()
    return _clients['async']


def get_sync():
    """This process's `redis.Redis` (opened with the API, or on first use; thread-safe)."""
    if _clients['sync'] is None:
        _clients['sync'] = new_sync()
    return _clients['sync']


def open_clients(app):
    """`before_server_start`: a fresh pair for this worker process, on `app.ctx` as notsobot has them."""
    app.ctx.redis = _clients['async'] = new_async()
    app.ctx.redis_sync = _clients['sync'] = new_sync()


async def close_clients(app):
    """`after_server_stop`: close both and forget them, so nothing reuses a pool bound to a stopped loop."""
    client, sync = _clients['async'], _clients['sync']
    _clients['async'] = _clients['sync'] = None
    app.ctx.redis = app.ctx.redis_sync = None
    if client is not None:
        await client.aclose()
    if sync is not None:
        sync.close()
