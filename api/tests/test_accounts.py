"""Milestone 6 accounts (docs/redesign/contracts/milestone-6.md §2-§4, §8, §11, §14, §16): the token formats and
signed claims, usernames, passwords, the session cookie and where it's accepted, CSRF, sign-in, register,
verify, forgot and reset, re-authentication, settings, sessions, deletion with its grace period, and exports."""

import io
import json
import time
import uuid
import zipfile

import pytest

from tests.conftest import (
    LOGIN_TOKEN, ORIGIN_SECRET, REGISTER_TOKEN, SESSION_COOKIE, TURNSTILE_TOKEN, VIA_MAIN, APP_DATABASE, TempDatabase,
    cookie_headers, make_user, new_session, sign_in, turnstile_token,
)
from utils import credentials
from utils.generators import Snowflake
from utils.tokens import GuestToken

RESET_TOKEN = turnstile_token('reset')
FORGOT_TOKEN = turnstile_token('forgot')


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


@pytest.fixture
def mx(monkeypatch):
    import views.account
    import views.auth

    async def accepts(address):
        return not address.endswith('@nomail.example')
    monkeypatch.setattr(views.auth, 'domain_accepts_mail', accepts)
    monkeypatch.setattr(views.account, 'domain_accepts_mail', accepts)


def name():
    return 'n_' + uuid.uuid4().hex[:10]


def net(headers=None):
    """A network of its own (the auth rate limits are per IP)."""
    return dict(headers or {}, **{'X-Filesgg-Client-Ip': '10.{}.{}.{}'.format(*uuid.uuid4().bytes[:3])})


def post(client, path, body=None, headers=None, **kwargs):
    return client.post(path, headers=net(dict(VIA_MAIN, **(headers or {}))), json=body or {}, **kwargs)


def cookie_of(response):
    header = response.headers.get('set-cookie') or ''
    return header.split(';')[0].split('=', 1)[1] if header.startswith(SESSION_COOKIE + '=') else None


def register(client, username=None, password='correct-horse', email=None, **extra):
    username = username or name()
    body = dict({'email': email or username.replace('.', '_') + '@example.com', 'username': username,
                 'password': password, 'turnstile_token': REGISTER_TOKEN}, **extra)
    return post(client, '/auth/register', body)


# --- §16.1-§16.4, §16.6, §16.7: formats and rules ---------------------------------------------------------------

TOKENS = [
    ('fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V', 'fgg_', 3255368311,
     '6214c9dda64e05eeb00d08d2d805afba9cc3e4496945181440a4c604549bed26'),
    ('fgg_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz43NeoO', 'fgg_', 3714498764,
     'fac1ad6d76e233aa550fb49b7916a7979bfb47775cada48216b9c97befade753'),
    ('fgg_0000000000000000000000000000001BAc6F', 'fgg_', 1081202267,
     '0991eb42e152ae76c9283d40dae42b65d816321b158c9b8df0656c8d166b07d6'),
    ('fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC', 'fgs_', 2933624500,
     'e5dd67fb14922911fd8419b7eef0d4903813affe498ceefb52be75585a304b8e'),
    ('fgs_Q7xK2mP9vL4nR8tW1yB5cD3fG6hJ0k2iu6sT', 'fgs_', 2495797257,
     'a3835d501243667199c6f3a88379e225c2f421820be2180f80b9774527f0b296'),
]


@pytest.mark.parametrize('token, prefix, crc, digest', TOKENS)
def test_token_vectors(token, prefix, crc, digest):
    assert credentials.well_formed(token, prefix)
    assert credentials.crc32(token) == crc
    assert credentials.token_hash(token).hex() == digest
    assert credentials.checksum(token[:-6]) == token[-6:]


@pytest.mark.parametrize('token, prefix', [
    ('fgg_0123456789ABCDEFGHIJabcdefghij3YJC0W', 'fgg_'),
    ('fgs_0123456789ABCDEFGHIJabcdefghij3YJC0V', 'fgs_'),
    ('fgg_0123456789ABCDEFGHIJabcdefghij3YJC0', 'fgg_'),
])
def test_bad_tokens(token, prefix):
    assert not credentials.well_formed(token, prefix)


def test_generated_tokens_and_the_display_prefix():
    for prefix in ('fgg_', 'fgs_'):
        token = credentials.generate(prefix)
        assert len(token) == 40 and credentials.well_formed(token, prefix)
        assert not credentials.well_formed(token, 'fgs_' if prefix == 'fgg_' else 'fgg_')
    assert credentials.display_prefix('fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V') == 'fgg_01234567'
    import re
    assert re.fullmatch(r'\bfg[gs]_[0-9A-Za-z]{36}\b', credentials.generate('fgg_'))


def test_pkce_vector():
    assert credentials.code_challenge('dBjftJeZ4CVP-mJ92IGzWRE3ZTJ0-YHlfYSV0xHrl4w') == \
        'SkrKhQFbMBX5ptYerKJJajG2CIJ-X_1O1IyRGzbnMZ8'


STATE = ('eyJjIjoiU2tyS2hRRmJNQlg1cHRZZXJLSkphakcyQ0lKLVhfMU8xSXlSR3pibk1aOCIsImUiOjE3OTU2MDQyMDAsImkiOjE3OTU2MDM2MDAs'
         'Im4iOiJuMG5jZS1BYkMxMjMiLCJwIjoibG9naW4iLCJ1IjpudWxsfQ.IhS_8MHN3GRuPXze_CmM976stCIR2ZaU3_35ENFnidw')
LINK_STATE = ('eyJjIjoiU2tyS2hRRmJNQlg1cHRZZXJLSkphakcyQ0lKLVhfMU8xSXlSR3pibk1aOCIsImUiOjE3OTU2MDQyMDAsImkiOjE3OTU2MDM2'
              'MDAsIm4iOiJuMG5jZS1BYkMxMjMiLCJwIjoibGluayIsInUiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5In0.XQseFi7qgojAlK9eM0H2Xq0NgI'
              'Jl-cTGsQKB6lXSiT0')
SIGNUP = ('eyJhIjoiYV8xYjJjM2Q0ZTVmIiwiZCI6IjgwMzUxMTEwMjI0Njc4OTEyIiwiZSI6MTc5NTYwNDUwMCwiZyI6IkRhbiBXIiwibSI6ImRhbkBl'
          'eGFtcGxlLmNvbSIsIm12Ijp0cnVlLCJuIjoiZGFuLncifQ.dTHKYhVaOnp_pzHdX018IqrZTCEuvdOBmNe41i_3cLc')
STATE_CLAIMS = {'c': 'SkrKhQFbMBX5ptYerKJJajG2CIJ-X_1O1IyRGzbnMZ8', 'e': 1795604200, 'i': 1795603600,
                'n': 'n0nce-AbC123', 'p': 'login', 'u': None}


