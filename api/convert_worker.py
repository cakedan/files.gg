"""The converter's RQ worker class (contract milestone-5 §3.3), modelled on notsobot.api's `NotSoWorker`:

    rq worker-pool convert_member convert_anonymous -n 4 --worker-class 'convert_worker.ConvertWorker'

- **One forked work horse per job** (rq's model): a job's memory goes back when it ends, a crash or the OOM killer
  takes one job, and nothing a job leaves behind reaches the next. rq puts the horse in its own process group and
  every tool it starts stays in it (and dies with its parent, media/sandbox.py `die_with_parent`), so killing the
  horse kills them all.
- **Loading once:** this module imports the job code and opens nothing; each horse opens its own Postgres
  connection when it first needs one and closes it when the job ends (jobs/convert.py).
- **`ConvertJob._execute`:** notsobot's `NotSoJob` fix. rq 3.0.0's `_execute` still runs a coroutine with
  `asyncio.run`, whose shutdown waits on the default executor's threads after the job raised (its timeout too);
  a job here exits as soon as it raises.
- **Structured errors** (`store_job_error`, notsobot's): an ApiError raised in the horse is saved as the
  conversion's `error`; anything else is a crash, logged as `{type, module, message}` for staff, and the conversion
  gets CONVERSION_FAILED (`internal`).
- **The parent finishes what the horse couldn't** (`execute_job`, which sees timeouts and killed horses): a
  conversion still `queued` or `running` after its horse is gone is `failed` with the right error, and
  `failure_reason` is saved either way (`failure_reason`, notsobot's `get_job_failure_reason`).
- **CPU time** (§7.3): rq 3.0.0 already reaps the horse with `os.wait4` (`Worker.wait_for_horse`), but drops the
  rusage when it kills a horse at its timeout, and a killed horse's tools are re-parented away from it before
  anyone reaps them. So the worker is a child subreaper (prctl PR_SET_CHILD_SUBREAPER): orphaned tools come back to
  it, it reaps them after the horse (`_reap_group`), and the job's CPU is this process's RUSAGE_CHILDREN before and
  after: the horse and every tool it ran, killed or not. Charged with `utils.conversions.charge_usage`.
- **Temp files** (notsobot's `track_temp_directories`): each job works in its own directory under
  `CONVERT_TMP_DIR`, made here before the fork and deleted when the job ends however it ended; before taking a job
  the worker deletes anything there idle longer than the longest time limit plus 5 minutes (`clean_temp`).
- **Metrics** (notsobot's `record_job`): the parent counts every job in the Redis hash `filesgg:metrics:jobs`
  (`record_job` documents its fields) and logs one structured line per job.
- **The thread budget:** `CONVERT_THREADS` (media/sandbox.py `convert_threads`) for every tool a job runs.
- **Not retried** (decision 16): the jobs are enqueued without `Retry`, with 120 s result and failure TTLs.
"""

import asyncio
import ctypes
import json
import logging
import os
import re
import resource
import shutil
import signal
import tempfile
import time

from typing import Optional

from rq import Worker
from rq.job import Job, JobStatus
from rq.timeouts import JobTimeoutException

import db
from jobs import convert as convert_jobs
from utils import conversions, errors, limits as limits_module
from utils.responses import ApiError

# a child of rq's logger, so the lines go where rq's own do (rq sets up the `rq.worker` handler)
log = logging.getLogger('rq.worker.convert')

TMP_DIR = os.getenv('CONVERT_TMP_DIR') or tempfile.gettempdir()
TMP_PREFIX = 'job-'
# §3.3: anything in CONVERT_TMP_DIR idle longer than the longest time limit plus 5 minutes belongs to no job
TMP_MAX_IDLE = max(values['TIME_LIMIT'] for values in map(limits_module.conversion_values,
                                                            limits_module.CONVERSION_TIERS)) + 5 * 60
TMP_CLEAN_EVERY = 60
# after the horse: how long its killed tools get to be reaped
REAP_WAIT = 5
PR_SET_CHILD_SUBREAPER = 36

METRICS_KEY = 'filesgg:metrics:jobs'
DURATION_BUCKETS = (0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800)
WAIT_BUCKETS = (0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 600, 3600)

# rq's failure for a horse that died without raising (a signal; the OOM killer is SIGKILL). `None` is a horse rq
# killed itself for running past its timeout + 60 s (it drops the kill's exit status)
WORK_HORSE_KILLED = re.compile(r'Work-horse terminated unexpectedly; waitpid returned (-?\d+|None)'
                               r'(?: \(signal (\d+)\))?')
