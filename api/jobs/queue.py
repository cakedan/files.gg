"""Postgres-backed job queue (PLAN.md §2.1 item 3).

A job is claimed with `SELECT … FOR UPDATE SKIP LOCKED` in a short
transaction that stamps `locked_by`/`locked_at` and bumps `attempts`; the
handler then runs outside any transaction. A job whose worker died is claimed
again once its lock is older than `lock_timeout`.

The worker side is synchronous psycopg 3: every function takes `conn`, an
autocommit `psycopg.Connection` (one is opened from DATABASE_URL when it is
None). The API enqueues with `enqueue_async()` on its pool.
"""

import json
import logging
import os
import socket
import traceback
import uuid

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import db

log = logging.getLogger(__name__)

DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_QUEUE = 'default'
# Scheduler marker rows live here; no worker may claim from it.
SCHEDULER_QUEUE = 'scheduler'
DEFAULT_LOCK_TIMEOUT = int(os.getenv('JOBS_LOCK_TIMEOUT', '600'))
BACKOFF_BASE = 10        # seconds before the first retry
BACKOFF_MAX = 60 * 60    # never wait more than an hour between retries

_registry = {}


class Job:
    __slots__ = ('id', 'kind', 'payload', 'attempts', 'max_attempts', 'run_at')

    def __init__(self, id, kind, payload, attempts, max_attempts, run_at):
        self.id = id
        self.kind = kind
        self.payload = payload
        self.attempts = attempts
        self.max_attempts = max_attempts
        self.run_at = run_at

    def __repr__(self):
        return '<Job {} {} attempt {}/{}>'.format(self.id, self.kind, self.attempts, self.max_attempts)


@contextmanager
def _connection(conn):
    if conn is not None:
        yield conn
        return
    with db.connect() as conn:
        yield conn


def make_worker_id():
    return '{}:{}:{}'.format(socket.gethostname(), os.getpid(), uuid.uuid4().hex[:8])


# --- handler registry -------------------------------------------------------

def register(kind, func=None):
    """Register a handler `func(payload, job)` for a job kind. Usable as a
    decorator: `@register('ping')`."""
    def decorator(func):
        if kind in _registry and _registry[kind] is not func:
            raise ValueError('a handler for job kind {!r} is already registered'.format(kind))
        _registry[kind] = func
        return func
    return decorator(func) if func is not None else decorator


def unregister(kind):
    _registry.pop(kind, None)


def get_handler(kind):
    return _registry.get(kind)


def registered_kinds():
    return sorted(_registry)


# --- queue operations ------------------------------------------------------

def backoff(attempts, base=BACKOFF_BASE, maximum=BACKOFF_MAX):
    """Seconds to wait before retrying after `attempts` failed attempts:
    base, 2*base, 4*base, ... capped at `maximum`."""
    return min(maximum, base * (2 ** max(0, attempts - 1)))


ENQUEUE_SQL = (
    'INSERT INTO jobs (kind, payload, run_at, max_attempts, queue) '
    'VALUES (%s, %s::jsonb, COALESCE(%s::timestamptz, now()), %s, %s) RETURNING id'
)


def _check_queue(queue):
    if not isinstance(queue, str) or not queue:
        raise ValueError('queue must be a non-empty string')
    if queue == SCHEDULER_QUEUE:
        raise ValueError('the {!r} queue is reserved for scheduler markers'.format(SCHEDULER_QUEUE))
    return queue


def parse_queues(value):
    """'default,convert' -> ['default', 'convert']."""
    queues = [q.strip() for q in (value or '').split(',') if q.strip()]
    return [_check_queue(q) for q in queues] or [DEFAULT_QUEUE]


def _enqueue_params(kind, payload, run_at, max_attempts, queue):
    if run_at is not None and run_at.tzinfo is None:
        run_at = run_at.replace(tzinfo=timezone.utc)
    return (kind, json.dumps(payload or {}), run_at, max_attempts, _check_queue(queue))


def enqueue(kind, payload=None, run_at=None, max_attempts=DEFAULT_MAX_ATTEMPTS, queue=DEFAULT_QUEUE, conn=None):
    """Queue a job on `queue`. `run_at` is a datetime (naive = UTC) or None
    for now. Returns the job id."""
    with _connection(conn) as conn:
        return conn.execute(ENQUEUE_SQL, _enqueue_params(kind, payload, run_at, max_attempts, queue)).fetchone()[0]