def test_signed_state_and_signup_vectors():
    secret = 'test-secret-key'
    assert credentials.sign(STATE_CLAIMS, credentials.STATE_LABEL, secret) == STATE
    assert credentials.sign(dict(STATE_CLAIMS, p='link', u='1234567890123456789'), credentials.STATE_LABEL,
                            secret) == LINK_STATE
    signup = {'a': 'a_1b2c3d4e5f', 'd': '80351110224678912', 'e': 1795604500, 'g': 'Dan W', 'm': 'dan@example.com',
              'mv': True, 'n': 'dan.w'}
    assert credentials.sign(signup, credentials.SIGNUP_LABEL, secret) == SIGNUP
    assert credentials.unsign(STATE, credentials.STATE_LABEL, secret, now=1795603700) == STATE_CLAIMS
    # rejected: another secret, expired, the wrong label
    forged = STATE.split('.')[0] + '.cov0bNlk7-TsdIbPPPwY4hxHTGXu5GRkTtl4gPue1eE'
    assert credentials.unsign(forged, credentials.STATE_LABEL, secret, now=1795603700) is None
    assert credentials.unsign(STATE, credentials.STATE_LABEL, secret, now=1795604200) is None
    assert credentials.unsign(SIGNUP, credentials.STATE_LABEL, secret, now=1795603700) is None
    assert credentials.unsign(STATE, credentials.SIGNUP_LABEL, secret, now=1795603700) is None


def test_email_rate_key_vector():
    expected = 'acct:a07a8820617033640ae9c815843de5b1524db5c58dabae4d6b875eed027fc576'
    assert credentials.email_key('test-abuse-hash-secret', 'dan@example.com') == expected
    assert credentials.email_key('test-abuse-hash-secret', ' Dan@Example.COM ') == expected


@pytest.mark.parametrize('raw, result', [
    ('Dan.W', 'dan.w'), ('d', 'length'), ('abcdefghijabcdefghijabcdefghijabc', 'length'), ('dan-w', 'characters'),
    ('.dan', 'dots'), ('dan.', 'dots'), ('da..n', 'dots'), ('12345', 'numeric'), ('u12345', 'reserved'),
    ('admin', 'reserved'), ('Files.GG', 'reserved'), ('filesgg_dan', 'reserved'), ('deleted-123', 'characters'),
    ('_x', '_x'),
])
def test_username_vectors(raw, result):
    from utils import usernames
    username, reason = usernames.check(raw)
    assert (reason or username) == result


@pytest.mark.parametrize('raw, cleaned, reason', [
    ('Dan W', 'Dan W', None), ('  Dan ​  W‮ ', 'Dan W', None), ('   ', None, None),
    ('x' * 33, 'x' * 33, 'length'), ('files.gg', 'files.gg', 'reserved'), ('Files GG Fan', 'Files GG Fan', 'reserved'),
    ('S.t-a_f f', 'S.t-a_f f', 'reserved'), ('Support', 'Support', 'reserved'), ('Admin of cats', 'Admin of cats', None),
])
def test_display_names(raw, cleaned, reason):
    from utils import usernames
    assert usernames.clean_display_name(raw) == cleaned
    assert usernames.display_name_reason(cleaned) == reason


@pytest.mark.parametrize('password, reason', [
    ('seven77', 'too_short'), ('eight888', None), ('p' * 1000, None), ('p' * 60000, None),
    ('Dan.W', 'too_short'), ('DAN.W.dan.w', None), ('DAN@example.com', 'matches_email'),
])
def test_password_vectors(password, reason):
    from utils import passwords
    assert passwords.account_password_reason(password, 'dan.w', 'dan@example.com') == reason
    assert passwords.account_password_reason('Dan.W1234', 'dan.w1234', 'x@example.com') == 'matches_username'


def test_username_rules_json_is_stable():
    """The web app's usernameRules.json is `python -m tools.username_rules`'s output."""
    import subprocess
    import sys
    from tests.conftest import API_DIR
    from utils import usernames
    out = subprocess.run([sys.executable, '-m', 'tools.username_rules'], cwd=API_DIR, capture_output=True, text=True,
                         timeout=60)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == usernames.RULES and 'admin' in usernames.RULES['reserved']


# --- §3: the cookie, where it's accepted, and CSRF (§16.11) -------------------------------------------------------

def test_cookie_headers_vector():
    from utils import auth
    token = 'fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC'
    assert auth.set_cookie_header(token, 1811155600 - 1795603600) == (
        '__Host-filesgg_session=fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC; Path=/; Secure; HttpOnly; SameSite=Lax; '
        'Max-Age=15552000')
    assert auth.clear_cookie_header() == '__Host-filesgg_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'


def test_insecure_cookie_name_only_for_the_local_stack(monkeypatch):
    from utils import auth
    from utils.account_settings import account_settings, check_api
    monkeypatch.setenv('SESSION_COOKIE_INSECURE', '1')
    assert account_settings().cookie_name == 'filesgg_session'
    assert auth.clear_cookie_header() == 'filesgg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    with pytest.raises(RuntimeError, match='SESSION_COOKIE_INSECURE'):
        check_api({'SESSION_COOKIE_INSECURE': '1'})
    with pytest.raises(RuntimeError, match='DISCORD'):
        check_api({'DISCORD_CLIENT_ID': 'x'})
    monkeypatch.setenv('FILESGG_DEV_TOOLS', '')
    assert account_settings().cookie_name == '__Host-filesgg_session'


def test_the_cookie_is_accepted_only_through_files_gg_api(client, appdb):
    user_id = make_user(appdb)
    token = new_session(user_id, appdb)
    cookie = {'Cookie': '{}={}; __cf_bm=x'.format(SESSION_COOKIE, token)}
    assert client.get('/users/@me', headers=dict(cookie, **{'X-Filesgg-Origin-Secret': ORIGIN_SECRET,
                                                            'X-Filesgg-Via': 'main'})).status_code == 200
    # api.files.gg (no Via), a client-made Via without the secret, a wrong secret, another Via value
    for headers in ({'X-Filesgg-Origin-Secret': ORIGIN_SECRET}, {'X-Filesgg-Via': 'main'},
                    {'X-Filesgg-Origin-Secret': 'wrong', 'X-Filesgg-Via': 'main'},
                    {'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Via': 'cdn'}, {}):
        response = client.get('/users/@me', headers=dict(cookie, **headers))
        assert response.status_code == 401, headers
        # an ignored cookie isn't cleared either
        assert 'set-cookie' not in response.headers


def test_bearer_and_user_tokens_are_never_a_session(client, appdb):
    user_id = make_user(appdb)
    token = new_session(user_id, appdb)
    for value in ('Bearer ' + token, token, 'Bearer anything'):
        for path in ('/users/@me', '/files/whatever', '/users/@me/files'):
            response = client.get(path, headers=dict(cookie_headers(token), Authorization=value))
            assert (response.status_code, response.json()['code']) == (401, 'UNAUTHORIZED'), (value, path)
    # on the admin and internal paths, any credential problem is the plain 404
    response = client.get('/admin/summary', headers={'Authorization': 'Bearer ' + token})
    assert (response.status_code, response.json()['code']) == (404, 'NOT_FOUND')


