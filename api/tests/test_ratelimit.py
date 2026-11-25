"""Milestone 5 rate limits on Redis (docs/redesign/contracts/milestone-5.md §18, §15): the Lua moving window, several
limits in one round trip, the global and route limits, `client_key`, internal lookups and staff, every §18.3 scope
with its value and code, failures-only counting, Redis being down, `Retry-After`, and the Postgres limits being gone.
With the real Redis at REDIS_URL, emptied before every test (conftest.py)."""

import asyncio
import json
import os
import time
import uuid

from types import SimpleNamespace

import pytest

from tests.conftest import (
    APP_DATABASE, LOGIN_TOKEN, ORIGIN_SECRET, VIA_MAIN, TempDatabase, free_port, make_user, sign_in,
    turnstile_token,
)
from utils import ratelimit, ratelimit_sync, redis as redis_clients
from utils.ratelimit import Limit, limit_for
from utils.responses import ApiError
from utils.tokens import GuestToken
from utils.generators import Snowflake

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


@pytest.fixture
def limits(monkeypatch):
    """Override scopes for one test through RATE_LIMITS, as an operator would (§18.2)."""
    def apply(**values):
        monkeypatch.setenv('RATE_LIMITS', json.dumps(values))
    return apply


@pytest.fixture
def redis_down(monkeypatch):
    """Both clients pointed at a closed port, as if Redis were down."""
    url = 'redis://127.0.0.1:{}/0'.format(free_port())
    monkeypatch.setenv('REDIS_URL', url)
    monkeypatch.setitem(redis_clients._clients, 'async', redis_clients.new_async())
    monkeypatch.setitem(redis_clients._clients, 'sync', redis_clients.new_sync())


def a_network():
    return '10.{}.{}.{}'.format(*uuid.uuid4().bytes[:3])


def from_ip(ip=None, headers=None):
    """A request the Worker forwarded from this client address (or a new one)."""
    return dict(headers or {}, **{'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Client-Ip': ip or a_network()})


def assert_limited(response, code='RATE_LIMITED', within=None):
    assert response.status_code == 429, response.text
    body = response.json()
    assert body['code'] == code
    # §18.1: retry_after in seconds with 3 decimals, and Retry-After in whole seconds, at least 1
    assert isinstance(body['retry_after'], (int, float)) and body['retry_after'] == round(body['retry_after'], 3)
    assert 0 <= body['retry_after'] <= (within or body['retry_after'])
    assert int(response.headers['retry-after']) >= max(1, int(body['retry_after']))
    return body


def keys():
    return sorted(key.decode() for key in redis_clients.get_sync().keys('ratelimit:*'))


# --- §18.1: limits, the script ------------------------------------------------------------------------------------

def test_limit_text():
    for text, amount, seconds in (('50 per second', 50, 1), ('5 per minute', 5, 60), ('3 per 2 hours', 3, 7200),
                                  ('10 per day', 10, 86400), ('1 PER MINUTES', 1, 60), (' 30 per hour ', 30, 3600)):
        limit = Limit.parse(text, 'scope')
        assert (limit.amount, limit.seconds, limit.fail) == (amount, seconds, 'open')
    assert Limit.parse('5 per minute', 'unlock').redis_key('file:1f:ab') == 'ratelimit:unlock:file:1f:ab:5/60'
    for bad in ('0 per second', '5 a minute', 'per minute', '5 per week', '5 per 0 minutes', ''):
        with pytest.raises(ValueError):
            Limit.parse(bad, 'scope')
    with pytest.raises(ValueError):
        Limit.parse('5 per minute', 'scope', fail='maybe')


