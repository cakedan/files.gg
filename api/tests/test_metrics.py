"""Milestone 7 §4.2 (docs/redesign/contracts/milestone-7.md): the metrics in Redis (utils/metrics.py), their labels
never carrying a path, vanity, id, email or address, the HTTP middleware, the conversion workers' counters re-exported,
the scrape-time gauges, and `GET /internal/metrics`: Prometheus' text format, behind the Worker's lookup guard."""

import asyncio
import json
import math
import re
import time
import uuid

import pytest

from tests.conftest import APP_DATABASE, LOGIN_TOKEN, ORIGIN_SECRET, TURNSTILE_TOKEN, VIA_MAIN, TempDatabase
from utils import metrics, ratelimit, redis as redis_clients
from utils.generators import Snowflake
from utils.tokens import GuestToken

# the Worker's own lookups (views/internal.py), as Prometheus sends them
SCRAPE = {'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Internal-Lookup': '1'}


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


@pytest.fixture(autouse=True)
def fresh_metrics():
    """No carried counts or backoff left by another test (a Redis-down test backs the writes off)."""
    metrics._state.update(carry={}, backoff_until=0.0)
    yield


def stored():
    """The `filesgg:metrics` hash as {(name, (labels...), part or None): value}."""
    out = {}
    for key, value in redis_clients.get_sync().hgetall(metrics.REDIS_KEY).items():
        try:
            name, labels, *part = json.loads(key)
        except ValueError:
            continue  # a field the rendering test plants
        out[(name, tuple(labels), part[0] if part else None)] = float(value)
    return out


def value(name, *labels, part=None):
    return stored().get((name, tuple(labels), part), 0.0)


def eventually(check, timeout=5.0):
    """The API's own writes are tasks on its event loop: wait for them to land."""
    deadline = time.monotonic() + timeout
    while True:
        result = check()
        if result or time.monotonic() > deadline:
            return result
        time.sleep(0.05)


def scrape(client):
    response = client.get('/internal/metrics', headers=SCRAPE)
    assert response.status_code == 200, response.text
    assert response.headers['content-type'] == metrics.CONTENT_TYPE
    return response.text


# --- the exposition format ---------------------------------------------------------------------------------------

