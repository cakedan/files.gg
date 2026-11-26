"""files.gg's Prometheus metrics (contract milestone-7 §4.2, decision 5), notsobot.api's `metrics.py`: counters and
histogram buckets live in the Redis hash `filesgg:metrics`, so every API worker, the Postgres-queue workers and RQ's
forked horses all count into one place without `prometheus_client`'s multiprocess mode. `GET /internal/metrics`
(views/internal.py) renders them with `render()`.

    incr(name, labels=None, value=1)        a counter
    observe(name, seconds, labels=None)     a histogram, with its metric's fixed buckets
    set_gauge(name, value, labels=None)     a gauge (the last value written wins)

Each call is one Redis pipeline (HINCRBYFLOAT, HSET for gauges), fire-and-forget: from a thread without an event loop
it's written there and then on the sync client; on the API's event loop it's a task on the async client, so a handler
never waits for it; on any other event loop (a script's `asyncio.run`) it's written from an executor thread on the sync
client, since the async client belongs to the API's loop. Nothing here ever raises into the caller. While Redis fails,
increments are kept in this process (`MAX_CARRY` series at most) and added to the next write that goes through, so a
short outage loses no counts; writes are skipped for `BACKOFF_SECONDS` after a failure, so an outage never makes every
request wait on Redis.

Hash fields are JSON `[name, [label values]]`, or `[name, [label values], part]` for a histogram's bucket index and
`"sum"` (notsobot's `series_key`). Every metric is declared in `METRICS` with its labels, and every label with the
values it may take: a fixed set, a shape (error codes) or a registry (`allow`: the app's route patterns and the
rate-limit scopes). Any other value is recorded as `other`, so no raw path, vanity, id, email or IP ever becomes a
label. An unknown metric, or one used as the wrong kind, is logged and dropped.

Rendered on top, read when Prometheus scrapes (`render`):
- the conversion workers' `filesgg:metrics:jobs` (convert_worker.py `record_job`), re-exported as
  `filesgg_conversion_job*`;
- pending scans (count and oldest, from Postgres), the conversion queues (length and oldest,
  `convert_queue.queue_health`) and the API's Postgres pools: each API worker writes its pool's numbers to
  `filesgg:metrics:pools` every `POOL_REPORT_INTERVAL` seconds (`report_pool`), and the scrape adds up the fresh ones.
"""

import asyncio
import json
import logging
import math
import os
import re
import socket
import threading
import time

from bisect import bisect_left
from dataclasses import dataclass

from utils import redis as redis_clients

log = logging.getLogger(__name__)

REDIS_KEY = 'filesgg:metrics'
POOLS_KEY = 'filesgg:metrics:pools'
CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'
OTHER = 'other'
UNMATCHED = 'unmatched'

# increments kept in the process while Redis fails, and how long writes are skipped after a failure
MAX_CARRY = 5000
BACKOFF_SECONDS = 5.0
# each API worker's pool numbers: written this often, ignored (and removed) once this old
POOL_REPORT_INTERVAL = 10
POOL_STALE_AFTER = 35

HTTP_DURATION_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300)
SCAN_DURATION_BUCKETS = (0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800)
# convert_worker.py's `record_job` buckets (it imports them from here)
CONVERSION_DURATION_BUCKETS = (0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800)
CONVERSION_WAIT_BUCKETS = (0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 600, 3600)


# --- label values ----------------------------------------------------------------------------------------------

METHODS = frozenset(('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'))
STATUS_CLASSES = frozenset(('1xx', '2xx', '3xx', '4xx', '5xx'))
UPLOAD_KINDS = frozenset(('single', 'chunked'))
UPLOADERS = frozenset(('signed_in', 'guest', 'key'))
SCAN_STATES = frozenset(('pending', 'passed', 'flagged', 'held', 'blocked', 'failed'))
# file_hashes.scan_reason (migrations/0003), and `none` for a scan without one
SCAN_REASONS = frozenset(('none', 'csam_match', 'hash_list', 'pdq_near_match', 'malware', 'unwanted_software',
                          'blocked_type', 'archive_bomb', 'pdf_dangerous', 'pdf_javascript', 'polyglot_archive',
                          'web_risk'))
