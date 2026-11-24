import os
import signal
import subprocess
import sys
import threading
import time

from jobs import Scheduler
from tests.conftest import API_DIR, subprocess_env


def make_scheduler(temp, task, interval=3600, name='count'):
    scheduler = Scheduler(temp.connect(), check_every=0)
    scheduler.register(name, interval, task)
    return scheduler


def test_two_schedulers_run_a_task_once(migrated_db):
    runs = []
    lock = threading.Lock()

    def task():
        with lock:
            runs.append(threading.current_thread().name)
        time.sleep(0.5)  # hold the advisory lock while the other replica ticks

    schedulers = [make_scheduler(migrated_db, task) for _ in range(2)]
    results = {}
    barrier = threading.Barrier(2)

    def replica(index):
        barrier.wait()
        results[index] = schedulers[index].tick()

    threads = [threading.Thread(target=replica, args=(i,), name='replica-{}'.format(i)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(runs) == 1
    assert sorted(len(x) for x in results.values()) == [0, 1]

    # ticks that are not aligned still don't run it again inside the interval
    for scheduler in schedulers:
        assert scheduler.tick() == []
    assert len(runs) == 1

    for scheduler in schedulers:
        scheduler.conn.close()


def test_task_runs_again_after_its_interval(migrated_db):
    runs = []
    scheduler = make_scheduler(migrated_db, lambda: runs.append(1), interval=1)
    assert scheduler.tick() == ['count']
    assert scheduler.tick() == []
    time.sleep(1.1)
    assert scheduler.tick() == ['count']
    assert len(runs) == 2
    scheduler.conn.close()


def test_failing_task_stays_due_and_records_error(migrated_db):
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) == 1:
            raise ValueError('first run fails')

    scheduler = make_scheduler(migrated_db, flaky)
    assert scheduler.tick() == []
    error = migrated_db.fetchone("SELECT last_error FROM jobs WHERE kind = 'scheduled:count'")[0]
    assert 'first run fails' in error
    assert scheduler.tick() == ['count']
    assert migrated_db.fetchone("SELECT last_error FROM jobs WHERE kind = 'scheduled:count'")[0] is None
    scheduler.conn.close()


def test_scheduler_markers_are_never_claimed_as_jobs(migrated_db):
    import jobs
    scheduler = make_scheduler(migrated_db, lambda: None)
    scheduler.tick()
    assert jobs.claim('w', conn=migrated_db.conn) is None
    scheduler.conn.close()


def test_snowflake_cleanup_task_is_registered_and_works(migrated_db):
    from jobs import tasks
    scheduler = tasks.register_scheduled(Scheduler(migrated_db.conn, check_every=0))
    assert sorted(scheduler.tasks) == ['file_view_seen_cleanup', 'snowflake_nodes_cleanup']
    del scheduler.tasks['file_view_seen_cleanup']

    migrated_db.execute(
        "INSERT INTO snowflake_nodes (node_id, holder, heartbeat_at) VALUES "
        "(1, 'live', now()), (2, 'gone', now() - interval '7 days')")
    assert scheduler.tick() == ['snowflake_nodes_cleanup']
    assert migrated_db.fetchall('SELECT node_id FROM snowflake_nodes') == [(1,)]


def test_worker_entrypoint_runs_jobs_and_exits_cleanly(migrated_db):
    import jobs
    job_id = jobs.enqueue('ping', {'from': 'test'}, conn=migrated_db.conn)

    proc = subprocess.Popen(
        [sys.executable, '-m', 'worker'], cwd=API_DIR,
        env=subprocess_env(DATABASE_URL=migrated_db.url, WORKER_POLL_INTERVAL='0.1'),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        deadline = time.time() + 20
        done = None
        while time.time() < deadline:
            done = migrated_db.fetchone('SELECT done_at FROM jobs WHERE id = %s', (job_id,))[0]
            if done is not None:
                break
            time.sleep(0.1)
        assert done is not None, 'worker did not run the ping job'
        assert migrated_db.fetchone(
            "SELECT count(*) FROM jobs WHERE kind = 'scheduled:snowflake_nodes_cleanup' AND done_at IS NOT NULL")[0] == 1
        assert migrated_db.fetchone(
            "SELECT count(*) FROM snowflake_nodes WHERE heartbeat_at > now() - interval '1 minute'")[0] == 1
    finally:
        proc.send_signal(signal.SIGTERM)
        output = proc.communicate(timeout=20)[0]

    assert proc.returncode == 0, output
    # the lease was released on exit
    assert migrated_db.fetchone(
        "SELECT count(*) FROM snowflake_nodes WHERE heartbeat_at > now() - interval '1 minute'")[0] == 0


def test_file_view_seen_cleanup_keeps_two_days(migrated_db):
    from datetime import date
    from jobs import tasks
    migrated_db.execute("INSERT INTO mimetype_types (id) VALUES ('text')")
    migrated_db.execute("INSERT INTO mimetypes (id, flags, type_id) VALUES ('text/plain', 0, 'text')")
    migrated_db.execute("INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (1, 'b', 's', 'm', 1)")
    migrated_db.execute("INSERT INTO files (id, vanity, mimetype_id, filename, hash_id, view_count) "
                        "VALUES (1, 'v', 'text/plain', 'f', 1, 0)")
    for day in ('2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'):
        migrated_db.execute("INSERT INTO file_view_seen (file_id, day, ip_hash) VALUES (1, %s, '\\x00')", (day,))
    assert tasks.cleanup_view_seen(migrated_db.conn, today=date(2026, 11, 24)) == 2
    assert [str(r[0]) for r in migrated_db.fetchall('SELECT day FROM file_view_seen ORDER BY day')] == \
        ['2026-11-22', '2026-11-23', '2026-11-24']

    scheduler = tasks.register_scheduled(Scheduler(migrated_db.conn, check_every=0))
    assert 'file_view_seen_cleanup' in scheduler.tick()