def test_the_moving_window():
    limit = Limit.parse('2 per second', 'test')
    checks = [(limit, 'k')]
    key = limit.redis_key('k')
    client = redis_clients.get_sync()
    # peek records nothing
    peeked = ratelimit_sync.check(checks, record=False, quiet=True)[0]
    assert (peeked.allowed, peeked.remaining, client.exists(key)) == (True, 2, 0)
    first = ratelimit_sync.check(checks, quiet=True)[0]
    assert (first.allowed, first.remaining) == (True, 1)
    assert 0.9 <= first.reset_after <= 1.0 and first.reset == pytest.approx(time.time() + 1, abs=0.5)
    time.sleep(0.5)
    assert ratelimit_sync.check(checks, quiet=True)[0].remaining == 0
    # a refused hit isn't recorded, so it doesn't push the window back
    for _ in range(3):
        refused = ratelimit_sync.check(checks, quiet=True)[0]
        assert not refused.allowed and refused.remaining == 0 and refused.reset_after <= 0.5
    assert client.llen(key) == 2 and 0 < client.pttl(key) <= 1000
    assert not ratelimit_sync.check(checks, record=False, quiet=True)[0].allowed
    # the window moves: once the first hit is a second old there's room for one, not two (a fixed window would reset)
    time.sleep(refused.reset_after + 0.05)
    assert ratelimit_sync.check(checks, quiet=True)[0].allowed
    assert not ratelimit_sync.check(checks, quiet=True)[0].allowed
    with pytest.raises(ApiError) as raised:
        ratelimit_sync.check(checks)
    assert (raised.value.status, raised.value.data['code']) == (429, 'RATE_LIMITED')


def test_several_limits_in_one_round_trip(monkeypatch):
    calls = []
    real = ratelimit_sync._script_for

    def counting(client):
        script = real(client)

        def call(**kwargs):
            calls.append(kwargs['keys'])
            return script(**kwargs)
        return call
    monkeypatch.setattr(ratelimit_sync, '_script_for', counting)
    one, two = Limit.parse('1 per minute', 'one'), Limit.parse('5 per minute', 'two')
    hits = ratelimit_sync.check([(one, 'a'), (two, 'a'), (two, 'b')], quiet=True)
    assert len(calls) == 1 and [hit.allowed for hit in hits] == [True, True, True]
    # the full limit refuses; the others still count (each window only records when it has room)
    hits = ratelimit_sync.check([(one, 'a'), (two, 'a')], quiet=True)
    assert len(calls) == 2 and [(hit.allowed, hit.remaining) for hit in hits] == [(False, 0), (True, 3)]
    with pytest.raises(ApiError):
        ratelimit_sync.check([(two, 'a'), (one, 'a')])


# --- §18.2, §18.3: every scope, its value, fail mode and code -------------------------------------------------------

SCOPES = {
    'global': (50, 1, 'open', 'RATE_LIMITED'),
    'login_ip': (30, 3600, 'closed', 'TOO_MANY_ATTEMPTS'),
    'login_account': (10, 3600, 'closed', 'TOO_MANY_ATTEMPTS'),
    'reauth': (10, 3600, 'closed', 'TOO_MANY_ATTEMPTS'),
    'register': (5, 3600, 'closed', 'TOO_MANY_ATTEMPTS'),
    'forgot_ip': (10, 3600, 'closed', 'TOO_MANY_ATTEMPTS'),
    'forgot_account': (3, 3600, 'closed', 'TOO_MANY_ATTEMPTS'),
    'verify_resend': (5, 3600, 'open', 'TOO_MANY_ATTEMPTS'),
    'discord': (30, 3600, 'open', 'TOO_MANY_ATTEMPTS'),
    'username_check': (60, 3600, 'open', 'TOO_MANY_ATTEMPTS'),
    'unlock': (5, 60, 'closed', 'TOO_MANY_ATTEMPTS'),
    'access': (30, 60, 'open', 'TOO_MANY_ATTEMPTS'),
    'report': (10, 3600, 'closed', 'MAX_REPORTS'),
    'report_message': (30, 3600, 'closed', 'MAX_MESSAGES'),
    'upload_key': (600, 3600, 'open', 'TOO_MANY_UPLOADS'),
    'domain_add': (10, 86400, 'open', 'TOO_MANY_ATTEMPTS'),
    'domain_check': (1, 60, 'open', 'DOMAIN_CHECK_RATE_LIMITED'),
}


