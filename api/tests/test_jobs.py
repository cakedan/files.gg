import threading

import pytest

import jobs
from jobs import queue


@pytest.fixture
def handlers():
    added = []

    def add(kind, func):
        jobs.register(kind, func)
        added.append(kind)
        return func

    yield add
    for kind in added:
        jobs.unregister(kind)


def job_row(temp, job_id):
    row = temp.fetchone(
        'SELECT attempts, locked_by, locked_at, last_error, done_at, failed_at, '
        'EXTRACT(EPOCH FROM (run_at - now())) FROM jobs WHERE id = %s', (job_id,))
    keys = ('attempts', 'locked_by', 'locked_at', 'last_error', 'done_at', 'failed_at', 'run_in')
    return dict(zip(keys, row))


def test_enqueue_and_run_ping(migrated_db):
    import jobs.tasks  # noqa: F401  registers ping
    job_id = jobs.enqueue('ping', {'hello': 'world'}, conn=migrated_db.conn)

    job = jobs.claim('w1', conn=migrated_db.conn)
    assert (job.id, job.kind, job.payload, job.attempts) == (job_id, 'ping', {'hello': 'world'}, 1)
    assert jobs.run_job(job, 'w1', conn=migrated_db.conn) == 'done'

    row = job_row(migrated_db, job_id)
    assert row['done_at'] is not None and row['locked_by'] is None
    assert jobs.claim('w1', conn=migrated_db.conn) is None


def test_future_jobs_are_not_claimed(migrated_db):
    jobs.enqueue('ping', run_at=queue.in_seconds(3600), conn=migrated_db.conn)
    assert jobs.claim('w1', conn=migrated_db.conn) is None


def test_two_concurrent_claimers_never_get_the_same_job(migrated_db):
    from tests.conftest import connect
    total = 300
    migrated_db.execute(
        "INSERT INTO jobs (kind, payload) SELECT 'ping', jsonb_build_object('n', n) "
        "FROM generate_series(1, %s) n", (total,))

    claimed = {}
    barrier = threading.Barrier(2)

    def claimer(name):
        got = claimed.setdefault(name, [])
        with connect(migrated_db.name) as conn:
            barrier.wait()
            while True:
                job = jobs.claim(name, conn=conn)
                if job is None:
                    return
                got.append(job.id)

    threads = [threading.Thread(target=claimer, args=(name,)) for name in ('a', 'b')]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    a, b = claimed['a'], claimed['b']
    assert not set(a) & set(b)
    assert len(a) + len(b) == len(set(a) | set(b)) == total
    assert a and b, 'both claimers should have made progress'
    owners = dict(migrated_db.fetchall('SELECT id, locked_by FROM jobs'))
    assert all(owners[x] == 'a' for x in a) and all(owners[x] == 'b' for x in b)


def test_claim_skips_rows_locked_by_another_transaction(migrated_db):
    from tests.conftest import connect
    first = jobs.enqueue('ping', conn=migrated_db.conn)
    second = jobs.enqueue('ping', conn=migrated_db.conn)

    with connect(migrated_db.name) as holder:
        with holder.transaction():
            holder.execute('SELECT id FROM jobs WHERE id = %s FOR UPDATE', (first,))
            job = jobs.claim('w2', conn=migrated_db.conn)
            assert job.id == second


def test_retry_with_exponential_backoff_then_fail(migrated_db, handlers):
    calls = []

    def boom(payload, job):
        calls.append(job.attempts)
        raise RuntimeError('kaboom #{}'.format(job.attempts))

    handlers('boom', boom)
    job_id = jobs.enqueue('boom', max_attempts=3, conn=migrated_db.conn)

    assert jobs.run_next('w', conn=migrated_db.conn) == 'retry'
    row = job_row(migrated_db, job_id)
    assert row['attempts'] == 1 and row['locked_by'] is None and row['failed_at'] is None
    assert 'RuntimeError: kaboom #1' in row['last_error']
    assert 8 < row['run_in'] <= 10  # backoff(1) = 10s

    # not due yet
    assert jobs.run_next('w', conn=migrated_db.conn) is None

    migrated_db.execute('UPDATE jobs SET run_at = now() WHERE id = %s', (job_id,))
    assert jobs.run_next('w', conn=migrated_db.conn) == 'retry'
    row = job_row(migrated_db, job_id)
    assert row['attempts'] == 2 and 'kaboom #2' in row['last_error']
    assert 18 < row['run_in'] <= 20  # backoff(2) = 20s

    migrated_db.execute('UPDATE jobs SET run_at = now() WHERE id = %s', (job_id,))
    assert jobs.run_next('w', conn=migrated_db.conn) == 'failed'
    row = job_row(migrated_db, job_id)
    assert row['attempts'] == 3 and row['failed_at'] is not None and 'kaboom #3' in row['last_error']
    assert calls == [1, 2, 3]

    migrated_db.execute('UPDATE jobs SET run_at = now() WHERE id = %s', (job_id,))
    assert jobs.run_next('w', conn=migrated_db.conn) is None