@pytest.mark.parametrize('method, path, csrf, origin, site, status', [
    ('GET', '/users/@me', None, None, 'same-origin', 200),
    ('PATCH', '/users/@me', '1', 'https://files.gg', 'same-origin', 200),
    ('PATCH', '/users/@me', None, 'https://files.gg', 'same-origin', 403),
    ('PATCH', '/users/@me', '1', 'https://evil.example', 'cross-site', 403),
    ('PATCH', '/users/@me', '1', 'https://files.gg', 'same-site', 403),
    ('POST', '/users/@me/albums', '1', 'null', 'same-site', 403),
    ('PATCH', '/users/@me', '1', None, None, 200),
    ('PATCH', '/users/@me', '2', None, None, 403),
])
def test_csrf_decisions(client, appdb, method, path, csrf, origin, site, status):
    user_id = make_user(appdb)
    headers = cookie_headers(new_session(user_id, appdb), csrf=False)
    for key, value in (('X-Filesgg-Csrf', csrf), ('Origin', origin), ('Sec-Fetch-Site', site)):
        if value is not None:
            headers[key] = value
    response = client.request(method, path, headers=headers, json={})
    assert response.status_code == status, response.text
    if status == 403:
        assert response.json() == {'code': 'CSRF', 'message': "This request didn't come from files.gg", 'status': 403}


def test_delete_with_only_the_custom_header_passes(client, appdb):
    """Older clients without Origin and Sec-Fetch-Site: the custom header still proves same-origin."""
    user_id = make_user(appdb)
    headers = cookie_headers(new_session(user_id, appdb))
    response = client.request('DELETE', '/users/@me/files/1', headers=headers)
    assert response.status_code != 403


def test_every_auth_post_needs_the_csrf_header(client):
    for path in ('/auth/login', '/auth/register', '/auth/forgot', '/auth/forgot/reset', '/auth/verify',
                 '/auth/logout', '/auth/discord/authorize'):
        response = client.post(path, headers={'Origin': 'https://files.gg', 'Sec-Fetch-Site': 'same-origin'},
                               json={})
        assert (response.status_code, response.json()['code']) == (403, 'CSRF'), path


def test_dead_cookies_are_cleared(client, appdb):
    user_id = make_user(appdb)
    token = new_session(user_id, appdb)
    appdb.execute("UPDATE sessions SET revoked_at = now(), revoked_reason = 'user' WHERE token_hash = %s",
                  (credentials.token_hash(token),))
    for value in (token, 'fgs_0123456789ABCDEFGHIJabcdefghij3CXBkD', 'nonsense'):
        response = client.get('/users/@me', headers=cookie_headers(value))
        assert response.status_code == 401
        assert response.headers['set-cookie'] == \
            '__Host-filesgg_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'
        # GET /auth/session never answers 401
        response = client.get('/auth/session', headers=cookie_headers(value))
        assert response.status_code == 200 and response.json() == {'user': None}
        assert 'Max-Age=0' in response.headers['set-cookie']
        # a dead cookie never falls back to the guest
        response = client.get('/users/@me/files', headers=dict(cookie_headers(value), **{
            'Authorization': 'Guest ' + GuestToken.generate(Snowflake.generate())}))
        assert response.status_code == 401


def test_idle_and_absolute_expiry_and_sliding(client, appdb):
    user_id = make_user(appdb)
    token = new_session(user_id, appdb)
    digest = credentials.token_hash(token)
    appdb.execute("UPDATE sessions SET last_used_at = now() - interval '1 hour', expires_at = now() + interval '1 day' "
                  'WHERE token_hash = %s', (digest,))
    assert client.get('/auth/session', headers=cookie_headers(token)).json()['user']['id'] == str(user_id)
    slid = appdb.fetchone("SELECT expires_at > now() + interval '29 days', last_used_at > now() - interval '1 minute' "
                          'FROM sessions WHERE token_hash = %s', (digest,))
    assert slid == (True, True)
    # never past the absolute expiry
    appdb.execute("UPDATE sessions SET last_used_at = now() - interval '1 hour', max_expires_at = now() + "
                  "interval '2 days' WHERE token_hash = %s", (digest,))
    client.get('/auth/session', headers=cookie_headers(token))
    assert appdb.fetchone('SELECT expires_at = max_expires_at FROM sessions WHERE token_hash = %s', (digest,))[0]
    for column in ('expires_at', 'max_expires_at'):
        fresh = new_session(user_id, appdb)
        appdb.execute('UPDATE sessions SET {} = now() - interval \'1 second\' WHERE token_hash = %s'.format(column),
                      (credentials.token_hash(fresh),))
        assert client.get('/auth/session', headers=cookie_headers(fresh)).json() == {'user': None}


# --- §4: sign-in, register, forgot, reset, logout ------------------------------------------------------------------

def test_register_signs_in_with_the_cookie_only(client, appdb, mx, outbox):
    username = name()
    response = register(client, username=username.upper().replace('N_', 'N_'), display_name='  New  Person ')
    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == {'expires_at', 'user'} and 'fgs_' not in response.text
    user = body['user']
    assert user['username'] == username and user['display_name'] == 'New Person'
    assert user['email_verified'] is False and user['has_password'] is True and user['premium'] == {
        'active': False, 'expires_at': None}
    assert set(user) == {'id', 'username', 'display_name', 'email', 'email_verified', 'pending_email', 'has_password',
                         'needs_username', 'created_at', 'username_changed_at', 'username_change_available_at',
                         'identities', 'settings', 'premium', 'deletion', 'staff', 'restrictions'}
    assert abs(body['expires_at'] - (time.time() + 30 * 86400)) < 60
    token = cookie_of(response)
    assert credentials.well_formed(token, 'fgs_')
    assert 'Max-Age=15552000' in response.headers['set-cookie'] or 'Max-Age=155519' in response.headers['set-cookie']
    assert appdb.fetchone('SELECT method FROM sessions WHERE token_hash = %s', (credentials.token_hash(token),))[0] == \
        'register'
    assert client.get('/auth/session', headers=cookie_headers(token)).json()['user']['id'] == user['id']
    # the verify link: a fragment token, stored hashed, single use
    link = [m for m in outbox if m['tag'] == 'auth-verify'][0]['text']
    verify = link.split('#token=')[1].split()[0]
    assert appdb.fetchone('SELECT count(*) FROM account_tokens WHERE token_hash = %s',
                          (credentials.email_token_hash(verify),))[0] == 1
    assert post(client, '/auth/verify', {'token': verify}).status_code == 204
    assert appdb.fetchone('SELECT email_verified FROM users WHERE id = %s', (int(user['id']),))[0] is True
    assert post(client, '/auth/verify', {'token': verify}).json()['code'] == 'INVALID_TOKEN'