@pytest.mark.parametrize('scope', sorted(SCOPES))
def test_every_scope(scope, monkeypatch):
    # the defaults, without the suite's raised global limit (conftest.py)
    monkeypatch.delenv('RATE_LIMITS')
    amount, seconds, fail, code = SCOPES[scope]
    limit = limit_for(scope)
    assert (limit.amount, limit.seconds, limit.fail) == (amount, seconds, fail)
    key = 'user:{:x}'.format(Snowflake.generate())
    for _ in range(amount):
        assert ratelimit_sync.hit(scope, key).allowed
    with pytest.raises(ApiError) as raised:
        ratelimit_sync.hit(scope, key)
    error = raised.value
    assert (error.status, error.data['code']) == (429, code)
    assert 0 < error.data['retry_after'] <= seconds
    if code == 'TOO_MANY_UPLOADS':
        assert error.data['limit'] == amount
    # another key has its own window
    assert ratelimit_sync.hit(scope, key + '0').allowed


def test_the_route_limits_and_env_overrides(monkeypatch, limits):
    monkeypatch.delenv('RATE_LIMITS')
    from views.auth import auth_guest
    from views.files import create_file
    from views.uploads import create_upload
    found = {limit.scope: limit.text for handler in (auth_guest, create_file, create_upload)
             for limit in getattr(handler, ratelimit.HANDLER_ATTRIBUTE)}
    assert found == {'guest': '30 per minute', 'file_upload': '60 per minute', 'chunked_upload': '60 per minute'}
    # REPORT_RATE_PER_HOUR and UPLOAD_KEY_RATE_PER_HOUR still set those two; RATE_LIMITS wins over everything
    monkeypatch.setenv('REPORT_RATE_PER_HOUR', '4')
    monkeypatch.setenv('UPLOAD_KEY_RATE_PER_HOUR', '7')
    assert (limit_for('report').amount, limit_for('upload_key').amount) == (4, 7)
    limits(report='2 per minute', upload_key='3 per day', guest='1 per second', **{'global': '9 per second'})
    assert [(limit_for(s).amount, limit_for(s).seconds) for s in ('report', 'upload_key', 'global')] == \
        [(2, 60), (3, 86400), (9, 1)]
    assert limit_for('guest', '30 per minute').text == '1 per second'
    # a closed scope stays closed with a new value
    assert limit_for('report').fail == 'closed'
    ratelimit.check_config()
    for bad in ('[1]', '{"global": "lots"}', 'nope'):
        monkeypatch.setenv('RATE_LIMITS', bad)
        with pytest.raises((RuntimeError, ValueError)):
            ratelimit.check_config()


def test_redis_url_is_required(monkeypatch):
    monkeypatch.delenv('REDIS_URL')
    with pytest.raises(RuntimeError, match='REDIS_URL'):
        redis_clients.url()
    import app as app_module
    with pytest.raises(RuntimeError, match='REDIS_URL'):
        app_module.create_app('filesgg-no-redis')


# --- §18.1: the global limit and route limits over HTTP -----------------------------------------------------------

def test_the_global_limit(client, limits):
    limits(**{'global': '3 per minute'})
    ip = a_network()
    for _ in range(3):
        assert client.get('/auth/config', headers=from_ip(ip)).status_code == 200
    body = assert_limited(client.get('/auth/config', headers=from_ip(ip)), within=60)
    assert body['message'] == "You're doing that too fast"
    # every route shares it, and other networks have their own
    assert_limited(client.get('/mimetypes', headers=from_ip(ip)))
    assert client.get('/auth/config', headers=from_ip()).status_code == 200
    # 404s aren't limited (and don't count)
    other = a_network()
    for _ in range(5):
        assert client.get('/no/such/route', headers=from_ip(other)).status_code == 404
    assert client.get('/auth/config', headers=from_ip(other)).status_code == 200


