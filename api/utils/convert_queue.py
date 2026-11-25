"""The conversion queues on RQ + Redis (contract milestone-5 §3.1, §3.3, §8, decision 10, decision 17).

- **Queues by tier:** `convert_premium`, `convert_member`, `convert_anonymous` and `convert_previews`. `POST
  /conversions` picks the queue from the caller (`get_limits().conversion_queue`); nothing else does.
- **Enqueue after commit:** the `conversions` row is committed first, then its job is enqueued with the job id
  `conversion-<id>` and `job_timeout` = the conversion's `time_limit`. A failed enqueue is logged and left to the
  sweeper (`convert_sweep`, utils/conversions.py `sweep`), which never enqueues a job id that exists.
- **By dotted path:** the API enqueues `jobs.convert.run` and `jobs.convert.preview` as strings, so it never imports
  the converter's code.
- **Queue position** (notsobot's `get_job_queue_position`): `LPOS` of the job in its queue, plus the length of every
  queue its worker pool drains first (`convert_member` jobs count `convert_premium`).
- **Cancel** (notsobot's `stop_job`): `send_stop_job_command` when it's started, `job.cancel()` when it's queued.

Every function here is synchronous on the sync Redis client (`utils.redis.get_sync()`); the API calls them from
executor threads (`in_executor`), as notsobot's `enqueue_job` does.
"""

import asyncio
import functools
import logging
import time

from datetime import timezone

log = logging.getLogger(__name__)

PREMIUM = 'convert_premium'
MEMBER = 'convert_member'
ANONYMOUS = 'convert_anonymous'
PREVIEWS = 'convert_previews'
CONVERSION_QUEUES = (PREMIUM, MEMBER, ANONYMOUS)
QUEUES = CONVERSION_QUEUES + (PREVIEWS,)
# the conversion object's `queue` (§8)
QUEUE_NAMES = {PREMIUM: 'premium', MEMBER: 'member', ANONYMOUS: 'anonymous'}
# §3.1: what each queue's jobs wait behind besides their own queue: the queues the worker pools that take this queue
# drain first (`converter-premium` takes premium then member; `converter` member then anonymous)
AHEAD = {PREMIUM: (), MEMBER: (PREMIUM,), ANONYMOUS: (MEMBER,), PREVIEWS: ()}

RUN = 'jobs.convert.run'
PREVIEW = 'jobs.convert.preview'
# notsobot's: the record is the Postgres row, not the RQ result (§3.3)
RESULT_TTL = 120
FAILURE_TTL = 120
# a document preview: the office path's 120 s, plus downloading, the thumbnails and storing (§9.1)
PREVIEW_TIME_LIMIT = 300


def redis():
    from utils.redis import get_sync
    return get_sync()


# the contract's `conversion:<id>` and `preview:<hash id>`, with a dash: rq 3.0 accepts only letters, digits,
# underscores and dashes in a job id
def conversion_job_id(conversion_id):
    return 'conversion-{}'.format(conversion_id)


def preview_job_id(hash_id):
    return 'preview-{}'.format(hash_id)


def _queue(name, connection=None):
    from rq import Queue
    return Queue(name, connection=connection or redis())


def job_exists(job_id, connection=None):
    from rq.job import Job
    return Job.exists(job_id, connection=connection or redis())


def enqueue_conversion(conversion_id, queue, time_limit, connection=None):
    """Put `jobs.convert.run(conversion_id)` on `queue`. Call it after the row is committed. Returns True when it
    was enqueued; a failure is logged (the sweeper enqueues it later) and returns False."""
    try:
        _queue(queue, connection).enqueue(
            RUN, conversion_id, job_id=conversion_job_id(conversion_id), job_timeout=int(time_limit),
            result_ttl=RESULT_TTL, failure_ttl=FAILURE_TTL)
        return True
    except Exception:
        log.exception('could not enqueue conversion %s; the sweeper will', conversion_id)
        return False


def enqueue_preview(hash_id, connection=None):
    """`jobs.convert.preview(hash_id)` on `convert_previews` (§9.1), after `preview_state = 'queued'` was committed."""
    try:
        _queue(PREVIEWS, connection).enqueue(
            PREVIEW, hash_id, job_id=preview_job_id(hash_id), job_timeout=PREVIEW_TIME_LIMIT,
            result_ttl=RESULT_TTL, failure_ttl=FAILURE_TTL)
        return True
    except Exception:
        log.exception('could not enqueue the preview of hash %s; the sweeper will', hash_id)
        return False


