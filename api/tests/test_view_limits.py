"""Milestone 6 §19 (docs/redesign/contracts/milestone-6.md): view limits. Unique viewers by abuse IP hash, the
owner and staff never counting, the `expire` and `private` actions, the owner PATCH, unlock counting on
password files, Turnstile, album pages and ZIPs, the payloads and the internal lookup. The Worker's half
(the `limited` shell, bots, unsigned CDN requests) is in cf-worker/test."""

import time
import uuid

import pytest

from tests.conftest import (
    APP_DATABASE, FAILING_TOKEN, UNLOCK_TOKEN, UPLOAD_TOKEN, TempDatabase, assert_signed, make_user, sign_in,
    turnstile_token,
)
from tests.test_milestone2 import ORIGIN, anonymous, new_user, unlock, upload

VIEW_TOKEN = turnstile_token('view')


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


def new_ip():
    return '10.{}.{}.{}'.format(*uuid.uuid4().bytes[:3])


def open_file(client, vanity, ip=None, headers=None, token=VIEW_TOKEN, access=None):
    sent = {'X-Forwarded-For': ip or new_ip()}
    sent.update(headers or {})
    if access is not None:
        sent['X-Filesgg-Access'] = access
    body = {} if token is None else {'turnstile_token': token}
    return client.post('/access/open/files/' + vanity, json=body, headers=sent)


def opened(client, vanity, **kwargs):
    response = open_file(client, vanity, **kwargs)
    assert response.status_code == 200, response.text
    return response.json()


def state_of(db, created):
    return db.fetchone('SELECT view_limit, view_limit_action, views_used, visibility, access_version, '
                       'extract(epoch FROM expires_at)::bigint FROM files WHERE id = %s', (int(created['id']),))


def viewers_of(db, created):
    return db.fetchone('SELECT count(*) FROM file_limit_viewers WHERE file_id = %s', (int(created['id']),))[0]


def patch(client, headers, created, **fields):
    return client.patch('/users/@me/files/' + created['id'], headers=headers, json=fields)


def code_of(response):
    return response.status_code, response.json().get('code')


def make_staff(db):
    from tools import staff
    user_id = make_user(db)
    staff.grant(db.conn, user_id, 'moderator', False, 'tests')
    return sign_in(user_id, db)


# --- counting (§19.4, §19.9) ---------------------------------------------------------------------------------

def test_three_viewers_on_a_limit_of_three(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=3)
    grant = 'file:{}:{{}}'.format(created['id'])
    first_ip = new_ip()
    first = opened(client, created['vanity'], ip=first_ip)
    assert first['file']['id'] == created['id'] and first['file']['view_limit'] == {'remaining': 2}
    assert_signed(first['file']['cdn_url'], grant.format(0), expires=first['expires_at'])
    assert opened(client, created['vanity'])['file']['view_limit'] == {'remaining': 1}
    # the third viewer is the last one, and still gets the file: signed after the action fired
    third = opened(client, created['vanity'])
    assert third['file']['id'] == created['id'] and third['file']['view_limit'] == {'remaining': 0}
    assert_signed(third['file']['cdn_url'], grant.format(1), expires=third['expires_at'])
    limit, action, used, visibility, version, _ = state_of(appdb, created)
    assert (limit, action, used, visibility, version) == (3, 'expire', 3, 'link', 1)
    assert viewers_of(appdb, created) == 3
    # a fourth viewer gets the normal missing state, never "view limit reached"
    assert code_of(open_file(client, created['vanity'])) == (404, 'UNKNOWN_FILE')
    response = client.get('/files/' + created['vanity'], headers={'X-Forwarded-For': new_ip()})
    assert response.json() == {'code': 'UNKNOWN_FILE', 'message': 'Unknown file', 'status': 404}
    # the first viewers coming back too, now the action fired
    assert code_of(open_file(client, created['vanity'], ip=first_ip)) == (404, 'UNKNOWN_FILE')


def test_one_viewer_opening_five_times_uses_one_view(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=3)
    ip = new_ip()
    for _ in range(5):
        body = opened(client, created['vanity'], ip=ip)
        assert body['file']['view_limit'] == {'remaining': 2}
    assert state_of(appdb, created)[2] == 1 and viewers_of(appdb, created) == 1
    # an IPv6 viewer is their /64: another address in the same network is the same viewer
    opened(client, created['vanity'], ip='2001:db8:1:2::1')
    opened(client, created['vanity'], ip='2001:db8:1:2:ffff::9')
    assert state_of(appdb, created)[2] == 2


