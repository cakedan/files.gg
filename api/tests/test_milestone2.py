"""Milestone 2 (docs/redesign/contracts/milestone-2.md): tokens, Turnstile,
uploads to B2 (MinIO), expiry, limits, access control, internal lookup."""

import hashlib
import os
import json
import time
import uuid

import httpx
import pytest

from tests.conftest import (
    API_DIR, APP_DATABASE, FAILING_TOKEN, LOGIN_TOKEN, SECRET_KEY, TURNSTILE_TOKEN, UNLOCK_TOKEN, TempDatabase,
    assert_signed, assert_unsigned, payload_urls, s3_keys, s3_object, hash_of, subprocess_env, turnstile_token,
)
from utils import access_token
from utils.generators import Snowflake
from utils.tokens import GuestToken

# the API's unlock tokens are signed with SECRET_KEY (milestone-3 §3)
SECRET = SECRET_KEY
# the milestone-2 token vectors were computed with this secret; the format is unchanged
VECTOR_SECRET = 'test-cdn-token-secret'
# the Worker's own lookups carry the secret and the lookup marker (views/internal.py)
ORIGIN = {'X-Filesgg-Origin-Secret': 'test-origin-secret', 'X-Filesgg-Internal-Lookup': '1'}


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


@pytest.fixture
def seeded(appdb):
    """The app's database (its mimetypes come from the migrations' seed)."""
    return appdb


def new_user(appdb, override=None):
    """A verified user, and headers for a signed-in website request (milestone-6: the session cookie, as the
    Worker forwards it from files.gg/api, with the CSRF header)."""
    from tests.conftest import make_user, sign_in
    user_id = make_user(appdb, username='m2{}'.format(Snowflake.generate()), override=override)
    return user_id, sign_in(user_id, appdb)


def anonymous(ip=None):
    headers = {'Authorization': 'Guest ' + GuestToken.generate(Snowflake.generate())}
    if ip:
        headers['X-Forwarded-For'] = ip
    return headers


def upload(client, headers, content=None, name='a.txt', status=200, **fields):
    content = uuid.uuid4().bytes * 4 if content is None else content
    data = {k: (json.dumps(v) if isinstance(v, bool) else str(v)) for k, v in fields.items()}
    response = client.post('/files', headers=headers, files={'file': (name, content, 'text/plain')}, data=data)
    assert response.status_code == status, response.text
    return response.json()


# --- unlock tokens (milestone-2 §1 format, API-only since milestone-3 §3) ----------------------------

VECTORS = [
    ({'e': 1795603600, 'k': 'file', 's': 'unlock', 't': '1234567890123456789', 'u': 1795600000, 'v': 0},
     'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAs'
     'InYiOjB9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk'),
    ({'e': 1796204800, 'k': 'album', 's': 'unlock', 't': '987654321098765432', 'u': 1795600000, 'v': 3},
     'eyJlIjoxNzk2MjA0ODAwLCJrIjoiYWxidW0iLCJzIjoidW5sb2NrIiwidCI6Ijk4NzY1NDMyMTA5ODc2NTQzMiIsInUiOjE3OTU2MDAwMDAs'
     'InYiOjN9.363h20AIfnXPJ20FngplD6_ARO_pidniwnoIaD0Lebk'),
    ({'e': 1795603600, 'k': 'file', 's': 'owner', 't': '1234567890123456789', 'u': 1795600000, 'v': 2},
     'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJvd25lciIsInQiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5IiwidSI6MTc5NTYwMDAwMCwi'
     'diI6Mn0.S7b7xKQg5Cu19qkZa4BGRNLeZgwmnVmqGjN_1p4nFiE'),
]
TAMPERED = ('eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAw'
            'MDAsInYiOjF9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk')


@pytest.mark.parametrize('claims, token', VECTORS)
def test_token_vectors(claims, token):
    assert access_token.mint(claims, VECTOR_SECRET) == token
    built = access_token.claims_for(claims['k'], int(claims['t']), claims['s'], claims['v'], claims['u'], claims['e'])
    assert access_token.mint(built, VECTOR_SECRET) == token
    assert access_token.decode(token, VECTOR_SECRET) == claims


def test_tampered_vector_is_rejected():
    assert access_token.decode(TAMPERED, VECTOR_SECRET) is None
    assert access_token.decode(VECTORS[0][1], 'another-secret') is None
    for junk in ('', 'abc', 'a.b.c', VECTORS[0][1] + 'x', None):
        assert access_token.decode(junk, VECTOR_SECRET) is None


def test_api_tokens_use_secret_key(client, seeded):
    """A token signed with any other secret (the old CDN_TOKEN_SECRET included) is refused."""
    created, _ = protected(client, seeded, password='hunter222')
    token = unlock(client, created['vanity'], 'hunter222').json()['token']
    claims = access_token.decode(token, SECRET_KEY)
    assert claims is not None and access_token.decode(token, VECTOR_SECRET) is None
    forged = access_token.mint(claims, VECTOR_SECRET)
    response = client.get('/access/view/files/{}'.format(created['vanity']), headers={'X-Filesgg-Access': forged})
    assert (response.status_code, response.json()['code']) == (401, 'UNLOCK_EXPIRED')


def test_token_validity_rules():
    claims = VECTORS[0][0]
    assert access_token.valid_for(claims, 'file', 1234567890123456789, 0, now=1795603599)
    assert not access_token.valid_for(claims, 'file', 1234567890123456789, 0, now=1795603600)  # e > now
    assert not access_token.valid_for(claims, 'file', 1234567890123456788, 0, now=1795600000)  # target
    assert not access_token.valid_for(claims, 'album', 1234567890123456789, 0, now=1795600000)  # kind
    assert not access_token.valid_for(claims, 'file', 1234567890123456789, 1, now=1795600000)  # version


# --- Turnstile (contract §8) -----------------------------------------------------------------------

async def test_turnstile_checks_success_action_and_hostname():
    """The default (mocked) siteverify: the action and hostname checks are enforced."""
    from utils.turnstile import Turnstile
    assert await Turnstile.verify(turnstile_token('unlock'), 'unlock') is True
    assert await Turnstile.verify(turnstile_token('login'), 'unlock') is False  # replayed from another form
    assert await Turnstile.verify(turnstile_token('unlock', 'evil.example'), 'unlock') is False
    assert await Turnstile.verify(FAILING_TOKEN, 'unlock') is False
    assert await Turnstile.verify(None, 'unlock') is False
    assert await Turnstile.verify('', 'unlock') is False


@pytest.mark.skipif(os.environ.get('FILESGG_NETWORK_TESTS') != '1',
                    reason='calls Cloudflare; set FILESGG_NETWORK_TESTS=1')
async def test_turnstile_live_testing_keys():
    """Opt-in: the real siteverify with Cloudflare's documented testing keys
    (developers.cloudflare.com/turnstile/troubleshooting/testing/). Testing
    secrets answer hostname example.com and no action, which is why only they
    skip those two checks. (Checked 2026-11-24: the always-pass secret accepts
    any non-empty token, not only the documented dummy token.)"""
    from utils import http
    from utils.turnstile import (
        TEST_SECRET_FAIL, TEST_SECRET_PASS, TEST_SECRET_SPENT, TEST_TOKEN, Turnstile,
    )
    saved = (Turnstile.secret, Turnstile.http)
    Turnstile.http = None
    http.open_client()
    try:
        Turnstile.configure(TEST_SECRET_PASS)
        assert await Turnstile.verify(TEST_TOKEN, 'upload') is True
        assert await Turnstile.verify('', 'upload') is False
        Turnstile.configure(TEST_SECRET_FAIL)
        assert await Turnstile.verify(TEST_TOKEN, 'upload') is False
        Turnstile.configure(TEST_SECRET_SPENT)
        assert await Turnstile.verify(TEST_TOKEN, 'upload') is False
    finally:
        Turnstile.secret, Turnstile.http = saved
        await http.close_client()