def test_backoff_doubles_and_caps():
    assert [jobs.backoff(n) for n in range(1, 6)] == [10, 20, 40, 80, 160]
    assert jobs.backoff(30) == queue.BACKOFF_MAX


def test_job_of_dead_worker_is_retried_after_lock_timeout(migrated_db):
    job_id = jobs.enqueue('ping', conn=migrated_db.conn)
    assert jobs.claim('dead-worker', conn=migrated_db.conn).id == job_id
    assert jobs.claim('w2', conn=migrated_db.conn) is None

    migrated_db.execute("UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = %s", (job_id,))
    job = jobs.claim('w2', conn=migrated_db.conn, lock_timeout=600)
    assert job.id == job_id and job.attempts == 2

    # the dead worker can no longer complete it
    assert jobs.complete(job, 'dead-worker', conn=migrated_db.conn) is False
    assert jobs.complete(job, 'w2', conn=migrated_db.conn) is True


def test_unknown_kind_is_recorded_as_error(migrated_db):
    job_id = jobs.enqueue('no-such-kind', conn=migrated_db.conn)
    assert jobs.run_next('w', conn=migrated_db.conn) == 'retry'
    assert 'no handler registered' in job_row(migrated_db, job_id)['last_error']


def test_claim_can_filter_kinds(migrated_db):
    jobs.enqueue('ping', conn=migrated_db.conn)
    other = jobs.enqueue('other', conn=migrated_db.conn)
    assert jobs.claim('w', kinds=['other'], conn=migrated_db.conn).id == other


async def test_async_enqueue_from_the_api_side(migrated_db):
    from psycopg import AsyncConnection
    async with await AsyncConnection.connect(migrated_db.url, autocommit=True) as conn:
        job_id = await jobs.enqueue_async('ping', {'n': 1}, run_at=queue.in_seconds(-1), conn=conn)
    job = jobs.claim('w', conn=migrated_db.conn)
    assert (job.id, job.payload) == (job_id, {'n': 1})


def test_only_the_known_kinds_are_registered_by_default():
    import jobs.tasks  # noqa: F401
    assert 'ping' in jobs.registered_kinds()
    # Milestone 3 adds the media jobs and blob garbage collection
    assert set(jobs.registered_kinds()) <= {'ping', 'boom', 'finalize_upload', 'probe', 'derive', 'album_collage',
                                            'delete_blob',
                                            # Milestone 4: scanning (safety/scan.py)
                                            'scan', 'rescan', 'pdq_sweep', 'album_text_scan', 'delete_objects',
                                            # §3.6, queued with every CSAM match (safety/csam.py)
                                            'csam_handle',
                                            # Milestone 6: Cloudflare hostnames and data exports (jobs/accounts.py)
                                            'domain_delete', 'account_export'}


def test_queues_are_isolated(migrated_db):
    conn = migrated_db.conn
    convert = jobs.enqueue('ping', {'q': 'convert'}, queue='convert', conn=conn)
    default = jobs.enqueue('ping', {'q': 'default'}, conn=conn)

    assert jobs.claim('default-worker', conn=conn).id == default
    assert jobs.claim('default-worker', conn=conn) is None  # never the convert job
    assert jobs.claim('default-worker', queues=['default'], conn=conn) is None

    assert jobs.claim('convert-worker', queues=['convert'], conn=conn).id == convert
    later = jobs.enqueue('ping', conn=conn)
    assert jobs.claim('convert-worker', queues=['convert'], conn=conn) is None  # never a default job
    assert jobs.claim('both', queues=['convert', 'default'], conn=conn).id == later
    assert migrated_db.fetchall('SELECT queue FROM jobs ORDER BY id') == [('convert',), ('default',), ('default',)]


async def test_async_enqueue_takes_a_queue(migrated_db):
    from psycopg import AsyncConnection
    async with await AsyncConnection.connect(migrated_db.url, autocommit=True) as conn:
        job_id = await jobs.enqueue_async('ping', queue='convert', conn=conn)
    assert migrated_db.fetchone('SELECT queue FROM jobs WHERE id = %s', (job_id,))[0] == 'convert'
    assert jobs.claim('w', conn=migrated_db.conn) is None