def test_the_owner_and_staff_never_count(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=1)
    for _ in range(3):
        body = opened(client, created['vanity'], headers=owner)
        assert body['file']['id'] == created['id'] and body['file']['view_limit'] == {'remaining': 1}
        assert_signed(body['file']['cdn_url'], 'file:{}:0'.format(created['id']))
    mine = client.get('/files/' + created['vanity'], headers=owner).json()
    assert mine['id'] == created['id'] and mine['view_limit'] == {'remaining': 1}
    assert_signed(mine['cdn_url'], 'file:{}:0'.format(created['id']))
    staff = make_staff(appdb)
    assert opened(client, created['vanity'], headers=staff)['file']['id'] == created['id']
    assert client.get('/files/' + created['vanity'], headers=staff).json()['id'] == created['id']
    # an owner pass is the owner too
    owner_pass = client.post('/users/@me/files/{}/pass'.format(created['id']), headers=owner).json()['token']
    response = client.get('/access/view/files/{}'.format(created['vanity']), headers={'X-Filesgg-Access': owner_pass})
    assert response.status_code == 200, response.text
    assert opened(client, created['vanity'], access=owner_pass)['file']['id'] == created['id']
    assert state_of(appdb, created)[2] == 0 and viewers_of(appdb, created) == 0
    # an anonymous upload's owner is its guest
    guest = anonymous()
    anon = upload(client, dict(guest, **{'X-Forwarded-For': new_ip()}), view_limit=1,
                  turnstile_token=UPLOAD_TOKEN)
    assert opened(client, anon['vanity'], headers=guest)['file']['id'] == anon['id']
    assert state_of(appdb, anon)[2] == 0
    # a stranger uses the only view
    assert opened(client, created['vanity'])['file']['view_limit'] == {'remaining': 0}
    assert state_of(appdb, created)[2] == 1


def test_the_expire_action_expires_the_file(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=1)
    before = client.get('/users/@me/files/' + created['id'], headers=owner).json()
    assert before['view_limit'] == 1 and before['view_limit_action'] == 'expire' and before['views_used'] == 0
    last = opened(client, created['vanity'])
    _, _, used, visibility, version, expires_at = state_of(appdb, created)
    assert (used, visibility, version) == (1, 'link', 1)
    # missing to everyone at once; the last viewer's URLs stay valid for their hour, then the file is gone
    assert expires_at is not None and expires_at <= time.time() + 3600 + 5
    assert last['expires_at'] <= expires_at
    assert code_of(open_file(client, created['vanity'])) == (404, 'UNKNOWN_FILE')
    assert client.get('/files/' + created['vanity']).status_code == 404
    # the owner's URLs from before the last view are revoked (access_version)
    assert client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()['access']['access_version'] == 1
    appdb.execute("UPDATE files SET expires_at = now() - interval '1 second' WHERE id = %s", (int(created['id']),))
    assert client.get('/internal/files/' + created['vanity'], headers=ORIGIN).status_code == 404
    assert client.get('/users/@me/files/' + created['id'], headers=owner).status_code == 404


def test_the_private_action_hides_it_from_everyone_but_the_owner(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=2, view_limit_action='private')
    first_ip = new_ip()
    first = opened(client, created['vanity'], ip=first_ip)
    assert_signed(first['file']['cdn_url'], 'file:{}:0'.format(created['id']))
    last = opened(client, created['vanity'])
    assert_signed(last['file']['cdn_url'], 'file:{}:1'.format(created['id']))
    limit, action, used, visibility, version, expires_at = state_of(appdb, created)
    assert (limit, action, used, visibility, version, expires_at) == (2, 'private', 2, 'private', 1, None)
    # every URL given out before is revoked: the lookup's access_version moved on, so the Worker refuses them
    lookup = client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()
    assert lookup['access'] == dict(lookup['access'], visibility='private', access_version=1)
    assert lookup['view_limit'] == {'limit': 2, 'used': 2, 'action': 'private'}
    for ip in (first_ip, new_ip()):
        assert code_of(open_file(client, created['vanity'], ip=ip)) == (404, 'UNKNOWN_FILE')
    assert client.get('/files/' + created['vanity']).status_code == 404
    # the owner still has it, shown as private
    mine = client.get('/users/@me/files/' + created['id'], headers=owner).json()
    assert (mine['visibility'], mine['view_limit'], mine['views_used']) == ('private', 2, 2)
    assert client.get('/files/' + created['vanity'], headers=owner).json()['visibility'] == 'private'
    # raising the limit and changing the visibility back opens it again; earlier viewers don't count twice
    response = patch(client, owner, created, view_limit=4, visibility='link')
    assert response.status_code == 200, response.text
    assert opened(client, created['vanity'], ip=first_ip)['file']['view_limit'] == {'remaining': 2}
    assert opened(client, created['vanity'])['file']['view_limit'] == {'remaining': 1}
    assert state_of(appdb, created)[2] == 3


