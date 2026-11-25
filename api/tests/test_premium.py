"""Milestone 6 premium and staff (docs/redesign/contracts/milestone-6.md §9, §11.4): entitlements as rows, the
admin endpoints and the CLI, the hourly expiry, premium limits (with the proxy body cap for everyone), and the new
staff actions on accounts."""

import json
import subprocess
import sys
import uuid

import pytest

from tests.conftest import (
    API_DIR, APP_DATABASE, TempDatabase, make_user, new_session, cookie_headers, set_premium, sign_in, subprocess_env,
)
from utils import credentials
from utils.generators import Snowflake

GB, MB = 1000 ** 3, 1000 ** 2  # decimal, as api/utils/limits.py


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


def staff(appdb, role='admin'):
    from tests.m4 import make_staff
    return make_staff(appdb, role=role)


# --- §9.2: limits -------------------------------------------------------------------------------------------------

def test_limits_by_plan(monkeypatch):
    from utils import limits
    from db.models import User
    free = User(id=1, email=None, username='a', storage_limit_override=None)
    premium = User(id=2, email=None, username='b', storage_limit_override=None, premium=True)
    anonymous = limits.get_limits(None)
    assert (anonymous.max_file_size_single, anonymous.max_file_size_chunked, anonymous.premium) == (25 * MB, 25 * MB,
                                                                                                    False)
    signed_in = limits.get_limits(free)
    assert (signed_in.storage_bytes, signed_in.max_file_size_chunked, signed_in.custom_domains) == (10 * GB, GB, 0)
    # 100 MB for tools, exactly (decimal), under the proxy's 100 MiB body limit less 1 MiB of framing
    assert signed_in.max_file_size_single == signed_in.max_file_size_single_configured == 100 * MB
    top = limits.get_limits(premium)
    assert (top.storage_bytes, top.max_file_size_chunked, top.custom_domains, top.domain_only_allowed) == (
        100 * GB, 5 * GB, 5, True)
    # premium tools get 100 MB too, until a bigger Cloudflare plan raises both settings
    assert top.max_file_size_single == top.max_file_size_single_configured == 100 * MB
    monkeypatch.setenv('LIMIT_PREMIUM_SINGLE_BYTES', str(500 * MB))
    monkeypatch.setenv('PROXY_BODY_LIMIT_BYTES', str(600 * MB))
    assert limits.get_limits(premium).max_file_size_single == 500 * MB
    # single requests are capped by the proxy's body limit less 1 MiB of framing, for everyone
    monkeypatch.setenv('PROXY_BODY_LIMIT_BYTES', '100000000')
    assert limits.get_limits(premium).max_file_size_single == 100000000 - limits.MIB
    assert limits.get_limits(free).max_file_size_single == 100000000 - limits.MIB
    # the manual override wins either way
    assert limits.get_limits(User(id=3, email=None, username='c', storage_limit_override=GB, premium=True)
                             ).storage_bytes == GB


