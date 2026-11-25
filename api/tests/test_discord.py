"""Milestone 6 Discord sign-in (docs/redesign/contracts/milestone-6.md §5, §16.2, §16.3): PKCE and the signed
state, sign-up with the email rules, linking, re-authentication, unlinking and the last-login-method rule.
Discord is mocked at the HTTP layer (utils/discord.py TRANSPORT): the suite never reaches it."""

import base64
import hashlib
import secrets
import time
import uuid

from urllib.parse import parse_qsl, urlsplit

import httpx
import pytest

from tests.conftest import (
    APP_DATABASE, LOGIN_TOKEN, REGISTER_TOKEN, VIA_MAIN, TempDatabase, cookie_headers, make_user, new_session, sign_in,
)
from utils import credentials
from utils.generators import Snowflake
from utils.tokens import GuestToken


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


class FakeDiscord:
    def __init__(self):
        self.calls = []
        self.me = None
        self.token_status = 200
        self.me_status = 200
        self.headers = {}

    def user(self, verified=True, email='default', username=None, global_name='Dan W', avatar='a_1b2c3d4e5f'):
        discord_id = str(Snowflake.generate())
        username = username or 'dan' + uuid.uuid4().hex[:6]
        self.me = {'id': discord_id, 'username': username, 'global_name': global_name, 'avatar': avatar,
                   'email': '{}@example.com'.format(username) if email == 'default' else email, 'verified': verified}
        return self.me

    def __call__(self, request):
        path = request.url.path
        form = dict(parse_qsl(request.content.decode())) if request.content else {}
        self.calls.append((request.method, path, form, request.headers.get('authorization')))
        if path == '/api/oauth2/token':
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={'error': 'invalid_grant', 'retry_after': 7},
                                      headers=self.headers)
            return httpx.Response(200, json={'access_token': 'discord-access-' + form['code'], 'token_type': 'Bearer',
                                             'expires_in': 604800, 'refresh_token': 'r', 'scope': 'identify email'})
        if path == '/api/v10/users/@me':
            if self.me_status != 200:
                return httpx.Response(self.me_status, json={})
            return httpx.Response(200, json=self.me)
        if path == '/api/oauth2/token/revoke':
            return httpx.Response(200, json={})
        return httpx.Response(404)


@pytest.fixture
def discord(monkeypatch):
    from utils import discord as discord_module
    fake = FakeDiscord()
    monkeypatch.setenv('DISCORD_CLIENT_ID', '1234567890')
    monkeypatch.setenv('DISCORD_CLIENT_SECRET', 'test-discord-secret')
    monkeypatch.setattr(discord_module, 'TRANSPORT', httpx.MockTransport(fake))
    return fake


def pkce():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    return verifier, challenge


def net(headers):
    return dict(VIA_MAIN, **headers, **{'X-Filesgg-Client-Ip': '10.{}.{}.{}'.format(*uuid.uuid4().bytes[:3])})


def authorize(client, purpose='login', headers=None):
    verifier, challenge = pkce()
    response = client.post('/auth/discord/authorize', headers=dict(VIA_MAIN, **(headers or {})),
                           json={'purpose': purpose, 'code_challenge': challenge})
    assert response.status_code == 200, response.text
    return verifier, response.json()


def callback(client, purpose='login', headers=None, verifier=None, state=None, code=None, turnstile=LOGIN_TOKEN):
    if state is None:
        verifier, body = authorize(client, purpose, headers)
        state = body['state']
    payload = {'code': code or uuid.uuid4().hex, 'state': state, 'code_verifier': verifier}
    if turnstile:
        payload['turnstile_token'] = turnstile
    return client.post('/auth/discord/callback', headers=net(headers or {}), json=payload)


def signup(client, body, username=None, headers=None, **extra):
    username = username or 'd_' + uuid.uuid4().hex[:10]
    return client.post('/auth/discord/signup', headers=net(headers or {}), json=dict({
        'signup_token': body['signup_token'], 'username': username, 'turnstile_token': REGISTER_TOKEN}, **extra))