EXCEPTION_NAME = re.compile(r'[A-Za-z_][\w.]{0,99}')


# --- the horse's error handler ------------------------------------------------------------------------------------------

def store_job_error(job, exc_type, exc_value, traceback):
    """notsobot's `store_job_error`, pushed as the worker's exception handler (it runs in the horse, before rq stores
    the failed result): the conversion's `error`, and the job's meta for the failure reason."""
    error = None
    if isinstance(exc_value, ApiError):
        error = exc_value
    elif isinstance(exc_value, JobTimeoutException):
        error = convert_jobs.timeout_error(job)
    exception = None
    if error is None and exc_type is not None:
        # a crash: its type and message for staff, never for the caller (§0)
        exception = {'type': exc_type.__name__, 'module': exc_type.__module__, 'message': str(exc_value)[:4000]}
        log.error('job %s crashed: %s', job.id, json.dumps(exception))
    try:
        convert_jobs.save_failure(job, error if error is not None else errors.conversion_failed('internal'))
    except Exception:
        log.exception('could not save the error of job %s', job.id)
    try:
        job.get_meta(refresh=True)
        if error is not None:
            job.meta['error'] = errors.conversion_error(error)
        elif exception is not None:
            job.meta['exception'] = exception
        job.save_meta()
    except Exception:
        log.exception('could not store the error of job %s', job.id)
    return True


# --- failure reasons (notsobot's get_job_failure_reason) ------------------------------------------------------------

def failure_reason(job, duration, status=None) -> Optional[str]:
    """Why a job didn't finish: `cancelled` (stopped or cancelled), `killed_at_timeout`, `killed_<SIGNAL>`,
    `work_horse_lost`, the saved exception's `package.Type`, or the ApiError's code. None when it finished."""
    if status == JobStatus.FINISHED:
        return None
    if status in (JobStatus.STOPPED, JobStatus.CANCELED):
        return 'cancelled'
    try:
        meta = job.get_meta(refresh=True)
    except Exception:
        meta = {}
    code = (meta.get('error') or {}).get('code')
    if code:
        return code
    try:
        result = job.latest_result()
        exc_string = (result and result.exc_string) or ''
    except Exception:
        return 'result_unreadable'
    match = WORK_HORSE_KILLED.search(exc_string)
    if match:
        if job.timeout and job.timeout <= duration:
            return 'killed_at_timeout'
        if match.group(1) == 'None':
            return 'work_horse_lost'
        if match.group(2):
            try:
                return 'killed_' + signal.Signals(int(match.group(2))).name
            except ValueError:
                return 'killed_signal_' + match.group(2)
        return 'work_horse_exited'
    name = saved_exception_name(meta.get('exception') or {})
    if name is not None:
        return name
    return 'no_result' if not exc_string else 'unknown'


def saved_exception_name(exception):
    """`package.Type` (a builtin's alone) of what `store_job_error` saved."""
    name, module = exception.get('type'), exception.get('module')
    if not name or not EXCEPTION_NAME.fullmatch(name):
        return None
    if not module or module == 'builtins':
        return name
    return '{}.{}'.format(module.split('.')[0], name)


def outcome(reason):
    """(result, detail) for the metrics: finished; timeout or error (an ApiError, its code); cancelled; or failed
    (a crash or a killed horse, its reason)."""
    if reason is None:
        return 'finished', None
    if reason == 'cancelled':
        return 'cancelled', reason
    if reason in ('CONVERSION_TIMEOUT', 'killed_at_timeout'):
        return 'timeout', reason
    if reason.isupper():
        return 'error', reason
    return 'failed', reason


# --- metrics (notsobot's record_job) ----------------------------------------------------------------------------------

def bucket_field(name, queue, buckets, value):
    index = next((i for i, bucket in enumerate(buckets) if value <= bucket), None)
    return '{}:{}:le_{}'.format(name, queue, 'inf' if index is None else '{:g}'.format(buckets[index]))