def test_the_owner_changes_the_limit(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=5)
    opened(client, created['vanity'])
    opened(client, created['vanity'])
    for limit in (2, 1):
        response = patch(client, owner, created, view_limit=limit)
        assert code_of(response) == (400, 'VIEW_LIMIT_TOO_LOW')
        assert response.json()['views_used'] == 2
    response = patch(client, owner, created, view_limit=3, view_limit_action='private')
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body['view_limit'], body['view_limit_action'], body['views_used']) == (3, 'private', 2)
    # removing it keeps views_used; the file is plain again
    body = patch(client, owner, created, view_limit=None).json()
    assert (body['view_limit'], body['views_used']) == (None, 2)
    assert 'view_limit' not in client.get('/files/' + created['vanity']).json()
    assert client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()['view_limit'] is None
    # a new limit still has to be above what was used
    assert code_of(patch(client, owner, created, view_limit=2)) == (400, 'VIEW_LIMIT_TOO_LOW')
    assert patch(client, owner, created, view_limit=10).json()['view_limit'] == 10
    for bad in (0, 1001, 'many', True, 2.5):
        assert code_of(patch(client, owner, created, view_limit=bad)) == (400, 'INVALID_PARAMETERS')
    assert code_of(patch(client, owner, created, view_limit_action='delete')) == (400, 'INVALID_PARAMETERS')
    # anonymous uploaders set it only at upload
    guest = anonymous(new_ip())
    anon = upload(client, guest, view_limit=3, turnstile_token=UPLOAD_TOKEN)
    response = client.patch('/users/@me/files/' + anon['id'], headers=guest, json={'view_limit': 5})
    assert code_of(response) == (403, 'FORBIDDEN')


# --- password files (§19.4) -----------------------------------------------------------------------------------

def test_unlock_counts_on_password_files(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, password='hunter222', view_limit=2)
    vanity = created['vanity']
    locked = client.get('/files/' + vanity).json()
    assert locked == {'vanity': vanity, 'protected': 'password', 'view_limited': True, 'views_remaining': 2}
    # /open without an unlock token: 401 UNLOCK_REQUIRED, and nothing counted
    assert code_of(open_file(client, vanity)) == (401, 'UNLOCK_REQUIRED')
    assert code_of(open_file(client, vanity, access='not-a-token')) == (401, 'UNLOCK_REQUIRED')
    ip = new_ip()
    response = unlock(client, vanity, 'hunter222', ip=ip)
    assert response.status_code == 200, response.text
    unlocked = response.json()
    assert unlocked['file']['view_limit'] == {'remaining': 1}
    assert state_of(appdb, created)[2] == 1
    # the same viewer reopening with the token never counts again
    assert opened(client, vanity, ip=ip, access=unlocked['token'])['file']['view_limit'] == {'remaining': 1}
    response = client.get('/access/view/files/{}'.format(vanity),
                          headers={'X-Filesgg-Access': unlocked['token'], 'X-Forwarded-For': ip})
    assert response.status_code == 200 and response.json()['file']['view_limit'] == {'remaining': 1}
    assert state_of(appdb, created)[2] == 1
    # a wrong password uses nothing
    assert unlock(client, vanity, 'wrong-one').status_code == 401
    assert state_of(appdb, created)[2] == 1
    # the second unlock is the last view
    last = unlock(client, vanity, 'hunter222')
    assert last.status_code == 200 and last.json()['file']['view_limit'] == {'remaining': 0}
    assert_signed(last.json()['file']['cdn_url'], 'file:{}:1'.format(created['id']))
    assert state_of(appdb, created)[2] == 2
    assert code_of(unlock(client, vanity, 'hunter222')) == (404, 'UNKNOWN_FILE')
    assert client.get('/files/' + vanity).status_code == 404
    # the first viewer's token no longer opens it
    response = client.get('/access/view/files/{}'.format(vanity),
                          headers={'X-Filesgg-Access': unlocked['token'], 'X-Forwarded-For': ip})
    assert response.status_code in (401, 404)