def test_config_and_the_authorize_url(client, discord):
    assert client.get('/auth/config').json() == {'discord': True}
    verifier, body = authorize(client)
    url = urlsplit(body['url'])
    assert '{}://{}{}'.format(url.scheme, url.netloc, url.path) == 'https://discord.com/oauth2/authorize'
    params = parse_qsl(url.query)
    assert [k for k, _ in params] == ['response_type', 'client_id', 'scope', 'redirect_uri', 'state', 'code_challenge',
                                      'code_challenge_method', 'prompt']
    values = dict(params)
    assert values['scope'] == 'identify email' and values['redirect_uri'] == 'https://files.gg/app/auth/discord'
    assert values['prompt'] == 'none' and values['code_challenge_method'] == 'S256'
    assert values['state'] == body['state'] and values['code_challenge'] == credentials.code_challenge(verifier)
    claims = credentials.unsign(body['state'], credentials.STATE_LABEL, 'test-secret-key')
    assert claims['p'] == 'login' and claims['u'] is None and 590 <= claims['e'] - claims['i'] <= 600
    # link and reauth need a session; link asks for consent
    response = client.post('/auth/discord/authorize', headers=VIA_MAIN, json={'purpose': 'link',
                                                                              'code_challenge': pkce()[1]})
    assert response.status_code == 401
    user_id = make_user()
    _, body = authorize(client, 'link', sign_in(user_id))
    assert dict(parse_qsl(urlsplit(body['url']).query))['prompt'] == 'consent'
    assert credentials.unsign(body['state'], credentials.STATE_LABEL, 'test-secret-key')['u'] == str(user_id)


def test_discord_off_without_its_credentials(client, appdb):
    assert client.get('/auth/config').json() == {'discord': False}
    response = client.post('/auth/discord/authorize', headers=VIA_MAIN, json={'purpose': 'login',
                                                                              'code_challenge': pkce()[1]})
    assert (response.status_code, response.json()['code']) == (503, 'DISCORD_UNAVAILABLE')
    # a Discord account linked while it was on isn't offered for re-auth (its button couldn't work)
    user_id = make_user(appdb, password='a-password')
    appdb.execute("INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES (%s, %s, 'discord', %s)",
                  (Snowflake.generate(), user_id, str(Snowflake.generate())))
    headers = cookie_headers(new_session(user_id, appdb, authenticated_ago=3600))
    response = client.post('/users/@me/email', headers=headers, json={'email': 'x@example.com'})
    assert (response.status_code, response.json()['methods']) == (403, ['password'])


def test_sign_up_with_a_verified_unused_email(client, appdb, discord):
    me = discord.user()
    guest_id = Snowflake.generate()
    guest = {'Authorization': 'Guest ' + GuestToken.generate(guest_id)}
    response = callback(client)
    body = response.json()
    assert body['status'] == 'signup_required' and 'set-cookie' not in response.headers
    assert body['suggested_username'] == me['username']
    assert body['email'] == {'address': me['email'], 'usable': True, 'reason': None}
    assert body['discord'] == {'id': me['id'], 'username': me['username'], 'display_name': 'Dan W',
                               'avatar_url': 'https://cdn.discordapp.com/avatars/{}/a_1b2c3d4e5f.webp?size=64&'
                                             'animated=true'.format(me['id'])}
    # the token was read once and revoked at once, with client_secret_basic and PKCE
    token_call = [c for c in discord.calls if c[1] == '/api/oauth2/token'][0]
    assert token_call[2]['grant_type'] == 'authorization_code' and token_call[2]['code_verifier']
    assert token_call[2]['redirect_uri'] == 'https://files.gg/app/auth/discord'
    assert token_call[3] == 'Basic ' + base64.b64encode(b'1234567890:test-discord-secret').decode()
    revoke = [c for c in discord.calls if c[1] == '/api/oauth2/token/revoke'][0]
    assert revoke[2] == {'token': token_call[2]['code'].join(['discord-access-', '']), 'token_type_hint': 'access_token'}
    assert [c[1] for c in discord.calls][-1] == '/api/oauth2/token/revoke'
    # sign-up
    response = signup(client, body, username=me['username'], headers=guest, display_name=None)
    assert response.status_code == 201, response.text
    user = response.json()['user']
    assert user['email'] == me['email'] and user['email_verified'] is True and user['has_password'] is False
    assert user['identities'][0]['provider'] == 'discord' and user['identities'][0]['username'] == me['username']
    assert response.headers['set-cookie'].startswith('__Host-filesgg_session=fgs_')
    assert appdb.fetchone('SELECT method FROM sessions WHERE user_id = %s', (int(user['id']),))[0] == 'discord'
    # the token can't make a second account
    response = signup(client, body)
    assert (response.status_code, response.json()['code']) == (409, 'IDENTITY_IN_USE')
    # next time: signed in, cache refreshed
    discord.me = dict(me, username='renamed', global_name='New Name')
    response = callback(client)
    assert response.json()['status'] == 'signed_in' and response.json()['user']['id'] == user['id']
    assert 'fgs_' in response.headers['set-cookie']
    assert appdb.fetchone("SELECT username, display_name FROM user_identities WHERE provider_user_id = %s",
                          (me['id'],)) == ('renamed', 'New Name')


