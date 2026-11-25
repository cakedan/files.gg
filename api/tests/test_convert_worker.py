"""The work horses and the worker class (contract milestone-5 §3.3, §7.3, §15 "Worker class"), with the real Redis of
docker-compose.test.yml and a real `rq worker-pool --worker-class convert_worker.ConvertWorker` in a subprocess:
pools drain their queues in order, time limits, cancelling, structured errors, crashes and killed horses with their
failure reasons, the job's directory, CPU charged for killed horses, and the metrics."""

import os
import signal
import subprocess
import time

import pytest

from PIL import Image
from rq import Queue
from rq.job import Job

from tests import m5convert
from tests.test_converter import processes_with
from utils import convert_queue
from utils.redis import get_sync

pytestmark = pytest.mark.usefixtures('client')


@pytest.fixture(scope='module')
def appdb():
    from tests.conftest import APP_DATABASE, TempDatabase
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


@pytest.fixture
def user(appdb):
    from tests.m3 import new_user
    return new_user(appdb)


class Pool:
    """`rq worker-pool <queues> -n 1 --burst` with the converter's worker class, in its own CONVERT_TMP_DIR."""

    def __init__(self, tmp_path, *queues, burst=True):
        self.tmp = tmp_path / 'convert-tmp'
        self.tmp.mkdir(exist_ok=True)
        self.log = tmp_path / 'worker.log'
        env = dict(os.environ, CONVERT_TMP_DIR=str(self.tmp), CONVERT_PROCESSES='1')
        cmd = ['rq', 'worker-pool', *queues, '-n', '1', '--worker-class', 'convert_worker.ConvertWorker',
               '--url', os.environ['REDIS_URL']]
        if burst:
            cmd.append('--burst')
        with open(self.log, 'wb') as log:
            self.proc = subprocess.Popen(cmd, cwd=m5convert.API_DIR, env=env, stdout=log, stderr=subprocess.STDOUT,
                                         start_new_session=True)

    def wait(self, timeout=120):
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.stop()
            raise AssertionError('the pool did not finish:\n' + self.log.read_text()[-4000:])
        return self.log.read_text()

    def stop(self):
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.proc.wait()

    def job_directories(self):
        return [name for name in os.listdir(self.tmp) if name.startswith('job-')]


def slow_source(client, headers, tmp_path):
    """A tiny GIF that takes minutes to encode (two 1000x1000 frames shown a minute each), uploaded."""
    from tests.conftest import APP_DATABASE, TempDatabase, hash_of
    from tests.m3 import send
    frames = [Image.new('RGB', (1000, 1000), colour) for colour in ((200, 30, 30), (30, 30, 200))]
    path = tmp_path / 'slow.gif'
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=60000, loop=0)
    created = send(client, headers, path.read_bytes(), 'slow.gif', 'image/gif')
    db = TempDatabase(APP_DATABASE)
    try:
        hash_id = int(hash_of(db, created))
    finally:
        db.close()
    m5convert.probe_source(hash_id)
    return int(created['id']), hash_id


def enqueue(conversion_id, queue='convert_member', time_limit=None, job_timeout=None):
    job_timeout = job_timeout or time_limit
    Queue(queue, connection=get_sync()).enqueue(
        convert_queue.RUN, conversion_id, job_id=convert_queue.conversion_job_id(conversion_id),
        job_timeout=job_timeout, result_ttl=convert_queue.RESULT_TTL, failure_ttl=convert_queue.FAILURE_TTL)


def wait_for(predicate, timeout=60, what='it'):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError('timed out waiting for ' + what)


def tools_running():
    return processes_with('media.convert')


def metrics():
    return {k.decode(): float(v) for k, v in get_sync().hgetall('filesgg:metrics:jobs').items()}


def usage_ms(appdb, user_id):
    row = appdb.fetchone("SELECT cpu_ms FROM conversion_usage WHERE subject = %s AND day = "
                         "(now() AT TIME ZONE 'UTC')::date", ('u:{}'.format(user_id),))
    return row[0] if row else 0


# --- queues ------------------------------------------------------------------------------------------------------------

def test_pools_drain_their_queues_in_order(tmp_path):
    connection = get_sync()
    for name, queue in (('member-1', 'convert_member'), ('member-2', 'convert_member'),
                        ('premium-1', 'convert_premium'), ('premium-2', 'convert_premium')):
        Queue(queue, connection=connection).enqueue('tests.convert_worker_jobs.record', name)
    Pool(tmp_path, 'convert_premium', 'convert_member').wait()
    order = [n.decode() for n in connection.lrange('test:order', 0, -1)]
    assert order == ['premium-1', 'premium-2', 'member-1', 'member-2']
    assert metrics()['jobs:convert_premium:finished'] == 2