def positions(jobs, connection=None):
    """{job id: jobs ahead} for [(job id, queue)], in one Redis pipeline: LPOS in its own queue, plus the LLEN of
    every queue its pool drains first (§8). A job that isn't in its queue (taken, or lost) has 0 ahead."""
    if not jobs:
        return {}
    connection = connection or redis()
    pipe = connection.pipeline(transaction=False)
    for job_id, queue in jobs:
        pipe.lpos(_queue(queue, connection).key, job_id)
        for earlier in AHEAD.get(queue, ()):
            pipe.llen(_queue(earlier, connection).key)
    results = iter(pipe.execute())
    out = {}
    for job_id, queue in jobs:
        index = next(results)
        ahead = sum(int(next(results) or 0) for _ in AHEAD.get(queue, ()))
        out[job_id] = 0 if index is None else int(index) + ahead
    return out


def queue_lengths(queues, connection=None):
    """{queue: LLEN} in one pipeline."""
    connection = connection or redis()
    pipe = connection.pipeline(transaction=False)
    for queue in queues:
        pipe.llen(_queue(queue, connection).key)
    return dict(zip(queues, (int(n or 0) for n in pipe.execute())))


def cancel(job_id, connection=None):
    """Stop a job (notsobot's `stop_job`): the stop command when a horse is running it, `cancel()` while it waits.
    Returns what was done: `stopped`, `cancelled` or None (no such job)."""
    from rq.command import send_stop_job_command
    from rq.exceptions import InvalidJobOperation, NoSuchJobError
    from rq.job import Job, JobStatus
    connection = connection or redis()
    try:
        job = Job.fetch(job_id, connection=connection)
    except NoSuchJobError:
        return None
    status = job.get_status(refresh=False)
    try:
        if status == JobStatus.STARTED:
            send_stop_job_command(connection, job_id)
            return 'stopped'
        job.cancel()
        return 'cancelled'
    except (InvalidJobOperation, NoSuchJobError):
        return None


def queue_health(connection=None):
    """The admin summary's conversion queues (§3.3): each queue's length and its oldest job's age in seconds."""
    from rq.job import Job
    connection = connection or redis()
    out = {}
    lengths = queue_lengths(QUEUES, connection)
    for queue in QUEUES:
        oldest = None
        head = connection.lindex(_queue(queue, connection).key, 0)
        if head is not None:
            job_id = head.decode() if isinstance(head, bytes) else head
            try:
                enqueued_at = Job.fetch(job_id, connection=connection).enqueued_at
            except Exception:
                enqueued_at = None
            if enqueued_at is not None:
                if enqueued_at.tzinfo is None:
                    enqueued_at = enqueued_at.replace(tzinfo=timezone.utc)
                oldest = max(0, int(time.time() - enqueued_at.timestamp()))
        out[queue] = {'length': lengths[queue], 'oldest_seconds': oldest}
    return out


METRICS_KEY = 'filesgg:metrics:jobs'


def admin_health(connection=None):
    """The admin summary's conversion health (§3.3, milestone-4 §9.2): each queue's length and oldest job's age, and
    the job counters the worker class keeps in `filesgg:metrics:jobs` (read as they are: numbers where they parse).
    None when Redis can't be read: the summary still answers."""
    try:
        connection = connection or redis()
        queues = queue_health(connection)
        raw = connection.hgetall(METRICS_KEY) or {}
    except Exception:
        log.warning('could not read the conversion queues for the admin summary', exc_info=True)
        return None
    jobs = {}
    for field, value in raw.items():
        field = field.decode('utf-8', 'replace') if isinstance(field, bytes) else str(field)
        value = value.decode('utf-8', 'replace') if isinstance(value, bytes) else value
        try:
            number = float(value)
            jobs[field] = int(number) if number.is_integer() else number
        except (TypeError, ValueError):
            jobs[field] = value
    return {'queues': queues, 'jobs': jobs}


async def in_executor(func, *args, **kwargs):
    """One of these (blocking Redis) from the API, on the default executor."""
    return await asyncio.get_running_loop().run_in_executor(None, functools.partial(func, *args, **kwargs))
