import json
import os
import re
import subprocess
import sys
import uuid

import pytest

from tests.conftest import hash_of  # noqa: E402
from tests.conftest import API_DIR, APP_DATABASE, LOGIN_TOKEN, REGISTER_TOKEN, TURNSTILE_TOKEN, TempDatabase, s3_keys, s3_object, subprocess_env
from tests.conftest import VIA_MAIN, cookie_headers, new_session, sign_in
from tests.conftest import make_user as make_account

from db.models import File, FileHash
from utils.generators import Snowflake
from utils.tokens import GuestToken


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


def seed_mimetypes(appdb):
    """text/plain comes from the migrations' seed; add a type with no extensions."""
    appdb.execute("INSERT INTO mimetypes (id, flags, type_id) VALUES ('application/x-thing', 0, 'application') "
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
        'INSERT INTO files (id, vanity, mimetype_id, extension, filename, hash_id, size) '
        'VALUES (%s, %s, %s, %s, %s, %s, 5)',
        (file_id, vanity, 'application/x-thing' if extension is None else 'text/plain', extension, 'thing', hash_id))
    return File(id=file_id, vanity=vanity, mimetype_id='application/x-thing' if extension is None else 'text/plain',
                extension=extension, filename='thing', hash_id=hash_id, user_id=None, guest_id=None,
                view_count=0, size=5, hash=FileHash(hash_id, content, content[:40], content[:32], 5))


def make_user(appdb):
    suffix = uuid.uuid4().hex[:10]
    user_id = make_account(appdb, username='user' + suffix, email='u{}@example.com'.format(suffix), verified=False,
                           password='password1')
    return user_id, 'u{}@example.com'.format(suffix)


# --- boot -------------------------------------------------------------------

@pytest.mark.parametrize('missing', ['SECRET_KEY', 'RPC_KEY', 'VIEW_HASH_SECRET', 'CDN_SIGNING_SECRET'])
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

def test_health(client):
    response = client.get('/health')
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

@pytest.mark.parametrize('origin', ['https://files.gg', 'https://beta.files.gg', 'https://evil.example'])
def test_cors_is_public_and_never_credentialed(client, origin):
    """Milestone-6 §12: the website calls files.gg/api same-origin, so no origin gets credentialed CORS, and the
    CSRF header is never allowed cross-origin."""
    for response in (client.get('/health', headers={'Origin': origin}),
                     client.options('/files', headers={'Origin': origin, 'Access-Control-Request-Method': 'POST'})):
        assert response.headers['access-control-allow-origin'] == '*'
        assert 'access-control-allow-credentials' not in response.headers
        assert response.headers['access-control-allow-headers'] == \
            'Authorization, Content-Type, X-Filesgg-Access'
        assert 'x-filesgg-csrf' not in response.headers['access-control-allow-headers'].lower()
        assert 'Origin' in response.headers.get('vary', '')


def test_no_cors_headers_without_origin(client):
    response = client.get('/health')
    assert 'access-control-allow-origin' not in response.headers
    assert response.headers['cache-control'] == 'no-cache, no-store'


# --- bug fixes ------------------------------------------------------------------

def test_payload_without_an_extension(client, appdb):
    fobj = make_file(appdb, extension=None)
    data = client.get('/files/' + fobj.vanity).json()
    # no extension: the URLs are just the vanity, with no trailing dot
    assert data['url'] == 'https://files.gg/' + fobj.vanity
    assert data['cdn_url'] == 'https://cdn.files.gg/files/' + fobj.vanity
    assert data['extension'] is None and data['filename'] == data['name'] == 'thing'


def test_payload_with_an_extension(client, appdb):
    fobj = make_file(appdb, extension='txt')
    data = client.get('/files/' + fobj.vanity).json()
    assert data['url'] == 'https://files.gg/{}.txt'.format(fobj.vanity)
    assert data['cdn_url'] == 'https://cdn.files.gg/files/{}.txt'.format(fobj.vanity)
    assert data['extension'] == 'txt' and data['filename'] == 'thing.txt'


def test_one_file_payload_shape(client, appdb):
    """snake_case, epoch seconds, no camelCase duplicates and no old `urls` object."""
    fobj = make_file(appdb, extension='txt')
    data = client.get('/files/' + fobj.vanity).json()
    assert set(data) == {
        'id', 'vanity', 'kind', 'name', 'extension', 'filename', 'mimetype', 'size', 'url', 'cdn_url',
        'visibility', 'uploaded_at', 'expires_at', 'views', 'media', 'width', 'height', 'duration', 'framecount',
        'processing', 'assets', 'nsfw',
        # milestone-4 §6.1
        'warnings', 'link_warnings', 'link_warning_types',
    }
    assert data['uploaded_at'] == Snowflake.decode(fobj.id)['timestamp'] // 1000
    assert data['expires_at'] is None and data['kind'] == 'text' and data['views'] == 1


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


