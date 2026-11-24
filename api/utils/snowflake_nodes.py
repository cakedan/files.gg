"""Per-process Snowflake node-id leases (PLAN.md §2.1 item 2).

Each process leases one 10-bit node id (datacenter + worker bits) from the
`snowflake_nodes` table at start, renews it with a heartbeat, and releases it
on a clean exit. A lease whose heartbeat is older than the TTL can be claimed
by another process.

- `AsyncNodeLease`: Sanic worker processes. Leased in `before_server_start`,
  heartbeat is an asyncio task, released in `after_server_stop`.
- `NodeLease`: `python -m worker` (synchronous), heartbeat in a thread.

Both install `current_node_id()` as Snowflake's node provider: synchronous, no
I/O, and it refuses when the lease is stale or was inherited across a fork.
"""

import asyncio
import atexit
import logging
import os
import socket
import threading
import time
import uuid

import db as database
from utils.generators import Snowflake, max_node

log = logging.getLogger(__name__)

DEFAULT_TTL = int(os.getenv('SNOWFLAKE_LEASE_TTL', '300'))
DEFAULT_HEARTBEAT_INTERVAL = int(os.getenv('SNOWFLAKE_HEARTBEAT_INTERVAL', '30'))
# expired rows are deleted by the cleanup task once they have been expired
# for this long, so a recently used node id is not handed out first
DEFAULT_RETENTION = int(os.getenv('SNOWFLAKE_NODE_RETENTION', '86400'))


class NoFreeNodeError(RuntimeError):
    pass


class LeaseLostError(RuntimeError):
    pass


# Atomic claim: pick a never-used id, else the longest-expired one, and take it
# with INSERT .. ON CONFLICT DO UPDATE .. WHERE expired. If another process wins
# the race for the same id, the conflict WHERE fails and no row is returned.
CLAIM_SQL = """
INSERT INTO snowflake_nodes AS s (node_id, holder, heartbeat_at)
SELECT c.node_id, %(holder)s, now()
FROM (
    SELECT n.node_id
    FROM generate_series(0, %(max_node)s::int) AS n(node_id)
    LEFT JOIN snowflake_nodes e ON e.node_id = n.node_id
    WHERE e.node_id IS NULL
       OR e.heartbeat_at < now() - make_interval(secs => %(ttl)s::float8)
    ORDER BY e.heartbeat_at ASC NULLS FIRST, random()
    LIMIT 1
) AS c
ON CONFLICT (node_id) DO UPDATE
    SET holder = EXCLUDED.holder, heartbeat_at = EXCLUDED.heartbeat_at
    WHERE s.heartbeat_at < now() - make_interval(secs => %(ttl)s::float8)
RETURNING s.node_id
"""

FREE_COUNT_SQL = """
SELECT (%(max_node)s::int + 1) - count(*)
FROM snowflake_nodes
WHERE heartbeat_at >= now() - make_interval(secs => %(ttl)s::float8)
"""

HEARTBEAT_SQL = """
UPDATE snowflake_nodes SET heartbeat_at = now()
WHERE node_id = %(node_id)s AND holder = %(holder)s
RETURNING node_id
"""

# Mark the lease expired rather than deleting it, so the id is picked last by
# the next claim (keeps a just-used id away from a host with a lagging clock).
RELEASE_SQL = """
UPDATE snowflake_nodes
SET heartbeat_at = now() - make_interval(secs => %(ttl)s::float8) - interval '1 second'
WHERE node_id = %(node_id)s AND holder = %(holder)s
"""

CLEANUP_SQL = """
DELETE FROM snowflake_nodes
WHERE heartbeat_at < now() - make_interval(secs => %(ttl)s::float8 + %(retention)s::float8)
"""


def make_holder():
    return '{}:{}:{}'.format(socket.gethostname(), os.getpid(), uuid.uuid4().hex[:8])


def cleanup_expired(conn, ttl=DEFAULT_TTL, retention=DEFAULT_RETENTION):
    """Delete long-expired leases. `conn` is a sync psycopg connection."""
    return conn.execute(CLEANUP_SQL, {'ttl': ttl, 'retention': retention}).rowcount


class _LeaseState:
    def __init__(self, ttl, heartbeat_interval, holder, max_attempts):
        if heartbeat_interval * 2 > ttl:
            raise ValueError('heartbeat_interval must be at most half of the lease ttl')
        self.ttl = ttl
        self.heartbeat_interval = heartbeat_interval
        self.holder = holder or make_holder()
        self.max_attempts = max_attempts
        self.node_id = None
        self.pid = None
        self._renewed_at = None

    @property
    def params(self):
        return {'holder': self.holder, 'node_id': self.node_id, 'ttl': self.ttl, 'max_node': max_node}

    def _claimed(self, node_id, started):
        self.node_id = node_id
        self.pid = os.getpid()
        self._renewed_at = started
        log.info('leased snowflake node id %s as %s', self.node_id, self.holder)
        return node_id

    def _no_free_node(self):
        return NoFreeNodeError(
            'No free Snowflake node id: all {} ids in snowflake_nodes are leased'.format(max_node + 1)
        )

    def current_node_id(self):
        """Used by Snowflake.generate(); synchronous and does no I/O."""
        node_id = self.node_id
        if node_id is None:
            raise LeaseLostError('This process holds no Snowflake node lease')
        if self.pid != os.getpid():
            raise LeaseLostError(
                'Snowflake node lease belongs to the parent process; '
                'each process must lease its own'
            )
        if time.monotonic() - self._renewed_at > self.ttl - self.heartbeat_interval:
            raise LeaseLostError('Snowflake node lease {} has not been renewed in time'.format(node_id))
        return node_id