# utils/mail.py and views/reports.py
EMAIL_TAGS = frozenset(('auth-verify', 'auth-forgot', 'auth-password-changed', 'auth-email-changed',
                        'auth-discord-linked', 'auth-deletion-requested', 'auth-deletion-cancelled',
                        'auth-account-deleted', 'domain-status', 'premium-changed', 'report-update'))
EMAIL_OUTCOMES = frozenset(('sent', 'failed', 'unconfigured'))
TURNSTILE_ACTIONS = frozenset(('upload', 'unlock', 'view', 'report', 'convert', 'login', 'register', 'forgot',
                               'reset'))
# passed; failed (siteverify said no); mismatch (another action or hostname); missing (no usable token);
# error (siteverify unreachable); unconfigured (no secret)
TURNSTILE_OUTCOMES = frozenset(('passed', 'failed', 'mismatch', 'missing', 'error', 'unconfigured'))
MATCHERS = frozenset(('photodna', 'standin'))
MATCHER_OUTCOMES = frozenset(('match', 'no_match', 'error'))
FAIL_MODES = frozenset(('open', 'closed'))
REDIS_CLIENTS = frozenset(('ratelimit', 'convert_queue', 'metrics'))
CONVERSION_QUEUES = frozenset(('convert_premium', 'convert_member', 'convert_anonymous', 'convert_previews'))
CONVERSION_RESULTS = frozenset(('finished', 'error', 'timeout', 'cancelled', 'failed'))
COLLECTORS = frozenset(('redis', 'jobs', 'scans', 'conversion_queues', 'db_pools'))

# an API error code (UPPER_SNAKE, utils/errors.py), never anything a caller typed
CODE = re.compile(r'[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*')
# a scheduled task's name (jobs/tasks.py)
TASK = re.compile(r'[a-z][a-z0-9_]{0,63}')
# a conversion's error code or failure reason (convert_worker.py: codes, `killed_SIGKILL`, exception names)
DETAIL = re.compile(r'[A-Za-z_][A-Za-z0-9_.]{0,99}')

# values that are only known at runtime: the app's route patterns (app startup) and the rate-limit scopes
# (utils/ratelimit.py, as its limits are declared)
_registry = {'route': set(), 'scope': set()}


def allow(kind, *values):
    """Add allowed values to a registry label (`route`, `scope`)."""
    _registry[kind].update(str(value) for value in values)


def allow_routes(app):
    """Every route pattern of `app` (`/files/<vanity:path>`), as `route_label` gives them."""
    allow('route', *(route_pattern(route) for route in app.router.routes))


def route_pattern(route):
    return '/' + route.path.lstrip('/')


def _registered(kind, *always):
    return lambda value: value in _registry[kind] or value in always


def _matches(pattern, max_length):
    return lambda value: len(value) <= max_length and pattern.fullmatch(value) is not None


ROUTE = _registered('route', UNMATCHED)
SCOPE = _registered('scope')
ERROR_CODE = _matches(CODE, 64)
JOB_DETAIL = _matches(DETAIL, 100)
TASK_NAME = _matches(TASK, 64)


# --- definitions -----------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Metric:
    kind: str  # counter | gauge | histogram
    help: str
    # (label name, allowed values: a frozenset or a predicate)
    labels: tuple = ()
    buckets: tuple = ()

    @property
    def label_names(self):
        return tuple(name for name, _ in self.labels)


def counter(help, *labels):
    return Metric('counter', help, labels)


def gauge(help, *labels):
    return Metric('gauge', help, labels)


def histogram(help, buckets, *labels):
    return Metric('histogram', help, labels, buckets)


