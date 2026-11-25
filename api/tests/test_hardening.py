"""Hardening fixes: bounded vanity retries and patterns, CSPRNG vanities, account password
hashing off the event loop, and per-IP limits keyed on an IPv6 /64."""

import asyncio
import random
import uuid

import pytest

from tests.conftest import LOGIN_TOKEN, REGISTER_TOKEN, TURNSTILE_TOKEN
from tests.test_milestone2 import anonymous, appdb, new_user, unlock, upload  # noqa: F401  (appdb is a fixture)


# --- vanity patterns and retries --------------------------------------------------------------------

@pytest.mark.parametrize('pattern, ok', [
    ('', True), ('1/1', True), ('3-5/3', True), ('3', True), ('(4)', True), ('128', True),
    ('0/0/0/0', False), ('0/0/0/1', False), ('0-3/abc', False), ('3/0', False), ('0', False), ('129', False),
])
def test_vanity_patterns_need_parts_of_at_least_one_character(pattern, ok):
    from utils.vanity import vanity_length_ok
    assert vanity_length_ok(pattern) is ok


def test_upload_with_an_empty_part_pattern_is_refused(client, appdb):
    _, headers = new_user(appdb)
    for pattern in ('0/0/0/0', '0/0/0/1', '0-2/5'):
        response = client.post('/files', headers=headers, files={'file': ('a.txt', b'hello', 'text/plain')},
                               data={'vanity': pattern})
        assert (response.status_code, response.json()['code']) == (400, 'INVALID_VANITY'), pattern
    assert '/' in upload(client, headers, vanity='1/1')['vanity']


def test_upload_gives_up_when_no_vanity_is_free(client, appdb, monkeypatch):
    import views.files as files_view
    from utils.vanity import MAX_VANITY_ATTEMPTS
    _, headers = new_user(appdb)
    taken = upload(client, headers)['vanity']
    tried = []

    def always_taken(pattern=''):
        tried.append(pattern)
        return taken

    monkeypatch.setattr(files_view, 'generate_vanity', always_taken)
    response = client.post('/files', headers=headers, files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')},
                           data={'vanity': '1/1'})
    assert (response.status_code, response.json()['code']) == (409, 'VANITY_EXHAUSTED')
    assert tried == ['1/1'] * MAX_VANITY_ATTEMPTS
    # the transaction (and the owner's quota lock) was released: the next upload goes through
    monkeypatch.undo()
    upload(client, headers)


def test_album_creation_gives_up_when_no_vanity_is_free(client, appdb, monkeypatch):
    import views.me as me_view
    from utils.vanity import MAX_VANITY_ATTEMPTS
    _, headers = new_user(appdb)
    file_id = upload(client, headers)['id']
    response = client.post('/users/@me/albums', headers=headers, json={'file_ids': [file_id]})
    assert response.status_code == 201, response.text
    taken = response.json()['vanity']
    tried = []

    def always_taken(length):
        tried.append(length)
        return taken

    monkeypatch.setattr(me_view, 'generate_id', always_taken)
    response = client.post('/users/@me/albums', headers=headers, json={'file_ids': [file_id]})
    assert (response.status_code, response.json()['code']) == (409, 'VANITY_EXHAUSTED')
    assert len(tried) == MAX_VANITY_ATTEMPTS


def test_finalize_gives_up_when_no_vanity_is_free(client, appdb, monkeypatch):
    import jobs.finalize as finalize_module
    from tests.test_milestone2 import put, start
    _, headers = new_user(appdb)
    taken = upload(client, headers)['vanity']
    data = uuid.uuid4().bytes * 8
    session = start(client, headers, len(data))
    assert put(client, headers, session['upload_id'], 0, data).status_code == 204
    assert client.post('/uploads/{}/complete'.format(session['upload_id']), headers=headers).status_code == 202

    monkeypatch.setattr(finalize_module, 'generate_vanity', lambda pattern='': taken)
    with pytest.raises(RuntimeError, match='no free vanity'):
        finalize_module.finalize(int(session['upload_id']))
    # nothing was committed: the job queue's retry finishes it
    assert client.get('/uploads/' + session['upload_id'], headers=headers).json()['status'] == 'processing'
    monkeypatch.undo()
    assert finalize_module.finalize(int(session['upload_id'])) is not None


