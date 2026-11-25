"""Scheduled tasks that run once across all worker replicas (PLAN.md §2.1 item 4).

Each run of a task takes `pg_try_advisory_lock` for that task; replicas that
do not get the lock skip it. Under the lock, the task's last finish time is
read from a marker row in `jobs` (kind `scheduled:<name>`, on the `scheduler`
queue that no worker may claim from, and always with `done_at` set). The task runs only if its interval has
passed, so replicas whose ticks are not aligned still run it once per interval.

The scheduler keeps one synchronous psycopg 3 connection (autocommit) for its
session-level advisory locks; tasks receive nothing and use their own.
"""

import logging
import time
import traceback

from utils import metrics

log = logging.getLogger(__name__)

DEFAULT_CHECK_EVERY = 15  # seconds between checks of one task in a replica


class ScheduledTask:
    def __init__(self, name, interval, func):
        self.name = name
        self.interval = interval
        self.func = func
        self.next_check = 0.0

    @property
    def lock_key(self):
        return 'scheduler:' + self.name

    @property
    def marker_kind(self):
        return 'scheduled:' + self.name


class Scheduler:
    def __init__(self, conn, check_every=DEFAULT_CHECK_EVERY):
        self.conn = conn
        self.check_every = check_every
        self.tasks = {}

    def register(self, name, interval, func=None):
        def decorator(func):
            self.tasks[name] = ScheduledTask(name, interval, func)
            return func
        return decorator(func) if func is not None else decorator

    def tick(self):
        """Run every task that is due and whose lock this replica gets.
        Returns the names of the tasks that ran."""
        ran = []
        now = time.monotonic()
        for task in list(self.tasks.values()):
            if now < task.next_check:
                continue
            task.next_check = now + min(task.interval, self.check_every)
            try:
                if self.run_task(task):
                    ran.append(task.name)
            except Exception:
                log.exception('scheduled task %s failed', task.name)
        return ran

    def run_task(self, task):
        conn = self.conn
        locked = conn.execute('SELECT pg_try_advisory_lock(hashtext(%s))', (task.lock_key,)).fetchone()[0]
        if not locked:
            return False
        try:
            due = conn.execute(
                'SELECT NOT EXISTS (SELECT 1 FROM jobs WHERE kind = %s '
                'AND done_at > now() - make_interval(secs => %s::float8))',
                (task.marker_kind, task.interval),
            ).fetchone()[0]
            if not due:
                return False

            try:
                task.func()
            except Exception as error:
                self._record(task, error='{}: {}\n{}'.format(
                    type(error).__name__, error, traceback.format_exc()))
                raise
            self._record(task)
            metrics.set_gauge('filesgg_scheduled_task_last_success_timestamp_seconds', time.time(),
                              {'task': task.name})
            return True
        finally:
            if not conn.closed:
                conn.execute('SELECT pg_advisory_unlock(hashtext(%s))', (task.lock_key,))

    def _record(self, task, error=None):
        conn = self.conn
        if error is None:
            sql = ('UPDATE jobs SET done_at = now(), attempts = attempts + 1, last_error = NULL '
                   'WHERE kind = %s')
            params = (task.marker_kind,)
        else:
            sql = 'UPDATE jobs SET last_error = %s WHERE kind = %s'
            params = (error[:10000], task.marker_kind)
        if conn.execute(sql, params).rowcount == 0:
            # first run: create the marker. If the task failed, its done_at is
            # -infinity so the task stays due.
            conn.execute(
                "INSERT INTO jobs (kind, queue, run_at, attempts, max_attempts, done_at, last_error) "
                "VALUES (%s, 'scheduler', now(), 1, 1, "
                "CASE WHEN %s::text IS NULL THEN now() ELSE '-infinity'::timestamptz END, %s)",
                (task.marker_kind, error, error),
            )