METRICS = {
    # HTTP (the middleware below)
    'filesgg_http_requests_total': counter(
        'API requests by route pattern, method and status class (`unmatched` when no route matched)',
        ('route', ROUTE), ('method', METHODS), ('status', STATUS_CLASSES)),
    'filesgg_http_request_duration_seconds': histogram(
        'How long the API took to answer, by route pattern (uploads include reading the body)',
        HTTP_DURATION_BUCKETS, ('route', ROUTE)),

    # uploads (views/files.py, views/uploads.py, jobs/finalize.py)
    'filesgg_uploads_total': counter(
        'Files uploaded: single requests, and chunked uploads once finalized', ('kind', UPLOAD_KINDS),
        ('uploader', UPLOADERS)),
    'filesgg_upload_bytes_total': counter(
        'Bytes of the files uploaded', ('kind', UPLOAD_KINDS), ('uploader', UPLOADERS)),
    'filesgg_upload_refusals_total': counter(
        'Upload requests refused, and chunked uploads failed at finalizing, by error code', ('kind', UPLOAD_KINDS),
        ('code', ERROR_CODE)),

    # scans (safety/scan.py)
    'filesgg_scans_total': counter(
        'Scans finished, by the state they left the hash in and its reason', ('state', SCAN_STATES),
        ('reason', SCAN_REASONS)),
    'filesgg_scan_seconds': histogram('How long a first scan took, from loading the hash to its result',
                                      SCAN_DURATION_BUCKETS),

    # rate limits (utils/ratelimit.py)
    'filesgg_ratelimit_refusals_total': counter('Requests refused by a rate limit, by scope', ('scope', SCOPE)),
    'filesgg_ratelimit_unavailable_total': counter(
        "Rate-limit checks Redis couldn't answer: let through (open) or answered 503 RATE_LIMIT_UNAVAILABLE (closed)",
        ('fail', FAIL_MODES)),

    # outside services
    'filesgg_emails_total': counter('Account emails sent through Cloudflare Email Service, by tag and outcome', ('tag', EMAIL_TAGS),
                                    ('outcome', EMAIL_OUTCOMES)),
    'filesgg_turnstile_verifications_total': counter(
        'Turnstile tokens checked, by action and outcome', ('action', TURNSTILE_ACTIONS),
        ('outcome', TURNSTILE_OUTCOMES)),
    'filesgg_csam_matcher_calls_total': counter(
        'Calls to the CSAM hash matcher, by outcome (error: unavailable, the hash stays pending)',
        ('matcher', MATCHERS), ('outcome', MATCHER_OUTCOMES)),
    # the scheduler (jobs/scheduler.py)
    'filesgg_scheduled_task_last_success_timestamp_seconds': gauge(
        'When a scheduled task last finished without an error, as a unix timestamp', ('task', TASK_NAME)),
    'filesgg_redis_errors_total': counter(
        'Redis commands that failed, by the client that sent them (counted in the process, written once Redis is back)',
        ('client', REDIS_CLIENTS)),
}

# read when Prometheus scrapes (`render`), never written to Redis
COLLECTED = {
    'filesgg_conversion_jobs_total': counter(
        'Conversion and preview jobs finished, by queue and result', ('queue', CONVERSION_QUEUES),
        ('result', CONVERSION_RESULTS)),
    'filesgg_conversion_job_errors_total': counter(
        'Jobs that ended with an error or timed out, by error code', ('queue', CONVERSION_QUEUES),
        ('code', JOB_DETAIL)),
    'filesgg_conversion_job_failures_total': counter(
        'Jobs that failed or were cancelled, by reason', ('queue', CONVERSION_QUEUES), ('reason', JOB_DETAIL)),
    'filesgg_conversion_job_duration_seconds': histogram(
        'How long a job ran', CONVERSION_DURATION_BUCKETS, ('queue', CONVERSION_QUEUES)),
    'filesgg_conversion_job_wait_seconds': histogram(
        'How long a job waited in its queue', CONVERSION_WAIT_BUCKETS, ('queue', CONVERSION_QUEUES)),
    'filesgg_conversion_job_cpu_seconds_total': counter(
        'CPU used by the jobs and every tool they ran', ('queue', CONVERSION_QUEUES)),
    'filesgg_conversion_queue_length': gauge('Jobs waiting in a conversion queue', ('queue', CONVERSION_QUEUES)),
    'filesgg_conversion_queue_oldest_seconds': gauge(
        "How long the queue's oldest job has waited (0 when empty)", ('queue', CONVERSION_QUEUES)),
    'filesgg_scans_pending': gauge('Hashes waiting for their first scan (not held for staff)'),
    'filesgg_scans_pending_oldest_seconds': gauge(
        'How long the oldest hash has waited for its first scan (0 when none): its files are unpublished meanwhile'),
    'filesgg_scans_stuck': gauge('Pending hashes held for staff after their scan kept failing'),
    'filesgg_db_pool_connections_in_use': gauge('Postgres connections the API workers have checked out'),
    'filesgg_db_pool_connections': gauge('Postgres connections the API workers hold, in use or idle'),
    'filesgg_db_pool_connections_max': gauge("The API workers' pool sizes added up"),
    'filesgg_db_pool_requests_waiting': gauge('Requests in the API waiting for a Postgres connection'),
    'filesgg_db_pool_processes': gauge('API worker processes that reported their pool'),
    'filesgg_metrics_collector_up': gauge('Whether a part of this scrape could be read (1) or not (0)',
                                          ('collector', COLLECTORS)),
}