# --- vanity randomness ------------------------------------------------------------------------------

def test_vanities_do_not_come_from_the_random_module():
    from utils import vanity
    # seeding `random` the same way twice used to give the same vanities (guessable `link` URLs)
    random.seed(1)
    first = [vanity.generate_vanity() for _ in range(5)] + [vanity.generate_id(8) for _ in range(5)]
    random.seed(1)
    second = [vanity.generate_vanity() for _ in range(5)] + [vanity.generate_id(8) for _ in range(5)]
    assert first != second
    assert not hasattr(vanity, 'random')
    for _ in range(200):
        assert 1 <= len(vanity.generate_vanity('1-2')) <= 2


# --- account passwords off the event loop -----------------------------------------------------------

def _on_event_loop():
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


@pytest.fixture
def hashing_calls(monkeypatch):
    """Every account-password hash or check: ('hash'|'check', ran on the event loop?)."""
    from utils import helpers
    calls = []
    real_generate, real_check = helpers.generate_password_hash, helpers.check_password_hash

    def generate(*args, **kwargs):
        calls.append(('hash', _on_event_loop()))
        return real_generate(*args, **kwargs)

    def check(*args, **kwargs):
        calls.append(('check', _on_event_loop()))
        return real_check(*args, **kwargs)

    monkeypatch.setattr(helpers, 'generate_password_hash', generate)
    monkeypatch.setattr(helpers, 'check_password_hash', check)
    return calls


def test_account_password_hashing_runs_off_the_event_loop(client, appdb, hashing_calls, monkeypatch):
    import views.auth
    from utils.email import Email
    from utils.tokens import EmailForgotToken

    async def accepts(address):
        return True

    async def send(**message):
        pass

    monkeypatch.setattr(views.auth, 'domain_accepts_mail', accepts)
    monkeypatch.setattr(Email, 'send', staticmethod(send))
    username = 'hard' + uuid.uuid4().hex[:8]
    email = username + '@example.com'
    response = client.post('/auth/register', json={'email': email, 'username': username, 'password': 'hunter22',
                                                   'turnstile_token': REGISTER_TOKEN})
    assert response.status_code == 200, response.text
    response = client.post('/auth/login', json={'email': email, 'password': 'hunter22',
                                                'turnstile_token': LOGIN_TOKEN})
    assert response.status_code == 200, response.text
    response = client.post('/auth/login', json={'email': email, 'password': 'wrong-one',
                                                'turnstile_token': LOGIN_TOKEN})
    assert response.json()['code'] == 'INVALID_CREDENTIALS'
    user_id = appdb.fetchone('SELECT id FROM users WHERE email = %s', (email,))[0]
    token = EmailForgotToken.generate({'user_id': user_id, 'email': email})
    response = client.post('/auth/forgot/reset', json={'token': token, 'password': 'hunter22'})
    assert response.json()['code'] == 'SAME_PASSWORD'
    response = client.post('/auth/forgot/reset', json={'token': token, 'password': 'brand-new-pw'})
    assert response.status_code == 204, response.text

    kinds = [kind for kind, _ in hashing_calls]
    assert kinds.count('hash') >= 2 and kinds.count('check') >= 4
    assert not any(on_loop for _, on_loop in hashing_calls), hashing_calls