def test_each_horse_leases_its_own_snowflake_node(tmp_path):
    """Two horses running at once generate ids with different leased nodes, never the static fallback node that
    every horse used to share (two of them writing in the same millisecond made the same file id)."""
    connection = get_sync()
    for name in ('a', 'b'):
        Queue('convert_member', connection=connection).enqueue('tests.convert_worker_jobs.record_node', name)
    for name in ('one', 'two'):
        (tmp_path / name).mkdir()
    first, second = Pool(tmp_path / 'one', 'convert_member'), Pool(tmp_path / 'two', 'convert_member')
    first.wait()
    second.wait()
    rows = [n.decode().split(':') for n in connection.lrange('test:nodes', 0, -1)]
    assert sorted(r[0] for r in rows) == ['a', 'b']
    assert all(r[2] == '1' for r in rows), rows  # a lease was installed in each horse
    assert rows[0][1] != rows[1][1], rows


def test_async_job_that_raises_exits_at_once(tmp_path):
    """ConvertJob._execute (notsobot's NotSoJob fix): the horse doesn't wait for the executor's 60 s task."""
    job = Queue('convert_member', connection=get_sync()).enqueue('tests.convert_worker_jobs.raise_with_busy_executor')
    started = time.monotonic()
    Pool(tmp_path, 'convert_member').wait()
    assert time.monotonic() - started < 30
    assert Job.fetch(job.id, connection=get_sync()).get_status() == 'failed'


# --- conversions through the pool ------------------------------------------------------------------------------------------

def test_conversion_succeeds_and_is_charged(tmp_path, client, appdb, user):
    user_id, headers = user
    file_id, hash_id = m5convert.upload(client, headers, 'clip.mp4')
    m5convert.probe_source(hash_id)
    conversion_id = m5convert.insert_conversion(appdb, 'video', 'webm', {}, file_id=file_id, hash_id=hash_id,
                                                user_id=user_id, name='clip')
    enqueue(conversion_id, time_limit=120)
    log = Pool(tmp_path, 'convert_member').wait()
    row = m5convert.conversion(appdb, conversion_id)
    assert row['status'] == 'succeeded', (row['error'], log[-3000:])
    assert row['failure_reason'] is None
    assert row['cpu_ms'] > 0 and usage_ms(appdb, user_id) >= row['cpu_ms']
    assert m5convert.mime_bytes(m5convert.output_bytes(appdb, conversion_id)) == 'video/webm'
    counters = metrics()
    assert counters['jobs:convert_member:finished'] == 1
    assert counters['cpu_ms_sum:convert_member'] == row['cpu_ms']
    assert sum(v for k, v in counters.items() if k.startswith('duration:convert_member:le_')) == 1
    assert sum(v for k, v in counters.items() if k.startswith('wait:convert_member:le_')) == 1
    assert '"result": "finished"' in log


def test_time_limit_kills_the_horse_and_its_tools(tmp_path, client, appdb, user):
    """rq's own limit (JobTimeoutException in the horse, here before the horse's own wall clock): the tools die, the
    error is CONVERSION_TIMEOUT with how long it ran and waited, the directory goes, the CPU is charged."""
    user_id, headers = user
    file_id, hash_id = slow_source(client, headers, tmp_path)
    conversion_id = m5convert.insert_conversion(appdb, 'animated', 'webm', {'fps': 60}, file_id=file_id,
                                                hash_id=hash_id, user_id=user_id, time_limit=600)
    enqueue(conversion_id, job_timeout=6)
    pool = Pool(tmp_path, 'convert_member')
    log = pool.wait()
    row = m5convert.conversion(appdb, conversion_id)
    assert row['status'] == 'failed', log[-3000:]
    assert row['error']['code'] == 'CONVERSION_TIMEOUT'
    metadata = row['error']['metadata']
    assert metadata['seconds'] == 6 and metadata['tier'] == 'premium'
    assert 5 <= metadata['ran_seconds'] <= 30 and metadata['queued_seconds'] >= 0
    assert row['failure_reason'] == 'CONVERSION_TIMEOUT'
    assert row['cpu_ms'] > 1000
    assert tools_running() == []
    assert pool.job_directories() == []
    assert metrics()['errors:convert_member:CONVERSION_TIMEOUT'] == 1


def test_horse_clean_timeout(tmp_path, client, appdb, user):
    """The usual timeout: the horse's tools stop a little before rq's limit (§3.3), so the error is a clean one."""
    user_id, headers = user
    file_id, hash_id = slow_source(client, headers, tmp_path)
    conversion_id = m5convert.insert_conversion(appdb, 'animated', 'mp4', {'fps': 60}, file_id=file_id,
                                                hash_id=hash_id, user_id=user_id, time_limit=8)
    enqueue(conversion_id, time_limit=8)
    Pool(tmp_path, 'convert_member').wait()
    row = m5convert.conversion(appdb, conversion_id)
    assert row['error']['code'] == 'CONVERSION_TIMEOUT'
    assert row['error']['metadata']['ran_seconds'] < 8
    assert tools_running() == []


