"""Database access on psycopg 3.

The API (async) uses one `psycopg_pool.AsyncConnectionPool` per Sanic worker
process, opened in `before_server_start` and closed in `after_server_stop`.
`python -m worker` and `python -m migrate` use plain synchronous connections.
All connections are in autocommit mode; multi-statement work opens an explicit
`conn.transaction()`.
"""

import os

from contextlib import asynccontextmanager
from urllib.parse import urlsplit, urlunsplit

import psycopg

from psycopg_pool import AsyncConnectionPool

_pool = None
# Earlier pools, restored when a later one closes. Only tests run more than one
# app (and so more than one pool) in a process.
_stack = []


def get_database_url():
    url = os.getenv('DATABASE_URL')
    if not url:
        raise RuntimeError('DATABASE_URL is required')
    return url


def conninfo(url=None):
    """Turn DATABASE_URL into a libpq URI. Accepts the Peewee-era schemes too
    (`postgres+pool://`, `postgresext://`, ...)."""
    url = url or get_database_url()
    parts = urlsplit(url)
    scheme = parts.scheme.split('+', 1)[0]
    if scheme.startswith('postgres'):
        scheme = 'postgresql'
    return urlunsplit(parts._replace(scheme=scheme))


def connect(url=None, **kwargs):
    """A synchronous autocommit connection (worker, migrations, leases)."""
    kwargs.setdefault('autocommit', True)
    return psycopg.connect(conninfo(url), **kwargs)


async def open_pool(url=None, min_size=None, max_size=None, timeout=30.0):
    """Open this process's async pool (called once per Sanic worker)."""
    global _pool
    pool = AsyncConnectionPool(
        conninfo(url),
        min_size=int(min_size or os.getenv('DATABASE_POOL_MIN', '1')),
        max_size=int(max_size or os.getenv('DATABASE_POOL_MAX', '10')),
        kwargs={'autocommit': True},
        timeout=float(os.getenv('DATABASE_POOL_TIMEOUT', timeout)),
        open=False,
        name='filesgg-api',
    )
    await pool.open(wait=True, timeout=timeout)
    if _pool is not None:
        _stack.append(_pool)
    _pool = pool
    return pool


async def close_pool(pool=None):
    global _pool
    pool = pool or _pool
    if pool is None:
        return
    if pool is _pool:
        _pool = _stack.pop() if _stack else None
    elif pool in _stack:
        _stack.remove(pool)
    await pool.close()


def get_pool():
    if _pool is None:
        raise RuntimeError('The database pool is not open in this process')
    return _pool


@asynccontextmanager
async def connection(timeout=None):
    """Borrow a pooled autocommit connection."""
    async with get_pool().connection(timeout=timeout) as conn:
        yield conn