def test_scheduler_markers_are_never_claimable(migrated_db):
    from jobs import Scheduler
    conn = migrated_db.conn
    scheduler = Scheduler(conn, check_every=0)
    scheduler.register('count', 3600, lambda: None)
    scheduler.tick()
    assert migrated_db.fetchone("SELECT queue FROM jobs WHERE kind = 'scheduled:count'")[0] == 'scheduler'

    # even if the marker looked runnable, no worker claims from the scheduler queue
    migrated_db.execute("UPDATE jobs SET done_at = NULL, run_at = now() - interval '1 hour' WHERE kind = 'scheduled:count'")
    assert jobs.claim('w', queues=['default', 'convert'], conn=conn) is None
    with pytest.raises(ValueError):
        jobs.claim('w', queues=['scheduler'], conn=conn)
    with pytest.raises(ValueError):
        jobs.enqueue('ping', queue='scheduler', conn=conn)


def test_worker_queue_option():
    import worker
    assert jobs.parse_queues(worker.parse_args([]).queues) == ['default']
    assert jobs.parse_queues(worker.parse_args(['--queues', 'convert, default']).queues) == ['convert', 'default']
    with pytest.raises(ValueError):
        jobs.parse_queues('default,scheduler')


# --- the lock heartbeat, the purge and the per-target indexes ---------------------------------------------

def test_a_running_job_renews_its_lock(migrated_db, handlers):
    import time
    seen = {}

    def slow(payload, job):
        seen['before'] = migrated_db.fetchone('SELECT locked_at FROM jobs WHERE id = %s', (job.id,))[0]
        time.sleep(0.5)
        seen['after'] = migrated_db.fetchone('SELECT locked_at FROM jobs WHERE id = %s', (job.id,))[0]
    handlers('slow', slow)
    job_id = jobs.enqueue('slow', conn=migrated_db.conn)
    job = jobs.claim('w1', conn=migrated_db.conn)
    assert jobs.run_job(job, 'w1', conn=migrated_db.conn, heartbeat=0.05) == 'done'
    assert seen['after'] > seen['before']
    # so another worker can't claim it while it runs, even with a lock timeout shorter than the job
    row = job_row(migrated_db, job_id)
    assert row['done_at'] is not None and row['locked_by'] is None


def test_the_heartbeat_stops_when_the_lock_is_lost(migrated_db):
    import time
    job_id = jobs.enqueue('anything', conn=migrated_db.conn)
    job = jobs.claim('w1', conn=migrated_db.conn)
    beat = queue.Heartbeat(job, 'w1', migrated_db.conn, interval=0.02)
    with beat:
        time.sleep(0.15)
        assert beat.beats >= 1
        # another worker took it over (its lock had expired): w1 stops renewing
        migrated_db.execute("UPDATE jobs SET locked_by = 'w2' WHERE id = %s", (job_id,))
        time.sleep(0.15)
        stopped = beat.beats
        time.sleep(0.1)
        assert beat.beats == stopped
    assert job_row(migrated_db, job_id)['locked_by'] == 'w2'


def test_old_done_jobs_are_purged(migrated_db):
    from jobs import tasks
    conn = migrated_db.conn
    old = jobs.enqueue('ping', conn=conn)
    recent = jobs.enqueue('ping', conn=conn)
    waiting = jobs.enqueue('ping', conn=conn)
    failed = jobs.enqueue('ping', conn=conn)
    migrated_db.execute("UPDATE jobs SET done_at = now() - interval '8 days' WHERE id = %s", (old,))
    migrated_db.execute("UPDATE jobs SET done_at = now() - interval '6 days' WHERE id = %s", (recent,))
    migrated_db.execute("UPDATE jobs SET failed_at = now() - interval '30 days' WHERE id = %s", (failed,))
    migrated_db.execute("INSERT INTO jobs (kind, queue, done_at) VALUES ('scheduled:x', 'scheduler', "
                        "now() - interval '30 days')")
    assert tasks.purge_done_jobs(conn) == 1
    left = {r[0] for r in migrated_db.fetchall('SELECT id FROM jobs')}
    assert old not in left and {recent, waiting, failed} <= left
    assert migrated_db.fetchone("SELECT count(*) FROM jobs WHERE queue = 'scheduler'")[0] == 1


def test_per_target_job_lookups_use_an_index(migrated_db):
    names = {r[0] for r in migrated_db.fetchall("SELECT indexname FROM pg_indexes WHERE tablename = 'jobs'")}
    assert {'jobs_runnable_hash', 'jobs_runnable_album', 'jobs_runnable_blocked_hash', 'jobs_done'} <= names
    migrated_db.execute('SET enable_seqscan = off')
    try:
        plan = '\n'.join(r[0] for r in migrated_db.fetchall(
            "EXPLAIN SELECT 1 FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = '1' AND done_at IS NULL "
            'AND failed_at IS NULL'))
    finally:
        migrated_db.execute('SET enable_seqscan = on')
    assert 'jobs_runnable_hash' in plan