def record_job(connection, queue, result, detail, duration, wait, cpu_ms):
    """Counters in the Redis hash `filesgg:metrics:jobs`, one HINCRBYFLOAT per field (notsobot's `metrics:totals`),
    in the parent, so killed and timed-out jobs count too. Fields, all cumulative since Redis started:

        jobs:<queue>:<result>              jobs by result: finished, error, timeout, cancelled, failed
        errors:<queue>:<code>              error and timeout results by error code
        failures:<queue>:<reason>          failed and cancelled results by failure reason
        duration:<queue>:le_<s>            how long the horse ran, per bucket (not cumulative; le_inf is the rest)
        duration_sum:<queue>               ... and their sum in seconds
        wait:<queue>:le_<s>, wait_sum:<queue>   time in the queue before a worker took it, the same way
        cpu_ms_sum:<queue>                 CPU charged (the horse and its tools)
    """
    increments = {'jobs:{}:{}'.format(queue, result): 1}
    if detail is not None:
        kind = 'errors' if result in ('error', 'timeout') else 'failures'
        increments['{}:{}:{}'.format(kind, queue, detail)] = 1
    increments[bucket_field('duration', queue, DURATION_BUCKETS, duration)] = 1
    increments['duration_sum:' + queue] = round(duration, 3)
    if wait is not None and wait >= 0:
        increments[bucket_field('wait', queue, WAIT_BUCKETS, wait)] = 1
        increments['wait_sum:' + queue] = round(wait, 3)
    increments['cpu_ms_sum:' + queue] = cpu_ms
    pipeline = connection.pipeline(transaction=False)
    for field, value in increments.items():
        pipeline.hincrbyfloat(METRICS_KEY, field, value)
    pipeline.execute()


# --- the parent's finishing (§3.3) ------------------------------------------------------------------------------------

def finish_conversion(conn, job, conversion_id, reason, cpu_ms):
    """After the horse: a conversion still `queued` or `running` is `failed` with the error its end calls for;
    `failure_reason` is saved for any that didn't succeed; its CPU is charged (killed horses too)."""
    row = conn.execute('SELECT status, failure_reason, queue FROM conversions WHERE id = %s',
                       (conversion_id,)).fetchone()
    if row is not None:
        status, saved, queue = row
        if status in ('queued', 'running'):
            reason = reason or 'unknown'
            if reason in ('killed_at_timeout', 'killed_SIGXCPU', 'CONVERSION_TIMEOUT'):
                error = convert_jobs.timeout_error(job, {'queue': queue})
            else:
                error = errors.conversion_failed('internal')
            conn.execute(
                "UPDATE conversions SET status = 'failed', error = %s::jsonb, failure_reason = %s, stage = NULL, "
                "finished_at = now() WHERE id = %s AND status IN ('queued', 'running')",
                (json.dumps(errors.conversion_error(error)), reason, conversion_id))
        elif status == 'cancelled' and saved is None:
            conn.execute('UPDATE conversions SET failure_reason = %s WHERE id = %s AND failure_reason IS NULL',
                         ('cancelled', conversion_id))
        elif status == 'failed' and saved is None:
            conn.execute('UPDATE conversions SET failure_reason = %s WHERE id = %s AND failure_reason IS NULL',
                         (reason or 'unknown', conversion_id))
    conversions.charge_usage(conn, conversion_id, cpu_ms)


def finish_preview(conn, hash_id, reason):
    """A preview whose horse ended without deciding is `failed`."""
    if reason is not None:
        conn.execute("UPDATE file_hashes SET preview_state = 'failed' WHERE id = %s AND preview_state = 'queued'",
                     (hash_id,))


def _cpu_seconds(usage):
    return usage.ru_utime + usage.ru_stime


# --- the classes ------------------------------------------------------------------------------------------------------

class ConvertJob(Job):
    def _execute(self):
        """notsobot's `NotSoJob._execute`: a coroutine runs on a plain new loop, so when the job raises (its
        JobTimeoutException too) the exception goes straight out and the horse exits, instead of `asyncio.run`'s
        shutdown waiting on the default executor's threads until rq kills it at timeout + 60 s."""
        if not self.func:
            raise ValueError('Cannot execute job: function is None')
        result = self.func(*self.args, **self.kwargs)
        if asyncio.iscoroutine(result):
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            return loop.run_until_complete(result)
        return result