NAME = r'[a-zA-Z_:][a-zA-Z0-9_:]*'
LABEL = r'[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*"'
SAMPLE = re.compile(r'({name})(\{{(?:{label}(?:,{label})*)?\}})? (\S+)'.format(name=NAME, label=LABEL))
LABEL_PAIR = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\\n]|\\[\\"n])*)"')


def parse_exposition(text):
    """Prometheus' text format 0.0.4, strictly: HELP and TYPE once per family before its samples, every sample line
    well formed and in its family, values that parse, and histograms whose buckets climb to `+Inf` == `_count`.
    Returns {family: {"type", "samples": [(name, {labels}, value)]}}."""
    assert text.endswith('\n')
    families, current = {}, None
    for line in text[:-1].split('\n'):
        assert line, 'empty line'
        if line.startswith('# HELP '):
            name = line.split(' ')[2]
            assert re.fullmatch(NAME, name) and name not in families, line
            families[name] = {'type': None, 'samples': []}
            current = name
            continue
        if line.startswith('# TYPE '):
            _, _, name, kind = line.split(' ')
            assert name == current and families[name]['type'] is None, line
            assert kind in ('counter', 'gauge', 'histogram'), line
            families[name]['type'] = kind
            continue
        match = SAMPLE.fullmatch(line)
        assert match, 'bad sample line: {!r}'.format(line)
        name, labels, raw = match.groups()
        family = families[current]
        allowed = {current} if family['type'] != 'histogram' else {current + s for s in ('_bucket', '_sum', '_count')}
        assert name in allowed, line
        number = float(raw.replace('+Inf', 'inf'))
        assert not math.isnan(number), line
        family['samples'].append((name, dict(LABEL_PAIR.findall(labels or '')), number))
    for name, family in families.items():
        assert family['type'] and family['samples'], name
        if family['type'] == 'histogram':
            series = {}
            for sample, labels, number in family['samples']:
                key = tuple(sorted((k, v) for k, v in labels.items() if k != 'le'))
                series.setdefault(key, {'buckets': [], 'count': None, 'sum': None})
                if sample.endswith('_bucket'):
                    series[key]['buckets'].append((float(labels['le'].replace('+Inf', 'inf')), number))
                else:
                    series[key][sample.rpartition('_')[2]] = number
            for parts in series.values():
                bounds = [b for b, _ in parts['buckets']]
                counts = [c for _, c in parts['buckets']]
                assert bounds == sorted(bounds) and bounds[-1] == math.inf, name
                assert counts == sorted(counts) and counts[-1] == parts['count'] and parts['sum'] is not None, name
    return families


def sample(families, name, **labels):
    family = name
    for suffix in ('_bucket', '_sum', '_count'):
        if name.endswith(suffix) and name[:-len(suffix)] in families:
            family = name[:-len(suffix)]
    for sample_name, sample_labels, number in families.get(family, {'samples': []})['samples']:
        if sample_name == name and sample_labels == labels:
            return number
    return None


# --- counters, histograms, gauges ------------------------------------------------------------------------------

def test_counters_histograms_and_gauges_go_to_one_redis_hash():
    labels = {'kind': 'single', 'uploader': 'guest'}
    metrics.incr('filesgg_uploads_total', labels)
    metrics.incr('filesgg_uploads_total', labels)
    metrics.incr('filesgg_upload_bytes_total', labels, 1536)
    assert value('filesgg_uploads_total', 'single', 'guest') == 2
    assert value('filesgg_upload_bytes_total', 'single', 'guest') == 1536

    # fixed buckets: an observation lands in the first bucket it fits (<=), past the last one in +Inf
    for seconds in (0.4, 0.5, 7, 4000):
        metrics.observe('filesgg_scan_seconds', seconds)
    buckets = metrics.SCAN_DURATION_BUCKETS
    assert value('filesgg_scan_seconds', part=0) == 2
    assert value('filesgg_scan_seconds', part=buckets.index(10)) == 1
    assert value('filesgg_scan_seconds', part=len(buckets)) == 1
    assert value('filesgg_scan_seconds', part='sum') == pytest.approx(4007.9)

    metrics.set_gauge('filesgg_scheduled_task_last_success_timestamp_seconds', 1700000000, {'task': 'purge_jobs'})
    metrics.set_gauge('filesgg_scheduled_task_last_success_timestamp_seconds', 1700000060, {'task': 'purge_jobs'})
    assert value('filesgg_scheduled_task_last_success_timestamp_seconds', 'purge_jobs') == 1700000060
    assert set(redis_clients.get_sync().keys('filesgg:metrics*')) == {metrics.REDIS_KEY.encode()}

    # rendered: cumulative buckets, _sum and _count
    samples = metrics.Samples()
    metrics.read_totals(samples, redis_clients.get_sync().hgetall(metrics.REDIS_KEY))
    families = parse_exposition('\n'.join(samples.lines()) + '\n')
    assert families['filesgg_scan_seconds']['type'] == 'histogram'
    assert sample(families, 'filesgg_scan_seconds_bucket', le='0.5') == 2
    assert sample(families, 'filesgg_scan_seconds_bucket', le='10') == 3
    assert sample(families, 'filesgg_scan_seconds_bucket', le='1800') == 3
    assert sample(families, 'filesgg_scan_seconds_bucket', le='+Inf') == 4
    assert sample(families, 'filesgg_scan_seconds_count') == 4
    assert sample(families, 'filesgg_uploads_total', kind='single', uploader='guest') == 2
    assert families['filesgg_scheduled_task_last_success_timestamp_seconds']['type'] == 'gauge'


def test_unknown_metrics_and_wrong_kinds_are_dropped_never_raised():
    metrics.incr('filesgg_nope_total')
    metrics.observe('filesgg_uploads_total', 1.0)
    metrics.incr('filesgg_scan_seconds')
    metrics.set_gauge('filesgg_uploads_total', 3)
    metrics.incr('filesgg_uploads_total', {'kind': 'single', 'uploader': 'guest'}, value='not a number')
    assert stored() == {}


def test_redis_down_never_raises_and_the_counts_arrive_later(monkeypatch):
    up = dict(redis_clients._clients)
    monkeypatch.setenv('REDIS_URL', 'redis://:x@127.0.0.1:1/0')
    monkeypatch.setitem(redis_clients._clients, 'sync', redis_clients.new_sync())
    metrics.incr('filesgg_emails_total', {'tag': 'auth-verify', 'outcome': 'sent'})
    metrics.incr('filesgg_emails_total', {'tag': 'auth-verify', 'outcome': 'sent'})
    assert metrics._state['backoff_until'] > time.monotonic()
    monkeypatch.setitem(redis_clients._clients, 'sync', up['sync'])
    monkeypatch.undo()
    metrics._state['backoff_until'] = 0.0
    metrics.incr('filesgg_emails_total', {'tag': 'auth-verify', 'outcome': 'sent'})
    assert value('filesgg_emails_total', 'auth-verify', 'sent') == 3
    assert value('filesgg_redis_errors_total', 'metrics') == 1
    assert metrics._state['carry'] == {}


def test_a_foreign_event_loop_writes_from_a_thread():
    """A script's own loop never touches the API's async client."""
    async def run():
        metrics.incr('filesgg_csam_matcher_calls_total', {'matcher': 'standin', 'outcome': 'no_match'})

    asyncio.run(run())
    assert eventually(lambda: value('filesgg_csam_matcher_calls_total', 'standin', 'no_match') == 1)


# --- label safety ------------------------------------------------------------------------------------------------

@pytest.mark.parametrize('name, labels, expected', [
    # raw paths, vanities and ids are never route patterns
    ('filesgg_http_requests_total', {'route': '/files/abc123', 'method': 'GET', 'status': '2xx'},
     ('other', 'GET', '2xx')),
    ('filesgg_http_requests_total', {'route': '/users/1234567890', 'method': 'BREW', 'status': '200'},
     ('other', 'other', 'other')),
    ('filesgg_http_requests_total', {'route': 'unmatched', 'method': 'GET', 'status': '4xx'},
     ('unmatched', 'GET', '4xx')),
    # error codes are UPPER_SNAKE; an email, an address, an id or a vanity isn't one
    ('filesgg_upload_refusals_total', {'kind': 'single', 'code': 'someone@example.com'}, ('single', 'other')),
    ('filesgg_upload_refusals_total', {'kind': 'single', 'code': '203.0.113.7'}, ('single', 'other')),
    ('filesgg_upload_refusals_total', {'kind': 'chunked', 'code': '1234567890123456789'}, ('chunked', 'other')),
    ('filesgg_upload_refusals_total', {'kind': 'chunked', 'code': 'aBc123'}, ('chunked', 'other')),
    ('filesgg_upload_refusals_total', {'kind': 'chunked', 'code': 'FILE_TOO_LARGE'}, ('chunked', 'FILE_TOO_LARGE')),
    # rate-limit scopes are the declared ones, never a key
    ('filesgg_ratelimit_refusals_total', {'scope': 'ip:0123abcd'}, ('other',)),
    ('filesgg_ratelimit_refusals_total', {'scope': 'login_ip'}, ('login_ip',)),
    ('filesgg_ratelimit_refusals_total', {'scope': 'file_upload'}, ('file_upload',)),
    ('filesgg_emails_total', {'tag': 'someone@example.com', 'outcome': 'sent'}, ('other', 'sent')),
    ('filesgg_turnstile_verifications_total', {'action': 'upload', 'outcome': '2001:db8::1'}, ('upload', 'other')),
    # a missing label is `other` too; an extra one is ignored
    ('filesgg_uploads_total', {'kind': 'single', 'vanity': 'abc123'}, ('single', 'other')),
])
def test_label_values_come_from_allowlists(app, name, labels, expected):
    metrics.incr(name, labels)
    assert stored() == {(name, expected, None): 1.0}


def test_route_patterns_are_registered_from_the_app(client):
    patterns = metrics._registry['route']
    assert {'/files/<vanity:path>', '/internal/metrics', '/uploads/<upload_id:str>/chunks/<index:str>',
            '/health'} <= patterns
    assert not any(re.search(r'/\d', pattern) for pattern in patterns)


def test_no_vanity_id_email_or_address_reaches_a_label(client, appdb):
    """Real traffic: an upload, its file by vanity and by id, a chunked upload, a refused login and a rate limit."""
    from tests.conftest import make_user
    ip = '10.77.{}.{}'.format(*uuid.uuid4().bytes[:2])
    guest = {'Authorization': 'Guest ' + GuestToken.generate(Snowflake.generate()), 'X-Forwarded-For': ip}
    created = client.post('/files', headers=guest, data={'turnstile_token': TURNSTILE_TOKEN},
                          files={'file': ('secret-name.txt', uuid.uuid4().bytes, 'text/plain')}).json()
    client.get('/files/' + created['vanity'])
    client.get('/files/' + created['vanity'] + 'nope')
    client.get('/users/@me/files/' + created['id'], headers=guest)
    started = client.post('/uploads', headers=guest, json={
        'filename': 'chunked-name.txt', 'size': 3, 'turnstile_token': TURNSTILE_TOKEN}).json()
    client.put('/uploads/{}/chunks/0'.format(started['upload_id']), headers=guest, content=b'abcd')
    username = 'mx{}'.format(Snowflake.generate())
    email = username + '@example.com'
    make_user(appdb, username=username, password='correct-horse')
    for _ in range(11):
        client.post('/auth/login', headers=dict(VIA_MAIN, **{'X-Filesgg-Client-Ip': ip}),
                    json={'email': email, 'password': 'wrong', 'turnstile_token': LOGIN_TOKEN})

    assert eventually(lambda: value('filesgg_ratelimit_refusals_total', 'login_account') >= 1)
    assert eventually(lambda: value('filesgg_upload_refusals_total', 'chunked', 'CHUNK_SIZE_MISMATCH') >= 1)
    assert eventually(lambda: value('filesgg_http_requests_total', '/files/<vanity:path>', 'GET', '4xx') >= 1)
    assert eventually(lambda: value('filesgg_uploads_total', 'single', 'guest') >= 1)
    assert eventually(lambda: value('filesgg_turnstile_verifications_total', 'login', 'passed') >= 1)
    raw = b' '.join(k + b' ' + v for k, v in redis_clients.get_sync().hgetall(metrics.REDIS_KEY).items()).decode()
    for secret in (created['vanity'], created['id'], started['upload_id'], email, username, ip,
                   'secret-name', 'chunked-name'):
        assert secret not in raw


# --- the HTTP middleware ---------------------------------------------------------------------------------------

def test_the_middleware_counts_requests_by_route_pattern(client):
    before = value('filesgg_http_requests_total', '/mimetypes', 'GET', '2xx')
    assert client.get('/mimetypes').status_code == 200
    assert eventually(lambda: value('filesgg_http_requests_total', '/mimetypes', 'GET', '2xx') == before + 1)
    assert value('filesgg_http_request_duration_seconds', '/mimetypes', part='sum') > 0
    assert sum(v for (name, labels, part), v in stored().items()
               if name == 'filesgg_http_request_duration_seconds' and labels == ('/mimetypes',)
               and isinstance(part, int)) == before + 1
    # no route: `unmatched`, whatever the path was
    assert client.get('/nope/123').status_code == 404
    assert eventually(lambda: value('filesgg_http_requests_total', 'unmatched', 'GET', '4xx') >= 1)
    # errors (an unknown file) are counted with their status
    client.get('/files/' + uuid.uuid4().hex[:12])
    assert eventually(lambda: value('filesgg_http_requests_total', '/files/<vanity:path>', 'GET', '4xx') >= 1)


# --- instrumentation ---------------------------------------------------------------------------------------------

def test_rate_limit_refusals_and_redis_failures_are_counted():
    from redis.exceptions import ConnectionError
    from utils.responses import ApiError
    limit = ratelimit.limit_for('unlock')
    error = ratelimit.refusal([ratelimit.RatelimitHit(limit, 'ip:0', False, 0, 0.0, 1.0)])
    assert error.code == 'TOO_MANY_ATTEMPTS'
    assert value('filesgg_ratelimit_refusals_total', 'unlock') == 1
    assert ratelimit.unavailable([(ratelimit.limit_for('global'), 'ip:0')], ConnectionError(), 'x') == []
    with pytest.raises(ApiError):
        ratelimit.unavailable([(limit, 'ip:0')], ConnectionError(), 'x')
    assert value('filesgg_ratelimit_unavailable_total', 'open') == 1
    assert value('filesgg_ratelimit_unavailable_total', 'closed') == 1
    assert value('filesgg_redis_errors_total', 'ratelimit') == 2


def test_the_upload_routes_keep_their_route_limits(client, monkeypatch):
    """The refusal counter wraps the upload handlers outside their limits: the limits still apply and still refuse,
    and a 429 from the limiter is a rate-limit refusal, not an upload refusal."""
    import views.files
    import views.uploads
    from tests.conftest import rate_limits_env
    for handler in (views.files.create_file, views.uploads.create_upload):
        assert getattr(handler, ratelimit.HANDLER_ATTRIBUTE)
    monkeypatch.setenv('RATE_LIMITS', rate_limits_env(file_upload='1 per minute', chunked_upload='1 per minute'))
    ip = '10.66.{}.{}'.format(*uuid.uuid4().bytes[:2])
    guest = {'Authorization': 'Guest ' + GuestToken.generate(Snowflake.generate()),
             'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Client-Ip': ip}
    for path, kwargs in (('/files', {'data': {'turnstile_token': TURNSTILE_TOKEN},
                                     'files': {'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')}}),
                         ('/uploads', {'json': {'filename': 'a.txt', 'size': 3,
                                                'turnstile_token': TURNSTILE_TOKEN}})):
        assert client.post(path, headers=guest, **kwargs).status_code in (200, 201)
        refused = client.post(path, headers=guest, **kwargs)
        assert (refused.status_code, refused.json()['code']) == (429, 'RATE_LIMITED')
    assert eventually(lambda: value('filesgg_ratelimit_refusals_total', 'file_upload') == 1
                      and value('filesgg_ratelimit_refusals_total', 'chunked_upload') == 1)
    assert not any(name == 'filesgg_upload_refusals_total' for name, _, _ in stored())