def test_private_files_with_a_limit_only_open_for_the_owner(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, visibility='private', view_limit=1)
    assert code_of(open_file(client, created['vanity'])) == (404, 'UNKNOWN_FILE')
    assert client.get('/files/' + created['vanity']).status_code == 404
    assert opened(client, created['vanity'], headers=owner)['file']['id'] == created['id']
    assert state_of(appdb, created)[2] == 0


# --- Turnstile and signed URLs --------------------------------------------------------------------------------

def test_turnstile_is_required(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=3)
    for token in (None, FAILING_TOKEN, UNLOCK_TOKEN, turnstile_token('view', 'evil.example')):
        assert code_of(open_file(client, created['vanity'], token=token)) == (403, 'CAPTCHA_INVALID')
    assert state_of(appdb, created)[2] == 0
    # then the rate limit, as unlock: 5 a minute per file and IP
    ip = new_ip()
    for _ in range(5):
        opened(client, created['vanity'], ip=ip)
    assert code_of(open_file(client, created['vanity'], ip=ip)) == (429, 'TOO_MANY_ATTEMPTS')
    assert state_of(appdb, created)[2] == 1


def test_open_urls_last_an_hour_capped_at_expiry(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=3)
    body = opened(client, created['vanity'])
    assert 3590 < body['expires_at'] - time.time() <= 3600
    short = upload(client, owner, view_limit=3)
    appdb.execute("UPDATE files SET expires_at = now() + interval '600 seconds' WHERE id = %s", (int(short['id']),))
    body = opened(client, short['vanity'])
    assert 590 < body['expires_at'] - time.time() <= 600
    assert_signed(body['file']['cdn_url'], 'file:{}:0'.format(short['id']), expires=body['expires_at'])
    # /open works on files without a limit too (nothing to count): plain URLs for a link file
    plain = upload(client, owner)
    assert 'view_limit' not in opened(client, plain['vanity'])['file']
    assert code_of(open_file(client, 'does-not-exist')) == (404, 'UNKNOWN_FILE')


# --- payloads and the internal lookup (§19.5, §19.6) -----------------------------------------------------------

def test_payloads_and_lookup(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, view_limit=3, view_limit_action='private')
    # the upload response is the owner's: the fields, and URLs signed like a protected file's
    assert (created['view_limit'], created['view_limit_action'], created['views_used']) == (3, 'private', 0)
    assert_signed(created['cdn_url'], 'file:{}:0'.format(created['id']))
    # the public lookup has no name and no URL until /open
    stub = client.get('/files/' + created['vanity']).json()
    assert stub == {'vanity': created['vanity'], 'view_limited': True, 'views_remaining': 3}
    lookup = client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()
    assert lookup['view_limit'] == {'limit': 3, 'used': 0, 'action': 'private'}
    assert lookup['access']['visibility'] == 'link'
    # its URLs are plain, which the CDN refuses for a view-limited file
    assert 'expires=' not in lookup['file']['cdn_url']
    plain = upload(client, owner)
    assert 'view_limit' not in plain or plain['view_limit'] is None
    assert client.get('/internal/files/' + plain['vanity'], headers=ORIGIN).json()['view_limit'] is None
    assert 'view_limit' not in client.get('/files/' + plain['vanity']).json()
    listed = client.get('/users/@me/files', headers=owner).json()
    item = next(i for i in listed['items'] if i['id'] == created['id'])
    assert (item['view_limit'], item['view_limit_action'], item['views_used']) == (3, 'private', 0)


# --- uploads (§19.3) ------------------------------------------------------------------------------------------

