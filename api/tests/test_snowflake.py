import asyncio
import json
import os
import subprocess
import sys
import threading
import time

import pytest

from tests.conftest import API_DIR, subprocess_env
from utils import generators
from utils.generators import Snowflake
from utils.snowflake_nodes import (
    AsyncNodeLease, LeaseLostError, NoFreeNodeError, NodeLease, cleanup_expired,
)


# --- layout compatibility ----------------------------------------------------

def old_generate(timestamp_ms, pid, sequence, epoch=1550102400000):
    """The pre-milestone generator (api/utils/generators.py at 6d8fc06), with
    worker_id = os.getpid() & 31 and datacenter_id = 0 as app.py set them."""
    worker_id = pid & 31
    datacenter_id = 0 & 31
    timestamp = timestamp_ms - epoch
    return int((timestamp << 22) | (datacenter_id << 17) | (worker_id << 12) | sequence)


def test_epoch_and_layout_unchanged():
    assert generators.EPOCH == 1550102400000
    assert (generators.shift_timestamp, generators.shift_datacenter, generators.shift_worker) == (22, 17, 12)
    assert generators.max_sequence == 4095
    assert generators.max_node == 1023


def test_decodes_an_id_made_the_old_way(snowflake_state):
    ts = 1700000000123
    old_id = old_generate(ts, pid=4242, sequence=77)
    decoded = Snowflake.decode(old_id)
    assert decoded == {
        'timestamp': ts,
        'datacenter_id': 0,
        'worker_id': 4242 & 31,
        'node_id': 4242 & 31,
        'sequence': 77,
    }


def test_new_ids_use_the_same_bits(snowflake_state, monkeypatch):
    ts = 1700000000999
    monkeypatch.setattr(generators, '_now_ms', lambda: ts)
    # node id = datacenter << 5 | worker; datacenter 0 matches the old ids
    Snowflake.set_node_id(4242 & 31)
    assert Snowflake.generate() == old_generate(ts, pid=4242, sequence=0)

    Snowflake.set_node_id((3 << 5) | 9)
    new_id = Snowflake.generate()
    decoded = Snowflake.decode(new_id)
    assert (decoded['datacenter_id'], decoded['worker_id'], decoded['sequence']) == (3, 9, 1)
    assert decoded['timestamp'] == ts


# --- sequence behaviour --------------------------------------------------------

class FakeClock:
    def __init__(self, start, calls_per_ms):
        self.now = start
        self.calls = 0
        self.calls_per_ms = calls_per_ms

    def __call__(self):
        self.calls += 1
        if self.calls > self.calls_per_ms:
            self.calls = 1
            self.now += 1
        return self.now


def test_sequence_resets_each_millisecond(snowflake_state, monkeypatch):
    clock = FakeClock(1700000000000, calls_per_ms=3)
    monkeypatch.setattr(generators, '_now_ms', clock)
    Snowflake.set_node_id(5)
    decoded = [Snowflake.decode(Snowflake.generate()) for _ in range(9)]
    sequences = [d['sequence'] for d in decoded]
    assert sequences == [0, 1, 2, 0, 1, 2, 0, 1, 2]


def test_waits_for_next_millisecond_on_overflow(snowflake_state, monkeypatch):
    ts = 1700000000000
    state = {'now': ts, 'spins': 0}

    def frozen_then_advance():
        # frozen until the generator starts spinning, then move on 1ms
        if state['spins'] > 0:
            state['spins'] += 1
            if state['spins'] > 5:
                state['now'] = ts + 1
        return state['now']

    monkeypatch.setattr(generators, '_now_ms', frozen_then_advance)
    Snowflake.set_node_id(1)
    ids = [Snowflake.generate() for _ in range(4096)]
    assert [Snowflake.decode(x)['sequence'] for x in ids] == list(range(4096))

    state['spins'] = 1  # the next generate() overflows and must spin
    overflow = Snowflake.decode(Snowflake.generate())
    assert overflow['timestamp'] == ts + 1
    assert overflow['sequence'] == 0
    assert state['spins'] > 5
    assert len(set(ids)) == 4096


def test_clock_going_backwards_stays_monotonic(snowflake_state, monkeypatch):
    times = iter([1700000000010, 1700000000005, 1700000000006, 1700000000011])
    monkeypatch.setattr(generators, '_now_ms', lambda: next(times))
    Snowflake.set_node_id(2)
    ids = [Snowflake.generate() for _ in range(4)]
    assert ids == sorted(ids) and len(set(ids)) == 4