def test_login_takes_turnstile_token(client, appdb):
    from tests.conftest import VIA_MAIN
    user_id, _ = new_user(appdb)
    email = appdb.fetchone('SELECT email FROM users WHERE id = %s', (user_id,))[0]
    for token in (FAILING_TOKEN, turnstile_token('upload'), None):  # a token from another form fails too
        response = client.post('/auth/login', headers=VIA_MAIN, json={'email': email, 'password': 'whatever1',
                                                                      'turnstile_token': token})
        assert response.json() == {'code': 'CAPTCHA_INVALID', 'message': 'Human verification failed', 'status': 403}
    # the old reCAPTCHA field name isn't read any more
    response = client.post('/auth/login', headers=VIA_MAIN, json={'email': email, 'password': 'whatever1',
                                                                  'captcha': LOGIN_TOKEN})
    assert response.json()['code'] == 'CAPTCHA_INVALID'
    response = client.post('/auth/login', headers=VIA_MAIN, json={'email': email, 'password': 'whatever1',
                                                                  'turnstile_token': LOGIN_TOKEN})
    assert response.json()['code'] == 'INVALID_CREDENTIALS'  # got past Turnstile


# --- single-request uploads -------------------------------------------------------------------------

def test_anonymous_upload_needs_turnstile(client, seeded):
    # milestone-6 §7.5: no credential and no turnstile_token at all is a tool upload: it needs an upload key
    response = client.post('/files', headers=anonymous(), files={'file': ('a.txt', b'hello', 'text/plain')})
    assert response.status_code == 401 and response.json()['code'] == 'UPLOAD_KEY_REQUIRED'
    for token in (FAILING_TOKEN, UNLOCK_TOKEN, turnstile_token('upload', 'evil.example')):
        response = client.post('/files', headers=anonymous(), files={'file': ('a.txt', b'hello', 'text/plain')},
                               data={'turnstile_token': token})
        assert response.status_code == 403 and response.json()['code'] == 'CAPTCHA_INVALID'
    created = upload(client, anonymous(), turnstile_token=TURNSTILE_TOKEN)
    # anonymous files always expire, by default after 21 days
    assert abs(created['expires_at'] - (time.time() + 21 * 86400)) < 60
    assert created['visibility'] == 'link'


def test_signed_in_upload_skips_turnstile_and_never_expires(client, seeded):
    _, headers = new_user(seeded)
    created = upload(client, headers)
    assert created['expires_at'] is None
    created = upload(client, headers, expires_in=3600)
    assert abs(created['expires_at'] - (time.time() + 3600)) < 60


def test_upload_response_is_the_file_payload(client, seeded):
    _, headers = new_user(seeded)
    created = upload(client, headers, name='notes.txt')
    # milestone-4 §6.2: upload responses also carry the owner's `safety`
    assert created['safety']['state'] == 'ok'
    # milestone-6 §10.9: and `direct_url` (on cdn.files.gg without a custom domain); §19.6: the owner's
    # view-limit fields
    assert created['direct_url'] == created['cdn_url']
    assert (created['view_limit'], created['view_limit_action'], created['views_used']) == (None, 'expire', 0)
    owner_only = ('safety', 'direct_url', 'view_limit', 'view_limit_action', 'views_used')
    assert {k: v for k, v in created.items() if k not in owner_only} == client.get(
        '/files/' + created['vanity']).json() | {'views': 0}
    assert created['filename'] == 'notes.txt' and created['processing'] is True and created['assets'] == {}
    assert_unsigned(created['cdn_url'])
    # a protected upload's URLs are signed for its owner (1 h)
    locked = upload(client, headers, generate_password='true')
    assert 'password' in locked and 'url_with_password' in locked
    expires = assert_signed(locked['cdn_url'], 'file:{}:0'.format(locked['id']))
    assert 3590 < expires - time.time() <= 3600


@pytest.mark.parametrize('fields, code', [
    ({'expires_in': 60}, 'EXPIRY_NOT_ALLOWED'),
    ({'expires_in': 22 * 86400}, 'EXPIRY_NOT_ALLOWED'),
    ({'visibility': 'private'}, 'PRIVATE_REQUIRES_ACCOUNT'),
])
def test_anonymous_upload_rules(client, seeded, fields, code):
    response = client.post('/files', headers=anonymous(), files={'file': ('a.txt', b'hi', 'text/plain')},
                           data=dict(fields, turnstile_token=TURNSTILE_TOKEN))
    assert response.status_code == 400 and response.json()['code'] == code
    if code == 'EXPIRY_NOT_ALLOWED':
        assert response.json()['max_expiry'] == 21 * 86400