class NodeLease(_LeaseState):
    """Synchronous lease (psycopg 3 sync, heartbeat thread)."""

    def __init__(self, url=None, ttl=DEFAULT_TTL, heartbeat_interval=DEFAULT_HEARTBEAT_INTERVAL,
                 holder=None, max_attempts=32):
        super().__init__(ttl, heartbeat_interval, holder, max_attempts)
        self.url = url
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    def _fetchone(self, sql):
        with database.connect(self.url) as conn:
            return conn.execute(sql, self.params).fetchone()

    def acquire(self):
        with self._lock:
            return self._acquire()

    def _acquire(self):
        for _ in range(self.max_attempts):
            started = time.monotonic()
            row = self._fetchone(CLAIM_SQL)
            if row is not None:
                return self._claimed(row[0], started)
            if self._fetchone(FREE_COUNT_SQL)[0] <= 0:
                break
            time.sleep(0.01)
        raise self._no_free_node()

    def heartbeat(self):
        """Renew the lease. If it was lost, lease a new node id."""
        with self._lock:
            if self.node_id is None:
                return False
            started = time.monotonic()
            if self._fetchone(HEARTBEAT_SQL) is not None:
                self._renewed_at = started
                return True
            log.warning('lost snowflake node lease %s (%s); leasing a new one', self.node_id, self.holder)
            self.node_id = None
            self._acquire()
            return False

    def release(self):
        with self._lock:
            if self.node_id is None or self.pid != os.getpid():
                return
            try:
                with database.connect(self.url) as conn:
                    conn.execute(RELEASE_SQL, self.params)
                log.info('released snowflake node id %s', self.node_id)
            finally:
                self.node_id = None

    def _run(self):
        while not self._stop.wait(self.heartbeat_interval):
            try:
                self.heartbeat()
            except Exception:
                log.exception('snowflake node heartbeat failed')

    def start(self, install=True):
        self.acquire()
        if install:
            Snowflake.set_node_provider(self.current_node_id)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name='snowflake-heartbeat', daemon=True)
        self._thread.start()
        atexit.register(self.stop)
        return self.node_id

    def stop(self):
        self._stop.set()
        try:
            self.release()
        except Exception:
            log.exception('failed to release snowflake node lease')


class AsyncNodeLease(_LeaseState):
    """Async lease for Sanic workers: uses the worker's connection pool and
    renews from an asyncio task."""

    def __init__(self, pool, ttl=DEFAULT_TTL, heartbeat_interval=DEFAULT_HEARTBEAT_INTERVAL,
                 holder=None, max_attempts=32):
        super().__init__(ttl, heartbeat_interval, holder, max_attempts)
        self.pool = pool
        self._lock = asyncio.Lock()
        self._task = None

    async def _fetchone(self, sql):
        async with self.pool.connection() as conn:
            cursor = await conn.execute(sql, self.params)
            return await cursor.fetchone()

    async def acquire(self):
        async with self._lock:
            return await self._acquire()

    async def _acquire(self):
        for _ in range(self.max_attempts):
            started = time.monotonic()
            row = await self._fetchone(CLAIM_SQL)
            if row is not None:
                return self._claimed(row[0], started)
            if (await self._fetchone(FREE_COUNT_SQL))[0] <= 0:
                break
            await asyncio.sleep(0.01)
        raise self._no_free_node()

    async def heartbeat(self):
        async with self._lock:
            if self.node_id is None:
                return False
            started = time.monotonic()
            if await self._fetchone(HEARTBEAT_SQL) is not None:
                self._renewed_at = started
                return True
            log.warning('lost snowflake node lease %s (%s); leasing a new one', self.node_id, self.holder)
            self.node_id = None
            await self._acquire()
            return False

    async def release(self):
        async with self._lock:
            if self.node_id is None or self.pid != os.getpid():
                return
            try:
                async with self.pool.connection() as conn:
                    await conn.execute(RELEASE_SQL, self.params)
                log.info('released snowflake node id %s', self.node_id)
            finally:
                self.node_id = None

    async def _run(self):
        while True:
            await asyncio.sleep(self.heartbeat_interval)
            try:
                await self.heartbeat()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception('snowflake node heartbeat failed')

    async def start(self, install=True):
        await self.acquire()
        if install:
            Snowflake.set_node_provider(self.current_node_id)
        self._task = asyncio.get_running_loop().create_task(self._run(), name='snowflake-heartbeat')
        return self.node_id

    async def stop(self):
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        try:
            await self.release()
        except Exception:
            log.exception('failed to release snowflake node lease')


_process_lease = None


def start_process_lease(url=None):
    """Sync processes (`python -m worker`): lease a node id for this process
    and wire it into Snowflake.generate(). Raises NoFreeNodeError if none is free."""
    global _process_lease
    if _process_lease is not None and _process_lease.pid == os.getpid():
        return _process_lease
    lease = NodeLease(url)
    lease.start(install=True)
    _process_lease = lease
    return lease


def stop_process_lease():
    global _process_lease
    if _process_lease is not None:
        _process_lease.stop()
        _process_lease = None