def test_turnstile_email_and_matcher_outcomes(monkeypatch):
    from safety.matchers import MatcherUnavailable
    from safety.matchers.standin import StandinMatcher
    from tests.conftest import turnstile_token
    from utils.email import Email, EmailUnavailable
    from utils.turnstile import Turnstile

    async def checks():
        assert await Turnstile.verify(turnstile_token('upload'), 'upload')
        assert not await Turnstile.verify(turnstile_token('login'), 'upload')
        assert not await Turnstile.verify('mock-fail', 'upload')
        assert not await Turnstile.verify(None, 'unlock')

    asyncio.run(checks())
    for outcome, count in (('passed', 1), ('mismatch', 1), ('failed', 1)):
        assert eventually(lambda: value('filesgg_turnstile_verifications_total', 'upload', outcome) == count)
    assert eventually(lambda: value('filesgg_turnstile_verifications_total', 'unlock', 'missing') == 1)

    monkeypatch.setattr(Email, 'token', None)
    with pytest.raises(EmailUnavailable):
        Email.send_sync(to='someone@example.com', subject='s', html='h', text='t', tag='auth-verify')
    assert value('filesgg_emails_total', 'auth-verify', 'unconfigured') == 1

    StandinMatcher([('blake2b', 'ab')]).match([], blake2b='ab')
    StandinMatcher([]).match([])
    with pytest.raises(MatcherUnavailable):
        StandinMatcher([], mode='unavailable').match([])
    for outcome in ('match', 'no_match', 'error'):
        assert value('filesgg_csam_matcher_calls_total', 'standin', outcome) == 1