def test_sessions_are_rows_revoked_by_a_password_reset(client, appdb, outbox):
    """Rewritten for milestone-6 §3.4 (was: itsdangerous tokens older than last_password_reset_at): a reset by
    email ends every session row and starts a new one (cookie replaced)."""
    from utils import credentials
    user_id, email = make_user(appdb)
    old = sign_in(user_id, appdb)
    assert client.get('/users/@me', headers=old).status_code == 200
    token = 'reset-' + uuid.uuid4().hex + uuid.uuid4().hex
    appdb.execute("INSERT INTO account_tokens (id, user_id, purpose, email, token_hash, expires_at) VALUES "
                  "(%s, %s, 'reset_password', %s, %s, now() + interval '1 hour')",
                  (Snowflake.generate(), user_id, email, credentials.email_token_hash(token)))
    response = client.post('/auth/forgot/reset', headers=VIA_MAIN, json={
        'token': token, 'password': 'brand-new-pw', 'turnstile_token': 'mock:reset:files.gg'})
    assert response.status_code == 200, response.text
    assert response.json()['user']['email_verified'] is True
    assert client.get('/users/@me', headers=old).status_code == 401
    reasons = appdb.fetchall('SELECT revoked_reason FROM sessions WHERE user_id = %s ORDER BY id', (user_id,))
    assert reasons[0][0] == 'password_reset' and reasons[-1][0] is None
    cookie = response.headers['set-cookie']
    assert cookie.startswith('__Host-filesgg_session=fgs_') and 'HttpOnly' in cookie
    new = cookie.split(';')[0].split('=', 1)[1]
    assert client.get('/users/@me', headers=cookie_headers(new)).status_code == 200
    assert [m['tag'] for m in outbox] == ['auth-password-changed']


def test_a_deleted_accounts_session_is_401(client, appdb):
    user_id, _ = make_user(appdb)
    headers = sign_in(user_id, appdb)
    appdb.execute("UPDATE users SET deleted_at = now(), email = NULL, username = 'deleted-' || id WHERE id = %s",
                  (user_id,))
    response = client.get('/users/@me', headers=headers)
    assert (response.status_code, response.json()['code']) == (401, 'UNAUTHORIZED')
    assert 'Max-Age=0' in response.headers['set-cookie']


def test_user_tokens_in_authorization_are_401(client, appdb):
    """Rewritten for milestone-6 §3.4: no user token in `Authorization`, ever (Bearer included)."""
    user_id, _ = make_user(appdb)
    token = new_session(user_id, appdb)
    for value in ('garbage', token, 'Bearer ' + token, 'User ' + token):
        response = client.get('/users/@me', headers={'Authorization': value})
        assert (response.status_code, response.json()['code']) == (401, 'UNAUTHORIZED'), value


# --- existing routes still work ------------------------------------------------------

def test_me_with_a_session(client, appdb):
    user_id, email = make_user(appdb)
    response = client.get('/users/@me', headers=sign_in(user_id, appdb))
    assert response.status_code == 200
    assert response.json()['email'] == email


def stored_blobs():
    return s3_keys('files/')