# --- recording -----------------------------------------------------------------------------------------------------

def series_key(name, values, part=None):
    return json.dumps([name, values] if part is None else [name, values, part], separators=(',', ':'))


def label_values(metric, labels):
    """The metric's label values in order: each allowed one as given, anything else `other`."""
    labels = labels or {}
    values = []
    for name, allowed in metric.labels:
        value = labels.get(name)
        value = '' if value is None else str(value)
        ok = value in allowed if isinstance(allowed, frozenset) else allowed(value)
        values.append(value if ok else OTHER)
    return values


_warned = set()


def _definition(name, kind):
    metric = METRICS.get(name)
    if metric is None or metric.kind != kind:
        if name not in _warned:
            _warned.add(name)
            log.warning('dropping metric %r: not a declared %s', name, kind)
        return None
    return metric


def incr(name, labels=None, value=1):
    """Add `value` to a counter."""
    try:
        metric = _definition(name, 'counter')
        if metric is not None:
            _send({series_key(name, label_values(metric, labels)): float(value)})
    except Exception:
        log.exception('could not record %s', name)


def observe(name, seconds, labels=None):
    """One observation of a histogram (in its metric's fixed buckets)."""
    try:
        metric = _definition(name, 'histogram')
        if metric is not None:
            seconds = float(seconds)
            values = label_values(metric, labels)
            _send({series_key(name, values, bisect_left(metric.buckets, seconds)): 1.0,
                   series_key(name, values, 'sum'): seconds})
    except Exception:
        log.exception('could not record %s', name)


def set_gauge(name, value, labels=None):
    """Set a gauge to `value`."""
    try:
        metric = _definition(name, 'gauge')
        if metric is not None:
            _send({}, {series_key(name, label_values(metric, labels)): float(value)})
    except Exception:
        log.exception('could not record %s', name)


_lock = threading.Lock()
_state = {'carry': {}, 'backoff_until': 0.0}
# the API's event loops (one per worker process; tests start more than one app), whose async Redis client the writes
# use (`init_app`)
_api_loops = set()
# the event loop's write tasks, kept until done (the loop only holds weak references)
_tasks = set()


def _send(increments, gauges=None):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is None:
        _write_sync(increments, gauges)
    elif loop in _api_loops:
        task = loop.create_task(_write_async(increments, gauges))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
    else:
        loop.run_in_executor(None, _write_sync, increments, gauges)


def _take(increments):
    """What to write now: these increments plus everything carried, or None while backing off (they're carried)."""
    with _lock:
        carry = _state['carry']
        if time.monotonic() < _state['backoff_until']:
            _carry(carry, increments)
            return None
        _state['carry'] = {}
    if carry:
        _carry(carry, increments)
        return carry
    return dict(increments)


def _carry(into, increments):
    for key, value in increments.items():
        if key in into:
            into[key] += value
        elif len(into) < MAX_CARRY:
            into[key] = value


def _failed(increments):
    with _lock:
        _state['backoff_until'] = time.monotonic() + BACKOFF_SECONDS
        _carry(_state['carry'], increments)
        _carry(_state['carry'], {series_key('filesgg_redis_errors_total', ['metrics']): 1.0})


def _write_sync(increments, gauges):
    increments = _take(increments)
    if increments is None:
        return
    try:
        pipeline = redis_clients.get_sync().pipeline(transaction=False)
        for key, value in increments.items():
            pipeline.hincrbyfloat(REDIS_KEY, key, value)
        if gauges:
            pipeline.hset(REDIS_KEY, mapping=gauges)
        pipeline.execute()
    except Exception as error:
        log.warning('could not write metrics: %r', error)
        _failed(increments)