def test_register_refusals(client, appdb, mx):
    taken = name()
    assert register(client, username=taken).status_code == 201
    cases = [
        (dict(username='ab-c'), 400, 'USERNAME_INVALID'),
        (dict(username='admin'), 400, 'USERNAME_INVALID'),
        (dict(password='seven77'), 400, 'INVALID_PASSWORD'),
        (dict(display_name='files.gg staff'), 400, 'DISPLAY_NAME_INVALID'),
        (dict(username='x', password='short'), 400, 'INVALID_PARAMETERS'),
        (dict(email='nope@nomail.example'), 400, 'INVALID_EMAIL'),
        (dict(username=taken, email=name() + '@example.com'), 400, 'USERNAME_TAKEN'),
        (dict(email=taken + '@example.com'), 400, 'EMAIL_TAKEN'),
        (dict(email=taken.upper() + '@EXAMPLE.com'), 400, 'EMAIL_TAKEN'),
        (dict(turnstile_token=LOGIN_TOKEN), 403, 'CAPTCHA_INVALID'),
    ]
    for extra, status, code in cases:
        response = register(client, **extra)
        assert (response.status_code, response.json()['code']) == (status, code), (extra, response.text)
    body = register(client, username='x', password='short').json()
    assert body['reasons'] == {'username': 'length', 'password': 'too_short'}
    assert register(client, password='p' * 60000).status_code == 201


def test_the_64_kib_limit_on_auth_endpoints(client):
    response = post(client, '/auth/register', {'password': 'p' * 66000, 'username': name()})
    assert (response.status_code, response.json()) == (413, {'code': 'REQUEST_TOO_LARGE', 'message': 'Request too large',
                                                             'status': 413, 'limit': 65536})
    response = post(client, '/auth/login', {'email': 'a@b.cd', 'password': 'p' * 66000})
    assert response.status_code == 413
    # other JSON endpoints: 1 MiB
    response = client.post('/reports/anonymous', headers=VIA_MAIN, content=b'{"x": "' + b'a' * 1100000 + b'"}',
                           )
    assert (response.status_code, response.json()['limit']) == (413, 1048576)


def test_register_is_rate_limited_and_refused_to_bans(client, appdb, mx):
    from safety import ip as abuse_ip
    from safety.settings import safety_settings
    ip = '10.77.{}.{}'.format(*uuid.uuid4().bytes[:2])
    headers = {'X-Filesgg-Client-Ip': ip}
    for _ in range(5):
        assert client.post('/auth/register', headers=dict(VIA_MAIN, **headers), json={}).status_code == 400
    response = client.post('/auth/register', headers=dict(VIA_MAIN, **headers), json={})
    assert response.status_code == 429 and response.json()['code'] == 'TOO_MANY_ATTEMPTS'
    assert 0 < response.json()['retry_after'] <= 3600
    # §11.3: bans refuse account creation
    banned_ip = '10.78.{}.{}'.format(*uuid.uuid4().bytes[:2])
    appdb.execute("INSERT INTO bans (abuse_ip_hash, rule) VALUES (%s, 'spam')",
                  (abuse_ip.abuse_ip_hash(banned_ip, safety_settings().abuse_hash_secret),))
    username = name()
    response = client.post('/auth/register', headers=dict(VIA_MAIN, **{'X-Filesgg-Client-Ip': banned_ip}), json={
        'email': username + '@example.com', 'username': username, 'password': 'correct-horse',
        'turnstile_token': REGISTER_TOKEN})
    assert (response.status_code, response.json()['code']) == (403, 'BANNED')
    guest = Snowflake.generate()
    appdb.execute("INSERT INTO bans (guest_id, rule) VALUES (%s, 'spam')", (guest,))
    response = post(client, '/auth/register', {'email': username + '@example.com', 'username': username,
                                               'password': 'correct-horse', 'turnstile_token': REGISTER_TOKEN},
                    headers={'Authorization': 'Guest ' + GuestToken.generate(guest)})
    assert (response.status_code, response.json()['code']) == (403, 'BANNED')