@pytest.mark.parametrize('verified, email, reason', [(False, 'default', 'unverified'), (True, None, 'missing')])
def test_sign_up_without_a_usable_email(client, appdb, discord, verified, email, reason):
    me = discord.user(verified=verified, email=email)
    body = callback(client).json()
    assert body['email'] == {'address': me['email'], 'usable': False, 'reason': reason}
    response = signup(client, body)
    assert response.status_code == 201
    assert response.json()['user']['email'] is None and response.json()['user']['email_verified'] is False


def test_email_collisions_are_never_merged(client, appdb, discord):
    me = discord.user()
    make_user(appdb, email=me['email'].upper())
    body = callback(client).json()
    assert body['status'] == 'signup_required'
    assert body['email'] == {'address': me['email'], 'usable': False, 'reason': 'in_use'}
    response = signup(client, body)
    assert (response.status_code, response.json()) == (409, {
        'code': 'DISCORD_EMAIL_IN_USE', 'status': 409,
        'message': 'An account already uses this email. Sign in with your password, then link Discord in Settings.'})


def test_suggested_usernames(client, appdb, discord):
    me = discord.user(username='Taken' + uuid.uuid4().hex[:6])
    make_user(appdb, username=me['username'].lower())
    assert callback(client).json()['suggested_username'] == me['username'].lower() + '_2'
    discord.user(username='bad-name!')
    suggestion = callback(client).json()['suggested_username']
    assert suggestion.startswith('user_') and len(suggestion) == 11


def test_state_and_verifier_checks(client, appdb, discord):
    discord.user()
    verifier, body = authorize(client)
    # §16.3's rejections: a forged signature, another verifier, the sign-up token as a state, an expired state
    forged = body['state'].split('.')[0] + '.' + 'A' * 43
    other_verifier, _ = pkce()
    for state, code_verifier in ((forged, verifier), (body['state'], other_verifier)):
        response = callback(client, state=state, verifier=code_verifier)
        assert (response.status_code, response.json()['code']) == (400, 'INVALID_OAUTH_STATE')
    signup_token = credentials.sign({'d': '1', 'e': int(time.time()) + 600}, credentials.SIGNUP_LABEL, 'test-secret-key')
    assert callback(client, state=signup_token, verifier=verifier).json()['code'] == 'INVALID_OAUTH_STATE'
    expired = credentials.sign({'p': 'login', 'c': credentials.code_challenge(verifier), 'n': 'x', 'u': None,
                                'i': 1, 'e': int(time.time()) - 1}, credentials.STATE_LABEL, 'test-secret-key')
    assert callback(client, state=expired, verifier=verifier).json()['code'] == 'INVALID_OAUTH_STATE'
    # a link state on another user's session
    owner = sign_in(make_user(appdb))
    verifier, body = authorize(client, 'link', owner)
    response = callback(client, 'link', sign_in(make_user(appdb)), verifier=verifier, state=body['state'])
    assert response.json()['code'] == 'INVALID_OAUTH_STATE'
    # Turnstile, for login only
    verifier, body = authorize(client)
    assert callback(client, state=body['state'], verifier=verifier, turnstile=None).json()['code'] == 'CAPTCHA_INVALID'
    assert not [c for c in discord.calls if c[1] == '/api/oauth2/token']


def test_discord_errors(client, discord):
    discord.user()
    discord.token_status = 400
    assert callback(client).json()['code'] == 'DISCORD_CODE_INVALID'
    discord.token_status = 429
    discord.headers = {'retry-after': '7'}
    response = callback(client)
    assert (response.status_code, response.json()['code'], response.json()['retry_after']) == (
        503, 'DISCORD_UNAVAILABLE', 7)
    discord.token_status = 502
    assert callback(client).json()['code'] == 'DISCORD_UNAVAILABLE'
    discord.token_status, discord.me_status = 200, 500
    assert callback(client).json()['code'] == 'DISCORD_UNAVAILABLE'
    # even then, the token was revoked
    assert [c[1] for c in discord.calls][-1] == '/api/oauth2/token/revoke'