def test_threads_get_unique_monotonic_ids(snowflake_state):
    Snowflake.set_node_id(7)
    per_thread = {}
    barrier = threading.Barrier(8)

    def run(index):
        barrier.wait()
        per_thread[index] = [Snowflake.generate() for _ in range(5000)]

    threads = [threading.Thread(target=run, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    everything = [x for ids in per_thread.values() for x in ids]
    assert len(everything) == len(set(everything)) == 40000
    for ids in per_thread.values():
        assert all(a < b for a, b in zip(ids, ids[1:]))


# --- node leases -------------------------------------------------------------

def test_concurrent_leases_get_distinct_node_ids(migrated_db):
    leased = []
    errors = []
    barrier = threading.Barrier(24)

    def run():
        lease = NodeLease(migrated_db.url)
        barrier.wait()
        try:
            leased.append(lease.acquire())
        except Exception as error:  # pragma: no cover - reported below
            errors.append(error)

    threads = [threading.Thread(target=run) for _ in range(24)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert len(leased) == len(set(leased)) == 24
    assert migrated_db.fetchone('SELECT count(*) FROM snowflake_nodes')[0] == 24


def test_processes_get_distinct_nodes_and_unique_monotonic_ids(migrated_db):
    count = 3000
    procs = [
        subprocess.Popen(
            [sys.executable, '-m', 'tests.snowflake_child', migrated_db.url, str(count)],
            cwd=API_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            env=subprocess_env(),
        )
        for _ in range(6)
    ]
    try:
        for proc in procs:
            assert proc.stdout.readline().strip() == 'ready'
        # every process holds its lease at the same time now
        held = migrated_db.fetchone(
            "SELECT count(*) FROM snowflake_nodes WHERE heartbeat_at > now() - interval '1 minute'")[0]
        assert held == 6
        for proc in procs:
            proc.stdin.write('go\n')
            proc.stdin.flush()
        results = [json.loads(proc.stdout.readline()) for proc in procs]
    finally:
        for proc in procs:
            proc.wait(timeout=60)

    assert all(proc.returncode == 0 for proc in procs)
    node_ids = [r['node_id'] for r in results]
    assert len(set(node_ids)) == 6

    everything = []
    for result in results:
        ids = result['ids']
        assert all(a < b for a, b in zip(ids, ids[1:])), 'ids must be monotonic per process'
        assert {Snowflake.decode(x)['node_id'] for x in ids} == {result['node_id']}
        everything.extend(ids)
    assert len(everything) == len(set(everything)) == 6 * count


def fill_nodes(temp, except_node=None, age='0 seconds'):
    temp.execute(
        "INSERT INTO snowflake_nodes (node_id, holder, heartbeat_at) "
        "SELECT n, 'other', now() - %s::interval FROM generate_series(0, 1023) n WHERE n IS DISTINCT FROM %s::int",
        (age, except_node),
    )


def test_refuses_when_no_node_is_free(migrated_db):
    fill_nodes(migrated_db)
    with pytest.raises(NoFreeNodeError):
        NodeLease(migrated_db.url).acquire()


@pytest.mark.parametrize('mode', [['--single-process'], ['--workers', '2']])
def test_server_refuses_to_start_when_no_node_is_free(migrated_db, mode):
    from tests.conftest import ServerProcess
    fill_nodes(migrated_db)
    server = ServerProcess(migrated_db, *mode)
    try:
        server.proc.wait(timeout=60)
    finally:
        code, output = server.stop()
    assert code != 0
    assert 'No free Snowflake node id' in output


def test_expired_lease_is_reclaimed(migrated_db):
    fill_nodes(migrated_db, except_node=77)
    migrated_db.execute(
        "INSERT INTO snowflake_nodes (node_id, holder, heartbeat_at) VALUES (77, 'dead', now() - interval '1 hour')")
    lease = NodeLease(migrated_db.url, ttl=300)
    assert lease.acquire() == 77
    assert migrated_db.fetchone('SELECT holder FROM snowflake_nodes WHERE node_id = 77')[0] == lease.holder


def test_heartbeat_release_and_reuse_order(migrated_db):
    lease = NodeLease(migrated_db.url, ttl=300, heartbeat_interval=30)
    node = lease.acquire()
    before = migrated_db.fetchone('SELECT heartbeat_at FROM snowflake_nodes WHERE node_id = %s', (node,))[0]
    time.sleep(0.01)
    assert lease.heartbeat() is True
    after = migrated_db.fetchone('SELECT heartbeat_at FROM snowflake_nodes WHERE node_id = %s', (node,))[0]
    assert after > before

    lease.release()
    assert lease.node_id is None
    expired = migrated_db.fetchone(
        "SELECT heartbeat_at < now() - interval '300 seconds' FROM snowflake_nodes WHERE node_id = %s", (node,))[0]
    assert expired is True

    # a released id is reusable, but never-used ids are handed out first
    other = NodeLease(migrated_db.url).acquire()
    assert other != node


def test_lost_lease_is_replaced(migrated_db, snowflake_state):
    lease = NodeLease(migrated_db.url)
    node = lease.acquire()
    Snowflake.set_node_provider(lease.current_node_id)
    migrated_db.execute("UPDATE snowflake_nodes SET holder = 'thief' WHERE node_id = %s", (node,))

    assert lease.heartbeat() is False
    assert lease.node_id is not None and lease.node_id != node
    assert Snowflake.decode(Snowflake.generate())['node_id'] == lease.node_id


def test_stale_lease_stops_id_generation(migrated_db, snowflake_state):
    lease = NodeLease(migrated_db.url, ttl=60, heartbeat_interval=10)
    lease.acquire()
    Snowflake.set_node_provider(lease.current_node_id)
    Snowflake.generate()

    lease._renewed_at -= 55  # pretend heartbeats have failed for 55s
    with pytest.raises(LeaseLostError):
        Snowflake.generate()


def test_forked_child_cannot_use_parent_lease(migrated_db):
    lease = NodeLease(migrated_db.url)
    lease.acquire()
    lease.pid = os.getpid() + 1  # as seen from a forked child
    with pytest.raises(LeaseLostError):
        lease.current_node_id()


def test_heartbeat_thread_renews(migrated_db, snowflake_state):
    lease = NodeLease(migrated_db.url, ttl=4, heartbeat_interval=1)
    node = lease.start(install=True)
    try:
        first = migrated_db.fetchone('SELECT heartbeat_at FROM snowflake_nodes WHERE node_id = %s', (node,))[0]
        time.sleep(2.5)
        later = migrated_db.fetchone('SELECT heartbeat_at FROM snowflake_nodes WHERE node_id = %s', (node,))[0]
        assert later > first
        Snowflake.generate()  # still valid after the original ttl window
    finally:
        lease.stop()
    assert lease.node_id is None


def test_cleanup_removes_only_long_expired_rows(migrated_db):
    migrated_db.execute(
        "INSERT INTO snowflake_nodes (node_id, holder, heartbeat_at) VALUES "
        "(1, 'fresh', now()), (2, 'just-expired', now() - interval '10 minutes'), "
        "(3, 'ancient', now() - interval '3 days')")
    assert cleanup_expired(migrated_db.conn, ttl=300, retention=86400) == 1
    remaining = [r[0] for r in migrated_db.fetchall('SELECT node_id FROM snowflake_nodes ORDER BY node_id')]
    assert remaining == [1, 2]


# --- async leases (Sanic workers) ---------------------------------------------------

async def _pool(temp, **kwargs):
    from psycopg_pool import AsyncConnectionPool
    pool = AsyncConnectionPool(temp.url, min_size=1, max_size=4, kwargs={'autocommit': True}, open=False)
    await pool.open(wait=True)
    return pool


async def test_async_lease_heartbeat_release_and_fencing(migrated_db, snowflake_state):
    pool = await _pool(migrated_db)
    try:
        lease = AsyncNodeLease(pool, ttl=4, heartbeat_interval=1)
        node = await lease.start(install=True)
        assert Snowflake.decode(Snowflake.generate())['node_id'] == node
        first = migrated_db.fetchone('SELECT heartbeat_at FROM snowflake_nodes WHERE node_id = %s', (node,))[0]
        await asyncio.sleep(2.5)  # the heartbeat task renews in the background
        later = migrated_db.fetchone('SELECT heartbeat_at FROM snowflake_nodes WHERE node_id = %s', (node,))[0]
        assert later > first
        Snowflake.generate()

        lease._renewed_at -= 10  # stale: fenced
        with pytest.raises(LeaseLostError):
            Snowflake.generate()
        lease._renewed_at += 10

        await lease.stop()
        assert lease.node_id is None
        with pytest.raises(LeaseLostError):
            Snowflake.generate()
        assert migrated_db.fetchone(
            "SELECT heartbeat_at < now() - interval '4 seconds' FROM snowflake_nodes WHERE node_id = %s", (node,))[0]
    finally:
        await pool.close()


async def test_async_leases_are_distinct_and_refuse_when_full(migrated_db):
    pool = await _pool(migrated_db)
    try:
        leases = [AsyncNodeLease(pool) for _ in range(16)]
        nodes = await asyncio.gather(*(lease.acquire() for lease in leases))
        assert len(set(nodes)) == 16
        fill_nodes_except(migrated_db, set(nodes))
        with pytest.raises(NoFreeNodeError):
            await AsyncNodeLease(pool).acquire()
    finally:
        await pool.close()


async def test_async_lost_lease_is_replaced(migrated_db, snowflake_state):
    pool = await _pool(migrated_db)
    try:
        lease = AsyncNodeLease(pool)
        node = await lease.acquire()
        migrated_db.execute("UPDATE snowflake_nodes SET holder = 'thief' WHERE node_id = %s", (node,))
        assert await lease.heartbeat() is False
        assert lease.node_id not in (None, node)
    finally:
        await pool.close()


def fill_nodes_except(temp, taken):
    temp.execute(
        "INSERT INTO snowflake_nodes (node_id, holder, heartbeat_at) "
        "SELECT n, 'other', now() FROM generate_series(0, 1023) n WHERE NOT (n = ANY(%s::int[]))",
        (list(taken),),
    )