def test_login_claims_files_and_albums_and_replaces_the_session(client, appdb, mx):
    username = name()
    created = register(client, username=username)
    old = cookie_of(created)
    guest_id = Snowflake.generate()
    guest = {'Authorization': 'Guest ' + GuestToken.generate(guest_id)}
    response = client.post('/files', headers=guest, files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    file_id = int(response.json()['id'])
    album_id = Snowflake.generate()
    appdb.execute("INSERT INTO albums (id, vanity, owner_guest_id) VALUES (%s, %s, %s)",
                  (album_id, 'al' + uuid.uuid4().hex[:8], guest_id))
    response = client.post('/auth/login', headers=net(dict(cookie_headers(old), **guest)), json={
        'email': username.upper() + '@EXAMPLE.COM', 'password': 'correct-horse', 'turnstile_token': LOGIN_TOKEN})
    assert response.status_code == 200, response.text
    user_id = int(response.json()['user']['id'])
    assert appdb.fetchone('SELECT user_id, guest_id FROM files WHERE id = %s', (file_id,)) == (user_id, None)
    assert appdb.fetchone('SELECT owner_user_id, owner_guest_id FROM albums WHERE id = %s', (album_id,)) == \
        (user_id, None)
    # one browser, one session: the old cookie's session ended
    assert client.get('/auth/session', headers=cookie_headers(old)).json() == {'user': None}
    assert appdb.fetchone('SELECT revoked_reason FROM sessions WHERE token_hash = %s',
                          (credentials.token_hash(old),))[0] == 'logout'
    assert client.get('/auth/session', headers=cookie_headers(cookie_of(response))).json()['user'] is not None


def test_login_rate_limits(client, appdb):
    username = name()
    make_user(appdb, username=username, password='correct-horse')
    ip = {'X-Filesgg-Client-Ip': '10.88.{}.{}'.format(*uuid.uuid4().bytes[:2])}
    body = {'email': username + '@example.com', 'password': 'wrong', 'turnstile_token': LOGIN_TOKEN}
    for _ in range(10):
        response = client.post('/auth/login', headers=dict(VIA_MAIN, **ip), json=body)
        assert response.json()['code'] == 'INVALID_CREDENTIALS'
    # login_account: 10 failures an hour, from any network, even with the right password
    for headers in (ip, net()):
        response = client.post('/auth/login', headers=dict(VIA_MAIN, **headers), json=dict(body, password='correct-horse'))
        assert response.status_code == 429 and response.json()['code'] == 'TOO_MANY_ATTEMPTS'
    # login_ip: 30 failures an hour from one network, whatever the account
    ip = {'X-Filesgg-Client-Ip': '10.89.{}.{}'.format(*uuid.uuid4().bytes[:2])}
    for _ in range(30):
        client.post('/auth/login', headers=dict(VIA_MAIN, **ip), json=dict(body, email=name() + '@example.com'))
    response = client.post('/auth/login', headers=dict(VIA_MAIN, **ip), json=dict(body, email=name() + '@example.com'))
    assert response.status_code == 429


def test_signing_in_before_verifying_and_with_a_pending_deletion(client, appdb):
    username = name()
    user_id = make_user(appdb, username=username, password='correct-horse', verified=False)
    appdb.execute("UPDATE users SET deletion_requested_at = now(), deletion_scheduled_for = now() + interval '14 days' "
                  'WHERE id = %s', (user_id,))
    response = post(client, '/auth/login', {'email': username + '@example.com', 'password': 'correct-horse',
                                            'turnstile_token': LOGIN_TOKEN})
    assert response.status_code == 200
    assert response.json()['user']['deletion']['scheduled_for'] > time.time() + 13 * 86400


def test_logout_is_idempotent(client, appdb):
    user_id = make_user(appdb)
    token = new_session(user_id, appdb)
    for _ in range(2):
        response = client.post('/auth/logout', headers=cookie_headers(token))
        assert response.status_code == 204 and 'Max-Age=0' in response.headers['set-cookie']
    assert client.post('/auth/logout', headers=VIA_MAIN).status_code == 204


def test_forgot_never_enumerates(client, appdb, outbox):
    username = name()
    user_id = make_user(appdb, username=username, verified=False)
    unknown = post(client, '/auth/forgot', {'email': name() + '@example.com', 'turnstile_token': FORGOT_TOKEN})
    known = post(client, '/auth/forgot', {'email': username + '@example.com', 'turnstile_token': FORGOT_TOKEN})
    assert unknown.status_code == known.status_code == 204 and unknown.content == known.content == b''
    assert [m['to'] for m in outbox] == [username + '@example.com']
    assert '/app/reset#token=' in outbox[0]['text']
    assert post(client, '/auth/forgot', {'email': 'x@example.com'}).json()['code'] == 'CAPTCHA_INVALID'
    # forgot_account: 3 an hour per address, then still 204 with nothing sent
    for _ in range(4):
        assert post(client, '/auth/forgot', {'email': username + '@example.com',
                                             'turnstile_token': FORGOT_TOKEN}).status_code == 204
    assert len(outbox) == 3
    token = outbox[0]['text'].split('#token=')[1].split()[0]
    # a Discord-only account (no password) sets its first one this way
    appdb.execute('UPDATE users SET password_hash = NULL WHERE id = %s', (user_id,))
    other = new_session(user_id, appdb)
    response = post(client, '/auth/forgot/reset', {'token': token, 'password': 'seven77', 'turnstile_token': RESET_TOKEN})
    assert response.json()['code'] == 'INVALID_PASSWORD'
    response = post(client, '/auth/forgot/reset', {'token': token, 'password': 'first-password',
                                                   'turnstile_token': RESET_TOKEN})
    assert response.status_code == 200 and response.json()['user']['email_verified'] is True
    assert response.json()['user']['has_password'] is True
    assert client.get('/auth/session', headers=cookie_headers(other)).json() == {'user': None}
    assert post(client, '/auth/forgot/reset', {'token': token, 'password': 'second-password',
                                               'turnstile_token': RESET_TOKEN}).json()['code'] == 'INVALID_TOKEN'


def test_reset_links_expire_and_follow_the_email(client, appdb, outbox):
    username = name()
    user_id = make_user(appdb, username=username)
    post(client, '/auth/forgot', {'email': username + '@example.com', 'turnstile_token': FORGOT_TOKEN})
    token = outbox[-1]['text'].split('#token=')[1].split()[0]
    appdb.execute('UPDATE users SET email = %s WHERE id = %s', ('changed-' + username + '@example.com', user_id))
    response = post(client, '/auth/forgot/reset', {'token': token, 'password': 'new-password',
                                                   'turnstile_token': RESET_TOKEN})
    assert response.json()['code'] == 'INVALID_TOKEN'
    appdb.execute('UPDATE users SET email = %s WHERE id = %s', (username + '@example.com', user_id))
    appdb.execute("UPDATE account_tokens SET expires_at = now() - interval '1 second' WHERE user_id = %s", (user_id,))
    response = post(client, '/auth/forgot/reset', {'token': token, 'password': 'new-password',
                                                   'turnstile_token': RESET_TOKEN})
    assert response.json()['code'] == 'INVALID_TOKEN'


def test_resend_and_nothing_to_verify(client, appdb, outbox):
    verified = make_user(appdb)
    response = client.post('/auth/verify/resend', headers=sign_in(verified, appdb))
    assert (response.status_code, response.json()['code']) == (409, 'NOTHING_TO_VERIFY')
    user_id = make_user(appdb, verified=False)
    headers = sign_in(user_id, appdb)
    for _ in range(5):
        assert client.post('/auth/verify/resend', headers=headers).status_code == 204
    response = client.post('/auth/verify/resend', headers=headers)
    assert (response.status_code, response.json()['code']) == (429, 'TOO_MANY_ATTEMPTS')
    assert len(outbox) == 5 and outbox[0]['tag'] == 'auth-verify'


# --- §3.5: re-authentication -----------------------------------------------------------------------------------------

def test_reauth_and_fresh_sessions(client, appdb, mx, outbox):
    username = name()
    user_id = make_user(appdb, username=username, password='correct-horse')
    stale = sign_in(user_id, appdb, authenticated_ago=3600)
    response = client.post('/users/@me/email', headers=stale, json={'email': name() + '@example.com'})
    assert (response.status_code, response.json()) == (403, {
        'code': 'REAUTH_REQUIRED', 'message': "Confirm it's you to continue", 'status': 403, 'methods': ['password']})
    assert client.post('/auth/reauth', headers=stale, json={'password': 'wrong'}).json()['code'] == \
        'INVALID_CREDENTIALS'
    assert client.post('/auth/reauth', headers=stale, json={'password': 'correct-horse'}).status_code == 204
    new_email = name() + '@example.com'
    response = client.post('/users/@me/email', headers=stale, json={'email': new_email})
    assert response.status_code == 202 and response.json()['pending_email'] == new_email
    # the old address keeps working until the link is used; the link goes to the new one
    assert outbox[-1]['to'] == new_email
    token = outbox[-1]['text'].split('#token=')[1].split()[0]
    assert post(client, '/auth/verify', {'token': token}).status_code == 204
    row = appdb.fetchone('SELECT email, pending_email, email_verified FROM users WHERE id = %s', (user_id,))
    assert row == (new_email, None, True)
    assert outbox[-1]['tag'] == 'auth-email-changed' and outbox[-1]['to'] == username + '@example.com'
    assert '***@example.com' in outbox[-1]['text']


def test_reauth_failures_are_limited(client, appdb):
    user_id = make_user(appdb, password='correct-horse')
    headers = sign_in(user_id, appdb)
    for _ in range(10):
        client.post('/auth/reauth', headers=headers, json={'password': 'nope'})
    response = client.post('/auth/reauth', headers=headers, json={'password': 'correct-horse'})
    assert (response.status_code, response.json()['code']) == (429, 'TOO_MANY_ATTEMPTS')


def test_a_pending_email_taken_meanwhile_is_dropped(client, appdb, mx, outbox):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    wanted = name() + '@example.com'
    assert client.post('/users/@me/email', headers=headers, json={'email': wanted}).status_code == 202
    token = outbox[-1]['text'].split('#token=')[1].split()[0]
    make_user(appdb, email=wanted)
    assert post(client, '/auth/verify', {'token': token}).json()['code'] == 'EMAIL_TAKEN'
    assert appdb.fetchone('SELECT pending_email FROM users WHERE id = %s', (user_id,))[0] is None
    # an account with no email gets the new one at once, unverified
    bare = make_user(appdb, email=None)
    address = name() + '@example.com'
    response = client.post('/users/@me/email', headers=sign_in(bare, appdb), json={'email': address})
    assert response.status_code == 202
    assert appdb.fetchone('SELECT email, email_verified FROM users WHERE id = %s', (bare,)) == (address, False)


# --- §8: profile, username, sessions, password --------------------------------------------------------------------

def test_profile_and_public_profiles(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    response = client.patch('/users/@me', headers=headers, json={'display_name': ' Dan  W ',
                                                                 'settings': {'show_name_on_albums': True}})
    assert response.status_code == 200
    assert response.json()['display_name'] == 'Dan W' and response.json()['settings']['show_name_on_albums'] is True
    assert client.patch('/users/@me', headers=headers, json={'display_name': 'Admin'}).json()['code'] == \
        'DISPLAY_NAME_INVALID'
    assert client.patch('/users/@me', headers=headers, json={'display_name': None}).json()['display_name'] is None
    assert client.get('/users/{}'.format(user_id), headers=headers).status_code == 404


def test_album_owner_line(client, appdb):
    user_id = make_user(appdb, display_name='Dan W')
    headers = sign_in(user_id, appdb)
    created = client.post('/files', headers=headers, files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')}).json()
    album = client.post('/users/@me/albums', headers=headers, json={'file_ids': [created['id']]}).json()
    assert client.get('/albums/' + album['vanity']).json()['owner'] is None
    appdb.execute('UPDATE users SET show_name_on_albums = true WHERE id = %s', (user_id,))
    owner = client.get('/albums/' + album['vanity']).json()['owner']
    assert owner == {'id': str(user_id), 'username': appdb.fetchone('SELECT username FROM users WHERE id = %s',
                                                                    (user_id,))[0], 'display_name': 'Dan W'}


def test_usernames_cooldown_and_holds(client, appdb):
    original = name()
    user_id = make_user(appdb, username=original)
    headers = sign_in(user_id, appdb)
    first = name()
    response = client.put('/users/@me/username', headers=headers, json={'username': first.upper()})
    assert response.status_code == 200 and response.json()['username'] == first
    available_at = response.json()['username_change_available_at']
    assert abs(available_at - (time.time() + 30 * 86400)) < 60
    response = client.put('/users/@me/username', headers=headers, json={'username': name()})
    assert (response.status_code, response.json()['code']) == (409, 'USERNAME_COOLDOWN')
    assert response.json()['available_at'] == available_at
    # the old name is held for its previous owner: anyone else gets USERNAME_TAKEN
    other = sign_in(make_user(appdb), appdb)
    assert client.put('/users/@me/username', headers=other, json={'username': original}).json()['code'] == \
        'USERNAME_TAKEN'
    check = client.get('/users/@me/username/check?username=' + original).json()
    assert check == {'username': original, 'available': False, 'reason': 'taken'}
    appdb.execute("UPDATE users SET username_changed_at = now() - interval '31 days' WHERE id = %s", (user_id,))
    response = client.put('/users/@me/username', headers=headers, json={'username': original})
    assert response.status_code == 200, response.text
    assert appdb.fetchone('SELECT count(*) FROM username_holds WHERE username = %s', (original,))[0] == 0


def test_username_check_signed_out_and_its_limit(client):
    ip = {'X-Filesgg-Client-Ip': '10.90.{}.{}'.format(*uuid.uuid4().bytes[:2])}
    headers = dict(VIA_MAIN, **ip)
    assert client.get('/users/@me/username/check?username=Dan.W', headers=headers).json()['username'] == 'dan.w'
    assert client.get('/users/@me/username/check?username=admin', headers=headers).json() == {
        'username': 'admin', 'available': False, 'reason': 'reserved'}
    for _ in range(58):
        client.get('/users/@me/username/check?username=' + name(), headers=headers)
    response = client.get('/users/@me/username/check?username=' + name(), headers=headers)
    assert (response.status_code, response.json()['code']) == (429, 'TOO_MANY_ATTEMPTS')


def test_sessions_list_sign_out_one_and_everywhere(client, appdb):
    user_id = make_user(appdb)
    tokens = [new_session(user_id, appdb) for _ in range(3)]
    appdb.execute("UPDATE sessions SET user_agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 "
                  "Firefox/140.0', country = 'GB' WHERE token_hash = %s", (credentials.token_hash(tokens[0]),))
    headers = cookie_headers(tokens[0])
    items = client.get('/users/@me/sessions', headers=headers).json()['items']
    assert len(items) == 3 and sum(i['current'] for i in items) == 1
    current = [i for i in items if i['current']][0]
    assert current['device'] == 'Firefox on macOS' and current['country'] == 'GB' and current['method'] == 'password'
    assert 'token' not in json.dumps(items) and 'hash' not in json.dumps(items)
    other = [i for i in items if not i['current']][0]
    assert client.delete('/users/@me/sessions/' + other['id'], headers=headers).status_code == 204
    assert client.delete('/users/@me/sessions/' + other['id'], headers=headers).json()['code'] == 'UNKNOWN_SESSION'
    stranger = new_session(make_user(appdb), appdb)
    stranger_id = appdb.fetchone('SELECT id FROM sessions WHERE token_hash = %s', (credentials.token_hash(stranger),))[0]
    assert client.delete('/users/@me/sessions/{}'.format(stranger_id), headers=headers).status_code == 404
    response = client.delete('/users/@me/sessions', headers=headers)
    assert response.json() == {'revoked': 2} and 'Max-Age=0' in response.headers['set-cookie']
    for token in tokens:
        assert client.get('/auth/session', headers=cookie_headers(token)).json() == {'user': None}
    assert {r[0] for r in appdb.fetchall('SELECT revoked_reason FROM sessions WHERE user_id = %s', (user_id,))} == \
        {'user', 'everywhere'}


def test_the_51st_session_ends_the_least_recently_used(client, appdb, monkeypatch):
    monkeypatch.setenv('SESSIONS_MAX', '3')
    username = name()
    user_id = make_user(appdb, username=username, password='correct-horse')
    tokens = []
    for _ in range(4):
        response = post(client, '/auth/login', {'email': username + '@example.com', 'password': 'correct-horse',
                                                'turnstile_token': LOGIN_TOKEN})
        tokens.append(cookie_of(response))
    assert client.get('/auth/session', headers=cookie_headers(tokens[0])).json() == {'user': None}
    assert appdb.fetchone("SELECT count(*) FROM sessions WHERE user_id = %s AND revoked_reason = 'limit'",
                          (user_id,))[0] == 1


def test_password_change_ends_the_other_sessions(client, appdb, outbox):
    user_id = make_user(appdb, password='correct-horse')
    current, other = sign_in(user_id, appdb), sign_in(user_id, appdb)
    response = client.put('/users/@me/password', headers=current, json={'new_password': 'brand-new-pass'})
    assert response.json()['code'] == 'INVALID_CREDENTIALS'
    response = client.put('/users/@me/password', headers=current, json={'current_password': 'correct-horse',
                                                                        'new_password': 'correct-horse'})
    assert response.json()['code'] == 'SAME_PASSWORD'
    response = client.put('/users/@me/password', headers=current, json={'current_password': 'correct-horse',
                                                                        'new_password': 'short'})
    assert response.json()['errors'] == {'new_password': 'Use at least 8 characters'}
    response = client.put('/users/@me/password', headers=current, json={'current_password': 'correct-horse',
                                                                        'new_password': 'brand-new-pass'})
    assert response.status_code == 204
    assert client.get('/users/@me', headers=current).status_code == 200
    assert client.get('/users/@me', headers=other).status_code == 401
    assert outbox[-1]['tag'] == 'auth-password-changed'
    # a first password (Discord-only account) needs a fresh session and a verified email
    bare = make_user(appdb, verified=False)
    response = client.put('/users/@me/password', headers=sign_in(bare, appdb), json={'new_password': 'first-pass'})
    assert response.json()['code'] == 'EMAIL_NOT_VERIFIED'
    response = client.put('/users/@me/password', headers=sign_in(bare, appdb, authenticated_ago=3600),
                          json={'new_password': 'first-pass'})
    assert response.json()['code'] == 'REAUTH_REQUIRED'


# --- §8.8: deletion with a 14-day grace period ------------------------------------------------------------------------

def make_content(client, headers):
    created = client.post('/files', headers=headers, files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')}).json()
    album = client.post('/users/@me/albums', headers=headers, json={'file_ids': [created['id']]}).json()
    return created, album


def test_deletion_cancel_and_the_grace_period(client, appdb, outbox, mx):
    from tests.m3 import ORIGIN
    username = name()
    user_id = make_user(appdb, username=username, password='correct-horse')
    headers, other = sign_in(user_id, appdb), sign_in(user_id, appdb)
    created, album = make_content(client, headers)
    response = client.post('/users/@me/delete', headers=headers, json={'confirm_username': 'wrong'})
    assert response.json()['code'] == 'INVALID_PARAMETERS'
    response = client.post('/users/@me/delete', headers=sign_in(user_id, appdb, authenticated_ago=3600),
                           json={'confirm_username': username})
    assert response.json()['code'] == 'REAUTH_REQUIRED'
    response = client.post('/users/@me/delete', headers=headers, json={'confirm_username': username})
    assert response.status_code == 202
    deletion = response.json()['deletion']
    assert deletion['scheduled_for'] - deletion['requested_at'] == 14 * 86400
    assert outbox[-1]['tag'] == 'auth-deletion-requested'
    # every other session ended; the current one stays to cancel
    assert client.get('/users/@me', headers=other).status_code == 401
    me = client.get('/users/@me', headers=headers).json()
    assert me['deletion'] == deletion
    # locked: only the allowlist works
    assert client.get('/users/@me/files', headers=headers).json()['code'] == 'ACCOUNT_PENDING_DELETION'
    assert client.patch('/users/@me', headers=headers, json={}).json()['code'] == 'ACCOUNT_PENDING_DELETION'
    assert client.get('/users/@me/sessions', headers=headers).status_code == 200
    assert client.post('/users/@me/delete', headers=headers, json={'confirm_username': username}).json() == {
        'code': 'ACCOUNT_DELETE_NOT_ALLOWED', 'message': 'Your account is already scheduled for deletion',
        'status': 409, 'reason': 'pending'}
    # content is offline, as missing (never removed), on every public read
    assert client.get('/files/' + created['vanity']).json()['code'] == 'UNKNOWN_FILE'
    assert client.get('/albums/' + album['vanity']).json()['code'] == 'UNKNOWN_ALBUM'
    lookup = client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()
    assert lookup['owner_state'] == 'pending_deletion' and lookup['safety']['state'] == 'ok'
    assert client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()['owner_state'] == \
        'pending_deletion'
    # the username and email stay the account's
    assert register(client, username=username).json()['code'] in ('USERNAME_TAKEN', 'EMAIL_TAKEN')
    # Keep my account
    response = client.post('/users/@me/delete/cancel', headers=headers)
    assert response.status_code == 200 and response.json()['deletion'] is None
    assert outbox[-1]['tag'] == 'auth-deletion-cancelled'
    assert client.get('/files/' + created['vanity']).status_code == 200
    assert client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()['owner_state'] == 'active'


def test_staff_and_suspended_accounts_cant_request_deletion(client, appdb):
    from tests.m4 import make_staff
    staff_id, headers = make_staff(appdb)
    username = appdb.fetchone('SELECT username FROM users WHERE id = %s', (staff_id,))[0]
    response = client.post('/users/@me/delete', headers=headers, json={'confirm_username': username})
    assert (response.status_code, response.json()['reason']) == (409, 'staff')
    user_id = make_user(appdb)
    appdb.execute("INSERT INTO user_restrictions (user_id, kind, rule) VALUES (%s, 'suspended', 'spam')", (user_id,))
    response = client.post('/users/@me/delete', headers=sign_in(user_id, appdb), json={})
    assert response.json()['code'] == 'ACCOUNT_SUSPENDED'


def test_the_permanent_deletion_after_14_days(client, appdb, outbox):
    from jobs import accounts as account_jobs
    from tests.m3 import ORIGIN
    username = name()
    user_id = make_user(appdb, username=username, password='correct-horse')
    headers = sign_in(user_id, appdb)
    created, album = make_content(client, headers)
    appdb.execute("INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES (%s, %s, 'discord', %s)",
                  (Snowflake.generate(), user_id, str(Snowflake.generate())))
    appdb.execute("INSERT INTO upload_keys (id, user_id, name, prefix, key_hash, scopes) VALUES (%s, %s, 'k', "
                  "'fgg_01234567', %s, ARRAY['files:upload'])", (Snowflake.generate(), user_id, uuid.uuid4().bytes * 2))
    from tests.conftest import set_premium
    set_premium(user_id, appdb)
    assert client.post('/users/@me/delete', headers=headers, json={'confirm_username': username}).status_code == 202
    # not before the 14 days
    with appdb.connect() as conn:
        assert account_jobs.delete_account(conn, user_id) == ([], [])
    appdb.execute("UPDATE users SET deletion_scheduled_for = now() - interval '1 second' WHERE id = %s", (user_id,))
    with appdb.connect() as conn:
        assert account_jobs.run_deletions(conn) >= 1
    row = appdb.fetchone('SELECT username, email, password_hash, display_name, deleted_at IS NOT NULL, '
                         'deletion_requested_at FROM users WHERE id = %s', (user_id,))
    assert row == ('deleted-{}'.format(user_id), None, None, None, True, None)
    assert appdb.fetchone('SELECT user_id FROM username_holds WHERE username = %s', (username,))[0] == user_id
    assert appdb.fetchone("SELECT count(*) FROM sessions WHERE user_id = %s AND revoked_reason = 'account_deleted'",
                          (user_id,))[0] >= 1
    assert appdb.fetchone('SELECT revoked_reason FROM upload_keys WHERE user_id = %s', (user_id,))[0] == \
        'account_deleted'
    assert appdb.fetchone('SELECT count(*) FROM user_identities WHERE user_id = %s', (user_id,))[0] == 0
    assert appdb.fetchone('SELECT deleted_reason FROM files WHERE id = %s', (int(created['id']),))[0] == \
        'account_deleted'
    assert appdb.fetchone('SELECT deleted_reason FROM albums WHERE vanity = %s', (album['vanity'],))[0] == \
        'account_deleted'
    assert appdb.fetchone("SELECT details->>'reason' FROM moderation_actions WHERE user_id = %s AND action = "
                          "'revoke_entitlement'", (user_id,))[0] == 'account_deleted'
    assert outbox[-1]['tag'] == 'auth-account-deleted' and outbox[-1]['to'] == username + '@example.com'
    assert client.get('/users/@me', headers=headers).status_code == 401
    assert client.get('/internal/files/' + created['vanity'], headers=ORIGIN).status_code == 404
    # the email and (after the hold) the Discord account can be used again
    assert appdb.fetchone('SELECT count(*) FROM users WHERE lower(email) = %s', (username + '@example.com',))[0] == 0


# --- §8.7: data export --------------------------------------------------------------------------------------------------

def test_data_export(client, appdb):
    from jobs import accounts as account_jobs
    user_id = make_user(appdb, display_name='Exporter')
    headers = sign_in(user_id, appdb)
    created, album = make_content(client, headers)
    response = client.post('/users/@me/exports', headers=headers)
    assert response.status_code == 202 and response.json()['export']['status'] == 'queued'
    export_id = response.json()['export']['id']
    again = client.post('/users/@me/exports', headers=headers)
    assert again.status_code == 429 and again.json()['code'] == 'EXPORT_LIMIT' and again.json()['retry_after'] > 0
    assert client.get('/users/@me/exports/{}/download'.format(export_id), headers=headers).json()['code'] == \
        'EXPORT_NOT_READY'
    account_jobs.account_export({'export_id': export_id}, None)
    listed = client.get('/users/@me/exports', headers=headers).json()['items'][0]
    assert listed['status'] == 'ready' and listed['size'] > 0
    assert abs(listed['expires_at'] - (time.time() + 7 * 86400)) < 60
    response = client.get('/users/@me/exports/{}/download'.format(export_id), headers=headers)
    assert response.status_code == 200 and response.headers['content-type'] == 'application/zip'
    assert response.headers['cache-control'] == 'private, no-store'
    assert 'attachment; filename="filesgg-export-' in response.headers['content-disposition']
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert set(archive.namelist()) == {'account.json', 'identities.json', 'sessions.json', 'upload_keys.json',
                                       'domains.json', 'files.json', 'albums.json', 'reports.json', 'notices.json',
                                       'README.txt'}
    assert all(i.compress_type == zipfile.ZIP_STORED for i in archive.infolist())
    assert json.loads(archive.read('account.json'))['display_name'] == 'Exporter'
    assert json.loads(archive.read('files.json'))[0]['id'] == created['id']
    assert json.loads(archive.read('albums.json'))[0]['items'][0]['file_id'] == created['id']
    sessions = archive.read('sessions.json').decode()
    assert 'fgs_' not in sessions and 'token_hash' not in sessions
    # someone else's export is unknown; expired ones go
    other = sign_in(make_user(appdb), appdb)
    assert client.get('/users/@me/exports/{}/download'.format(export_id), headers=other).status_code == 404
    appdb.execute("UPDATE data_exports SET expires_at = now() - interval '1 second' WHERE id = %s", (int(export_id),))
    with appdb.connect() as conn:
        assert account_jobs.cleanup_exports(conn) >= 1
    assert client.get('/users/@me/exports/{}/download'.format(export_id), headers=headers).json()['code'] == \
        'UNKNOWN_EXPORT'


# --- §11.1: suspended accounts -------------------------------------------------------------------------------------------

def test_suspended_accounts_allowlist(client, appdb):
    user_id = make_user(appdb, password='correct-horse')
    appdb.execute("INSERT INTO user_restrictions (user_id, kind, rule) VALUES (%s, 'suspended', 'spam')", (user_id,))
    headers = sign_in(user_id, appdb)
    assert client.get('/users/@me', headers=headers).status_code == 200
    assert client.get('/users/@me/sessions', headers=headers).status_code == 200
    assert client.post('/users/@me/exports', headers=headers).status_code == 202
    assert client.put('/users/@me/password', headers=headers, json={'current_password': 'correct-horse',
                                                                    'new_password': 'another-pass'}).status_code == 204
    for method, path in (('GET', '/users/@me/files'), ('POST', '/users/@me/upload-keys'),
                         ('POST', '/users/@me/domains'), ('PATCH', '/users/@me'), ('POST', '/users/@me/delete'),
                         ('PUT', '/users/@me/username')):
        response = client.request(method, path, headers=headers, json={})
        assert response.json()['code'] == 'ACCOUNT_SUSPENDED', path


# --- §15, §16.2: config, the session cleanup --------------------------------------------------------------------------------

def test_auth_config_and_session_cleanup(client, appdb):
    from jobs import accounts as account_jobs
    assert client.get('/auth/config').json() == {'discord': False}
    user_id = make_user(appdb)
    token = new_session(user_id, appdb)
    appdb.execute("UPDATE sessions SET revoked_at = now() - interval '31 days', revoked_reason = 'user' WHERE "
                  'token_hash = %s', (credentials.token_hash(token),))
    appdb.execute("INSERT INTO username_holds (username, user_id, held_until) VALUES (%s, %s, now() - interval '1 day')",
                  (name(), user_id))
    with appdb.connect() as conn:
        sessions, _, holds = account_jobs.cleanup_sessions(conn)
    assert sessions >= 1 and holds >= 1
    assert appdb.fetchone('SELECT count(*) FROM sessions WHERE token_hash = %s', (credentials.token_hash(token),))[0] == 0