def test_anonymous_file_size_limit(client, seeded, monkeypatch):
    monkeypatch.setenv('LIMIT_ANONYMOUS_FILE_BYTES', '1000')
    response = client.post('/files', headers=anonymous(), files={'file': ('a.txt', b'x' * 1001, 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    assert response.status_code == 413
    assert response.json()['code'] == 'FILE_TOO_LARGE' and response.json()['limit'] == 1000
    # raw, by Content-Length before reading
    response = client.post('/files?type=raw&filename=a.txt&turnstile_token=' + TURNSTILE_TOKEN,
                           headers=dict(anonymous(), **{'Content-Type': 'text/plain'}), content=b'x' * 5000)
    assert response.status_code == 413
    # raw without Content-Length (chunked): checked while streaming
    async def body():
        yield b'x' * 600
        yield b'x' * 600
    response = client.post('/files?type=raw&filename=a.txt&turnstile_token=' + TURNSTILE_TOKEN,
                           headers=dict(anonymous(), **{'Content-Type': 'text/plain'}), content=body())
    assert response.status_code == 413 and response.json()['limit'] == 1000
    upload(client, anonymous(), content=b'x' * 1000, turnstile_token=TURNSTILE_TOKEN)


def test_anonymous_rolling_caps_per_guest_and_per_ip(client, seeded, monkeypatch):
    monkeypatch.setenv('LIMIT_ANONYMOUS_DAILY_BYTES', '3000')
    ip = '198.51.100.{}'.format(uuid.uuid4().int % 250)
    first = anonymous(ip)
    upload(client, first, content=uuid.uuid4().bytes * 62, turnstile_token=TURNSTILE_TOKEN)  # 992 bytes
    upload(client, first, content=uuid.uuid4().bytes * 62, turnstile_token=TURNSTILE_TOKEN)
    # per guest
    response = client.post('/files', headers=first, files={'file': ('a.txt', uuid.uuid4().bytes * 70, 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    assert response.status_code == 413 and response.json()['code'] == 'STORAGE_LIMIT_REACHED'
    assert response.json()['limit'] == 3000 and response.json()['used'] == 1984
    # per IP, with a fresh guest
    response = client.post('/files', headers=anonymous(ip),
                           files={'file': ('a.txt', uuid.uuid4().bytes * 70, 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    assert response.status_code == 413 and response.json()['code'] == 'STORAGE_LIMIT_REACHED'
    # another IP and guest is unaffected
    upload(client, anonymous('203.0.113.{}'.format(uuid.uuid4().int % 250)), content=uuid.uuid4().bytes * 70,
           turnstile_token=TURNSTILE_TOKEN)


def test_signed_in_storage_limit(client, seeded):
    _, headers = new_user(seeded, override=2000)
    upload(client, headers, content=uuid.uuid4().bytes * 100)  # 1600
    response = client.post('/files', headers=headers, files={'file': ('a.txt', uuid.uuid4().bytes * 30, 'text/plain')})
    assert response.status_code == 413
    assert response.json() == {'limit': 2000, 'used': 1600, 'code': 'STORAGE_LIMIT_REACHED',
                               'message': 'Storage limit reached', 'status': 413}


def test_blob_is_stored_before_the_hash_row(client, seeded, monkeypatch):
    _, headers = new_user(seeded)
    content = uuid.uuid4().bytes * 8
    digest = hashlib.blake2b(content).hexdigest()

    async def broken(*args, **kwargs):
        raise RuntimeError('b2 is down')

    monkeypatch.setattr(client.app.ctx.storage, 'upload_file', broken)
    response = client.post('/files', headers=headers, files={'file': ('a.txt', content, 'text/plain')})
    assert response.status_code == 500
    assert seeded.fetchone('SELECT count(*) FROM file_hashes WHERE blake2b = %s', (digest,))[0] == 0
    monkeypatch.undo()
    created = upload(client, headers, content=content)
    assert s3_object('files/' + hash_of(seeded, created)) == content


def test_generated_password_upload(client, seeded):
    from utils.passwords import words
    created = upload(client, anonymous(), generate_password='true', turnstile_token=TURNSTILE_TOKEN)
    assert created['visibility'] == 'password'
    parts = created['password'].split('-')
    assert len(parts) == 4 and all(p in words() for p in parts)
    assert created['url_with_password'] == 'https://files.gg/{}#pw={}'.format(created['vanity'], created['password'])
    stored = seeded.fetchone('SELECT password_hash FROM files WHERE id = %s', (int(created['id']),))[0]
    assert stored.startswith('$argon2id$') and created['password'] not in stored


# --- expiry ---------------------------------------------------------------------------------------

def test_expired_files_are_gone_at_read_time(client, seeded):
    from jobs import tasks
    _, headers = new_user(seeded)
    created = upload(client, headers, expires_in=3600)
    file_id = int(created['id'])
    assert client.get('/files/' + created['vanity']).status_code == 200
    seeded.execute("UPDATE files SET expires_at = now() - interval '1 second' WHERE id = %s", (file_id,))

    assert client.get('/files/' + created['vanity']).json()['code'] == 'UNKNOWN_FILE'
    assert created['id'] not in [f['id'] for f in client.get('/users/@me/files', headers=headers).json()['items']]
    assert client.get('/internal/files/' + created['vanity'], headers=ORIGIN).status_code == 404
    assert client.get('/users/@me/limits', headers=headers).json()['storage']['used'] == 0

    deleted, _ = tasks.reap_expired(seeded.conn)
    assert deleted >= 1
    assert seeded.fetchone('SELECT deleted_at IS NOT NULL FROM files WHERE id = %s', (file_id,))[0] is True


# --- limits endpoint ----------------------------------------------------------------------------

def test_limits_endpoint(client, seeded):
    _, headers = new_user(seeded)
    upload(client, headers, content=b'y' * 100)
    assert client.get('/users/@me/limits', headers=headers).json() == {
        'storage': {'used': 100, 'limit': 10_000_000_000},
        # decimal sizes: 100 MB single, under PROXY_BODY_LIMIT_BYTES (100 MiB) less 1 MiB of framing
        'max_file_size_single': 100_000_000,
        'max_file_size_single_configured': 100_000_000,
        'max_file_size_chunked': 1_000_000_000,
        'premium': False,
        'custom_domains': {'used': 0, 'limit': 0},
        'upload_keys': {'used': 0, 'limit': 20},
        'domain_only_allowed': False,
        'max_expiry': None,
        'allow_no_expiry': True,
        'anonymous': False,
        'nsfw_allowed': True,
        # Milestone 3
        'album_max_files': 500,
        'albums_max': 1000,
    }
    body = client.get('/users/@me/limits', headers=anonymous('192.0.2.77')).json()
    assert body['album_max_files'] == 50 and body['albums_max'] is None
    assert body['storage'] == {'used': 0, 'limit': None} and body['anonymous'] is True
    assert body['max_file_size_single'] == body['max_file_size_chunked'] == 25_000_000
    assert body['max_expiry'] == 1814400 and body['allow_no_expiry'] is False
    assert body['daily'] == {'used': 0, 'limit': 500_000_000}
    assert client.get('/users/@me/limits').status_code == 401


# --- access control ---------------------------------------------------------------------------------

def protected(client, seeded, **fields):
    user_id, headers = new_user(seeded)
    created = upload(client, headers, **fields)
    return created, headers


def unlock(client, vanity, password, token=UNLOCK_TOKEN, ip=None):
    headers = {'X-Forwarded-For': ip or '10.1.{}.{}'.format(uuid.uuid4().int % 250, uuid.uuid4().int % 250)}
    return client.post('/access/unlock/files/{}'.format(vanity), json={'password': password, 'turnstile_token': token},
                       headers=headers)


def test_password_file_is_locked_until_unlocked(client, seeded):
    created, owner = protected(client, seeded, password='hunter222')
    vanity = created['vanity']
    grant = 'file:{}:0'.format(created['id'])
    assert client.get('/files/' + vanity).json() == {'vanity': vanity, 'protected': 'password'}
    # the owner gets the payload, signed for 1 h
    mine = client.get('/files/' + vanity, headers=owner).json()
    assert mine['id'] == created['id']
    assert 3590 < assert_signed(mine['cdn_url'], grant) - time.time() <= 3600
    seeded.execute('UPDATE files SET show_name_when_locked = true WHERE id = %s', (int(created['id']),))
    assert client.get('/files/' + vanity).json()['filename'] == created['filename']

    response = unlock(client, vanity, 'hunter222')
    assert response.status_code == 200, response.text
    body = response.json()
    claims = access_token.decode(body['token'], SECRET)
    assert claims['k'] == 'file' and claims['t'] == created['id'] and claims['s'] == 'unlock'
    assert body['expires_at'] == claims['e'] == claims['u'] + 3600
    assert body['file']['id'] == created['id'] and 'hash' not in body['file']
    # the token never appears in a URL; the URLs are signed until the unlock expires
    assert body['file']['cdn_url'].split('?')[0] == created['cdn_url'].split('?')[0]
    assert body['token'] not in body['file']['cdn_url']
    assert assert_signed(body['file']['cdn_url'], grant) == body['expires_at']
    shown = client.get('/files/' + vanity, headers={'X-Filesgg-Access': body['token']}).json()
    assert shown['id'] == created['id']
    assert_signed(shown['cdn_url'], grant, expires=body['expires_at'])


def test_unlock_error_paths(client, seeded):
    created, owner = protected(client, seeded, password='hunter222')
    vanity = created['vanity']
    # 1. Turnstile first: the password isn't even checked (and no attempt is counted)
    for token in (FAILING_TOKEN, TURNSTILE_TOKEN, turnstile_token('unlock', 'evil.example')) * 3:
        response = unlock(client, vanity, 'hunter222', token=token, ip='10.9.9.9')
        assert (response.status_code, response.json()['code']) == (403, 'CAPTCHA_INVALID')
    response = unlock(client, vanity, 'wrong', token=None)
    assert (response.status_code, response.json()['code']) == (403, 'CAPTCHA_INVALID')
    # 4. wrong password
    response = unlock(client, vanity, 'wrong-one', ip='10.9.9.9')
    assert (response.status_code, response.json()['code']) == (401, 'WRONG_PASSWORD')
    # 2. rate limit: 5 attempts a minute per file and IP
    for _ in range(4):
        assert unlock(client, vanity, 'wrong-one', ip='10.9.9.9').status_code == 401
    response = unlock(client, vanity, 'hunter222', ip='10.9.9.9')
    assert (response.status_code, response.json()['code']) == (429, 'TOO_MANY_ATTEMPTS')
    assert 0 < response.json()['retry_after'] <= 60
    assert unlock(client, vanity, 'hunter222', ip='10.9.9.10').status_code == 200  # other IPs aren't affected
    # 3. expired password
    seeded.execute("UPDATE files SET password_expires_at = now() - interval '1 minute' WHERE id = %s",
                   (int(created['id']),))
    response = unlock(client, vanity, 'hunter222')
    assert (response.status_code, response.json()['code']) == (410, 'PASSWORD_EXPIRED')
    assert client.get('/files/' + vanity).json()['password_expired'] is True
    # unknown file
    response = unlock(client, 'does-not-exist', 'x')
    assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_FILE')


def test_private_files_are_404_to_everyone_but_the_owner(client, seeded):
    created, owner = protected(client, seeded, visibility='private')
    vanity = created['vanity']
    assert client.get('/files/' + vanity).json() == {'code': 'UNKNOWN_FILE', 'message': 'Unknown file', 'status': 404}
    assert client.get('/files/' + vanity, headers=owner).status_code == 200
    response = unlock(client, vanity, 'x')
    assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_FILE')
    response = client.get('/access/view/files/{}'.format(vanity), headers={'X-Filesgg-Access': 'nope'})
    assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_FILE')
    assert client.get('/access/view/files/{}'.format(vanity)).json()['code'] == 'UNKNOWN_FILE'
    # the owner's pass opens it
    owner_pass = client.post('/users/@me/files/{}/pass'.format(created['id']), headers=owner).json()
    response = client.get('/access/view/files/{}'.format(vanity), headers={'X-Filesgg-Access': owner_pass['token']})
    assert response.status_code == 200 and response.json()['file']['id'] == created['id']
    assert response.json()['expires_at'] == owner_pass['expires_at']
    assert_signed(response.json()['file']['cdn_url'], 'file:{}:0'.format(created['id']),
                  expires=owner_pass['expires_at'])


def test_owner_pass(client, seeded):
    created, owner = protected(client, seeded, password='hunter222')
    response = client.post('/users/@me/files/{}/pass'.format(created['id']), headers=owner)
    body = response.json()
    claims = access_token.decode(body['token'], SECRET)
    assert claims['s'] == 'owner' and claims['t'] == created['id'] and claims['e'] == claims['u'] + 3600
    assert body['expires_at'] == claims['e']
    assert body['url'] == 'https://files.gg/{}#t={}'.format(created['vanity'], body['token'])
    _, stranger = new_user(seeded)
    response = client.post('/users/@me/files/{}/pass'.format(created['id']), headers=stranger)
    assert response.status_code == 404
    assert client.post('/users/@me/albums/1/pass', headers=owner).json()['code'] == 'UNKNOWN_ALBUM'


def test_view_endpoint(client, seeded, caplog):
    created, owner = protected(client, seeded, password='hunter222')
    vanity = created['vanity']
    token = unlock(client, vanity, 'hunter222').json()['token']
    caplog.set_level('DEBUG')
    response = client.get('/access/view/files/{}'.format(vanity), headers={'X-Filesgg-Access': token})
    assert response.status_code == 200
    assert response.json()['expires_at'] == access_token.decode(token, SECRET)['e']
    assert response.json()['file']['id'] == created['id']
    for url in payload_urls(response.json()['file']):
        assert_signed(url, 'file:{}:0'.format(created['id']), expires=response.json()['expires_at'])
    assert token not in caplog.text
    for bad in (None, 'garbage', VECTORS[0][1]):
        headers = {'X-Filesgg-Access': bad} if bad else {}
        response = client.get('/access/view/files/{}'.format(vanity), headers=headers)
        assert (response.status_code, response.json()['code']) == (401, 'UNLOCK_EXPIRED')
    # an expired token
    claims = access_token.decode(token, SECRET)
    expired = access_token.mint(dict(claims, e=int(time.time()) - 1), SECRET)
    assert client.get('/access/view/files/{}'.format(vanity), headers={'X-Filesgg-Access': expired}).status_code == 401


def test_refresh(client, seeded):
    created, owner = protected(client, seeded, password='hunter222', unlock_ttl=86400)
    vanity, file_id = created['vanity'], int(created['id'])
    token = unlock(client, vanity, 'hunter222').json()['token']
    claims = access_token.decode(token, SECRET)
    assert claims['e'] == claims['u'] + 86400

    response = client.post('/access/refresh/files/{}'.format(vanity), json={'token': token})
    refreshed = access_token.decode(response.json()['token'], SECRET)
    assert refreshed['u'] == claims['u']  # keeps the unlock time
    assert abs(refreshed['e'] - (time.time() + 3600)) < 5  # min(now + 3600, u + ttl, ...)
    # and the payload comes back with fresh URLs, signed until the new expiry
    assert response.json()['file']['id'] == created['id']
    assert_signed(response.json()['file']['cdn_url'], 'file:{}:0'.format(file_id), expires=refreshed['e'])

    # capped by u + unlock_ttl: an old unlock can't be refreshed past it
    old = access_token.mint(dict(claims, u=int(time.time()) - 86400 + 10, e=int(time.time()) + 10), SECRET)
    response = client.post('/access/refresh/files/{}'.format(vanity), json={'token': old})
    assert response.json()['expires_at'] <= int(time.time()) + 10
    spent = access_token.mint(dict(claims, u=int(time.time()) - 86400 - 1, e=int(time.time()) + 10), SECRET)
    response = client.post('/access/refresh/files/{}'.format(vanity), json={'token': spent})
    assert (response.status_code, response.json()['code']) == (401, 'UNLOCK_EXPIRED')
    assert client.post('/access/refresh/files/{}'.format(vanity), json={'token': 'x'}).status_code == 401


def test_owner_pass_refresh(client, seeded):
    for visibility in ('password', 'private'):
        fields = {'password': 'hunter222'} if visibility == 'password' else {'visibility': 'private'}
        created, owner = protected(client, seeded, **fields)
        vanity = created['vanity']
        owner_pass = client.post('/users/@me/files/{}/pass'.format(created['id']), headers=owner).json()['token']
        claims = access_token.decode(owner_pass, SECRET)

        response = client.post('/access/refresh/files/{}'.format(vanity), json={'token': owner_pass})
        assert response.status_code == 200, response.text
        refreshed = access_token.decode(response.json()['token'], SECRET)
        assert refreshed['s'] == 'owner' and refreshed['u'] == claims['u']
        assert abs(refreshed['e'] - (time.time() + 3600)) < 5
        assert_signed(response.json()['file']['cdn_url'], 'file:{}:0'.format(created['id']), expires=refreshed['e'])
        # capped 12 h after minting
        now = int(time.time())
        old = access_token.mint(dict(claims, u=now - 43200 + 100, e=now + 50), SECRET)
        response = client.post('/access/refresh/files/{}'.format(vanity), json={'token': old})
        assert response.json()['expires_at'] == now - 43200 + 100 + 43200
        spent = access_token.mint(dict(claims, u=now - 43201, e=now + 50), SECRET)
        response = client.post('/access/refresh/files/{}'.format(vanity), json={'token': spent})
        assert (response.status_code, response.json()['code']) == (401, 'UNLOCK_EXPIRED')
        # access_version still has to match
        stale = access_token.mint(dict(claims, v=claims['v'] + 1), SECRET)
        response = client.post('/access/refresh/files/{}'.format(vanity), json={'token': stale})
        expected = (404, 'UNKNOWN_FILE') if visibility == 'private' else (401, 'UNLOCK_EXPIRED')
        assert (response.status_code, response.json()['code']) == expected
        # a private file is never confirmed without an owner pass
        if visibility == 'private':
            unlock_scope = access_token.mint(dict(claims, s='unlock'), SECRET)
            response = client.post('/access/refresh/files/{}'.format(vanity), json={'token': unlock_scope})
            assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_FILE')


def test_unknown_album_access_endpoints(client):
    for path, method in (('/access/unlock/albums/abc', 'POST'), ('/access/refresh/albums/abc', 'POST'),
                         ('/access/view/albums/abc', 'GET')):
        response = client.request(method, path, json={} if method == 'POST' else None)
        assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_ALBUM')


def test_access_routes_put_the_vanity_last(client, seeded):
    """milestone-6 §20.1: unlock, refresh, view and open are `/access/<action>/files/<vanity>`. The old paths after
    a vanity are gone: 404 whatever the method, never an alias."""
    created, owner = protected(client, seeded, password='hunter222')
    vanity = created['vanity']
    unlocked = unlock(client, vanity, 'hunter222')
    assert unlocked.status_code == 200, unlocked.text
    token = unlocked.json()['token']
    response = client.get('/access/view/files/' + vanity, headers={'X-Filesgg-Access': token})
    assert response.status_code == 200 and response.json()['file']['id'] == created['id']
    response = client.post('/access/refresh/files/' + vanity, json={'token': token})
    assert response.status_code == 200 and response.json()['file']['id'] == created['id']
    # `open` is for view-limited files: without Turnstile it's refused, but the route is there
    response = client.post('/access/open/files/' + vanity, json={})
    assert (response.status_code, response.json()['code']) == (403, 'CAPTCHA_INVALID')
    for method, path, body in (
            ('POST', '/files/{}/unlock', {'password': 'hunter222', 'turnstile_token': UNLOCK_TOKEN}),
            ('POST', '/files/{}/unlock/refresh', {'token': token}),
            ('POST', '/files/{}/open', {'turnstile_token': UNLOCK_TOKEN}),
            ('GET', '/files/{}/view', None),
            ('POST', '/albums/{}/unlock', {'password': 'hunter222', 'turnstile_token': UNLOCK_TOKEN}),
            ('POST', '/albums/{}/unlock/refresh', {'token': token}),
            ('GET', '/albums/{}/view', None)):
        response = client.request(method, path.format(vanity), json=body, headers={'X-Filesgg-Access': token})
        assert response.status_code == 404, (method, path, response.text)
        assert response.json()['code'] in ('NOT_FOUND', 'UNKNOWN_FILE'), (method, path)
    # nothing comes after a vanity, so no other method on /files/<anything> is a route either
    for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        assert client.request(method, '/files/' + vanity, json={}).status_code == 404, method
    # the unknown access paths: another action, kind, or nothing after the kind
    for method, path in (('POST', '/access/lock/files/' + vanity), ('POST', '/access/unlock/users/' + vanity),
                         ('GET', '/access/view/' + vanity), ('GET', '/access/view/files'),
                         ('POST', '/access/unlock/albums/{}/x'.format(vanity))):
        assert client.request(method, path, json={}).status_code in (404, 405), (method, path)


def test_word_vanities_never_match_an_action(client, seeded):
    """milestone-6 §20.3: a multi-segment vanity made of words (`unlock/view`, `report/x`) never matches an action
    route, and resolves only through `GET /files/<vanity>` (and the access routes, as itself)."""
    parent, owner = protected(client, seeded, password='hunter222')
    words = upload(client, owner)
    report_x = upload(client, owner)
    # reserved segments: no upload can choose these, so they're set directly
    for created, vanity in ((parent, 'unlock'), (words, 'unlock/view'), (report_x, 'report/x')):
        seeded.execute('UPDATE files SET vanity = %s WHERE id = %s', (vanity, int(created['id'])))
    assert client.get('/files/unlock/view').json()['id'] == words['id']
    assert client.get('/files/report/x').json()['id'] == report_x['id']
    assert client.get('/files/unlock').json() == {'vanity': 'unlock', 'protected': 'password'}
    # `unlock/view` is a vanity, not the view action of `unlock`, and `unlock/unlock` unlocks nothing
    token = unlock(client, 'unlock', 'hunter222').json()['token']
    response = client.get('/files/unlock/view', headers={'X-Filesgg-Access': token})
    assert response.status_code == 200 and response.json()['id'] == words['id']
    response = client.post('/files/unlock/unlock', json={'password': 'hunter222', 'turnstile_token': UNLOCK_TOKEN})
    assert (response.status_code, response.json()['code']) == (404, 'NOT_FOUND')
    # the access routes read the whole rest of the path as the vanity
    response = client.get('/access/view/files/unlock', headers={'X-Filesgg-Access': token})
    assert response.status_code == 200 and response.json()['file']['id'] == parent['id']
    response = client.get('/access/view/files/unlock/view', headers={'X-Filesgg-Access': token})
    assert (response.status_code, response.json()['code']) == (401, 'UNLOCK_EXPIRED')
    response = client.post('/access/unlock/files/report/x', json={'password': 'x', 'turnstile_token': UNLOCK_TOKEN})
    assert response.status_code == 200 and response.json()['file']['id'] == report_x['id']


def test_visibility_is_in_every_public_payload(client, seeded):
    created, owner = protected(client, seeded, password='hunter222')
    vanity = created['vanity']
    unlocked = unlock(client, vanity, 'hunter222').json()
    assert unlocked['file']['visibility'] == 'password'
    view = client.get('/access/view/files/{}'.format(vanity), headers={'X-Filesgg-Access': unlocked['token']}).json()
    assert view['file']['visibility'] == 'password'
    lookup = client.get('/internal/files/' + vanity, headers=ORIGIN).json()
    assert lookup['file']['visibility'] == 'password' == lookup['access']['visibility']
    private, owner = protected(client, seeded, visibility='private')
    owner_pass = client.post('/users/@me/files/{}/pass'.format(private['id']), headers=owner).json()['token']
    view = client.get('/access/view/files/' + private['vanity'], headers={'X-Filesgg-Access': owner_pass}).json()
    assert view['file']['visibility'] == 'private'
    link = upload(client, owner)
    assert client.get('/internal/files/' + link['vanity'], headers=ORIGIN).json()['file']['visibility'] == 'link'


def test_changing_access_revokes_tokens(client, seeded):
    created, owner = protected(client, seeded, password='hunter222')
    vanity, file_id = created['vanity'], created['id']
    token = unlock(client, vanity, 'hunter222').json()['token']
    view = lambda t: client.get('/access/view/files/' + vanity, headers={'X-Filesgg-Access': t}).status_code  # noqa
    assert view(token) == 200

    # lengthening unlock_ttl: no bump, the token still works
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner, json={'unlock_ttl': 86400})
    assert response.status_code == 200 and response.json()['access_version'] == 0
    assert 'hash' not in response.json()
    assert view(token) == 200
    # shortening it bumps access_version
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner, json={'unlock_ttl': 600})
    assert response.json()['access_version'] == 1
    assert view(token) == 401
    # a new password: bump, and the old password stops working
    token = unlock(client, vanity, 'hunter222').json()['token']
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner, json={'generate_password': True})
    body = response.json()
    assert body['access_version'] == 2 and len(body['password'].split('-')) == 4
    assert view(token) == 401
    assert unlock(client, vanity, 'hunter222').status_code == 401
    unlocked = unlock(client, vanity, body['password']).json()
    # new URLs are signed for the new access_version (the old ones stop working at the CDN)
    assert_signed(unlocked['file']['cdn_url'], 'file:{}:2'.format(file_id))
    # password expiry: setting one (shortening from "never") bumps
    expires = int(time.time()) + 86400
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner,
                              json={'password_expires_at': expires})
    assert response.json()['password_expires_at'] == expires and response.json()['access_version'] == 3
    # making it private: bump, gone for others
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner, json={'visibility': 'private'})
    assert response.json()['visibility'] == 'private' and response.json()['access_version'] == 4
    assert client.get('/files/' + vanity).status_code == 404
    # and back to a link: everyone sees it again
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner, json={'visibility': 'link'})
    assert client.get('/files/' + vanity).json()['id'] == file_id
    # expiry changes go through the limits
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner, json={'expires_in': 10})
    assert response.json()['code'] == 'EXPIRY_NOT_ALLOWED'
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner, json={'expires_in': 7200})
    assert abs(response.json()['expires_at'] - (time.time() + 7200)) < 5
    response = client.request('PATCH', '/users/@me/files/' + file_id, headers=owner, json={'expires_at': None})
    assert response.json()['expires_at'] is None
    _, stranger = new_user(seeded)
    assert client.request('PATCH', '/users/@me/files/' + file_id, headers=stranger,
                          json={'visibility': 'link'}).status_code == 404


# --- internal lookup (contract §2) -------------------------------------------------------------------

def test_internal_lookup(client, seeded):
    owner_id, owner = new_user(seeded)
    created = upload(client, owner, visibility='private')
    vanity = created['vanity']
    # the secret alone is what the Worker adds to every client request it forwards: not a lookup
    for headers in ({}, {'X-Filesgg-Origin-Secret': 'wrong'}, {'X-Filesgg-Origin-Secret': 'wrong', 'X-Filesgg-Internal-Lookup': '1'},
                    {'X-Filesgg-Origin-Secret': 'test-origin-secret'},
                    {'X-Filesgg-Origin-Secret': 'test-origin-secret', 'X-Filesgg-Internal-Lookup': 'yes'},
                    {'X-Filesgg-Internal-Lookup': '1'}):
        response = client.get('/internal/files/' + vanity, headers=headers)
        assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_FILE')
        # identical to an unknown vanity
        assert response.json() == client.get('/internal/files/nope', headers=ORIGIN).json()

    response = client.get('/internal/files/{}.txt'.format(vanity), headers=ORIGIN)
    assert response.status_code == 200
    assert 'no-store' in response.headers['cache-control']
    body = response.json()
    assert body['file']['id'] == created['id']
    # unsigned: only the API signs, for someone allowed to see the file
    assert body['file']['cdn_url'] == created['cdn_url'].split('?')[0] and body['file']['url'] == created['url']
    assert_unsigned(body['file']['cdn_url'])
    assert 'hash' not in body['file'] and body['file']['kind'] == 'text'
    assert body['access'] == {'visibility': 'private', 'access_version': 0, 'unlock_ttl': 3600,
                              'password_expires_at': None, 'show_name_when_locked': False}
    assert body['owner_user_id'] == str(owner_id)
    assert body['albums'] == []
    assert body['storage'] == {'key': 'files/' + hash_of(seeded, created), 'size': created['size']}
    assert body['previews'] == {} and body['previews_version'] is None
    assert set(body) == {'file', 'access', 'owner_user_id', 'albums', 'storage', 'previews', 'previews_version',
                         'safety', 'serve_inline',
                         # milestone-6 §10.7
                         'owner_state', 'served_on',
                         # milestone-6 §19.5
                         'view_limit'}

    anon = upload(client, anonymous(), turnstile_token=TURNSTILE_TOKEN)
    body = client.get('/internal/files/' + anon['vanity'], headers=ORIGIN).json()
    assert body['owner_user_id'] is None and body['file']['expires_at'] == anon['expires_at']
    assert client.get('/internal/albums/x', headers=ORIGIN).status_code == 404


def test_reserved_vanities():
    from utils.vanity import blacklisted_ids, generate_vanity, is_reserved
    for name in ('app', 'api', 'a', 'convert', 'internal', 'report', 'uploads', 'favicon', 'apple-touch-icon',
                 'og-image'):
        assert name in blacklisted_ids
    assert is_reserved('app/xyz') and is_reserved('favicon.ico') and not is_reserved('abc/def')
    for _ in range(2000):
        assert not is_reserved(generate_vanity('1/1'))


# --- chunked uploads (in-process; the 2-server run is in test_chunked_server) ----------------------------

def start(client, headers, size, status=201, **fields):
    response = client.post('/uploads', headers=headers, json=dict({'filename': 'big.bin', 'size': size}, **fields))
    assert response.status_code == status, response.text
    return response.json()


def put(client, headers, upload_id, index, data):
    return client.request('PUT', '/uploads/{}/chunks/{}'.format(upload_id, index), headers=headers, content=data)


@pytest.fixture
def small_chunks(monkeypatch):
    # S3 parts must be at least 5 MiB, except the last
    monkeypatch.setenv('UPLOAD_CHUNK_SIZE', str(5 * 1024 * 1024))
    return 5 * 1024 * 1024


def test_chunked_upload_dedup_and_errors(client, seeded, small_chunks):
    from jobs.finalize import finalize
    _, headers = new_user(seeded)
    data = uuid.uuid4().bytes * (small_chunks // 16 * 2 // 1) + b'tail'  # 2 chunks + 4 bytes
    session = start(client, headers, len(data))
    upload_id = session['upload_id']
    assert session['chunk_size'] == small_chunks and session['chunk_count'] == 3
    chunks = [data[i:i + small_chunks] for i in range(0, len(data), small_chunks)]

    response = put(client, headers, upload_id, 0, chunks[0][:-1])
    assert (response.status_code, response.json()['code']) == (400, 'CHUNK_SIZE_MISMATCH')
    assert response.json()['expected'] == small_chunks
    assert put(client, headers, upload_id, 2, chunks[2]).status_code == 204
    assert put(client, headers, upload_id, 0, chunks[0]).status_code == 204
    response = client.post('/uploads/{}/complete'.format(upload_id), headers=headers)
    assert (response.status_code, response.json()['code'], response.json()['missing']) == (409, 'UPLOAD_INCOMPLETE', [1])
    assert put(client, headers, upload_id, 1, chunks[1]).status_code == 204
    assert put(client, headers, upload_id, 1, chunks[1]).status_code == 204  # idempotent
    assert put(client, headers, upload_id, 3, b'x').json()['code'] == 'UNKNOWN_UPLOAD'

    # someone else can't see or touch it
    _, stranger = new_user(seeded)
    assert client.get('/uploads/' + upload_id, headers=stranger).json()['code'] == 'UNKNOWN_UPLOAD'
    assert put(client, stranger, upload_id, 0, chunks[0]).status_code == 404

    state = client.get('/uploads/' + upload_id, headers=headers).json()
    assert state == {'status': 'open', 'received': [0, 1, 2], 'size': len(data)}
    response = client.post('/uploads/{}/complete'.format(upload_id), headers=headers)
    assert response.status_code == 202 and response.json() == {'status': 'processing'}
    file_id = finalize(int(upload_id))
    state = client.get('/uploads/' + upload_id, headers=headers).json()
    assert state['status'] == 'complete' and state['file']['id'] == str(file_id)
    assert state['file']['size'] == len(data) and state['file']['extension'] == 'bin'
    assert 'hash' not in state['file']
    assert s3_object('files/' + hash_of(seeded, state['file'])) == data
    assert s3_keys('staging/' + upload_id) == []
    assert seeded.fetchone('SELECT blake2b, size FROM file_hashes WHERE id = %s', (int(hash_of(seeded, state['file'])),)) == \
        (hashlib.blake2b(data).hexdigest(), len(data))

    # the same bytes again: de-duplicated by finalize_upload, no second blob
    again = start(client, headers, len(data))
    for index, chunk in enumerate(chunks):
        assert put(client, headers, again['upload_id'], index, chunk).status_code == 204
    client.post('/uploads/{}/complete'.format(again['upload_id']), headers=headers)
    finalize(int(again['upload_id']))
    second = client.get('/uploads/' + again['upload_id'], headers=headers).json()['file']
    assert hash_of(seeded, second) == hash_of(seeded, state['file']) and second['id'] != state['file']['id']
    assert s3_keys('staging/' + again['upload_id']) == []


def test_chunked_limits_reservations_and_delete(client, seeded, small_chunks, monkeypatch):
    monkeypatch.setenv('LIMIT_CHUNKED_BYTES', str(40 * 1024 * 1024))
    _, headers = new_user(seeded, override=60 * 1024 * 1024)
    response = client.post('/uploads', headers=headers, json={'filename': 'x.bin', 'size': 40 * 1024 * 1024 + 1})
    assert (response.status_code, response.json()['code'], response.json()['limit']) == \
        (413, 'FILE_TOO_LARGE', 40 * 1024 * 1024)
    first = start(client, headers, 40 * 1024 * 1024)
    # the open session reserves its size
    response = client.post('/uploads', headers=headers, json={'filename': 'y.bin', 'size': 30 * 1024 * 1024})
    assert (response.status_code, response.json()['code']) == (413, 'STORAGE_LIMIT_REACHED')
    assert response.json()['used'] == 40 * 1024 * 1024
    assert client.get('/users/@me/limits', headers=headers).json()['storage']['used'] == 40 * 1024 * 1024
    # deleting it frees the reservation and aborts the multipart upload
    assert client.request('DELETE', '/uploads/' + first['upload_id'], headers=headers).status_code == 204
    assert client.get('/uploads/' + first['upload_id'], headers=headers).status_code == 404
    start(client, headers, 30 * 1024 * 1024)


def test_anonymous_chunked_uploads(client, seeded, small_chunks):
    guest = anonymous()
    response = client.post('/uploads', headers=guest, json={'filename': 'x.bin', 'size': 100})
    # milestone-6 §7.5: no credential and no turnstile_token at all needs an upload key
    assert (response.status_code, response.json()['code']) == (401, 'UPLOAD_KEY_REQUIRED')
    response = client.post('/uploads', headers=guest, json={'filename': 'x.bin', 'size': 100,
                                                                  'turnstile_token': FAILING_TOKEN})
    assert (response.status_code, response.json()['code']) == (403, 'CAPTCHA_INVALID')
    response = client.post('/uploads', headers=guest,
                           json={'filename': 'x.bin', 'size': 26214401, 'turnstile_token': TURNSTILE_TOKEN})
    assert response.json()['code'] == 'FILE_TOO_LARGE'
    session = start(client, guest, 100, turnstile_token=TURNSTILE_TOKEN, generate_password=True)
    assert len(session['password'].split('-')) == 4  # shown once, here
    assert put(client, guest, session['upload_id'], 0, b'z' * 100).status_code == 204  # no Turnstile on chunks
    assert client.get('/uploads/' + session['upload_id'], headers=anonymous()).status_code == 404
    assert client.get('/uploads/' + session['upload_id']).status_code == 401


def test_upload_reaper_aborts_abandoned_sessions(client, seeded, small_chunks):
    from jobs import tasks
    _, headers = new_user(seeded)
    session = start(client, headers, small_chunks + 10)
    assert put(client, headers, session['upload_id'], 0, b'q' * small_chunks).status_code == 204
    seeded.execute("UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = %s",
                   (int(session['upload_id']),))
    assert tasks.reap_uploads(seeded.conn) >= 1
    assert seeded.fetchone('SELECT count(*) FROM upload_sessions WHERE id = %s', (int(session['upload_id']),))[0] == 0
    from tests.conftest import BUCKET, s3_client
    uploads = s3_client().list_multipart_uploads(Bucket=BUCKET, Prefix='staging/' + session['upload_id'])
    assert not uploads.get('Uploads')


def multipart_uploads(upload_id):
    from tests.conftest import BUCKET, s3_client
    return s3_client().list_multipart_uploads(Bucket=BUCKET, Prefix='staging/' + upload_id).get('Uploads') or []


def session_row(seeded, upload_id):
    return seeded.fetchone('SELECT status, error, b2_upload_id FROM upload_sessions WHERE id = %s', (int(upload_id),))


ELF_HEAD = b'\x7fELF\x02\x01\x01\x00' + b'\x00' * 8


def test_a_refused_chunk_0_aborts_the_multipart_upload(client, seeded, small_chunks):
    """99 chunks then an executable chunk 0 must not leave the parts on B2."""
    _, headers = new_user(seeded)
    session = start(client, headers, 2 * small_chunks + 10)
    upload_id = session['upload_id']
    assert put(client, headers, upload_id, 1, b'a' * small_chunks).status_code == 204
    assert put(client, headers, upload_id, 2, b'b' * 10).status_code == 204
    assert len(multipart_uploads(upload_id)) == 1
    response = put(client, headers, upload_id, 0, ELF_HEAD + b'\x00' * (small_chunks - len(ELF_HEAD)))
    assert (response.status_code, response.json()['code']) == (400, 'FILE_TYPE_NOT_ALLOWED')
    assert multipart_uploads(upload_id) == []
    # failed (no reservation), and the upload id cleared once aborted
    assert session_row(seeded, upload_id) == ('failed', 'FILE_TYPE_NOT_ALLOWED', None)
    assert client.get('/users/@me/limits', headers=headers).json()['storage']['used'] == 0
    assert put(client, headers, upload_id, 1, b'a' * small_chunks).json()['code'] == 'UNKNOWN_UPLOAD'
    # and DELETE removes the row
    assert client.request('DELETE', '/uploads/' + upload_id, headers=headers).status_code == 204
    assert session_row(seeded, upload_id) is None


def test_deleting_a_failed_session_aborts_its_multipart_upload(client, seeded, small_chunks):
    """A failed session whose abort didn't happen yet (or failed) still has its parts: DELETE aborts."""
    _, headers = new_user(seeded)
    session = start(client, headers, small_chunks + 10)
    upload_id = session['upload_id']
    assert put(client, headers, upload_id, 0, b'q' * small_chunks).status_code == 204
    seeded.execute("UPDATE upload_sessions SET status = 'failed', error = 'SIZE_MISMATCH' WHERE id = %s",
                   (int(upload_id),))
    assert len(multipart_uploads(upload_id)) == 1
    assert client.request('DELETE', '/uploads/' + upload_id, headers=headers).status_code == 204
    assert multipart_uploads(upload_id) == [] and session_row(seeded, upload_id) is None
    assert s3_keys('staging/' + upload_id) == []


def test_a_chunk_in_flight_when_its_session_fails_is_aborted_again(client, seeded, small_chunks, monkeypatch):
    """A part that lands after the session was failed (and its upload aborted) is aborted again."""
    _, headers = new_user(seeded)
    session = start(client, headers, small_chunks + 10)
    upload_id = session['upload_id']
    # the session fails between this chunk's checks and its upload_part
    original = client.app.ctx.storage.upload_part

    async def failing_meanwhile(key, b2_upload_id, number, data):
        etag = await original(key, b2_upload_id, number, data)
        seeded.execute("UPDATE upload_sessions SET status = 'failed', error = 'FILE_TYPE_NOT_ALLOWED' WHERE id = %s",
                       (int(upload_id),))
        return etag
    monkeypatch.setattr(client.app.ctx.storage, 'upload_part', failing_meanwhile)
    response = put(client, headers, upload_id, 1, b'z' * 10)
    assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_UPLOAD')
    assert multipart_uploads(upload_id) == []
    assert seeded.fetchone('SELECT count(*) FROM upload_parts WHERE session_id = %s', (int(upload_id),))[0] == 0


def test_upload_reaper_aborts_failed_sessions(client, seeded, small_chunks):
    from jobs import tasks
    _, headers = new_user(seeded)
    live = start(client, headers, small_chunks + 10)['upload_id']
    expired = start(client, headers, small_chunks + 10)['upload_id']
    for upload_id in (live, expired):
        assert put(client, headers, upload_id, 0, b'r' * small_chunks).status_code == 204
        seeded.execute("UPDATE upload_sessions SET status = 'failed', error = 'SIZE_MISMATCH' WHERE id = %s",
                       (int(upload_id),))
    seeded.execute("UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = %s",
                   (int(expired),))
    tasks.reap_uploads(seeded.conn)
    # an expired failed session: aborted and deleted
    assert multipart_uploads(expired) == [] and session_row(seeded, expired) is None
    # a failed session within its 24 h: aborted at once, the row kept (GET still says why it failed)
    assert multipart_uploads(live) == []
    assert session_row(seeded, live) == ('failed', 'SIZE_MISMATCH', None)
    assert client.get('/uploads/' + live, headers=headers).json()['error'] == 'SIZE_MISMATCH'
    # idempotent
    tasks.reap_uploads(seeded.conn)
    assert session_row(seeded, live) == ('failed', 'SIZE_MISMATCH', None)


def test_upload_reaper_keeps_a_session_whose_abort_fails(client, seeded, small_chunks):
    from jobs import tasks
    from jobs.finalize import s3
    _, headers = new_user(seeded)
    upload_id = start(client, headers, small_chunks + 10)['upload_id']
    seeded.execute("UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = %s",
                   (int(upload_id),))

    class Refusing:
        def abort_multipart_upload(self, **kwargs):
            raise RuntimeError('B2 is down')

        def delete_object(self, **kwargs):
            raise AssertionError('not reached')

    tasks.reap_uploads(seeded.conn, client=Refusing())
    status, _, b2_upload_id = session_row(seeded, upload_id)
    assert status == 'failed' and b2_upload_id is not None
    assert seeded.fetchone('SELECT expires_at > now() FROM upload_sessions WHERE id = %s', (int(upload_id),))[0]
    # the next run that reaches B2 aborts it
    seeded.execute("UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = %s",
                   (int(upload_id),))
    tasks.reap_uploads(seeded.conn, client=s3())
    assert multipart_uploads(upload_id) == [] and session_row(seeded, upload_id) is None


def test_open_upload_sessions_are_capped(client, seeded, small_chunks, monkeypatch):
    monkeypatch.setenv('UPLOAD_MAX_OPEN_SESSIONS', '2')
    _, headers = new_user(seeded)
    first = start(client, headers, 100)['upload_id']
    second = start(client, headers, 100)['upload_id']
    response = client.post('/uploads', headers=headers, json={'filename': 'c.bin', 'size': 100})
    assert response.status_code == 429 and response.json() == {
        'code': 'TOO_MANY_UPLOADS', 'message': 'Too many uploads in progress. Finish or cancel one first',
        'status': 429, 'limit': 2}
    # another user is unaffected
    _, other = new_user(seeded)
    client.request('DELETE', '/uploads/' + start(client, other, 100)['upload_id'], headers=other)
    # cancelling one, or one failing or expiring, frees a slot
    assert client.request('DELETE', '/uploads/' + first, headers=headers).status_code == 204
    third = start(client, headers, 100)['upload_id']
    seeded.execute("UPDATE upload_sessions SET status = 'failed' WHERE id = %s", (int(second),))
    fourth = start(client, headers, 100)['upload_id']
    seeded.execute("UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = %s",
                   (int(third),))
    fifth = start(client, headers, 100)['upload_id']
    assert client.post('/uploads', headers=headers, json={'filename': 'c.bin', 'size': 100}).status_code == 429
    for upload_id in (second, third, fourth, fifth):
        client.request('DELETE', '/uploads/' + upload_id, headers=headers)

    # anonymous: per guest, and per IP across guests
    ip = '198.51.100.{}'.format(uuid.uuid4().int % 250)
    guest = anonymous(ip)
    opened = [start(client, guest, 100, turnstile_token=TURNSTILE_TOKEN)['upload_id'] for _ in range(2)]
    response = client.post('/uploads', headers=guest,
                           json={'filename': 'c.bin', 'size': 100, 'turnstile_token': TURNSTILE_TOKEN})
    assert (response.status_code, response.json()['code']) == (429, 'TOO_MANY_UPLOADS')
    response = client.post('/uploads', headers=anonymous(ip),
                           json={'filename': 'c.bin', 'size': 100, 'turnstile_token': TURNSTILE_TOKEN})
    assert (response.status_code, response.json()['code']) == (429, 'TOO_MANY_UPLOADS')
    other = anonymous('203.0.113.{}'.format(uuid.uuid4().int % 250))
    extra = start(client, other, 100, turnstile_token=TURNSTILE_TOKEN)['upload_id']
    client.request('DELETE', '/uploads/' + extra, headers=other)
    for upload_id in opened:
        client.request('DELETE', '/uploads/' + upload_id, headers=guest)


# --- configurable public URLs (PUBLIC_URL, CDN_URL) --------------------------------------------

def test_public_urls_default_to_files_gg(client, seeded):
    _, owner = new_user(seeded)
    created = upload(client, owner, generate_password='true')
    vanity = created['vanity']
    assert created['url'] == 'https://files.gg/{}.txt'.format(vanity)
    assert created['cdn_url'].split('?')[0] == 'https://cdn.files.gg/files/{}.txt'.format(vanity)
    assert created['url_with_password'] == 'https://files.gg/{}#pw={}'.format(vanity, created['password'])


def test_public_urls_follow_public_url_and_cdn_url(client, seeded, monkeypatch):
    monkeypatch.setenv('PUBLIC_URL', 'http://files.localhost:8787/')
    monkeypatch.setenv('CDN_URL', 'http://cdn.files.localhost:8787')
    _, owner = new_user(seeded)
    created = upload(client, owner, generate_password='true')
    vanity = created['vanity']
    assert created['url'] == 'http://files.localhost:8787/{}.txt'.format(vanity)
    assert created['cdn_url'].split('?')[0] == 'http://cdn.files.localhost:8787/files/{}.txt'.format(vanity)
    # the signature covers the path only, so it's the same on any CDN origin
    assert_signed(created['cdn_url'], 'file:{}:0'.format(created['id']))
    assert created['url_with_password'] == 'http://files.localhost:8787/{}#pw={}'.format(vanity, created['password'])

    patched = client.request('PATCH', '/users/@me/files/{}'.format(created['id']), headers=owner,
                             json={'generate_password': True}).json()
    assert patched['url_with_password'] == 'http://files.localhost:8787/{}#pw={}'.format(vanity, patched['password'])
    owner_pass = client.post('/users/@me/files/{}/pass'.format(created['id']), headers=owner).json()
    assert owner_pass['url'] == 'http://files.localhost:8787/{}#t={}'.format(vanity, owner_pass['token'])

    found = client.get('/internal/files/' + vanity, headers=ORIGIN).json()
    assert found['file']['cdn_url'] == 'http://cdn.files.localhost:8787/files/{}.txt'.format(vanity)
    assert found['file']['url'] == 'http://files.localhost:8787/{}.txt'.format(vanity)


def test_public_url_validation():
    from utils import urls
    urls.validate({})
    urls.validate({'PUBLIC_URL': 'http://files.localhost:8787', 'CDN_URL': 'https://cdn.staging.example/'})
    for bad in ('files.gg', 'ftp://files.gg', 'https://files.gg/path', 'https://'):
        with pytest.raises(RuntimeError):
            urls.validate({'PUBLIC_URL': bad})


async def test_email_links_follow_public_url(monkeypatch):
    from views import auth as auth_views
    sent = []

    async def fake_send(**kwargs):
        sent.append(kwargs)

    # milestone-6 §2.5: the token is in the fragment of an /app page
    from utils import mail
    from utils.email import Email
    monkeypatch.setattr(Email, 'send', fake_send)
    await mail.send([mail.verify_email('a@example.com', 'alice', 'tok')])
    monkeypatch.setenv('PUBLIC_URL', 'https://staging.example')
    await mail.send([mail.verify_email('a@example.com', 'alice', 'tok'), mail.reset_password('a@example.com', 'alice',
                                                                                             'tok')])
    assert 'https://files.gg/app/verify#token=tok' in sent[0]['text']
    assert 'https://staging.example/app/verify#token=tok' in sent[1]['text']
    assert 'https://staging.example/app/reset#token=tok' in sent[2]['text']


# --- dev tools ------------------------------------------------------------------------------------

def run_create_user(db_url, *args, **env):
    import subprocess
    import sys
    return subprocess.run(
        [sys.executable, '-m', 'tools.create_user', *args], cwd=API_DIR, capture_output=True, text=True,
        env=subprocess_env(DATABASE_URL=db_url, **env), timeout=60)


def test_create_user_refuses_without_dev_tools(migrated_db):
    result = run_create_user(migrated_db.url, '--username', 'devuser', '--password', 'devpass123',
                             FILESGG_DEV_TOOLS=None)
    assert result.returncode == 2 and 'refusing to run' in result.stderr
    result = run_create_user(migrated_db.url, '--username', 'devuser', '--password', 'devpass123',
                             FILESGG_DEV_TOOLS='true')
    assert result.returncode == 2
    assert migrated_db.fetchone('SELECT count(*) FROM users')[0] == 0


def test_create_user_creates_a_verified_user_with_a_working_session(migrated_db):
    """Rewritten for milestone-6 §3 (was: a UserToken and a Werkzeug hash): an argon2id password and a session
    row whose token is printed for the session cookie."""
    from utils import credentials, passwords
    result = run_create_user(migrated_db.url, '--username', 'devuser', '--password', 'devpass123',
                             FILESGG_DEV_TOOLS='1')
    assert result.returncode == 0, result.stderr
    created = json.loads(result.stdout)
    assert created['username'] == 'devuser' and created['email'] == 'devuser@files.localhost'
    session = created['session']
    assert session['name'] == '__Host-filesgg_session' and credentials.well_formed(session['value'], 'fgs_')
    assert migrated_db.fetchone('SELECT user_id FROM sessions WHERE token_hash = %s',
                                (credentials.token_hash(session['value']),))[0] == int(created['id'])
    row = migrated_db.fetchone('SELECT id, email_verified, password_hash FROM users')
    assert str(row[0]) == created['id'] and row[1] is True and passwords.verify_account_sync(row[2], 'devpass123')

    # again: same user, new password, and the insecure cookie name for the local http stack
    result = run_create_user(migrated_db.url, '--username', 'devuser', '--password', 'another123',
                             FILESGG_DEV_TOOLS='1', SESSION_COOKIE_INSECURE='1')
    assert result.returncode == 0, result.stderr
    again = json.loads(result.stdout)
    assert again['id'] == created['id'] and again['session']['name'] == 'filesgg_session'
    assert migrated_db.fetchone('SELECT count(*) FROM users')[0] == 1
    assert passwords.verify_account_sync(migrated_db.fetchone('SELECT password_hash FROM users')[0], 'another123')