async def _write_async(increments, gauges):
    increments = _take(increments)
    if increments is None:
        return
    try:
        async with redis_clients.get_async().pipeline(transaction=False) as pipeline:
            for key, value in increments.items():
                pipeline.hincrbyfloat(REDIS_KEY, key, value)
            if gauges:
                pipeline.hset(REDIS_KEY, mapping=gauges)
            await pipeline.execute()
    except Exception as error:
        log.warning('could not write metrics: %r', error)
        _failed(increments)


# --- the API: request middleware and the pool reporter ----------------------------------------------------------

def init_app(app):
    """The HTTP counters (every request, by route pattern, method and status class) and the pool reporter."""
    app.on_request(_request_started, priority=1000)
    app.on_response(_request_finished)

    @app.before_server_start
    async def start_metrics(app):
        allow_routes(app)
        loop = asyncio.get_running_loop()
        _api_loops.add(loop)
        app.ctx.pool_reporter = loop.create_task(report_pool(app.ctx.pool))

    @app.after_server_stop
    async def stop_metrics(app):
        task = getattr(app.ctx, 'pool_reporter', None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            app.ctx.pool_reporter = None
        _api_loops.discard(asyncio.get_running_loop())


async def _request_started(request):
    request.ctx.metrics_started = time.perf_counter()


async def _request_finished(request, response):
    record_request(request, getattr(response, 'status', 500))


def record_request(request, status):
    started = getattr(request.ctx, 'metrics_started', None)
    route = route_pattern(request.route) if request.route is not None else UNMATCHED
    incr('filesgg_http_requests_total', {'route': route, 'method': request.method,
                                         'status': '{}xx'.format(int(status) // 100)})
    if started is not None:
        observe('filesgg_http_request_duration_seconds', time.perf_counter() - started, {'route': route})


def pool_field():
    return '{}:{}'.format(socket.gethostname(), os.getpid())


async def report_pool(pool):
    """This worker's pool, every POOL_REPORT_INTERVAL seconds, until cancelled (then its entry is removed)."""
    field = pool_field()
    try:
        while True:
            stats = pool.get_stats()
            size, available = stats.get('pool_size', 0), stats.get('pool_available', 0)
            entry = json.dumps({'in_use': max(size - available, 0), 'size': size, 'max': stats.get('pool_max', 0),
                                'waiting': stats.get('requests_waiting', 0), 'at': time.time()})
            try:
                await redis_clients.get_async().hset(POOLS_KEY, field, entry)
            except Exception as error:
                log.debug('could not report the pool: %r', error)
            await asyncio.sleep(POOL_REPORT_INTERVAL)
    finally:
        try:
            await redis_clients.get_async().hdel(POOLS_KEY, field)
        except Exception:
            pass


# --- rendering -------------------------------------------------------------------------------------------------

def to_str(value):
    return value.decode('utf-8', 'replace') if isinstance(value, bytes) else str(value)


def format_value(value):
    if math.isnan(value):
        return 'NaN'
    if math.isinf(value):
        return '+Inf' if value > 0 else '-Inf'
    if value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(value)


def format_labels(labels):
    if not labels:
        return ''
    parts = []
    for key, value in labels:
        value = value.replace('\\', '\\\\').replace('\n', '\\n').replace('"', '\\"')
        parts.append('{}="{}"'.format(key, value))
    return '{' + ','.join(parts) + '}'


class Samples:
    """Samples and histograms by metric name, rendered in `METRICS` then `COLLECTED` order."""

    def __init__(self):
        self.samples = {}
        self.histograms = {}

    def add(self, name, values, value, definitions=None):
        metric = (definitions or METRICS)[name]
        labels = tuple(zip(metric.label_names, values))
        series = self.samples.setdefault(name, {})
        series[labels] = series.get(labels, 0.0) + value

    def add_bucket(self, name, values, part, value, definitions=None):
        metric = (definitions or METRICS)[name]
        labels = tuple(zip(metric.label_names, values))
        counts, total = self.histograms.setdefault(name, {}).get(labels, ([0.0] * (len(metric.buckets) + 1), 0.0))
        if part == 'sum':
            total += value
        elif isinstance(part, int) and 0 <= part < len(counts):
            counts[part] += value
        self.histograms[name][labels] = (counts, total)

    def lines(self):
        lines = []
        for name, metric in (*METRICS.items(), *COLLECTED.items()):
            if metric.kind == 'histogram':
                series = self.histograms.get(name)
                if not series:
                    continue
                lines.append('# HELP {} {}'.format(name, metric.help))
                lines.append('# TYPE {} histogram'.format(name))
                for labels, (counts, total) in sorted(series.items()):
                    cumulative = 0.0
                    for bucket, count in zip((*metric.buckets, math.inf), counts):
                        cumulative += count
                        lines.append('{}_bucket{} {}'.format(
                            name, format_labels((*labels, ('le', format_value(float(bucket))))),
                            format_value(cumulative)))
                    lines.append('{}_sum{} {}'.format(name, format_labels(labels), format_value(total)))
                    lines.append('{}_count{} {}'.format(name, format_labels(labels), format_value(cumulative)))
            else:
                series = self.samples.get(name)
                if not series:
                    continue
                lines.append('# HELP {} {}'.format(name, metric.help))
                lines.append('# TYPE {} {}'.format(name, metric.kind))
                for labels, value in sorted(series.items()):
                    lines.append('{}{} {}'.format(name, format_labels(labels), format_value(value)))
        return lines


def read_totals(samples, totals):
    """The `filesgg:metrics` hash. Fields of renamed or removed metrics, or with other labels, are skipped."""
    for raw_key, raw_value in totals.items():
        try:
            name, values, *part = json.loads(to_str(raw_key))
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        metric = METRICS.get(name)
        if metric is None or not isinstance(values, list) or len(values) != len(metric.labels):
            continue
        values = label_values(metric, dict(zip(metric.label_names, values)))
        if metric.kind == 'histogram':
            if part:
                samples.add_bucket(name, values, part[0], value)
        elif not part:
            samples.add(name, values, value)


def bucket_index(buckets, bound):
    """convert_worker.py's `le_<s>` (or `le_inf`) as a bucket index; None for a bound that isn't one of them."""
    if bound == 'inf':
        return len(buckets)
    try:
        bound = float(bound)
    except ValueError:
        return None
    index = bisect_left(buckets, bound)
    return index if index < len(buckets) and buckets[index] == bound else None


JOB_COUNTERS = {'jobs': ('filesgg_conversion_jobs_total', 'result'),
                'errors': ('filesgg_conversion_job_errors_total', 'code'),
                'failures': ('filesgg_conversion_job_failures_total', 'reason')}
JOB_HISTOGRAMS = {'duration': 'filesgg_conversion_job_duration_seconds', 'wait': 'filesgg_conversion_job_wait_seconds'}


def read_jobs(samples, fields):
    """`filesgg:metrics:jobs` (convert_worker.py `record_job`) as the `filesgg_conversion_job*` metrics."""
    for raw_field, raw_value in fields.items():
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        kind, _, rest = to_str(raw_field).partition(':')
        if kind in JOB_COUNTERS:
            queue, _, detail = rest.partition(':')
            name, label = JOB_COUNTERS[kind]
            metric = COLLECTED[name]
            samples.add(name, label_values(metric, {'queue': queue, label: detail}), value, COLLECTED)
        elif kind in JOB_HISTOGRAMS:
            queue, _, bound = rest.partition(':le_')
            name = JOB_HISTOGRAMS[kind]
            metric = COLLECTED[name]
            index = bucket_index(metric.buckets, bound)
            if index is not None:
                samples.add_bucket(name, label_values(metric, {'queue': queue}), index, value, COLLECTED)
        elif kind.endswith('_sum') and kind[:-4] in JOB_HISTOGRAMS:
            name = JOB_HISTOGRAMS[kind[:-4]]
            samples.add_bucket(name, label_values(COLLECTED[name], {'queue': rest}), 'sum', value, COLLECTED)
        elif kind == 'cpu_ms_sum':
            name = 'filesgg_conversion_job_cpu_seconds_total'
            samples.add(name, label_values(COLLECTED[name], {'queue': rest}), value / 1000, COLLECTED)


def read_pools(samples, entries, now):
    """The API workers' pools (`report_pool`), added up; returns the fields too old to count."""
    totals = {'in_use': 0, 'size': 0, 'max': 0, 'waiting': 0}
    stale, processes = [], 0
    for field, raw in entries.items():
        try:
            entry = json.loads(to_str(raw))
            fresh = now - float(entry['at']) <= POOL_STALE_AFTER
        except (TypeError, ValueError, KeyError):
            fresh = False
        if not fresh:
            stale.append(field)
            continue
        processes += 1
        for key in totals:
            totals[key] += int(entry.get(key) or 0)
    for name, key in (('filesgg_db_pool_connections_in_use', 'in_use'), ('filesgg_db_pool_connections', 'size'),
                      ('filesgg_db_pool_connections_max', 'max'), ('filesgg_db_pool_requests_waiting', 'waiting')):
        samples.add(name, [], float(totals[key]), COLLECTED)
    samples.add('filesgg_db_pool_processes', [], float(processes), COLLECTED)
    return stale


async def read_scans(samples):
    """Pending first scans (the partial index `file_hashes_pending`); a hash's id is its upload time."""
    import db
    from utils.generators import EPOCH
    async with db.connection() as conn:
        cursor = await conn.execute(
            "SELECT count(*) FILTER (WHERE scan_stuck_at IS NULL), min(id) FILTER (WHERE scan_stuck_at IS NULL), "
            "count(*) FILTER (WHERE scan_stuck_at IS NOT NULL) FROM file_hashes WHERE scan_state = 'pending'")
        pending, oldest_id, stuck = await cursor.fetchone()
    oldest = 0.0
    if oldest_id is not None:
        oldest = max(time.time() - (EPOCH + (oldest_id >> 22)) / 1000, 0.0)
    samples.add('filesgg_scans_pending', [], float(pending), COLLECTED)
    samples.add('filesgg_scans_pending_oldest_seconds', [], round(oldest, 3), COLLECTED)
    samples.add('filesgg_scans_stuck', [], float(stuck), COLLECTED)


async def read_conversion_queues(samples):
    from utils import convert_queue
    queues = await convert_queue.in_executor(convert_queue.queue_health)
    for queue, health in queues.items():
        for name, value in (('filesgg_conversion_queue_length', health['length']),
                            ('filesgg_conversion_queue_oldest_seconds', health['oldest_seconds'] or 0)):
            samples.add(name, label_values(COLLECTED[name], {'queue': queue}), float(value), COLLECTED)


async def render():
    """Everything above in Prometheus' text format. A part that can't be read is left out and its
    `filesgg_metrics_collector_up` is 0; the rest still renders."""
    from utils import convert_queue
    samples = Samples()
    up = {}
    try:
        async with redis_clients.get_async().pipeline(transaction=False) as pipeline:
            pipeline.hgetall(REDIS_KEY)
            pipeline.hgetall(convert_queue.METRICS_KEY)
            pipeline.hgetall(POOLS_KEY)
            totals, jobs, pools = await pipeline.execute()
    except Exception:
        log.exception('could not read the metrics from Redis')
        up['redis'] = up['jobs'] = up['db_pools'] = False
    else:
        for collector, read in (('redis', lambda: read_totals(samples, totals)),
                                ('jobs', lambda: read_jobs(samples, jobs))):
            try:
                read()
                up[collector] = True
            except Exception:
                log.exception('could not render %s metrics', collector)
                up[collector] = False
        try:
            stale = read_pools(samples, pools, time.time())
            if stale:
                await redis_clients.get_async().hdel(POOLS_KEY, *stale)
            up['db_pools'] = True
        except Exception:
            log.exception('could not render the pools')
            up['db_pools'] = False
    for collector, read in (('scans', read_scans), ('conversion_queues', read_conversion_queues)):
        try:
            await read(samples)
            up[collector] = True
        except Exception:
            log.exception('could not collect %s metrics', collector)
            up[collector] = False
    for collector, ok in up.items():
        samples.add('filesgg_metrics_collector_up', [collector], float(ok), COLLECTED)
    return '\n'.join(samples.lines()) + '\n'
