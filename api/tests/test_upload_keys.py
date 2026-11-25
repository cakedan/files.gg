"""Milestone 6 upload keys (docs/redesign/contracts/milestone-6.md §7): creating and listing them, the ShareX
config, authenticating only the upload endpoints, scopes, per-key limits, chunked sessions bound to their key,
and Milestone 4's standing rules for key uploads."""

import json
import uuid

import pytest

from tests.conftest import (
    APP_DATABASE, ORIGIN_SECRET, TURNSTILE_TOKEN, TempDatabase, cookie_headers, make_user, new_session, sign_in,
)
from utils import credentials
from utils.generators import Snowflake
from utils.tokens import FingerprintToken


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


def create_key(client, headers, status=201, **body):
    response = client.post('/users/@me/upload-keys', headers=headers, json=body)
    assert response.status_code == status, response.text
    return response.json()


def key_header(secret):
    return {'Authorization': 'Key ' + secret, 'X-Forwarded-For': '10.{}.{}.{}'.format(*uuid.uuid4().bytes[:3])}


def send(client, headers, status=200, **fields):
    response = client.post('/files', headers=headers, files={'file': ('shot.png.txt', uuid.uuid4().bytes, 'text/plain')},
                           data={k: str(v) for k, v in fields.items()})
    assert response.status_code == status, response.text
    return response.json()