def test_route_limits(client, appdb, limits):
    limits(guest='2 per minute', file_upload='1 per minute', chunked_upload='1 per minute')
    ip = a_network()
    # GET /auth/guest is per IP, signed in or not
    assert client.get('/auth/guest', headers=from_ip(ip)).status_code == 200
    assert client.get('/auth/guest', headers=sign_in(make_user(appdb), appdb) | from_ip(ip)).status_code == 200
    assert_limited(client.get('/auth/guest', headers=from_ip(ip)), within=60)
    assert client.get('/auth/guest', headers=from_ip()).status_code == 200
    # POST /files and POST /uploads, per client_key (a user here); a refusal comes before the body is looked at
    headers = sign_in(make_user(appdb), appdb)
    assert client.post('/files', headers=headers).status_code != 429
    assert_limited(client.post('/files', headers=headers))
    # a preflight only counts against the global limit
    assert client.options('/files', headers=headers).status_code == 204
    assert client.post('/uploads', headers=headers, json={}).status_code != 429
    assert_limited(client.post('/uploads', headers=headers, json={}))
    # the two are separate windows, and other users have their own
    assert client.post('/uploads', headers=sign_in(make_user(appdb), appdb), json={}).status_code != 429


# --- §18.1: client_key, internal lookups, staff, ctx_ratelimit_own ------------------------------------------------

def fake_request(auth=None, ip='10.1.2.3', internal=False, guest_id=None):
    from utils.auth import Auth
    return SimpleNamespace(ctx=SimpleNamespace(auth=auth or Auth(guest_id=guest_id), client_ip=ip,
                                               internal_lookup=internal), headers={})


def test_client_key_order():
    from safety import ip as abuse_ip
    from safety.settings import safety_settings
    from utils.auth import Auth
    user, key = SimpleNamespace(id=0x1f), SimpleNamespace(id=0x2a)
    assert ratelimit.client_key(fake_request(Auth('session', user))) == 'user:1f'
    assert ratelimit.client_key(fake_request(Auth('key', user, key=key))) == 'key:2a'
    digest = abuse_ip.abuse_ip_hash('10.1.2.3', safety_settings().abuse_hash_secret)
    # never the guest (the browser picks it)
    assert ratelimit.client_key(fake_request(guest_id=Snowflake.generate())) == 'ip:' + digest.hex()
    # IPv6 by /64
    assert ratelimit.client_key(fake_request(ip='2001:db8::1')) == ratelimit.client_key(fake_request(ip='2001:db8::2'))
    assert ratelimit.client_key(fake_request(ip='unknown')) == 'ip:0'
    # the Worker's own lookups skip every limit
    assert ratelimit.client_key(fake_request(Auth('session', user), internal=True)) is None


def test_guests_share_their_network_window(client, limits):
    limits(**{'global': '2 per minute'})
    ip = a_network()
    for _ in range(2):
        guest = {'Authorization': 'Guest ' + GuestToken.generate(Snowflake.generate())}
        assert client.get('/auth/config', headers=from_ip(ip, guest)).status_code == 200
    guest = {'Authorization': 'Guest ' + GuestToken.generate(Snowflake.generate())}
    assert_limited(client.get('/auth/config', headers=from_ip(ip, guest)))


def test_internal_lookups_are_never_limited(client, limits):
    limits(**{'global': '1 per minute'})
    lookup = {'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Internal-Lookup': '1'}
    for _ in range(4):
        assert client.get('/internal/files/nope1234', headers=lookup).status_code == 404
    assert keys() == []


def test_staff_skip_the_global_and_route_limits_only(client, appdb, limits):
    limits(**{'global': '1 per minute', 'reauth': '1 per hour'})
    staff_id = make_user(appdb, password='correct-horse')
    appdb.execute("INSERT INTO staff (user_id, role) VALUES (%s, 'moderator')", (staff_id,))
    staff = sign_in(staff_id, appdb)
    for _ in range(3):
        assert client.get('/auth/session', headers=staff).status_code == 200
    user = sign_in(make_user(appdb), appdb)
    assert client.get('/auth/session', headers=user).status_code == 200
    assert_limited(client.get('/auth/session', headers=user))
    # not the brute-force ones (§18.3)
    response = client.post('/auth/reauth', headers=staff, json={'password': 'wrong'})
    assert response.json()['code'] == 'INVALID_CREDENTIALS'
    assert_limited(client.post('/auth/reauth', headers=staff, json={'password': 'correct-horse'}), 'TOO_MANY_ATTEMPTS')