def test_cancel_stops_a_running_horse(tmp_path, client, appdb, user):
    user_id, headers = user
    file_id, hash_id = slow_source(client, headers, tmp_path)
    conversion_id = m5convert.insert_conversion(appdb, 'animated', 'webm', {'fps': 60}, file_id=file_id,
                                                hash_id=hash_id, user_id=user_id, time_limit=600)
    enqueue(conversion_id, time_limit=600)
    pool = Pool(tmp_path, 'convert_member')
    wait_for(lambda: m5convert.conversion(appdb, conversion_id)['stage'] == 'converting' and tools_running(),
             what='the conversion to run')
    # DELETE /conversions/<id>: cancelled in Postgres, then stopped (utils/convert_queue.py `cancel`)
    appdb.execute("UPDATE conversions SET status = 'cancelled', finished_at = now() WHERE id = %s", (conversion_id,))
    assert convert_queue.cancel(convert_queue.conversion_job_id(conversion_id)) == 'stopped'
    pool.wait()
    row = m5convert.conversion(appdb, conversion_id)
    assert row['status'] == 'cancelled' and row['failure_reason'] == 'cancelled'
    assert row['cpu_ms'] > 0
    assert tools_running() == []
    assert pool.job_directories() == []
    assert metrics()['failures:convert_member:cancelled'] == 1


def test_cancel_skips_a_queued_job(tmp_path, client, appdb, user):
    user_id, headers = user
    file_id, hash_id = m5convert.upload(client, headers, 'sample.png')
    first = m5convert.insert_conversion(appdb, 'image', 'jpg', {}, file_id=file_id, hash_id=hash_id, user_id=user_id)
    second = m5convert.insert_conversion(appdb, 'image', 'webp', {}, file_id=file_id, hash_id=hash_id,
                                         user_id=user_id)
    enqueue(first, time_limit=60)
    enqueue(second, time_limit=60)
    # queued: job.cancel(); and one already cancelled in Postgres whose job still ran returns without work
    for conversion_id in (first, second):
        appdb.execute("UPDATE conversions SET status = 'cancelled' WHERE id = %s", (conversion_id,))
    assert convert_queue.cancel(convert_queue.conversion_job_id(first)) == 'cancelled'
    Pool(tmp_path, 'convert_member').wait()
    for conversion_id in (first, second):
        row = m5convert.conversion(appdb, conversion_id)
        assert row['status'] == 'cancelled' and row['started_at'] is None and row['output_file_id'] is None
    assert m5convert.conversion(appdb, first)['failure_reason'] is None  # never reached a worker
    assert m5convert.conversion(appdb, second)['failure_reason'] == 'cancelled'


def test_api_error_is_saved(tmp_path, client, appdb, user):
    user_id, headers = user
    file_id, hash_id = m5convert.upload(client, headers, 'sample.png')
    conversion_id = m5convert.insert_conversion(appdb, 'video', 'mp4', {}, file_id=file_id, hash_id=hash_id,
                                                user_id=user_id)
    enqueue(conversion_id, time_limit=60)
    Pool(tmp_path, 'convert_member').wait()
    row = m5convert.conversion(appdb, conversion_id)
    assert row['status'] == 'failed'
    assert row['error'] == {'code': 'CONVERSION_FAILED', 'message': 'The conversion failed',
                            'metadata': {'reason': 'unreadable_source'}}
    assert row['failure_reason'] == 'CONVERSION_FAILED'
    assert metrics()['errors:convert_member:CONVERSION_FAILED'] == 1


def test_crash_gives_its_exception_type(tmp_path, client, appdb, user):
    """A crash (the source's blob is gone): CONVERSION_FAILED `internal` for the caller, the exception's
    `package.Type` as the failure reason, nothing of it in the error."""
    from tests.conftest import BUCKET, s3_client
    from utils import storage
    user_id, headers = user
    # bytes of its own: the blob is deleted, and other tests upload the fixture too
    file_id, hash_id = m5convert.upload(client, headers, 'gps.jpg', unique=True)
    s3_client().delete_object(Bucket=BUCKET, Key=storage.blob_key(hash_id))
    conversion_id = m5convert.insert_conversion(appdb, 'image', 'png', {}, file_id=file_id, hash_id=hash_id,
                                                user_id=user_id)
    enqueue(conversion_id, time_limit=60)
    log = Pool(tmp_path, 'convert_member').wait()
    row = m5convert.conversion(appdb, conversion_id)
    assert row['status'] == 'failed'
    assert row['error'] == {'code': 'CONVERSION_FAILED', 'message': 'The conversion failed',
                            'metadata': {'reason': 'internal'}}
    assert row['failure_reason'] == 'botocore.NoSuchKey', log[-3000:]
    assert metrics()['failures:convert_member:botocore.NoSuchKey'] == 1