def test_create_list_rename_and_revoke(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    created = create_key(client, headers, name='Laptop ShareX', scopes=['files:upload', 'albums:append'],
                         expires_in=30 * 86400,
                         sharex={'expires_in': 604800, 'visibility': 'password', 'generate_password': True,
                                 'album': 'Ab3dE6gH'})
    secret, key = created['secret'], created['key']
    assert credentials.well_formed(secret, 'fgg_') and key['prefix'] == secret[:12]
    assert key['scopes'] == ['files:upload', 'albums:append'] and key['state'] == 'active'
    assert key['domain'] is None and key['last_used_at'] is None
    sharex = created['sharex']
    assert list(sharex) == ['Version', 'Name', 'DestinationType', 'RequestMethod', 'RequestURL', 'Headers', 'Body',
                            'Arguments', 'FileFormName', 'URL', 'ErrorMessage']
    assert sharex == {
        'Version': '17.0.0', 'Name': 'files.gg (Laptop ShareX)',
        'DestinationType': 'ImageUploader, TextUploader, FileUploader', 'RequestMethod': 'POST',
        'RequestURL': 'https://api.files.gg/files', 'Headers': {'Authorization': 'Key ' + secret},
        'Body': 'MultipartFormData',
        'Arguments': {'expires_in': '604800', 'visibility': 'password', 'generate_password': 'true',
                      'album': 'Ab3dE6gH'},
        'FileFormName': 'file', 'URL': '{json:url_with_password}', 'ErrorMessage': '{json:message}'}
    assert created['curl'].startswith('curl -H "Authorization: Key {}" \\'.format(secret))
    assert '-F "file=@photo.png" -F "expires_in=604800"' in created['curl']
    assert created['curl'].endswith('https://api.files.gg/files')
    # only the hash is stored; the list never has the secret
    assert appdb.fetchone('SELECT key_hash FROM upload_keys WHERE id = %s', (int(key['id']),))[0] == \
        credentials.token_hash(secret)
    listing = client.get('/users/@me/upload-keys', headers=headers).json()
    assert listing['limit'] == 20 and listing['items'][0]['id'] == key['id'] and secret not in json.dumps(listing)
    # defaults: no Arguments, `{json:url}`
    plain = create_key(client, headers)
    assert plain['key']['name'] == 'Upload key' and plain['key']['scopes'] == ['files:upload']
    assert 'Arguments' not in plain['sharex'] and plain['sharex']['URL'] == '{json:url}'
    assert client.patch('/users/@me/upload-keys/' + key['id'], headers=headers, json={'name': 'Desk'}).json()['name'] \
        == 'Desk'
    assert client.delete('/users/@me/upload-keys/' + key['id'], headers=headers).status_code == 204
    assert [i['state'] for i in client.get('/users/@me/upload-keys', headers=headers).json()['items']
            if i['id'] == key['id']] == ['revoked']
    assert send(client, key_header(secret), status=401)['code'] == 'UPLOAD_KEY_INVALID'
    other = sign_in(make_user(appdb), appdb)
    assert client.delete('/users/@me/upload-keys/' + plain['key']['id'], headers=other).json()['code'] == \
        'UNKNOWN_UPLOAD_KEY'


def test_key_validation_and_the_limit(client, appdb, monkeypatch):
    headers = sign_in(make_user(appdb), appdb)
    for body in ({'scopes': ['files:delete']}, {'expires_in': 12345}, {'name': ''}, {'name': 'x' * 65}):
        assert create_key(client, headers, status=400, **body)['code'] == 'INVALID_PARAMETERS'
    assert create_key(client, headers, status=404, domain_id='123')['code'] == 'UNKNOWN_DOMAIN'
    monkeypatch.setenv('UPLOAD_KEYS_MAX', '2')
    create_key(client, headers)
    create_key(client, headers)
    assert create_key(client, headers, status=400) == {'code': 'UPLOAD_KEY_LIMIT', 'limit': 2, 'status': 400,
                                                        'message': 'You have reached the upload key limit'}


def test_keys_upload_and_nothing_else(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    secret = create_key(client, headers)['secret']
    created = send(client, key_header(secret))
    assert appdb.fetchone('SELECT user_id, upload_key_id IS NOT NULL FROM files WHERE id = %s',
                          (int(created['id']),)) == (user_id, True)
    assert created['url'].startswith('https://files.gg/') and created['direct_url'] == created['cdn_url']
    assert appdb.fetchone('SELECT last_used_at IS NOT NULL FROM upload_keys WHERE user_id = %s', (user_id,))[0]
    # a key works without the cookie's CSRF header, and wins over a cookie on the same request
    other = sign_in(make_user(appdb), appdb)
    both = dict(other, **key_header(secret))
    del both['X-Filesgg-Csrf']
    created = send(client, both)
    assert appdb.fetchone('SELECT user_id FROM files WHERE id = %s', (int(created['id']),))[0] == user_id
    # anywhere else: 403 UPLOAD_KEY_NOT_ALLOWED, and the plain 404 on /admin
    for method, path in (('GET', '/users/@me'), ('GET', '/users/@me/files'), ('POST', '/users/@me/upload-keys'),
                         ('DELETE', '/users/@me/files/' + created['id']), ('POST', '/users/@me/albums'),
                         ('GET', '/files/' + created['vanity']), ('POST', '/auth/logout'), ('GET', '/auth/session')):
        headers = key_header(secret)
        if path.startswith('/auth/'):
            headers['X-Filesgg-Csrf'] = '1'
        response = client.request(method, path, headers=headers, json={})
        assert (response.status_code, response.json()['code']) == (403, 'UPLOAD_KEY_NOT_ALLOWED'), path
    assert client.get('/admin/summary', headers=key_header(secret)).json()['code'] == 'NOT_FOUND'
    # other schemes on the upload endpoints
    response = client.post('/files', headers={'Authorization': 'Bearer ' + secret}, files={'file': ('a', b'a')})
    assert response.status_code == 401 and response.json()['message'] == 'Upload keys use `Authorization: Key fgg_…`'
    for bad in ('fgg_0123456789ABCDEFGHIJabcdefghij3YJC0W', credentials.generate('fgg_'), 'nope'):
        assert send(client, key_header(bad), status=401)['code'] == 'UPLOAD_KEY_INVALID'


def test_scopes_and_albums(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    first = send(client, headers)
    album = client.post('/users/@me/albums', headers=headers, json={'file_ids': [first['id']]}).json()
    plain = create_key(client, headers)['secret']
    response = send(client, key_header(plain), status=403, album=album['vanity'])
    assert response == {'code': 'UPLOAD_KEY_SCOPE', 'message': "This upload key can't do that", 'status': 403,
                        'scope': 'albums:append'}
    appending = create_key(client, headers, scopes=['albums:append'])['secret']
    created = send(client, key_header(appending), album=album['vanity'])
    assert created['id'] in [i['id'] for i in client.get('/albums/' + album['vanity']).json()['items']]


def test_expired_keys_and_pending_deletion_owners(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    created = create_key(client, headers, expires_in=30 * 86400)
    appdb.execute("UPDATE upload_keys SET expires_at = now() - interval '1 second' WHERE id = %s",
                  (int(created['key']['id']),))
    assert send(client, key_header(created['secret']), status=401)['code'] == 'UPLOAD_KEY_INVALID'
    assert client.get('/users/@me/upload-keys', headers=headers).json()['items'][0]['state'] == 'expired'
    secret = create_key(client, headers)['secret']
    appdb.execute("UPDATE users SET deletion_requested_at = now(), deletion_scheduled_for = now() + interval '14 days' "
                  'WHERE id = %s', (user_id,))
    body = send(client, key_header(secret), status=403)
    assert body['code'] == 'ACCOUNT_PENDING_DELETION' and body['scheduled_for'] > 0
    appdb.execute('UPDATE users SET deletion_requested_at = NULL, deletion_scheduled_for = NULL WHERE id = %s',
                  (user_id,))
    send(client, key_header(secret))


def test_standing_applies_to_key_uploads(client, appdb):
    from safety import ip as abuse_ip
    from safety.settings import safety_settings
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    secret = create_key(client, headers)['secret']
    appdb.execute("INSERT INTO user_restrictions (user_id, kind, rule) VALUES (%s, 'uploads', 'spam')", (user_id,))
    assert send(client, key_header(secret), status=403)['code'] == 'UPLOADS_RESTRICTED'
    appdb.execute('UPDATE user_restrictions SET lifted_at = now() WHERE user_id = %s', (user_id,))
    ip = '10.66.{}.{}'.format(*uuid.uuid4().bytes[:2])
    appdb.execute("INSERT INTO bans (abuse_ip_hash, rule) VALUES (%s, 'spam')",
                  (abuse_ip.abuse_ip_hash(ip, safety_settings().abuse_hash_secret),))
    response = client.post('/files', headers={'Authorization': 'Key ' + secret, 'X-Forwarded-For': ip},
                           files={'file': ('a.txt', b'hello', 'text/plain')})
    assert response.json()['code'] == 'BANNED'
    # upload-restricted accounts can still create keys
    appdb.execute("INSERT INTO user_restrictions (user_id, kind, rule) VALUES (%s, 'uploads', 'spam')", (user_id,))
    create_key(client, headers)


def test_the_per_key_rate(client, appdb, monkeypatch):
    monkeypatch.setenv('UPLOAD_KEY_RATE_PER_HOUR', '2')
    headers = sign_in(make_user(appdb), appdb)
    secret = create_key(client, headers)['secret']
    send(client, key_header(secret))
    response = client.post('/uploads', headers=key_header(secret), json={'filename': 'a.bin', 'size': 10})
    assert response.status_code == 201
    body = send(client, key_header(secret), status=429)
    assert body['code'] == 'TOO_MANY_UPLOADS' and body['limit'] == 2 and 0 < body['retry_after'] <= 3600


def test_anonymous_tools_need_a_key(client):
    fingerprint = {'X-Fingerprint': FingerprintToken.generate(Snowflake.generate())}
    for headers in (fingerprint, {}):
        response = client.post('/files', headers=headers, files={'file': ('a.txt', b'hello', 'text/plain')})
        assert (response.status_code, response.json()) == (401, {
            'code': 'UPLOAD_KEY_REQUIRED', 'message': 'Create a free account to upload with ShareX', 'status': 401})
    response = client.post('/files?type=raw&filename=a.txt', headers=dict(fingerprint, **{'Content-Type': 'text/plain'}),
                           content=b'hello')
    assert response.json()['code'] == 'UPLOAD_KEY_REQUIRED'
    response = client.post('/uploads', headers=fingerprint, json={'filename': 'a.bin', 'size': 10})
    assert response.json()['code'] == 'UPLOAD_KEY_REQUIRED'
    # a present but failing token is still CAPTCHA_INVALID; a good one uploads
    response = client.post('/files', headers=fingerprint, files={'file': ('a.txt', b'hello', 'text/plain')},
                           data={'turnstile_token': 'mock-fail'})
    assert response.json()['code'] == 'CAPTCHA_INVALID'
    response = client.post('/files', headers=fingerprint, files={'file': ('a.txt', b'hello', 'text/plain')},
                           data={'turnstile_token': TURNSTILE_TOKEN})
    assert response.status_code == 200


def test_chunked_sessions_belong_to_their_key(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    first, second = create_key(client, headers)['secret'], create_key(client, headers)['secret']
    data = uuid.uuid4().bytes * 4
    session = client.post('/uploads', headers=key_header(first), json={'filename': 'a.bin', 'size': len(data)}).json()
    upload_id = session['upload_id']
    assert appdb.fetchone('SELECT upload_key_id IS NOT NULL FROM upload_sessions WHERE id = %s', (int(upload_id),))[0]
    assert client.get('/uploads/' + upload_id, headers=key_header(second)).json()['code'] == 'UNKNOWN_UPLOAD'
    response = client.request('PUT', '/uploads/{}/chunks/0'.format(upload_id), headers=key_header(first), content=data)
    assert response.status_code == 204
    # the owner's session cookie can see (and cancel) it
    assert client.get('/uploads/' + upload_id, headers=headers).json()['received'] == [0]
    # a website session never reaches a key through another key's session either
    website = client.post('/uploads', headers=headers, json={'filename': 'b.bin', 'size': 10}).json()['upload_id']
    assert client.get('/uploads/' + website, headers=key_header(first)).json()['code'] == 'UNKNOWN_UPLOAD'
    assert client.delete('/uploads/' + upload_id, headers=headers).status_code == 204


def test_staff_revoke_upload_keys(client, appdb):
    from tests.m4 import make_staff
    _, staff = make_staff(appdb)
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    one, two = create_key(client, headers), create_key(client, headers)
    response = client.post('/admin/actions', headers=staff, json={
        'action': 'revoke_upload_keys', 'target': {'type': 'user', 'id': str(user_id)},
        'details': {'key_id': one['key']['id']}})
    assert response.status_code == 200, response.text
    assert send(client, key_header(one['secret']), status=401)['code'] == 'UPLOAD_KEY_INVALID'
    send(client, key_header(two['secret']))
    notice = appdb.fetchone("SELECT appealable, message FROM user_warnings WHERE user_id = %s AND action = "
                            "'revoke_upload_keys'", (user_id,))
    assert notice == (False, 'An upload key was revoked')
    client.post('/admin/actions', headers=staff, json={'action': 'revoke_upload_keys',
                                                       'target': {'type': 'user', 'id': str(user_id)}})
    assert send(client, key_header(two['secret']), status=401)['code'] == 'UPLOAD_KEY_INVALID'
    assert {r[0] for r in appdb.fetchall('SELECT revoked_reason FROM upload_keys WHERE user_id = %s', (user_id,))} == \
        {'staff'}