class ConvertWorker(Worker):
    def __init__(self, *args, **kwargs):
        # `rq worker-pool` passes its own (`Job`) along
        kwargs['job_class'] = ConvertJob
        super().__init__(*args, **kwargs)
        self.push_exc_handler(store_job_error)
        self._job_directory = None
        self._last_horse = 0
        self._last_clean = 0.0
        # orphaned tools of a killed horse are re-parented to this process, so it reaps them and their CPU counts
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            log.warning('could not become a child subreaper: killed tools would not be charged')

    # --- in the horse ---

    def perform_job(self, job, queue, *args, **kwargs):
        # rq 3 passes the job's `execution` too, forwarded as is. Runs in the forked horse (one job per process): its
        # directory goes when the job ends, and so does its database connection.
        # Each horse leases its own Snowflake node (PLAN.md §2.1 item 2) for the rows it creates (files, hashes,
        # albums). Without one, Snowflake falls back to a fixed node id shared by every horse on every host, each
        # starting its sequence afresh, so two horses writing in the same millisecond made the same id. A lease
        # can't be inherited across the fork (`current_node_id` refuses it), so it's taken here, in the horse.
        from utils.snowflake_nodes import start_process_lease, stop_process_lease
        with convert_jobs.job_directory(self._job_directory):
            start_process_lease()
            try:
                return super().perform_job(job, queue, *args, **kwargs)
            finally:
                stop_process_lease()
                convert_jobs.close_connection()

    # --- in the worker ---

    def fork_work_horse(self, job, queue):
        super().fork_work_horse(job, queue)
        self._last_horse = self._horse_pid

    def dequeue_job_and_maintain_ttl(self, timeout, max_idle_time=None):
        self.clean_temp()
        return super().dequeue_job_and_maintain_ttl(timeout, max_idle_time)

    def clean_temp(self, now=None):
        """notsobot's tasker `TempCleaner`, without a separate service: what's in CONVERT_TMP_DIR idle longer than
        the longest time limit plus 5 minutes (a worker killed mid-job left it). At most once a minute."""
        now = time.time() if now is None else now
        if now - self._last_clean < TMP_CLEAN_EVERY:
            return
        self._last_clean = now
        try:
            entries = os.listdir(TMP_DIR)
        except OSError:
            return
        for name in entries:
            if not name.startswith(TMP_PREFIX):
                continue
            path = os.path.join(TMP_DIR, name)
            try:
                idle = now - os.stat(path).st_mtime
            except OSError:
                continue
            if idle > TMP_MAX_IDLE:
                shutil.rmtree(path, ignore_errors=True)

    def _reap_group(self, pgid):
        """Kill what's left of the horse's process group (its tools, re-parented here) and reap it, so its CPU time
        is in this process's RUSAGE_CHILDREN."""
        if not pgid:
            return
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        deadline = time.monotonic() + REAP_WAIT
        while True:
            try:
                pid, _ = os.waitpid(-pgid, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                if time.monotonic() > deadline:
                    log.warning('processes of horse %s are still running', pgid)
                    return
                time.sleep(0.02)

    def execute_job(self, job, queue):
        # this runs in the worker that forks and watches the horse, so it sees timeouts and killed horses too
        started = time.time()
        enqueued = convert_jobs.timestamp(job.enqueued_at)
        wait = started - enqueued if enqueued is not None else None
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        self._job_directory = tempfile.mkdtemp(prefix=TMP_PREFIX, dir=TMP_DIR)
        self._last_horse = 0
        try:
            return super().execute_job(job, queue)
        finally:
            directory, self._job_directory = self._job_directory, None
            self._reap_group(self._last_horse)
            shutil.rmtree(directory, ignore_errors=True)
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu_ms = int(round((_cpu_seconds(after) - _cpu_seconds(before)) * 1000))
            self.finish(job, queue, time.time() - started, wait, cpu_ms)

    def finish(self, job, queue, duration, wait, cpu_ms):
        reason = None
        try:
            reason = failure_reason(job, duration, job.get_status(refresh=True))
        except Exception:
            reason = 'result_unreadable'
        target = convert_jobs.job_target(job)
        if target is not None:
            try:
                with db.connect() as conn:
                    if target[0] == 'conversion':
                        finish_conversion(conn, job, target[1], reason, cpu_ms)
                    else:
                        finish_preview(conn, target[1], reason)
            except Exception:
                log.exception('could not finish job %s', job.id)
        result, detail = outcome(reason)
        try:
            record_job(self.connection, queue.name, result, detail, duration, wait, cpu_ms)
        except Exception:
            log.exception('could not record metrics for job %s', job.id)
        log.info('job %s', json.dumps({
            'job': job.id, 'queue': queue.name, 'result': result, 'detail': detail,
            'duration': round(duration, 3), 'wait': round(wait, 3) if wait is not None else None, 'cpu_ms': cpu_ms,
        }))