def test_premium_limits_through_the_api(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    body = client.get('/users/@me/limits', headers=headers).json()
    assert body['premium'] is False and body['max_file_size_chunked'] == GB
    response = client.post('/uploads', headers=headers, json={'filename': 'big.bin', 'size': 2 * GB})
    assert (response.status_code, response.json()['code']) == (413, 'FILE_TOO_LARGE')
    set_premium(user_id, appdb)
    body = client.get('/users/@me/limits', headers=headers).json()
    assert body['premium'] is True and body['storage']['limit'] == 100 * GB
    assert body['max_file_size_chunked'] == 5 * GB and body['max_file_size_single'] == 100 * MB
    assert body['max_file_size_single_configured'] == 100 * MB
    assert body['custom_domains'] == {'used': 0, 'limit': 5} and body['domain_only_allowed'] is True
    response = client.post('/uploads', headers=headers, json={'filename': 'big.bin', 'size': 2 * GB})
    assert response.status_code == 201, response.text
    # 2 GB (decimal) in 10 MiB chunks
    assert response.json()['chunk_count'] == 191
    client.delete('/uploads/' + response.json()['upload_id'], headers=headers)
    assert client.get('/users/@me', headers=headers).json()['premium'] == {'active': True, 'expires_at': None}


# --- §9.3: granting and revoking ------------------------------------------------------------------------------------

def test_admin_grant_change_and_revoke(client, appdb, outbox):
    admin_id, admin = staff(appdb, 'admin')
    _, moderator = staff(appdb, 'moderator')
    user_id = make_user(appdb)
    path = '/admin/users/{}/entitlements'.format(user_id)
    assert client.post(path, headers=moderator, json={'note': 'x'}).json()['code'] == 'FORBIDDEN'
    assert client.post(path, headers=sign_in(make_user(appdb), appdb), json={'note': 'x'}).status_code == 404
    assert client.post(path, headers=admin, json={}).json()['code'] == 'INVALID_PARAMETERS'
    assert client.post(path, headers=admin, json={'note': 'x', 'expires_at': 1000}).json()['code'] == \
        'INVALID_PARAMETERS'
    response = client.post(path, headers=admin, json={'kind': 'premium', 'note': 'early supporter'})
    assert response.status_code == 201, response.text
    entitlement = response.json()
    assert entitlement['active'] is True and entitlement['kind'] == 'premium' and entitlement['note'] == \
        'early supporter'
    assert entitlement['granted_by']['id'] == str(admin_id) and entitlement['expires_at'] is None
    assert client.post(path, headers=admin, json={'note': 'again'}).json()['code'] == 'ENTITLEMENT_EXISTS'
    assert outbox[-1]['tag'] == 'premium-changed'
    import time
    later = int(time.time()) + 86400 * 30
    changed = client.patch('{}/{}'.format(path, entitlement['id']), headers=admin,
                           json={'expires_at': later, 'note': 'a month'}).json()
    assert changed['expires_at'] == later
    detail = client.get('/admin/users/{}'.format(user_id), headers=admin).json()
    assert detail['premium']['active'] is True and detail['entitlements'][0]['id'] == entitlement['id']
    assert detail['sessions'] == {'active': 0} and detail['deletion'] is None
    assert detail['upload_keys'] == [] and detail['domains'] == [] and detail['identities'] == []
    assert 'password_hash' not in json.dumps(detail)
    revoked = client.request('DELETE', '{}/{}'.format(path, entitlement['id']), headers=admin,
                             json={'note': 'ended'}).json()
    assert revoked['active'] is False and revoked['revoked_by']['id'] == str(admin_id)
    actions = [r[0] for r in appdb.fetchall('SELECT action FROM moderation_actions WHERE user_id = %s ORDER BY id',
                                            (user_id,))]
    assert actions == ['grant_entitlement', 'change_entitlement', 'revoke_entitlement']
    details = appdb.fetchone("SELECT details, actor_kind FROM moderation_actions WHERE user_id = %s AND action = "
                             "'grant_entitlement'", (user_id,))
    assert details[0]['entitlement_id'] == entitlement['id'] and details[1] == 'staff'
    # a new grant after a revoke works
    assert client.post(path, headers=admin, json={'note': 'back'}).status_code == 201
    deleted = make_user(appdb)
    appdb.execute("UPDATE users SET deleted_at = now(), email = NULL, username = 'deleted-' || id WHERE id = %s",
                  (deleted,))
    assert client.post('/admin/users/{}/entitlements'.format(deleted), headers=admin,
                       json={'note': 'x'}).json()['code'] == 'UNKNOWN_USER'


def test_expiry_task(client, appdb, outbox):
    from jobs import accounts as account_jobs  # noqa: F401
    from utils import entitlements
    user_id = make_user(appdb)
    set_premium(user_id, appdb, expires_days=1)
    appdb.execute("UPDATE user_entitlements SET expires_at = now() - interval '1 second' WHERE user_id = %s",
                  (user_id,))
    assert client.get('/users/@me', headers=sign_in(user_id, appdb)).json()['premium']['active'] is False
    with appdb.connect() as conn:
        with conn.transaction():
            mails = entitlements.record_expired(conn)
        with conn.transaction():
            assert entitlements.record_expired(conn) == []
    assert any(m.tag == 'premium-changed' for m in mails)
    row = appdb.fetchone("SELECT actor_kind FROM moderation_actions WHERE user_id = %s AND action = "
                         "'entitlement_expired'", (user_id,))
    assert row == ('system',)
    # a new grant is possible at once
    _, admin = staff(appdb)
    assert client.post('/admin/users/{}/entitlements'.format(user_id), headers=admin,
                       json={'note': 'renewed'}).status_code == 201


def test_entitlements_cli(appdb):
    user_id = make_user(appdb)

    def run(*args):
        result = subprocess.run([sys.executable, '-m', 'tools.entitlements', *args], cwd=API_DIR, capture_output=True,
                                text=True, timeout=60, env=subprocess_env())
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    granted = run('grant', str(user_id), '--kind', 'premium', '--days', '30', '--by', 'dan', '--note', 'cli grant')
    assert granted['active'] is True and granted['expires_at'] is not None
    assert str(user_id) in [r['user_id'] for r in run('list')]
    run('revoke', str(user_id), '--by', 'dan', '--note', 'cli revoke')
    rows = appdb.fetchall("SELECT action, actor_kind, details->>'by' FROM moderation_actions WHERE user_id = %s ORDER BY "
                          'id', (user_id,))
    assert rows == [('grant_entitlement', 'cli', 'dan'), ('revoke_entitlement', 'cli', 'dan')]


# --- §11.4: staff actions on accounts, lookup ---------------------------------------------------------------------------

def test_revoke_sessions_and_reset_username(client, appdb):
    _, moderator = staff(appdb, 'moderator')
    user_id = make_user(appdb)
    token = new_session(user_id, appdb)
    old_name = appdb.fetchone('SELECT username FROM users WHERE id = %s', (user_id,))[0]
    response = client.post('/admin/actions', headers=moderator, json={'action': 'revoke_sessions',
                                                                      'target': {'type': 'user', 'id': str(user_id)}})
    assert response.status_code == 200, response.text
    assert client.get('/users/@me', headers=cookie_headers(token)).status_code == 401
    assert appdb.fetchone('SELECT revoked_reason FROM sessions WHERE token_hash = %s',
                          (credentials.token_hash(token),))[0] == 'staff'
    assert appdb.fetchone("SELECT count(*) FROM user_warnings WHERE user_id = %s", (user_id,))[0] == 0
    response = client.post('/admin/actions', headers=moderator, json={'action': 'reset_username',
                                                                      'target': {'type': 'user', 'id': str(user_id)}})
    assert response.json()['code'] == 'INVALID_ACTION'
    response = client.post('/admin/actions', headers=moderator, json={
        'action': 'reset_username', 'target': {'type': 'user', 'id': str(user_id)}, 'rule': 'harassment'})
    assert response.status_code == 200
    headers = sign_in(user_id, appdb)
    me = client.get('/users/@me', headers=headers).json()
    assert me['username'] == 'u{}'.format(user_id) and me['needs_username'] is True
    assert appdb.fetchone('SELECT appealable FROM user_warnings WHERE user_id = %s AND action = %s',
                          (user_id, 'reset_username'))[0] is True
    # the old name is held; a new name skips the cooldown and clears needs_username
    other = sign_in(make_user(appdb), appdb)
    assert client.put('/users/@me/username', headers=other, json={'username': old_name}).json()['code'] == \
        'USERNAME_TAKEN'
    fresh = 'r_' + uuid.uuid4().hex[:8]
    assert client.put('/users/@me/username', headers=headers, json={'username': fresh}).json()['needs_username'] is False
    # staff never act on themselves
    own_id, own = staff(appdb, 'moderator')
    response = client.post('/admin/actions', headers=own, json={'action': 'revoke_sessions',
                                                                'target': {'type': 'user', 'id': str(own_id)}})
    assert response.json()['code'] == 'FORBIDDEN'


def test_lookup_by_username_discord_id_and_key_prefix(client, appdb):
    _, moderator = staff(appdb, 'moderator')
    username = 'look_' + uuid.uuid4().hex[:8]
    user_id = make_user(appdb, username=username)
    discord_id = str(Snowflake.generate())
    appdb.execute("INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES (%s, %s, 'discord', %s)",
                  (Snowflake.generate(), user_id, discord_id))
    secret = client.post('/users/@me/upload-keys', headers=sign_in(user_id, appdb), json={}).json()['secret']
    for q in (username.upper(), discord_id, secret[:12]):
        users = client.get('/admin/lookup?q=' + q, headers=moderator).json()['users']
        assert [u['id'] for u in users] == [str(user_id)], q
    detail = client.get('/admin/users/{}'.format(user_id), headers=moderator).json()
    assert detail['identities'][0]['provider_user_id'] == discord_id
    assert detail['upload_keys'][0]['prefix'] == secret[:12] and secret not in json.dumps(detail)