def test_login_with_an_unknown_email_still_checks_a_hash(client, appdb, hashing_calls):
    from utils import helpers
    helpers._dummy_hash = None
    response = client.post('/auth/login', json={'email': 'nobody-{}@example.com'.format(uuid.uuid4().hex),
                                                'password': 'whatever1', 'turnstile_token': LOGIN_TOKEN})
    assert (response.status_code, response.json()['code']) == (400, 'INVALID_CREDENTIALS')
    # one dummy hash (made once per process), then one check against it, like a known email
    assert hashing_calls == [('hash', False), ('check', False)]
    hashing_calls.clear()
    response = client.post('/auth/login', json={'email': 'nobody-{}@example.com'.format(uuid.uuid4().hex),
                                                'password': 'whatever1', 'turnstile_token': LOGIN_TOKEN})
    assert response.json()['code'] == 'INVALID_CREDENTIALS'
    assert hashing_calls == [('check', False)]


async def test_check_password_without_a_hash_is_false():
    from utils import helpers
    hashed = await helpers.hash_password_async('correct horse', salt_length=10)
    assert hashed.startswith('pbkdf2:sha256:') and len(hashed) <= 128
    assert await helpers.check_password(hashed, 'correct horse') is True
    assert await helpers.check_password(hashed, 'wrong horse') is False
    assert await helpers.check_password(None, 'correct horse') is False
    assert await helpers.check_password('', None) is False


# --- per-IP limits on an IPv6 /64 -------------------------------------------------------------------

def test_ip_hashes_collapse_ipv6_to_the_64():
    from datetime import date
    from utils import view_hash
    day = date(2026, 11, 25)
    same = ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff', '[2001:DB8:1:2::abcd]']
    for fn in (lambda ip: view_hash.ip_hash('s', day, ip), lambda ip: view_hash.purpose_hash('s', 'unlock', day, ip)):
        assert len({fn(ip) for ip in same}) == 1
        assert fn('2001:db8:1:3::1') != fn(same[0])
        assert fn('::ffff:198.51.100.7') == fn('198.51.100.7') != fn('198.51.100.8')
        assert fn('not-an-ip') == fn('not-an-ip')  # not an IP: hashed as it is


def _v6_net():
    return '2001:db8:{:x}:{:x}'.format(uuid.uuid4().int % 65535, uuid.uuid4().int % 65535)


def test_unlock_rate_limit_is_per_ipv6_64(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, password='hunter222')
    net = _v6_net()
    # 5 attempts a minute, each from a different address in the same /64
    for host in range(1, 6):
        assert unlock(client, created['vanity'], 'wrong-one', ip='{}::{:x}'.format(net, host)).status_code == 401
    response = unlock(client, created['vanity'], 'hunter222', ip='{}::99'.format(net))
    assert (response.status_code, response.json()['code']) == (429, 'TOO_MANY_ATTEMPTS')
    # another /64 isn't affected
    assert unlock(client, created['vanity'], 'hunter222', ip=_v6_net() + '::1').status_code == 200


def test_anonymous_ip_cap_is_per_ipv6_64(client, appdb, monkeypatch):
    monkeypatch.setenv('LIMIT_ANONYMOUS_DAILY_BYTES', '3000')
    net = _v6_net()
    for host in (1, 2):  # 992 bytes each, from two addresses (and fingerprints) in one /64
        upload(client, anonymous('{}::{:x}'.format(net, host)), content=uuid.uuid4().bytes * 62,
               turnstile_token=TURNSTILE_TOKEN)
    response = client.post('/files', headers=anonymous(net + '::3'),
                           files={'file': ('a.txt', uuid.uuid4().bytes * 70, 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    assert (response.status_code, response.json()['code']) == (413, 'STORAGE_LIMIT_REACHED')
    assert response.json()['used'] == 1984
    upload(client, anonymous(_v6_net() + '::1'), content=uuid.uuid4().bytes * 70, turnstile_token=TURNSTILE_TOKEN)


def test_unique_views_are_per_ipv6_64(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner)
    net = _v6_net()
    for host in (1, 2, 3):
        response = client.get('/files/' + created['vanity'], headers={'X-Forwarded-For': '{}::{:x}'.format(net, host)})
        assert response.json()['views'] == 1
    response = client.get('/files/' + created['vanity'], headers={'X-Forwarded-For': _v6_net() + '::1'})
    assert response.json()['views'] == 2