async def enqueue_async(kind, payload=None, run_at=None, max_attempts=DEFAULT_MAX_ATTEMPTS, queue=DEFAULT_QUEUE,
                        conn=None):
    """`enqueue()` for the API: uses `conn` (an AsyncConnection) or borrows
    one from the worker's pool."""
    params = _enqueue_params(kind, payload, run_at, max_attempts, queue)
    if conn is not None:
        cursor = await conn.execute(ENQUEUE_SQL, params)
        return (await cursor.fetchone())[0]
    async with db.connection() as conn:
        cursor = await conn.execute(ENQUEUE_SQL, params)
        return (await cursor.fetchone())[0]


CLAIM_SQL = """
UPDATE jobs
SET locked_by = %(worker)s, locked_at = now(), attempts = attempts + 1
WHERE id = (
    SELECT id FROM jobs
    WHERE queue = ANY(%(queues)s::text[])
      AND done_at IS NULL
      AND failed_at IS NULL
      AND run_at <= now()
      AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => %(lock_timeout)s::float8))
      {kinds}
    ORDER BY run_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING id, kind, payload, attempts, max_attempts, run_at
"""


def claim(worker_id, queues=(DEFAULT_QUEUE,), kinds=None, lock_timeout=DEFAULT_LOCK_TIMEOUT, conn=None):
    """Claim the next runnable job on one of `queues` for `worker_id`, or
    return None. The scheduler queue can never be claimed from."""
    if isinstance(queues, str):
        queues = [queues]
    queues = [_check_queue(q) for q in queues]
    if not queues:
        raise ValueError('claim needs at least one queue')
    params = {'worker': worker_id, 'lock_timeout': lock_timeout, 'queues': queues}
    kinds_sql = ''
    if kinds is not None:
        kinds_sql = 'AND kind = ANY(%(kinds)s::text[])'
        params['kinds'] = list(kinds)
    with _connection(conn) as conn:
        with conn.transaction():
            row = conn.execute(CLAIM_SQL.format(kinds=kinds_sql), params).fetchone()
    if row is None:
        return None
    return Job(*row)


def complete(job, worker_id, conn=None):
    with _connection(conn) as conn:
        return conn.execute(
            'UPDATE jobs SET done_at = now(), locked_by = NULL, locked_at = NULL '
            'WHERE id = %s AND locked_by = %s',
            (job.id, worker_id),
        ).rowcount == 1


def fail(job, worker_id, error, conn=None, backoff_func=backoff):
    """Record a failed attempt: reschedule with exponential backoff, or mark the
    job failed once it has used all its attempts. Returns 'retry' or 'failed'."""
    error = str(error)[:10000]
    with _connection(conn) as conn:
        if job.attempts >= job.max_attempts:
            conn.execute(
                'UPDATE jobs SET failed_at = now(), last_error = %s, locked_by = NULL, locked_at = NULL '
                'WHERE id = %s AND locked_by = %s',
                (error, job.id, worker_id),
            )
            return 'failed'
        delay = backoff_func(job.attempts)
        conn.execute(
            'UPDATE jobs SET run_at = now() + make_interval(secs => %s::float8), last_error = %s, '
            'locked_by = NULL, locked_at = NULL '
            'WHERE id = %s AND locked_by = %s',
            (delay, error, job.id, worker_id),
        )
        return 'retry'


def run_job(job, worker_id, conn=None, backoff_func=backoff):
    """Run a claimed job's handler and record the outcome.
    Returns 'done', 'retry' or 'failed'."""
    with _connection(conn) as conn:
        if job.attempts > job.max_attempts:
            # its last attempt was claimed but never finished (worker died)
            return fail(job, worker_id, 'exceeded max attempts (lock expired)', conn, backoff_func)

        handler = get_handler(job.kind)
        if handler is None:
            return fail(job, worker_id, 'no handler registered for job kind {!r}'.format(job.kind),
                        conn, backoff_func)
        try:
            handler(job.payload, job)
        except Exception as error:
            log.warning('%r failed: %s', job, error)
            detail = '{}: {}\n{}'.format(type(error).__name__, error, traceback.format_exc())
            return fail(job, worker_id, detail, conn, backoff_func)
        complete(job, worker_id, conn)
        return 'done'


def run_next(worker_id, queues=(DEFAULT_QUEUE,), kinds=None, conn=None, lock_timeout=DEFAULT_LOCK_TIMEOUT,
             backoff_func=backoff):
    """Claim and run one job. Returns the outcome, or None if nothing was runnable."""
    with _connection(conn) as conn:
        job = claim(worker_id, queues=queues, kinds=kinds, lock_timeout=lock_timeout, conn=conn)
        if job is None:
            return None
        return run_job(job, worker_id, conn=conn, backoff_func=backoff_func)


def utcnow():
    return datetime.now(timezone.utc)


def in_seconds(seconds):
    return utcnow() + timedelta(seconds=seconds)