def test_own_limit_routes_skip_the_middleware():
    """`ctx_ratelimit_own=True`: no global or route limit is even looked at."""
    calls = []

    class Recorder(ratelimit.Limiter):
        async def check(self, request, checks, record=True, quiet=False):
            calls.append(checks)
            return []
    recorder = Recorder(key_func=lambda request: 'ip:0')
    own = SimpleNamespace(route=SimpleNamespace(ctx=SimpleNamespace(ratelimit_own=True), handler=lambda: None),
                          method='GET', path='/x', ctx=SimpleNamespace())
    plain = SimpleNamespace(route=SimpleNamespace(ctx=SimpleNamespace(), handler=lambda: None), method='GET',
                            path='/x', ctx=SimpleNamespace())
    unrouted = SimpleNamespace(route=None, method='GET', path='/x', ctx=SimpleNamespace())
    for request in (own, plain, unrouted):
        asyncio.run(recorder.check_request(request))
    assert len(calls) == 1 and [limit.scope for limit, _ in calls[0]] == ['global']


# --- §18.3: the moved limits over HTTP -------------------------------------------------------------------------------

def login(client, email, password, ip):
    return client.post('/auth/login', headers=dict(VIA_MAIN, **{'X-Filesgg-Client-Ip': ip}),
                       json={'email': email, 'password': password, 'turnstile_token': LOGIN_TOKEN})


def test_login_and_reauth_count_failures_only(client, appdb, limits):
    limits(login_account='2 per hour', reauth='2 per hour')
    user_id = make_user(appdb, username='rl_' + uuid.uuid4().hex[:10], password='correct-horse')
    email = appdb.fetchone('SELECT email FROM users WHERE id = %s', (user_id,))[0]
    for _ in range(3):
        assert login(client, email, 'correct-horse', a_network()).status_code == 200
    for _ in range(2):
        assert login(client, email, 'wrong', a_network()).json()['code'] == 'INVALID_CREDENTIALS'
    # from any network, even with the right password
    assert_limited(login(client, email, 'correct-horse', a_network()), 'TOO_MANY_ATTEMPTS', within=3600)
    headers = sign_in(user_id, appdb)
    for _ in range(3):
        assert client.post('/auth/reauth', headers=headers, json={'password': 'correct-horse'}).status_code == 204
    for _ in range(2):
        response = client.post('/auth/reauth', headers=headers, json={'password': 'wrong'})
        assert response.json()['code'] == 'INVALID_CREDENTIALS'
    assert_limited(client.post('/auth/reauth', headers=headers, json={'password': 'correct-horse'}),
                   'TOO_MANY_ATTEMPTS', within=3600)
    # keys are ids and hashes: no email and no address ever reaches Redis
    found = keys()
    assert found and not [key for key in found if '@' in key or '10.' in key or email.split('@')[0] in key]
    assert any(key.startswith('ratelimit:login_account:acct:') for key in found)
    assert any(key.startswith('ratelimit:reauth:user:{:x}:'.format(user_id)) for key in found)


def test_forgot_stays_silent(client, appdb, limits, outbox):
    limits(forgot_account='1 per hour')
    user_id = make_user(appdb, password='correct-horse')
    email = appdb.fetchone('SELECT email FROM users WHERE id = %s', (user_id,))[0]
    for _ in range(3):
        response = client.post('/auth/forgot', headers=dict(VIA_MAIN, **{'X-Filesgg-Client-Ip': a_network()}),
                               json={'email': email, 'turnstile_token': turnstile_token('forgot')})
        assert response.status_code == 204
    assert len(outbox) == 1


def test_register_and_retry_after(client, limits):
    ip = a_network()
    for _ in range(5):
        assert client.post('/auth/register', headers=dict(VIA_MAIN, **{'X-Filesgg-Client-Ip': ip}),
                           json={}).status_code == 400
    assert_limited(client.post('/auth/register', headers=dict(VIA_MAIN, **{'X-Filesgg-Client-Ip': ip}), json={}),
                   'TOO_MANY_ATTEMPTS', within=3600)