def test_guest_and_upload_flow(client, appdb):
    seed_mimetypes(appdb)
    guest = client.get('/auth/guest').json()['guest']
    headers = {'Authorization': 'Guest ' + guest}
    before = len(stored_blobs())

    payload = uuid.uuid4().bytes
    response = client.post('/files', headers=headers, files={'file': ('notes.txt', payload, 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    assert response.status_code == 200, response.text
    created = response.json()
    assert created['extension'] == 'txt' and created['name'] == 'notes'
    assert created['url'].endswith('.txt') and created['cdn_url'].endswith('.txt')
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

    listing = client.get('/users/@me/files', headers=headers)
    assert listing.status_code == 200
    assert listing.json()['total']['count'] == 3


def test_authorization_guest_only_names_a_guest(client):
    """milestone-5 §20.1: `Authorization: Guest` names the guest and never a user; an invalid token is ignored;
    `Key` and `Guest` never come together; any other scheme stays 401."""
    guest = client.get('/auth/guest').json()['guest']
    headers = {'Authorization': 'Guest ' + guest}
    again = client.get('/auth/guest', headers=headers).json()['guest']
    assert GuestToken.deconstruct(again) == GuestToken.deconstruct(guest)
    assert client.get('/users/@me/files', headers=headers).status_code == 200
    assert client.get('/users/@me', headers=headers).status_code == 401
    for authorization in ('Guest nope', 'Guest', 'Bearer ' + guest):
        response = client.get('/users/@me/files', headers={'Authorization': authorization})
        assert (response.status_code, response.json()['code']) == (401, 'UNAUTHORIZED'), authorization
    both = [('Authorization', 'Guest ' + guest), ('Authorization', 'Key fgg_nope')]
    response = client.post('/uploads', headers=both, json={'filename': 'a.bin', 'size': 10})
    assert (response.status_code, response.json()['code']) == (401, 'UNAUTHORIZED')


def test_login_and_register_claim_anonymous_files(client, appdb, monkeypatch, outbox):
    """Rewritten for milestone-6 §4.2: a new account gets a fresh Snowflake id (never the guest's), and
    register and login claim the guest's files and albums."""
    import views.auth

    async def domain_accepts_mail(address):
        return True

    monkeypatch.setattr(views.auth, 'domain_accepts_mail', domain_accepts_mail)
    seed_mimetypes(appdb)

    def upload(guest):
        response = client.post('/files', headers={'Authorization': 'Guest ' + guest},
                               files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')},
                               data={'turnstile_token': TURNSTILE_TOKEN})
        assert response.status_code == 200
        return response.json()['id']

    guest_id = Snowflake.generate()
    guest = GuestToken.generate(guest_id)
    file_id = upload(guest)
    username = 'reg' + uuid.uuid4().hex[:8]
    email = username + '@example.com'
    response = client.post('/auth/register', headers=dict(VIA_MAIN, **{'Authorization': 'Guest ' + guest}),
                           json={'email': email, 'username': username, 'password': 'hunter22',
                                 'turnstile_token': REGISTER_TOKEN})
    assert response.status_code == 201, response.text
    me = response.json()['user']
    assert me['id'] != str(guest_id) and me['email_verified'] is False and 'token' not in response.json()
    user_id = int(me['id'])
    assert appdb.fetchone('SELECT user_id, guest_id FROM files WHERE id = %s', (int(file_id),)) == (user_id, None)
    assert outbox and outbox[0]['to'] == email
    assert outbox[0]['tag'] == 'auth-verify' and '/app/verify#token=' in outbox[0]['text']
    assert appdb.fetchone('SELECT password_hash FROM users WHERE id = %s', (user_id,))[0].startswith('$argon2id$')

    other = GuestToken.generate(Snowflake.generate())
    other_file = upload(other)
    response = client.post('/auth/login', headers=dict(VIA_MAIN, **{'Authorization': 'Guest ' + other}),
                           json={'email': email, 'password': 'hunter22', 'turnstile_token': LOGIN_TOKEN})
    assert response.status_code == 200, response.text
    assert appdb.fetchone('SELECT user_id FROM files WHERE id = %s', (int(other_file),))[0] == user_id

    response = client.post('/auth/login', headers=VIA_MAIN, json={'email': email, 'password': 'wrong-password',
                                                                  'turnstile_token': LOGIN_TOKEN})
    assert (response.status_code, response.json()['code']) == (400, 'INVALID_CREDENTIALS')


def test_validation_errors(client):
    guest = GuestToken.generate(Snowflake.generate())
    response = client.get('/users/@me/files?limit=0', headers={'Authorization': 'Guest ' + guest})
    assert response.status_code == 400
    assert response.json() == {'errors': {'limit': 'Must be at least or in between 1 and 100'},
                               'code': 'INVALID_PARAMETERS', 'message': 'Some fields are invalid', 'status': 400}

    response = client.post('/auth/login', headers=VIA_MAIN, json={'email': 'not-an-email'})
    assert response.status_code == 400
    errors = response.json()['errors']
    assert errors['password'].startswith('Missing required parameter')


@pytest.mark.parametrize('method, path', [
    ('GET', '/files'), ('DELETE', '/files/abc'), ('GET', '/users/@me/file-count'), ('GET', '/users/@me/mimetypes'),
    ('GET', '/google/health-check'), ('GET', '/internal/file-ids/1'), ('GET', '/internal/album-ids/1'),
])
def test_removed_routes(client, method, path):
    response = client.request(method, path, headers={'X-Filesgg-Origin-Secret': ORIGIN_SECRET})
    assert response.status_code in (404, 405)
    assert response.json()['code'] in ('NOT_FOUND', 'METHOD_NOT_ALLOWED')


def test_every_error_has_a_string_code(client):
    assert client.get('/files/does-not-exist').json() == {'code': 'UNKNOWN_FILE', 'message': 'Unknown file',
                                                           'status': 404}
    assert client.get('/nope').json() == {'code': 'NOT_FOUND', 'message': 'Not found', 'status': 404}
    assert client.get('/mimetypes/nope').json()['code'] == 'UNKNOWN_TYPE'
    assert client.get('/mimetypes/nope/nope').json()['code'] == 'UNKNOWN_MIMETYPE'
    assert client.get('/users/@me').json()['code'] == 'UNAUTHORIZED'
    response = client.post('/files', headers={'Authorization': 'Guest ' + GuestToken.generate(Snowflake.generate())},
                           data={'vanity': '200', 'turnstile_token': TURNSTILE_TOKEN},
                           files={'file': ('a.txt', b'hi', 'text/plain')})
    assert (response.status_code, response.json()['code']) == (400, 'INVALID_VANITY')


def test_unhandled_errors_hide_their_text(client, monkeypatch):
    import views.mimetypes

    async def broken(*args, **kwargs):
        raise RuntimeError('secret internals')

    monkeypatch.setattr(views.mimetypes.queries, 'list_mimetypes', broken)
    response = client.get('/mimetypes')
    assert response.status_code == 500
    assert response.json() == {'code': 'INTERNAL_ERROR', 'message': 'Something went wrong', 'status': 500}


def test_mimetypes_and_users_routes(client, appdb):
    seed_mimetypes(appdb)
    listing = client.get('/mimetypes')
    assert listing.status_code == 200
    assert any(m['mimetype'] == 'text/plain' for m in listing.json())
    assert client.get('/mimetypes/text/plain').json()['extensions'][0]['extension'] == 'txt'
    assert client.get('/mimetypes/nope/nope').status_code == 404
    # milestone-6 §8.1: no public profiles
    assert client.get('/users/123').status_code == 404
    assert client.get('/users/-5').status_code == 404
    assert client.get('/users/someone/limits').status_code == 404
    assert client.get('/users/%40me/limits').status_code == 401  # encoded '@' still routes


def test_openapi_and_docs(client):
    spec = client.get('/openapi.json')
    assert spec.status_code == 200
    paths = spec.json()['paths']
    assert {'/files', '/files/{vanity}', '/auth/login', '/users/{user_id}', '/users/{me}/files',
            '/health', '/mimetypes/{mtype}/{subtype}'} <= set(paths)
    assert client.get('/docs').status_code == 404  # DEBUG is off


def test_access_is_a_reserved_top_level_segment(client):
    """milestone-6 §20.1: `access` is reserved for the access routes, and in every route the vanity is the last
    path segment: nothing is routed after `{vanity}`."""
    paths = set(client.get('/openapi.json').json()['paths'])
    access = {path for path in paths if path == '/access' or path.startswith('/access/')}
    assert access == {'/access/{}/{}/{{vanity}}'.format(action, kind) for action, kind in (
        ('unlock', 'files'), ('refresh', 'files'), ('view', 'files'), ('open', 'files'),
        ('unlock', 'albums'), ('refresh', 'albums'), ('view', 'albums'))}
    assert [path for path in paths if re.search(r'\{vanity\}.', path)] == []


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


def test_account_passwords_are_argon2id():
    """Rewritten for milestone-6 §2.6 (was: Werkzeug pbkdf2 within 128 characters)."""
    from utils import passwords
    hashed = passwords.hash_sync('correct horse battery staple')
    assert hashed.startswith('$argon2id$v=19$m=65536,t=3,p=4$')
    assert passwords.verify_account_sync(hashed, 'correct horse battery staple')
    assert not passwords.verify_account_sync(hashed, 'wrong')
    assert not passwords.verify_account_sync('pbkdf2:sha256:1000000$abc$def', 'anything')
    assert not passwords.verify_account_sync(None, 'anything')


def test_json_serialisation():
    from utils.responses import ApiResponse
    response = ApiResponse({'name': 'ünï "q" 😀', 'n': None, 'ok': True})
    assert response.body == json.dumps({'name': 'ünï "q" 😀', 'n': None, 'ok': True}).encode()
    assert response.content_type == 'application/json'