# --- GET /internal/metrics ---------------------------------------------------------------------------------------

@pytest.mark.parametrize('headers', [
    {},
    # what the Worker adds to every request it forwards from files.gg, api.files.gg or a custom domain
    {'X-Filesgg-Origin-Secret': ORIGIN_SECRET},
    {'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'Host': 'api.files.gg'},
    {'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'Host': 'files.gg', 'X-Filesgg-Via': 'main'},
    {'X-Filesgg-Internal-Lookup': '1', 'Host': 'cdn.files.gg'},
    {'X-Filesgg-Origin-Secret': 'wrong', 'X-Filesgg-Internal-Lookup': '1'},
])
def test_the_endpoint_is_unreachable_from_outside(client, headers):
    for method in ('GET', 'HEAD'):
        response = client.request(method, '/internal/metrics', headers=headers)
        assert response.status_code == 404
    response = client.get('/internal/metrics', headers=headers)
    assert response.json() == client.get('/no-such-route').json()
    assert 'filesgg_' not in response.text


def test_the_endpoint_renders_everything_in_prometheus_format(client, appdb):
    from convert_worker import record_job
    from utils.uploading import snowflake_since
    sync = redis_clients.get_sync()
    record_job(sync, 'convert_member', 'finished', None, 3.0, 0.2, 1500)
    record_job(sync, 'convert_member', 'error', 'CONVERSION_TIMEOUT', 4000.0, None, 500)
    record_job(sync, 'convert_premium', 'failed', 'killed_SIGKILL', 1.0, 61.0, 0)
    metrics.incr('filesgg_scans_total', {'state': 'flagged', 'reason': 'pdf_javascript'})
    # a label value with a quote and a backslash in it can't happen, but must still render escaped
    sync.hincrbyfloat(metrics.REDIS_KEY, metrics.series_key('filesgg_emails_total', ['a"b\\c', 'sent']), 1)
    # a renamed metric, a field that isn't JSON and a wrong label count are skipped
    sync.hincrbyfloat(metrics.REDIS_KEY, metrics.series_key('filesgg_gone_total', []), 1)
    sync.hincrbyfloat(metrics.REDIS_KEY, 'not json', 1)
    sync.hincrbyfloat(metrics.REDIS_KEY, metrics.series_key('filesgg_uploads_total', ['single']), 1)
    # a hash waiting 20 minutes for its first scan
    hash_id = snowflake_since(1200)
    appdb.execute("INSERT INTO file_hashes (id, blake2b, sha1, md5, size, scan_state) VALUES "
                  "(%s, %s, %s, %s, 1, 'pending')", (hash_id, uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex))
    try:
        families = parse_exposition(scrape(client))
    finally:
        appdb.execute('DELETE FROM file_hashes WHERE id = %s', (hash_id,))

    assert sample(families, 'filesgg_conversion_jobs_total', queue='convert_member', result='finished') == 1
    assert sample(families, 'filesgg_conversion_job_errors_total', queue='convert_member',
                  code='CONVERSION_TIMEOUT') == 1
    assert sample(families, 'filesgg_conversion_job_failures_total', queue='convert_premium',
                  reason='killed_SIGKILL') == 1
    assert sample(families, 'filesgg_conversion_job_duration_seconds_bucket', queue='convert_member', le='5') == 1
    assert sample(families, 'filesgg_conversion_job_duration_seconds_bucket', queue='convert_member',
                  le='+Inf') == 2
    assert sample(families, 'filesgg_conversion_job_duration_seconds_sum', queue='convert_member') == 4003
    assert sample(families, 'filesgg_conversion_job_wait_seconds_count', queue='convert_member') == 1
    assert sample(families, 'filesgg_conversion_job_cpu_seconds_total', queue='convert_member') == 2
    assert sample(families, 'filesgg_scans_total', state='flagged', reason='pdf_javascript') == 1
    assert sample(families, 'filesgg_emails_total', tag='other', outcome='sent') == 1
    assert 'filesgg_gone_total' not in families
    assert sample(families, 'filesgg_uploads_total', kind='single', uploader='guest') is None
    for queue in ('convert_premium', 'convert_member', 'convert_anonymous', 'convert_previews'):
        assert sample(families, 'filesgg_conversion_queue_length', queue=queue) is not None
        assert sample(families, 'filesgg_conversion_queue_oldest_seconds', queue=queue) is not None
    assert sample(families, 'filesgg_scans_pending') >= 1
    assert sample(families, 'filesgg_scans_pending_oldest_seconds') >= 1200
    assert sample(families, 'filesgg_scans_stuck') is not None
    assert sample(families, 'filesgg_db_pool_processes') is not None
    for collector in ('redis', 'jobs', 'scans', 'conversion_queues', 'db_pools'):
        assert sample(families, 'filesgg_metrics_collector_up', collector=collector) == 1
    # every family is a declared filesgg_ metric
    assert set(families) <= set(metrics.METRICS) | set(metrics.COLLECTED)
    # the scrape itself was counted (the request before this one at least)
    scrape(client)
    assert eventually(lambda: value('filesgg_http_requests_total', '/internal/metrics', 'GET', '2xx') >= 1)


def test_the_api_workers_pools_are_added_up():
    samples = metrics.Samples()
    now = time.time()
    stale = metrics.read_pools(samples, {
        b'api-1:10': json.dumps({'in_use': 3, 'size': 5, 'max': 10, 'waiting': 2, 'at': now - 5}),
        b'api-1:11': json.dumps({'in_use': 1, 'size': 2, 'max': 10, 'waiting': 0, 'at': now}),
        b'api-2:10': json.dumps({'in_use': 9, 'size': 9, 'max': 10, 'waiting': 9, 'at': now - 60}),
        b'broken': b'{',
    }, now)
    assert sorted(stale) == [b'api-2:10', b'broken']
    families = parse_exposition('\n'.join(samples.lines()) + '\n')
    assert sample(families, 'filesgg_db_pool_connections_in_use') == 4
    assert sample(families, 'filesgg_db_pool_connections') == 7
    assert sample(families, 'filesgg_db_pool_connections_max') == 20
    assert sample(families, 'filesgg_db_pool_requests_waiting') == 2
    assert sample(families, 'filesgg_db_pool_processes') == 2


def test_each_api_worker_reports_its_pool(client):
    """Every POOL_REPORT_INTERVAL seconds (the suite empties Redis before each test, so wait for the next report)."""
    def reported():
        return sample(parse_exposition(scrape(client)), 'filesgg_db_pool_processes')

    assert eventually(reported, timeout=metrics.POOL_REPORT_INTERVAL + 5) >= 1
    entry = json.loads(next(iter(redis_clients.get_sync().hgetall(metrics.POOLS_KEY).values())))
    assert entry['max'] >= 1 and 0 <= entry['in_use'] <= entry['size'] and entry['waiting'] >= 0