def test_linking(client, appdb, discord, outbox):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    me = discord.user()
    response = callback(client, 'link', headers, turnstile=None)
    assert response.status_code == 200 and response.json()['status'] == 'linked'
    assert response.json()['identity']['username'] == me['username']
    assert outbox[-1]['tag'] == 'auth-discord-linked'
    assert callback(client, 'link', headers, turnstile=None).json()['status'] == 'linked'  # idempotent
    # another account's Discord, and a second Discord
    other = sign_in(make_user(appdb), appdb)
    response = callback(client, 'link', other, turnstile=None)
    assert (response.status_code, response.json()['code']) == (409, 'IDENTITY_IN_USE')
    discord.user()
    response = callback(client, 'link', headers, turnstile=None)
    assert (response.status_code, response.json()['code']) == (409, 'IDENTITY_ALREADY_LINKED')
    assert client.get('/users/@me/identities', headers=headers).json()['items'][0]['username'] == me['username']


def test_reauth_through_discord(client, appdb, discord):
    user_id = make_user(appdb, email=None)
    me = discord.user()
    appdb.execute("INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES (%s, %s, 'discord', %s)",
                  (Snowflake.generate(), user_id, me['id']))
    token = new_session(user_id, appdb, authenticated_ago=3600, method='discord')
    headers = cookie_headers(token)
    response = client.post('/users/@me/email', headers=headers, json={'email': 'x@example.com'})
    assert response.json()['methods'] == ['discord']
    assert callback(client, 'reauth', headers, turnstile=None).json() == {'status': 'reauthenticated'}
    assert appdb.fetchone("SELECT authenticated_at > now() - interval '1 minute' FROM sessions WHERE token_hash = %s",
                          (credentials.token_hash(token),))[0]
    discord.user()
    response = callback(client, 'reauth', headers, turnstile=None)
    assert (response.status_code, response.json()['code']) == (403, 'IDENTITY_MISMATCH')


def test_unlinking_and_the_last_login_method(client, appdb):
    user_id = make_user(appdb, password=None, verified=True)
    appdb.execute("INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES (%s, %s, 'discord', %s)",
                  (Snowflake.generate(), user_id, str(Snowflake.generate())))
    headers = sign_in(user_id, appdb)
    response = client.delete('/users/@me/identities/discord', headers=headers)
    assert (response.status_code, response.json()['code']) == (409, 'LAST_LOGIN_METHOD')
    from utils import passwords
    appdb.execute('UPDATE users SET password_hash = %s, email_verified = false WHERE id = %s',
                  (passwords.hash_sync('a-password'), user_id))
    assert client.delete('/users/@me/identities/discord', headers=sign_in(user_id, appdb)).json()['code'] == \
        'LAST_LOGIN_METHOD'
    appdb.execute('UPDATE users SET email_verified = true WHERE id = %s', (user_id,))
    stale = sign_in(user_id, appdb, authenticated_ago=3600)
    assert client.delete('/users/@me/identities/discord', headers=stale).json()['code'] == 'REAUTH_REQUIRED'
    assert client.delete('/users/@me/identities/discord', headers=sign_in(user_id, appdb)).status_code == 204
    assert client.delete('/users/@me/identities/discord', headers=sign_in(user_id, appdb)).json()['code'] == \
        'UNKNOWN_IDENTITY'


def test_bans_refuse_discord_sign_up(client, appdb, discord):
    discord.user()
    body = callback(client).json()
    guest = Snowflake.generate()
    appdb.execute("INSERT INTO bans (guest_id, rule) VALUES (%s, 'spam')", (guest,))
    response = signup(client, body, headers={'Authorization': 'Guest ' + GuestToken.generate(guest)})
    assert (response.status_code, response.json()['code']) == (403, 'BANNED')
    bad = signup(client, dict(body, signup_token=body['signup_token'][:-2] + 'xx'))
    assert bad.json()['code'] == 'INVALID_SIGNUP_TOKEN'
    assert signup(client, body, username='admin').json()['code'] == 'USERNAME_INVALID'


def test_a_permanently_deleted_accounts_discord_is_unknown(client, appdb, discord):
    from jobs import accounts as account_jobs
    me = discord.user()
    user = signup(client, callback(client).json()).json()['user']
    appdb.execute("UPDATE users SET deletion_requested_at = now() - interval '15 days', deletion_scheduled_for = "
                  "now() - interval '1 day' WHERE id = %s", (int(user['id']),))
    with appdb.connect() as conn:
        account_jobs.delete_account(conn, int(user['id']))
    body = callback(client).json()
    assert body['status'] == 'signup_required' and body['discord']['id'] == me['id']
    assert body['email']['usable'] is True
