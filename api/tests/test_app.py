import json
import os
import subprocess
import sys
import uuid

import pytest

from tests.conftest import hash_of  # noqa: E402
from tests.conftest import API_DIR, APP_DATABASE, LOGIN_TOKEN, REGISTER_TOKEN, TURNSTILE_TOKEN, TempDatabase, s3_keys, s3_object, subprocess_env

from db.models import File, FileHash
from utils import helpers
from utils.generators import Snowflake
from utils.responses import ApiError
from utils.tokens import FingerprintToken, UserToken


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


def seed_mimetypes(appdb):
    appdb.execute("INSERT INTO mimetype_types (id) VALUES ('text'), ('application') ON CONFLICT DO NOTHING")
    appdb.execute(
        "INSERT INTO mimetypes (id, flags, type_id) VALUES ('text/plain', 0, 'text'), "
        "('application/x-thing', 0, 'application') ON CONFLICT DO NOTHING")
    appdb.execute(
        "INSERT INTO mimetype_extensions (mimetype_id, extension, priority) VALUES ('text/plain', 'txt', 1) "
        "ON CONFLICT DO NOTHING")


def make_file(appdb, extension):
    seed_mimetypes(appdb)
    content = uuid.uuid4().hex
    hash_id, file_id = Snowflake.generate(), Snowflake.generate()
    appdb.execute(
        'INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (%s, %s, %s, %s, 5)',
        (hash_id, content, content[:40], content[:32]))
    vanity = 'v' + uuid.uuid4().hex[:10]
    appdb.execute(
        'INSERT INTO files (id, vanity, mimetype_id, extension, filename, hash_id, view_count) '
        'VALUES (%s, %s, %s, %s, %s, %s, 0)',
        (file_id, vanity, 'application/x-thing' if extension is None else 'text/plain', extension, 'thing', hash_id))
    return File(id=file_id, vanity=vanity, mimetype_id='application/x-thing' if extension is None else 'text/plain',
                extension=extension, filename='thing', hash_id=hash_id, user_id=None, fingerprint=None,
                view_count=0, hash=FileHash(hash_id, content, content[:40], content[:32], 5, None, None, None))


def make_user(appdb):
    suffix = uuid.uuid4().hex[:10]
    user_id = Snowflake.generate()
    appdb.execute(
        'INSERT INTO users (id, email, bot, username, discriminator, password, flags, verified, '
        'last_email_reset, last_password_reset) VALUES (%s, %s, false, %s, 1, %s, 0, false, 1500000000, 1500000000)',
        (user_id, 'u{}@example.com'.format(suffix), 'user' + suffix, helpers.hash_password('password1')))
    return user_id, 'u{}@example.com'.format(suffix)


# --- boot -------------------------------------------------------------------

@pytest.mark.parametrize('missing', ['SECRET_KEY', 'RPC_KEY', 'VIEW_HASH_SECRET'])
def test_boot_fails_without_secrets(missing):
    for value in (None, ''):
        result = subprocess.run(
            [sys.executable, '-c', 'import app; app.create_app()'], cwd=API_DIR, capture_output=True, text=True,
            timeout=60,
            # an unreachable database proves the check happens before anything else
            env=subprocess_env(**{missing: value, 'DATABASE_URL': 'postgresql://nobody@127.0.0.1:1/none'}),
        )
        assert result.returncode != 0
        assert 'Refusing to start: missing required secret(s) {}'.format(missing) in result.stderr


def test_sanic_cli_refuses_to_start_without_secrets():
    result = subprocess.run(
        [sys.executable, '-m', 'sanic', 'app:create_app', '--factory', '--single-process', '--port', '1'],
        cwd=API_DIR, capture_output=True, text=True, timeout=60, env=subprocess_env(SECRET_KEY=None),
    )
    assert result.returncode != 0
    assert 'missing required secret(s) SECRET_KEY' in result.stdout + result.stderr