def test_killed_horse(tmp_path, client, appdb, user):
    """The OOM killer's SIGKILL on the horse: its tools die with it, the parent fails the conversion with
    `killed_SIGKILL`, charges the CPU it used (tools included), and deletes its directory."""
    user_id, headers = user
    file_id, hash_id = slow_source(client, headers, tmp_path)
    conversion_id = m5convert.insert_conversion(appdb, 'animated', 'webm', {'fps': 60}, file_id=file_id,
                                                hash_id=hash_id, user_id=user_id, time_limit=600)
    enqueue(conversion_id, time_limit=600)
    pool = Pool(tmp_path, 'convert_member')
    children = wait_for(tools_running, what='the conversion to run')
    assert pool.job_directories()
    time.sleep(2)  # let the tools use some CPU
    with open('/proc/{}/stat'.format(children[0])) as handle:
        horse = int(handle.read().rsplit(')', 1)[1].split()[1])
    os.kill(horse, signal.SIGKILL)
    log = pool.wait()
    row = m5convert.conversion(appdb, conversion_id)
    assert row['status'] == 'failed', log[-3000:]
    assert row['failure_reason'] == 'killed_SIGKILL'
    assert row['error']['metadata'] == {'reason': 'internal'}
    assert row['cpu_ms'] >= 1000
    assert usage_ms(appdb, user_id) >= row['cpu_ms']
    assert tools_running() == []
    assert pool.job_directories() == []
    assert metrics()['failures:convert_member:killed_SIGKILL'] == 1


def test_idle_temp_directories_are_swept(tmp_path):
    """Before taking a job, anything in CONVERT_TMP_DIR idle past the longest time limit plus 5 minutes goes."""
    import convert_worker
    old = tmp_path / 'job-old'
    old.mkdir()
    (old / 'input').write_bytes(b'x')
    recent = tmp_path / 'job-recent'
    recent.mkdir()
    past = time.time() - convert_worker.TMP_MAX_IDLE - 10
    os.utime(old, (past, past))
    worker = convert_worker.ConvertWorker.__new__(convert_worker.ConvertWorker)
    worker._last_clean = 0.0
    original = convert_worker.TMP_DIR
    convert_worker.TMP_DIR = str(tmp_path)
    try:
        worker.clean_temp()
    finally:
        convert_worker.TMP_DIR = original
    assert not old.exists() and recent.exists()
    assert convert_worker.TMP_MAX_IDLE == 1800 + 300


# --- failure reasons (notsobot's get_job_failure_reason) -------------------------------------------------------------

class FakeResult:
    def __init__(self, exc_string):
        self.exc_string = exc_string


class FakeJob:
    def __init__(self, exc_string='', meta=None, timeout=60):
        self.timeout = timeout
        self.meta = meta or {}
        self.result = FakeResult(exc_string)

    def get_meta(self, refresh=False):
        return self.meta

    def latest_result(self):
        return self.result


@pytest.mark.parametrize('exc_string,meta,duration,status,expected', [
    ('', {}, 1, 'finished', None),
    ('', {}, 1, 'stopped', 'cancelled'),
    ('', {}, 1, 'canceled', 'cancelled'),
    ('', {'error': {'code': 'CONVERSION_TIMEOUT'}}, 1, 'failed', 'CONVERSION_TIMEOUT'),
    ('Work-horse terminated unexpectedly; waitpid returned None; ', {}, 125, 'failed', 'killed_at_timeout'),
    ('Work-horse terminated unexpectedly; waitpid returned None; ', {}, 5, 'failed', 'work_horse_lost'),
    ('Work-horse terminated unexpectedly; waitpid returned 9 (signal 9); ', {}, 5, 'failed', 'killed_SIGKILL'),
    ('Traceback...', {'exception': {'type': 'OSError', 'module': 'builtins'}}, 1, 'failed', 'OSError'),
    ('Traceback...', {'exception': {'type': 'Error', 'module': 'pyvips.error'}}, 1, 'failed', 'pyvips.Error'),
    ('', {}, 1, 'failed', 'no_result'),
])
def test_failure_reasons(exc_string, meta, duration, status, expected):
    import convert_worker
    assert convert_worker.failure_reason(FakeJob(exc_string, meta), duration, status) == expected