def test_an_anonymous_upload_cant_choose_private(client, appdb, monkeypatch):
    guest = anonymous(new_ip())
    response = client.post('/files', headers=guest, files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')},
                           data={'view_limit': '1', 'view_limit_action': 'private', 'turnstile_token': UPLOAD_TOKEN})
    assert code_of(response) == (400, 'PRIVATE_REQUIRES_ACCOUNT')
    created = upload(client, guest, view_limit=1, turnstile_token=UPLOAD_TOKEN)
    assert (created['view_limit'], created['view_limit_action']) == (1, 'expire')
    response = client.post('/uploads', headers=guest, json={
        'filename': 'x.bin', 'size': 100, 'view_limit': 2, 'view_limit_action': 'private',
        'turnstile_token': UPLOAD_TOKEN})
    assert code_of(response) == (400, 'PRIVATE_REQUIRES_ACCOUNT')
    for bad in ('0', '1001', 'x'):
        response = client.post('/files', headers=guest,
                               files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')},
                               data={'view_limit': bad, 'turnstile_token': UPLOAD_TOKEN})
        assert code_of(response) == (400, 'INVALID_PARAMETERS')


def test_chunked_and_key_uploads_carry_the_limit(client, appdb, monkeypatch):
    from jobs.finalize import finalize
    monkeypatch.setenv('UPLOAD_CHUNK_SIZE', str(5 * 1024 * 1024))
    _, owner = new_user(appdb)
    data = uuid.uuid4().bytes * 8
    response = client.post('/uploads', headers=owner, json={
        'filename': 'big.bin', 'size': len(data), 'view_limit': 7, 'view_limit_action': 'private'})
    assert response.status_code == 201, response.text
    upload_id = response.json()['upload_id']
    response = client.request('PUT', '/uploads/{}/chunks/0'.format(upload_id), headers=owner, content=data)
    assert response.status_code == 204, response.text
    assert client.post('/uploads/{}/complete'.format(upload_id), headers=owner).status_code == 202
    finalize(int(upload_id))
    done = client.get('/uploads/' + upload_id, headers=owner).json()
    assert (done['file']['view_limit'], done['file']['view_limit_action'], done['file']['views_used']) == \
        (7, 'private', 0)
    # an upload key (ShareX), and the .sxcu carries the options
    created = client.post('/users/@me/upload-keys', headers=owner, json={
        'name': 'ShareX', 'sharex': {'view_limit': 5, 'view_limit_action': 'private'}}).json()
    assert created['sharex']['Arguments'] == {'view_limit': '5', 'view_limit_action': 'private'}
    assert '-F "view_limit=5" -F "view_limit_action=private"' in created['curl']
    headers = {'Authorization': 'Key ' + created['secret'], 'X-Forwarded-For': new_ip()}
    response = client.post('/files', headers=headers, files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')},
                           data={'view_limit': '5', 'view_limit_action': 'private'})
    assert response.status_code == 200, response.text
    assert (response.json()['view_limit'], response.json()['view_limit_action']) == (5, 'private')


# --- albums (§19.6) -------------------------------------------------------------------------------------------

def test_view_limited_files_are_absent_from_album_pages_and_the_zip(client, appdb):
    _, owner = new_user(appdb)
    plain = upload(client, owner)
    limited = upload(client, owner, view_limit=3)
    later = upload(client, owner)
    response = client.post('/users/@me/albums', headers=owner,
                           json={'file_ids': [plain['id'], limited['id'], later['id']]})
    assert response.status_code == 201, response.text
    album = response.json()
    public = client.get('/albums/' + album['vanity']).json()
    assert [i['id'] for i in public['items']] == [plain['id'], later['id']] and public['count'] == 2
    internal = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert list(internal['items_storage']) == [plain['id'], later['id']]
    assert list(internal['items_access']) == [plain['id'], later['id']]
    assert client.get('/internal/files/' + limited['vanity'], headers=ORIGIN).json()['albums'] == []
    # the owner's editor shows it as hidden, with the reason for the note
    items = {i['id']: i for i in album['items']}
    assert items[limited['id']]['shown'] is False and items[limited['id']]['hidden_reason'] == 'view_limit'
    assert items[plain['id']]['shown'] is True and 'hidden_reason' not in items[plain['id']]
    # setting a limit later takes the file out; removing it brings it back
    assert patch(client, owner, later, view_limit=10).status_code == 200
    assert [i['id'] for i in client.get('/albums/' + album['vanity']).json()['items']] == [plain['id']]
    assert list(client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()['items_storage']) == \
        [plain['id']]
    assert patch(client, owner, later, view_limit=None).status_code == 200
    assert [i['id'] for i in client.get('/albums/' + album['vanity']).json()['items']] == [plain['id'], later['id']]
    # an album token never opens it (it isn't a shown item)
    assert client.get('/internal/files/' + limited['vanity'], headers=ORIGIN).json()['albums'] == []