def test_postgres_limits_get_retry_after_too(client, appdb):
    """EXPORT_LIMIT stays in Postgres (one export a day, from `data_exports`), and still gets the header."""
    headers = sign_in(make_user(appdb), appdb)
    assert client.post('/users/@me/exports', headers=headers).status_code == 202
    response = client.post('/users/@me/exports', headers=headers)
    assert response.status_code == 429 and response.json()['code'] == 'EXPORT_LIMIT'
    assert int(response.headers['retry-after']) >= 1


def test_unlock_and_access_keys_use_the_daily_purpose_hash(monkeypatch):
    from utils import access, view_hash
    seen = []

    async def hit(request, scope, key, text=None, fail=None):
        seen.append((scope, key))
    monkeypatch.setattr(ratelimit.limiter, 'hit', hit)
    request = fake_request(ip='10.4.5.6')
    request.app = SimpleNamespace(ctx=SimpleNamespace(view_hash_secret='test-view-hash-secret'))
    asyncio.run(access.rate_limit(request, SimpleNamespace(id=0xabc), 'unlock'))
    asyncio.run(access.rate_limit(request, SimpleNamespace(id=0xdef), 'access', kind='album'))
    digest = view_hash.purpose_hash('test-view-hash-secret', 'unlock', view_hash.utc_today(), '10.4.5.6').hex()
    assert seen == [('unlock', 'file:abc:' + digest), ('access', 'album:def:' + digest)]


# --- §18.1: Redis down ---------------------------------------------------------------------------------------------

def test_redis_down_open_limits_let_it_through_closed_ones_answer_503(client, appdb, redis_down):
    started = time.time()
    # the global limit and the open ones
    assert client.get('/auth/config', headers=from_ip()).status_code == 200
    assert client.get('/users/@me/username/check?username=someone_new', headers=from_ip()).status_code == 200
    # the closed ones
    for path, body in (('/auth/register', {}),
                       ('/auth/login', {'email': 'a@example.com', 'password': 'x', 'turnstile_token': LOGIN_TOKEN}),
                       ('/auth/forgot', {'email': 'a@example.com', 'turnstile_token': turnstile_token('forgot')})):
        response = client.post(path, headers=dict(VIA_MAIN, **{'X-Filesgg-Client-Ip': a_network()}), json=body)
        assert (response.status_code, response.json()['code'], response.json()['message']) == \
            (503, 'RATE_LIMIT_UNAVAILABLE', 'Try again in a moment'), path
    headers = sign_in(make_user(appdb, password='correct-horse'), appdb)
    assert client.post('/auth/reauth', headers=headers, json={'password': 'x'}).status_code == 503
    # the sync side: open passes (None), closed refuses
    assert ratelimit_sync.hit('domain_check', 'domain:1') is None
    with pytest.raises(ApiError) as raised:
        ratelimit_sync.hit_many([('report', 'user:1')])
    assert (raised.value.status, raised.value.data['code']) == (503, 'RATE_LIMIT_UNAVAILABLE')
    # decided at once, not after seconds of retries
    assert time.time() - started < 10


# --- §18.5: removed ------------------------------------------------------------------------------------------------

def test_the_postgres_limits_are_gone(migrated_db):
    from db import queries
    from utils import account_settings, accounts, wrappers
    assert not {'safety_rate_limits', 'unlock_attempts'} & {
        row[0] for row in migrated_db.fetchall("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}
    assert not hasattr(wrappers, 'ratelimit')
    assert not [name for name in ('rate_hit', 'rate_peek', 'rate_limited', 'ip_key', 'email_key')
                if hasattr(accounts, name)]
    assert not hasattr(queries, 'count_attempt')
    assert not hasattr(account_settings, 'DEFAULT_AUTH_RATE_LIMITS')
    assert not hasattr(account_settings.account_settings(), 'rate_limits')
    found = []
    for root, dirs, files in os.walk(API_DIR):
        dirs[:] = [d for d in dirs if d not in ('migrations', 'tests', '__pycache__')]
        for name in files:
            if name.endswith('.py'):
                with open(os.path.join(root, name)) as handle:
                    text = handle.read()
                found += [(name, word) for word in ('safety_rate_limits', 'unlock_attempts', 'AUTH_RATE_LIMITS')
                          if word in text]
    assert found == []