def test_app_holds_a_snowflake_lease(client):
    lease = client.app.ctx.lease
    assert lease is not None and lease.current_node_id() == Snowflake.get_node_id()
    assert Snowflake.decode(Snowflake.generate())['node_id'] == lease.node_id


# --- health -------------------------------------------------------------------

@pytest.mark.parametrize('path', ['/health', '/google/health-check'])
def test_health(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert response.json() == {'status': 'ok', 'checks': {'database': 'ok'}}


def test_health_reports_database_failure(client, monkeypatch):
    import views.health

    def broken(*args, **kwargs):
        raise RuntimeError('db down')

    monkeypatch.setattr(views.health.db, 'connection', broken)
    response = client.get('/health')
    assert response.status_code == 503
    assert response.json()['status'] == 'error'


# --- CORS ---------------------------------------------------------------------

@pytest.mark.parametrize('origin', ['https://files.gg', 'https://beta.files.gg'])
def test_cors_allowlisted_origin_is_reflected_with_credentials(client, origin):
    for response in (client.get('/health', headers={'Origin': origin}),
                     client.options('/files', headers={'Origin': origin,
                                                       'Access-Control-Request-Method': 'POST'})):
        assert response.headers['access-control-allow-origin'] == origin
        assert response.headers['access-control-allow-credentials'] == 'true'
        assert response.headers['access-control-allow-headers'] == 'Authorization, Content-Type, X-Fingerprint'
        assert 'Origin' in response.headers.get('vary', '')


def test_cors_foreign_origin_gets_wildcard_without_credentials(client):
    for response in (client.get('/health', headers={'Origin': 'https://evil.example'}),
                     client.options('/files', headers={'Origin': 'https://files.gg.evil.example',
                                                       'Access-Control-Request-Method': 'POST'})):
        assert response.headers['access-control-allow-origin'] == '*'
        assert 'access-control-allow-credentials' not in response.headers
        assert response.headers['access-control-allow-headers'] == 'Authorization, Content-Type, X-Fingerprint'


def test_no_cors_headers_without_origin(client):
    response = client.get('/health')
    assert 'access-control-allow-origin' not in response.headers
    assert response.headers['cache-control'] == 'no-cache, no-store'


# --- bug fixes ------------------------------------------------------------------

def test_to_dict_with_null_extension(client, appdb):
    fobj = make_file(appdb, extension=None)
    data = fobj.to_dict()
    assert data['urls'] == {
        'main': 'https://files.gg/' + fobj.vanity,
        'cdn': 'https://cdn.files.gg/files/' + fobj.vanity,
    }
    assert data['extension'] == 'unknown'  # unchanged behaviour


def test_to_dict_with_extension(client, appdb):
    fobj = make_file(appdb, extension='txt')
    assert fobj.to_dict()['urls']['main'] == 'https://files.gg/{}.txt'.format(fobj.vanity)


ORIGIN_SECRET = 'test-origin-secret'  # conftest sets ORIGIN_SHARED_SECRET to this
PEER = '127.0.0.1'


VIEW_HASH_SECRET = 'test-view-hash-secret'  # conftest / docker-compose.test.yml


def hashed(ip, day=None):
    from utils import view_hash
    return view_hash.ip_hash(VIEW_HASH_SECRET, day or view_hash.utc_today(), ip)


def recorded_ip(client, appdb, headers):
    """The (hashed) IP the view counter recorded for one request with these headers."""
    fobj = make_file(appdb, extension=None)
    response = client.get('/files/' + fobj.vanity, headers=headers)
    assert response.status_code == 200
    assert response.json()['views'] == 1
    return bytes(appdb.fetchone('SELECT ip_hash FROM file_view_seen WHERE file_id = %s', (fobj.id,))[0])


@pytest.mark.parametrize('headers, expected', [
    # through the worker: the secret matches, so its client-IP header is used
    ({'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Client-Ip': '203.0.113.5',
      'X-Forwarded-For': '172.68.1.1'}, '203.0.113.5'),
    ({'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Client-Ip': '2001:db8::1'}, '2001:db8::1'),
    # right secret, unusable client IP: fall back to X-Forwarded-For / peer
    ({'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Client-Ip': 'not-an-ip'}, PEER),
    ({'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Forwarded-For': '172.68.1.1'}, '172.68.1.1'),
    # wrong or missing secret: the client-IP header is ignored
    ({'X-Filesgg-Origin-Secret': 'wrong', 'X-Filesgg-Client-Ip': '203.0.113.5'}, PEER),
    ({'X-Filesgg-Origin-Secret': ORIGIN_SECRET + 'x', 'X-Filesgg-Client-Ip': '203.0.113.5'}, PEER),
    ({'X-Filesgg-Origin-Secret': '', 'X-Filesgg-Client-Ip': '203.0.113.5'}, PEER),
    ({'X-Filesgg-Client-Ip': '203.0.113.5', 'X-Forwarded-For': '198.51.100.4'}, '198.51.100.4'),
    # spoofed CF-Connecting-IP without the secret: ignored
    ({'CF-Connecting-IP': '203.0.113.9'}, PEER),
    ({'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '198.51.100.4'}, '198.51.100.4'),
    # injected X-Forwarded-For chain: only the last hop (PROXIES_COUNT=1) counts
    ({'X-Forwarded-For': '1.1.1.1, 2.2.2.2, 198.51.100.4'}, '198.51.100.4'),
    ({'X-Forwarded-For': '1.1.1.1, not-an-ip'}, PEER),
], ids=['worker', 'worker-ipv6', 'worker-bad-ip', 'worker-no-ip', 'wrong-secret', 'longer-secret',
        'empty-secret', 'no-secret', 'spoofed-cf', 'spoofed-cf-xff', 'xff-chain', 'xff-garbage'])
def test_client_ip_resolution(client, appdb, headers, expected):
    assert recorded_ip(client, appdb, headers) == hashed(expected)


def test_client_ip_without_a_configured_secret(client, appdb, monkeypatch):
    monkeypatch.setattr(client.app.ctx, 'origin_secret', None)
    headers = {'X-Filesgg-Origin-Secret': '', 'X-Filesgg-Client-Ip': '203.0.113.5'}
    assert recorded_ip(client, appdb, headers) == hashed(PEER)
    headers = {'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Client-Ip': '203.0.113.5'}
    assert recorded_ip(client, appdb, headers) == hashed(PEER)


@pytest.mark.parametrize('proxies, expected', [(0, PEER), (1, '3.3.3.3'), (2, '2.2.2.2'), (5, PEER)])
def test_proxies_count_picks_the_forwarded_hop(client, appdb, monkeypatch, proxies, expected):
    monkeypatch.setattr(client.app.ctx, 'proxies_count', proxies)
    # two header lines are combined, in order
    headers = [('X-Forwarded-For', '1.1.1.1, 2.2.2.2'), ('X-Forwarded-For', '3.3.3.3')]
    assert recorded_ip(client, appdb, headers) == hashed(expected)


def test_views_are_counted_once_per_client(client, appdb):
    fobj = make_file(appdb, extension=None)
    through_worker = {'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Client-Ip': '203.0.113.9'}
    assert client.get('/files/' + fobj.vanity, headers=through_worker).json()['views'] == 1
    assert client.get('/files/' + fobj.vanity, headers=through_worker).json()['views'] == 1
    # rotating a spoofed header does not mint new views
    assert client.get('/files/' + fobj.vanity, headers={'CF-Connecting-IP': '10.9.9.9'}).json()['views'] == 2
    assert client.get('/files/' + fobj.vanity, headers={'CF-Connecting-IP': '10.9.9.8'}).json()['views'] == 2


def test_origin_secret_never_reaches_logs_or_errors(client, appdb, monkeypatch, caplog):
    from db import queries

    seen = {}

    async def broken(conn, vanity):
        seen['headers'] = dict(_current_request().headers)
        raise RuntimeError('boom')

    import sanic
    def _current_request():
        return sanic.Request.get_current()

    monkeypatch.setattr(queries, 'get_file_by_vanity', broken)
    caplog.set_level('DEBUG')
    response = client.get('/files/anything', headers={'X-Filesgg-Origin-Secret': ORIGIN_SECRET,
                                                      'X-Filesgg-Client-Ip': '203.0.113.5'})
    assert response.status_code == 500
    assert ORIGIN_SECRET not in response.text
    assert ORIGIN_SECRET not in caplog.text
    assert 'boom' in caplog.text  # the error itself was logged
    assert 'x-filesgg-origin-secret' not in {k.lower() for k in seen['headers']}
    assert ORIGIN_SECRET not in response.text + str(response.headers)


def test_views_are_daily_counts_without_raw_ips(client, appdb, monkeypatch):
    from datetime import date
    from utils import view_hash
    fobj = make_file(appdb, extension=None)
    alice = {'X-Forwarded-For': '198.51.100.10'}
    bob = {'X-Forwarded-For': '198.51.100.11'}
    get = lambda headers: client.get('/files/' + fobj.vanity, headers=headers).json()['views']  # noqa: E731

    monkeypatch.setattr(view_hash, 'utc_today', lambda: date(2026, 11, 24))
    assert [get(alice), get(alice), get(bob), get(alice)] == [1, 1, 2, 2]
    # a new UTC day: a new key, so the same IP is unique again (per-day semantics)
    monkeypatch.setattr(view_hash, 'utc_today', lambda: date(2026, 11, 25))
    assert [get(alice), get(alice)] == [3, 3]

    days = appdb.fetchall('SELECT day, views, unique_views FROM file_view_days WHERE file_id = %s ORDER BY day',
                          (fobj.id,))
    assert [(str(d), v, u) for d, v, u in days] == [('2026-11-24', 4, 2), ('2026-11-25', 2, 1)]
    assert appdb.fetchone('SELECT view_count FROM files WHERE id = %s', (fobj.id,))[0] == 3
    hashes = {bytes(r[0]) for r in appdb.fetchall('SELECT ip_hash FROM file_view_seen WHERE file_id = %s', (fobj.id,))}
    # the daily key rotates: the same IP hashes differently each day, and no IP is stored
    assert hashes == {hashed('198.51.100.10', date(2026, 11, 24)), hashed('198.51.100.11', date(2026, 11, 24)),
                      hashed('198.51.100.10', date(2026, 11, 25))}
    assert hashed('198.51.100.10', date(2026, 11, 24)) != hashed('198.51.100.10', date(2026, 11, 25))
    assert appdb.fetchone('SELECT count(*) FROM file_views WHERE file_id = %s', (fobj.id,))[0] == 0


def test_token_check_around_a_password_reset(client, appdb, monkeypatch):
    """Tokens issued before the last password reset are rejected, from the new
    timestamptz column, exactly as before: 1 s before fails, 1 s after works."""
    import time as time_module
    from datetime import datetime, timezone
    user_id, _ = make_user(appdb)
    reset = int(time_module.time()) - 100
    appdb.execute('UPDATE users SET last_password_reset_at = %s, last_password_reset = %s WHERE id = %s',
                  (datetime.fromtimestamp(reset, timezone.utc), reset, user_id))

    real_time = time_module.time

    def token_at(seconds):
        monkeypatch.setattr(time_module, 'time', lambda: seconds + 0.5)
        try:
            return UserToken.generate(user_id)
        finally:
            monkeypatch.setattr(time_module, 'time', real_time)

    me = lambda token: client.get('/users/@me', headers={'Authorization': token}).status_code  # noqa: E731
    assert me(token_at(reset - 1)) == 401
    assert me(token_at(reset)) == 200
    assert me(token_at(reset + 1)) == 200


def test_password_reset_writes_both_timestamp_columns(client, appdb):
    import time as time_module
    from utils.tokens import EmailForgotToken
    user_id, email = make_user(appdb)
    old_token = UserToken.generate(user_id)
    assert client.get('/users/@me', headers={'Authorization': old_token}).status_code == 200

    token = EmailForgotToken.generate({'user_id': user_id, 'email': email})
    time_module.sleep(1.1)  # the reset must land in a later second than the old token
    response = client.post('/auth/forgot/reset', json={'token': token, 'password': 'brand-new-pw'})
    assert response.status_code == 204, response.text
    at, legacy = appdb.fetchone('SELECT last_password_reset_at, last_password_reset FROM users WHERE id = %s',
                                (user_id,))
    assert int(at.timestamp()) == legacy and abs(legacy - time_module.time()) < 5
    assert client.get('/users/@me', headers={'Authorization': old_token}).status_code == 401
    time_module.sleep(1)  # the reset second is rounded (as Peewee did), so it may be the next one
    assert client.get('/users/@me', headers={'Authorization': UserToken.generate(user_id)}).status_code == 200


def test_get_user_unknown_id_is_404(client):
    token = UserToken.generate(999999999999)
    response = client.get('/users/@me', headers={'Authorization': token})
    assert response.status_code == 404
    assert response.json() == {'code': 0, 'message': 'Unknown User', 'status': 404}


async def test_get_user_helper_raises_404(migrated_db):
    from psycopg import AsyncConnection
    async with await AsyncConnection.connect(migrated_db.url, autocommit=True) as conn:
        with pytest.raises(ApiError) as raised:
            await helpers.get_user(conn, UserToken.generate(123))
    assert raised.value.status == 404


def test_get_user_bad_token_is_401(client):
    assert client.get('/users/@me', headers={'Authorization': 'garbage'}).status_code == 401


# --- existing routes still work ------------------------------------------------------

def test_me_with_valid_token(client, appdb):
    user_id, email = make_user(appdb)
    response = client.get('/users/@me', headers={'Authorization': UserToken.generate(user_id)})
    assert response.status_code == 200
    assert response.json()['email'] == email


def stored_blobs():
    return s3_keys('files/')


def test_fingerprint_and_upload_flow(client, appdb):
    seed_mimetypes(appdb)
    fingerprint = client.get('/auth/fingerprint').json()['fingerprint']
    headers = {'X-Fingerprint': fingerprint}
    before = len(stored_blobs())

    payload = uuid.uuid4().bytes
    response = client.post('/files', headers=headers, files={'file': ('notes.txt', payload, 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    assert response.status_code == 200, response.text
    created = response.json()
    assert created['extension'] == 'txt' and created['name'] == 'notes'
    assert created['urls']['main'].endswith('.txt')
    assert len(stored_blobs()) == before + 1
    assert s3_object('files/' + hash_of(appdb, created)) == payload

    # same bytes again: de-duplicated, no second blob upload
    response = client.post('/files', headers=headers, files={'file': ('again.txt', payload, 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    assert response.status_code == 200
    assert 'hash' not in response.json()
    assert hash_of(appdb, response.json()) == hash_of(appdb, created)
    assert len(stored_blobs()) == before + 1

    # raw upload, streamed
    raw = uuid.uuid4().bytes * 1000
    response = client.post('/files?type=raw&filename=raw.txt&turnstile_token=' + TURNSTILE_TOKEN,
                           headers=dict(headers, **{'Content-Type': 'text/plain'}),
                           content=raw)
    assert response.status_code == 200, response.text
    assert response.json()['size'] == len(raw)

    listing = client.get('/files', headers=headers)
    assert listing.status_code == 200
    assert listing.json()['total'] == 3

    count = client.get('/users/@me/file-count', headers=headers)
    assert count.json() == {'count': 3}


def test_login_and_register_claim_anonymous_files(client, appdb, monkeypatch):
    import views.auth
    from utils.email import Email

    sent = []

    async def domain_accepts_mail(address):
        return True

    async def send(**message):
        sent.append(message)

    monkeypatch.setattr(views.auth, 'domain_accepts_mail', domain_accepts_mail)
    monkeypatch.setattr(Email, 'send', staticmethod(send))
    seed_mimetypes(appdb)

    def upload(fingerprint):
        response = client.post('/files', headers={'X-Fingerprint': fingerprint},
                               files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')},
                               data={'turnstile_token': TURNSTILE_TOKEN})
        assert response.status_code == 200
        return response.json()['id']

    # register with a fingerprint: the account takes the fingerprint's id and its files
    fingerprint_id = Snowflake.generate()
    fingerprint = FingerprintToken.generate(fingerprint_id)
    file_id = upload(fingerprint)
    username = 'reg' + uuid.uuid4().hex[:8]
    email = username + '@example.com'
    response = client.post('/auth/register', headers={'X-Fingerprint': fingerprint},
                           json={'email': email, 'username': username, 'password': 'hunter22',
                                 'turnstile_token': REGISTER_TOKEN})
    assert response.status_code == 200, response.text
    token = response.json()['token']
    me = client.get('/users/@me', headers={'Authorization': token}).json()
    assert me['id'] == str(fingerprint_id) and me['discriminator'] == '0001' and me['verified'] is False
    assert appdb.fetchone('SELECT user_id, fingerprint FROM files WHERE id = %s', (int(file_id),)) == (fingerprint_id, None)
    assert sent and sent[0]['to'] == email and sent[0]['to_name'] == username and sent[0]['tag'] == 'auth-verify'
    assert '/auth/verify/' in sent[0]['text']
    stored = appdb.fetchone('SELECT password FROM users WHERE id = %s', (fingerprint_id,))[0]
    assert stored.startswith('pbkdf2:sha256:') and len(stored) <= 128

    # log in (form-encoded) with another fingerprint: its files are claimed
    other = FingerprintToken.generate(Snowflake.generate())
    other_file = upload(other)
    response = client.post('/auth/login', headers={'X-Fingerprint': other},
                           data={'email': email, 'password': 'hunter22', 'captcha': LOGIN_TOKEN})
    assert response.status_code == 200, response.text
    assert appdb.fetchone('SELECT user_id FROM files WHERE id = %s', (int(other_file),))[0] == fingerprint_id

    response = client.post('/auth/login', json={'email': email, 'password': 'wrong-password',
                                                'turnstile_token': LOGIN_TOKEN})
    assert response.status_code == 400 and response.json()['message'] == 'Invalid Email or Password'


def test_legacy_password_hash_still_verifies(client, appdb, monkeypatch):
    """A Werkzeug 0.14 default hash (pbkdf2:sha256, 50000 rounds)."""
    from werkzeug.security import generate_password_hash
    user_id, email = make_user(appdb)
    appdb.execute('UPDATE users SET password = %s WHERE id = %s',
                  (generate_password_hash('old-password', method='pbkdf2:sha256:50000', salt_length=8), user_id))
    response = client.post('/auth/login', json={'email': email, 'password': 'old-password',
                                                'turnstile_token': LOGIN_TOKEN})
    assert response.status_code == 200


def test_validation_errors_keep_their_shape(client):
    fingerprint = FingerprintToken.generate(Snowflake.generate())
    response = client.get('/files?limit=0', headers={'X-Fingerprint': fingerprint})
    assert response.status_code == 400
    assert response.json() == {'errors': {'limit': 'Must be at least or in between 1 and 100'},
                               'code': 0, 'message': 'Bad Request', 'status': 400}

    response = client.post('/auth/login', json={'email': 'not-an-email'})
    assert response.status_code == 400
    errors = response.json()['errors']
    assert errors['email'] == 'Not a well formed email address'
    assert errors['password'].startswith('Missing required parameter')


def test_files_requires_auth(client):
    assert client.get('/files').status_code == 401


def test_unknown_file_error_code(client):
    assert client.get('/files/does-not-exist').json() == {'code': 140401, 'message': 'Unknown File', 'status': 404}


def test_mimetypes_and_users_routes(client, appdb):
    seed_mimetypes(appdb)
    listing = client.get('/mimetypes')
    assert listing.status_code == 200
    assert any(m['mimetype'] == 'text/plain' for m in listing.json())
    assert client.get('/mimetypes/text/plain').json()['extensions'][0]['extension'] == 'txt'
    assert client.get('/mimetypes/nope/nope').status_code == 404
    assert client.get('/users/123').json() == {'id': 123}
    assert client.get('/users/-5').status_code == 404
    assert client.get('/users/someone/file-count').status_code == 404
    assert client.get('/users/%40me/file-count').status_code == 401  # encoded '@' still routes


def test_openapi_and_docs(client):
    spec = client.get('/openapi.json')
    assert spec.status_code == 200
    paths = spec.json()['paths']
    assert {'/files', '/files/{vanity}', '/auth/login', '/users/{user_id}', '/users/{me}/file-count',
            '/health', '/mimetypes/{mtype}/{subtype}'} <= set(paths)
    assert client.get('/docs').status_code == 404  # DEBUG is off


def test_docs_only_with_debug(monkeypatch):
    import app as app_module
    from tests.conftest import Client
    from utils.generators import Snowflake as Generator
    monkeypatch.setenv('DEBUG', '1')
    saved = Generator.node_provider
    try:
        with Client(app_module.create_app('filesgg-test-debug')) as debug_client:
            assert debug_client.get('/docs').status_code == 200
            assert debug_client.get('/openapi.json').status_code == 200
    finally:
        Generator.node_provider = saved


# --- compatibility --------------------------------------------------------------

def test_tokens_issued_by_the_old_stack_still_validate(monkeypatch):
    """Tokens generated with itsdangerous 1.1.0 / Flask 1.0.2 (the pre-upgrade
    stack) under SECRET_KEY='compat-secret'."""
    from utils import tokens
    monkeypatch.setattr(tokens, '_secret_key', 'compat-secret')
    # A files.gg UserToken issued by the old stack for the fake user id 123456789012345678, signed
    # with the test-only key above: not a credential. It's kept as its three parts because the
    # joined string has the same shape as a Discord bot token and trips secret scanners.
    user_token = '.'.join([
        'MTIzNDU2Nzg5MDEyMzQ1Njc4',
        'awXPsg',
        'b_yhdJNiJNQiXnCEQ5x6SSSbNbM',
    ])
    assert UserToken.deconstruct(user_token) == 123456789012345678
    assert UserToken.validate(user_token, min_timestamp=0)
    assert FingerprintToken.deconstruct('NDI.nrNuiKSKilhUwh5PJynzb99DQNQ') == 42


def test_password_hashes_fit_the_column():
    hashed = helpers.hash_password('correct horse battery staple', salt_length=10)
    assert hashed.startswith('pbkdf2:sha256:') and len(hashed) <= 128
    from werkzeug.security import check_password_hash
    assert check_password_hash(hashed, 'correct horse battery staple')


def test_json_serialisation_matches_flask():
    from utils.responses import ApiResponse
    response = ApiResponse({'name': 'ünï "q" 😀', 'n': None, 'ok': True})
    assert response.body == json.dumps({'name': 'ünï "q" 😀', 'n': None, 'ok': True}).encode()
    assert response.content_type == 'application/json'
