"""Milestone 3 (docs/redesign/contracts/milestone-3.md): albums, album access, the
owner's library, signed CDN URLs, the internal lookups, and upload integration."""

import time
import uuid

import pytest

from tests.conftest import (
    CDN_SIGNING_SECRET, SECRET_KEY, TURNSTILE_TOKEN, UNLOCK_TOKEN, assert_signed, assert_unsigned, hash_of,
    payload_urls, s3_object, url_query,
)
from tests.m3 import (  # noqa: F401  (fixtures)
    ORIGIN, anonymous, appdb, image_size, lookup, media_db, new_user, png, process, send,
)
from utils import access_token, cdn_signing

# the API's unlock tokens are signed with SECRET_KEY (milestone-3 §3)
SECRET = SECRET_KEY


def text_file(client, headers, status=200, name='a.txt', **fields):
    return send(client, headers, uuid.uuid4().bytes * 4, name, 'text/plain', status=status, **fields)


def image_file(client, headers, size=(100, 100), **fields):
    return send(client, headers, png(*size), 'pic.png', 'image/png', **fields)


def make_album(client, headers, file_ids, status=201, **fields):
    response = client.post('/users/@me/albums', headers=headers, json=dict(fields, file_ids=file_ids))
    assert response.status_code == status, response.text
    return response.json()


def patch_album(client, headers, album_id, status=200, **fields):
    response = client.request('PATCH', '/users/@me/albums/' + album_id, headers=headers, json=fields)
    assert response.status_code == status, response.text
    return response.json()


def ids(items):
    return [item['id'] for item in items]


def unlock_album(client, vanity, password):
    ip = '10.3.{}.{}'.format(uuid.uuid4().int % 250, uuid.uuid4().int % 250)
    return client.post('/albums/{}/unlock'.format(vanity), json={'password': password, 'turnstile_token': UNLOCK_TOKEN},
                       headers={'X-Forwarded-For': ip})


# --- creating and reading albums ---------------------------------------------------------------------

def test_create_and_read_a_link_album(client, media_db):
    _, owner = new_user(media_db)
    files = [text_file(client, owner) for _ in range(3)]
    album = make_album(client, owner, ids(files), title='  My\x07 trip\n ', description='Day one\nDay two\x00',
                       layout='grid')
    assert album['title'] == 'My trip' and album['description'] == 'Day one\nDay two'
    assert album['layout'] == 'grid' and album['visibility'] == 'link' and album['nsfw'] is False
    assert len(album['vanity']) == 8 and album['url'] == 'https://files.gg/a/' + album['vanity']
    assert album['download_url'] == 'https://cdn.files.gg/albums/download/{}.zip'.format(album['vanity'])
    assert 'downloadUrl' not in album and 'expiresAt' not in album
    assert [i['position'] for i in album['items']] == [0, 1, 2] and ids(album['items']) == ids(files)
    assert all(i['shown'] is True and i['caption'] == '' for i in album['items'])
    assert album['access_version'] == 0 and album['cover_file_id'] is None
    assert album['created_at'] and album['updated_at'] and album['count'] == 3
    assert album['items'][0]['albums'] == [{'id': album['id'], 'vanity': album['vanity'], 'title': 'My trip'}]

    public = client.get('/albums/' + album['vanity']).json()
    assert public['id'] == album['id'] and ids(public['items']) == ids(files)
    assert public['count'] == 3 and public['total_size'] == sum(f['size'] for f in files)
    assert public['next_cursor'] is None and public['expires_at'] is None
    # a link album's URLs are never signed
    assert_unsigned(public['download_url'])
    for item in public['items']:
        for url in payload_urls(item):
            assert_unsigned(url)
    # items are the public file payload plus position and caption; no owner fields
    item = public['items'][0]
    assert item['visibility'] == 'link' and 'access_version' not in item and 'shown' not in item
    assert item['position'] == 0 and item['caption'] == '' and 'snippet' not in item['media']
    assert client.get('/albums/nope1234').json()['code'] == 'UNKNOWN_ALBUM'


def test_owner_list_and_get(client, media_db):
    _, owner = new_user(media_db)
    a = text_file(client, owner)
    first = make_album(client, owner, [a['id']], title='Beta')
    second = make_album(client, owner, [a['id']], title='alpha')
    listing = client.get('/users/@me/albums', headers=owner).json()
    assert listing['count'] == 2 and ids(listing['items']) == [second['id'], first['id']]
    summary = listing['items'][0]
    assert set(summary) == {'id', 'vanity', 'url', 'title', 'layout', 'visibility', 'count', 'cover', 'collage',
                            'created_at', 'updated_at'}
    assert summary['count'] == 1
    by_title = client.get('/users/@me/albums?sort_by=title', headers=owner).json()
    assert [i['title'] for i in by_title['items']] == ['alpha', 'Beta']
    assert client.get('/users/@me/albums?query=ALP', headers=owner).json()['count'] == 1
    assert client.get('/users/@me/albums?limit=1&offset=1', headers=owner).json()['items'][0]['id'] == first['id']
    assert client.get('/users/@me/albums/' + first['id'], headers=owner).json()['title'] == 'Beta'
    _, stranger = new_user(media_db)
    assert client.get('/users/@me/albums/' + first['id'], headers=stranger).json()['code'] == 'UNKNOWN_ALBUM'
    assert client.get('/users/@me/albums', headers=stranger).json() == {'count': 0, 'items': []}


def test_text_limits(client, media_db):
    _, owner = new_user(media_db)
    a = text_file(client, owner)
    response = client.post('/users/@me/albums', headers=owner, json={'file_ids': [a['id']], 'title': 'x' * 101})
    assert response.status_code == 400 and 'title' in response.json()['errors']
    response = client.post('/users/@me/albums', headers=owner,
                           json={'file_ids': [a['id']], 'description': 'x' * 2001})
    assert response.status_code == 400
    album = make_album(client, owner, [a['id']])
    response = client.request('PATCH', '/users/@me/albums/{}/files/{}'.format(album['id'], a['id']), headers=owner,
                              json={'caption': 'y' * 501})
    assert response.status_code == 400 and 'caption' in response.json()['errors']


# --- which items an album shows -----------------------------------------------------------------------------

def test_link_album_hides_protected_items(client, media_db):
    _, owner = new_user(media_db)
    link = text_file(client, owner)
    locked = text_file(client, owner, password='hunter222')
    private = text_file(client, owner, visibility='private')
    album = make_album(client, owner, [link['id'], locked['id'], private['id']])
    public = client.get('/albums/' + album['vanity']).json()
    assert ids(public['items']) == [link['id']] and public['count'] == 1
    # the owner's editor shows all of them, with a note
    assert [i['shown'] for i in album['items']] == [True, False, False]
    assert album['count'] == 1
    # the internal file lookup lists the album only where the item is shown
    assert lookup(client, link)['albums'] == [{'id': album['id'], 'vanity': album['vanity'], 'access_version': 0}]
    assert lookup(client, locked)['albums'] == []
    assert lookup(client, private)['albums'] == []
    internal = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert list(internal['items_access']) == [link['id']] and list(internal['items_storage']) == [link['id']]


def test_protected_album_shows_every_item_and_its_token_opens_them(client, media_db):
    _, owner = new_user(media_db)
    link = text_file(client, owner)
    locked = text_file(client, owner, password='hunter222')
    private = text_file(client, owner, visibility='private')
    album = make_album(client, owner, [link['id'], locked['id'], private['id']], title='Secret')
    patched = patch_album(client, owner, album['id'], generate_password=True)
    password = patched['password']
    assert patched['visibility'] == 'password' and patched['access_version'] == 1
    assert patched['url_with_password'] == 'https://files.gg/a/{}#pw={}'.format(album['vanity'], password)
    assert all(i['shown'] for i in patched['items'])

    vanity = album['vanity']
    assert client.get('/albums/' + vanity).json() == {'vanity': vanity, 'protected': 'password'}
    patch_album(client, owner, album['id'], show_name_when_locked=True)
    assert client.get('/albums/' + vanity).json()['title'] == 'Secret'
    # the owner sees it
    assert client.get('/albums/' + vanity, headers=owner).json()['count'] == 3

    response = unlock_album(client, vanity, 'wrong-password')
    assert (response.status_code, response.json()['code']) == (401, 'WRONG_PASSWORD')
    response = client.post('/albums/{}/unlock'.format(vanity), json={'password': password})
    assert response.json()['code'] == 'CAPTCHA_INVALID'
    response = unlock_album(client, vanity, password)
    assert response.status_code == 200, response.text
    body = response.json()
    claims = access_token.decode(body['token'], SECRET)
    assert claims['k'] == 'album' and claims['t'] == album['id'] and claims['v'] == 1 and claims['s'] == 'unlock'
    assert ids(body['album']['items']) == [link['id'], locked['id'], private['id']]
    grant = 'album:{}:1'.format(album['id'])
    assert_album_signed(body['album'], grant, body['expires_at'])

    token = body['token']
    view = client.get('/albums/{}/view'.format(vanity), headers={'X-Filesgg-Access': token})
    assert view.status_code == 200 and view.json()['expires_at'] == claims['e']
    assert_album_signed(view.json()['album'], grant, claims['e'])
    with_token = client.get('/albums/' + vanity, headers={'X-Filesgg-Access': token}).json()
    assert with_token['count'] == 3
    assert_album_signed(with_token, grant, claims['e'])
    response = client.post('/albums/{}/unlock/refresh'.format(vanity), json={'token': token})
    refreshed = response.json()
    assert access_token.decode(refreshed['token'], SECRET)['u'] == claims['u']
    # refresh returns the album again, with fresh URLs
    assert_album_signed(refreshed['album'], grant, refreshed['expires_at'])

    # the album grant opens the items: through the lookup's albums (for the Worker) and /files/<v>/view
    for item in (link, locked, private):
        assert lookup(client, item)['albums'] == [{'id': album['id'], 'vanity': vanity, 'access_version': 1}]
    response = client.get('/files/{}/view'.format(private['vanity']), headers={'X-Filesgg-Access': token})
    assert response.status_code == 200 and response.json()['file']['id'] == private['id']
    # through the album token, the file's URLs use the album grant and carry album=
    assert_signed(response.json()['file']['cdn_url'], grant, album=vanity, expires=claims['e'])
    response = client.get('/files/' + locked['vanity'], headers={'X-Filesgg-Access': token})
    assert_signed(response.json()['cdn_url'], grant, album=vanity, expires=claims['e'])
    assert client.get('/files/{}/view'.format(locked['vanity']), headers={'X-Filesgg-Access': token}).status_code == 200
    # another album's token doesn't
    other = make_album(client, owner, [link['id']])
    patch_album(client, owner, other['id'], password='other-pass1')
    other_token = unlock_album(client, other['vanity'], 'other-pass1').json()['token']
    assert client.get('/files/{}/view'.format(private['vanity']),
                      headers={'X-Filesgg-Access': other_token}).status_code == 404

    # changing the album's access revokes its tokens (for the album and for the items)
    patch_album(client, owner, album['id'], generate_password=True)
    assert client.get('/albums/{}/view'.format(vanity), headers={'X-Filesgg-Access': token}).status_code == 401
    assert client.get('/files/{}/view'.format(locked['vanity']), headers={'X-Filesgg-Access': token}).status_code == 401
    assert lookup(client, locked)['albums'] == [{'id': album['id'], 'vanity': vanity, 'access_version': 2}]


def test_private_album(client, media_db):
    _, owner = new_user(media_db)
    a = text_file(client, owner)
    album = make_album(client, owner, [a['id']])
    patch_album(client, owner, album['id'], visibility='private')
    vanity = album['vanity']
    assert client.get('/albums/' + vanity).status_code == 404
    response = unlock_album(client, vanity, 'whatever1')
    assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_ALBUM')
    assert client.get('/albums/{}/view'.format(vanity)).json()['code'] == 'UNKNOWN_ALBUM'
    mine = client.get('/albums/' + vanity, headers=owner).json()
    # the owner's URLs are signed for 1 h with the album grant
    expires = assert_signed(mine['download_url'], 'album:{}:1'.format(album['id']))
    assert 3590 < expires - time.time() <= 3600
    owner_pass = client.post('/users/@me/albums/{}/pass'.format(album['id']), headers=owner).json()
    assert owner_pass['url'] == 'https://files.gg/a/{}#t={}'.format(vanity, owner_pass['token'])
    claims = access_token.decode(owner_pass['token'], SECRET)
    assert claims['k'] == 'album' and claims['s'] == 'owner'
    view = client.get('/albums/{}/view'.format(vanity), headers={'X-Filesgg-Access': owner_pass['token']})
    assert view.status_code == 200 and view.json()['album']['visibility'] == 'private'
    _, stranger = new_user(media_db)
    assert client.post('/users/@me/albums/{}/pass'.format(album['id']), headers=stranger).status_code == 404
    # the internal lookups: private still answers (the Worker renders missing), with its access
    internal = client.get('/internal/albums/' + vanity, headers=ORIGIN).json()
    assert internal['access']['visibility'] == 'private'


def test_hidden_items_and_empty_albums(client, media_db):
    _, owner = new_user(media_db)
    a = text_file(client, owner)
    b = text_file(client, owner, expires_in=3600)
    album = make_album(client, owner, [a['id'], b['id']])
    media_db.execute("UPDATE files SET expires_at = now() - interval '1 second' WHERE id = %s", (int(b['id']),))
    assert ids(client.get('/albums/' + album['vanity']).json()['items']) == [a['id']]
    # deleting a file removes it from every album
    assert client.request('DELETE', '/users/@me/files/' + a['id'], headers=owner).status_code == 204
    assert media_db.fetchone('SELECT count(*) FROM album_files WHERE file_id = %s', (int(a['id']),))[0] == 0
    # nothing left to show: missing
    assert client.get('/albums/' + album['vanity']).json()['code'] == 'UNKNOWN_ALBUM'
    assert client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).status_code == 404
    # moderation hides an album
    c = text_file(client, owner)
    other = make_album(client, owner, [c['id']])
    media_db.execute("UPDATE albums SET moderation_state = 'removed' WHERE id = %s", (int(other['id']),))
    # milestone-4 §6.4: a removed album answers 410 ALBUM_REMOVED (it was a 404)
    assert client.get('/albums/' + other['vanity']).json()['code'] == 'ALBUM_REMOVED'
    assert lookup(client, c)['albums'] == []


# --- ownership, limits and anonymous albums ---------------------------------------------------------------------

def test_only_your_own_live_files(client, media_db):
    _, owner = new_user(media_db)
    _, stranger = new_user(media_db)
    mine = text_file(client, owner)
    theirs = text_file(client, stranger)
    gone = text_file(client, owner)
    client.request('DELETE', '/users/@me/files/' + gone['id'], headers=owner)
    response = client.post('/users/@me/albums', headers=owner,
                           json={'file_ids': [mine['id'], theirs['id'], gone['id'], '123']})
    assert (response.status_code, response.json()['code']) == (400, 'INVALID_ALBUM_FILES')
    assert response.json()['file_ids'] == [theirs['id'], gone['id'], '123']
    album = make_album(client, owner, [mine['id']])
    for method, path, body in (('PUT', '/files', {'file_ids': [theirs['id']]}),
                               ('POST', '/files', {'file_ids': [theirs['id']]})):
        response = client.request(method, '/users/@me/albums/{}{}'.format(album['id'], path), headers=owner, json=body)
        assert response.json()['code'] == 'INVALID_ALBUM_FILES'
    response = client.post('/users/@me/albums', headers=owner, json={'file_ids': [mine['id']],
                                                                     'cover_file_id': theirs['id']})
    assert response.json()['code'] == 'INVALID_ALBUM_FILES'
    # someone else's album is unknown
    response = client.request('PATCH', '/users/@me/albums/' + album['id'], headers=stranger, json={'title': 'x'})
    assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_ALBUM')
    assert client.request('DELETE', '/users/@me/albums/' + album['id'], headers=stranger).status_code == 404
    assert client.get('/users/@me/albums').status_code == 401


def test_album_limits(client, media_db, monkeypatch):
    monkeypatch.setenv('LIMIT_ALBUM_FILES', '2')
    monkeypatch.setenv('LIMIT_ALBUMS', '2')
    _, owner = new_user(media_db)
    files = [text_file(client, owner) for _ in range(3)]
    response = client.post('/users/@me/albums', headers=owner, json={'file_ids': ids(files)})
    assert (response.status_code, response.json()['code'], response.json()['limit']) == (400, 'ALBUM_FULL', 2)
    album = make_album(client, owner, ids(files[:2]))
    response = client.post('/users/@me/albums/{}/files'.format(album['id']), headers=owner,
                           json={'file_ids': [files[2]['id']]})
    assert response.json()['code'] == 'ALBUM_FULL'
    response = client.request('PUT', '/users/@me/albums/{}/files'.format(album['id']), headers=owner,
                              json={'file_ids': ids(files)})
    assert response.json()['code'] == 'ALBUM_FULL'
    # adding files already there is fine
    client.post('/users/@me/albums/{}/files'.format(album['id']), headers=owner, json={'file_ids': [files[0]['id']]})
    make_album(client, owner, [])
    response = client.post('/users/@me/albums', headers=owner, json={'file_ids': []})
    assert (response.status_code, response.json()['code'], response.json()['limit']) == (400, 'ALBUM_LIMIT_REACHED', 2)
    assert client.get('/users/@me/limits', headers=owner).json()['album_max_files'] == 2


def test_anonymous_albums(client, media_db, monkeypatch):
    from views import me as me_views
    fingerprint = anonymous()
    files = [text_file(client, fingerprint, turnstile_token=TURNSTILE_TOKEN) for _ in range(2)]
    album = make_album(client, fingerprint, ids(files), title='Batch')
    expiries = [f['expires_at'] for f in files]
    assert album['expires_at'] == max(expiries) and 'expiresAt' not in album
    assert client.get('/albums/' + album['vanity']).json()['count'] == 2
    assert client.get('/users/@me/albums', headers=fingerprint).json()['count'] == 1
    # can't edit it afterwards
    for method, path, body in (('PATCH', '', {'title': 'x'}), ('PUT', '/files', {'file_ids': ids(files)}),
                               ('POST', '/files', {'file_ids': ids(files)}), ('DELETE', '', None)):
        response = client.request(method, '/users/@me/albums/{}{}'.format(album['id'], path), headers=fingerprint,
                                  json=body)
        assert (response.status_code, response.json()['code']) == (403, 'ANONYMOUS_ALBUM_NOT_ALLOWED')
    # no files, too many files, someone else's files, or older ones
    other = text_file(client, anonymous(), turnstile_token=TURNSTILE_TOKEN)
    for file_ids in ([], ids(files) + [other['id']]):
        response = client.post('/users/@me/albums', headers=fingerprint, json={'file_ids': file_ids})
        assert (response.status_code, response.json()['code']) == (403, 'ANONYMOUS_ALBUM_NOT_ALLOWED')
    monkeypatch.setenv('LIMIT_ANONYMOUS_ALBUM_FILES', '1')
    response = client.post('/users/@me/albums', headers=fingerprint, json={'file_ids': ids(files)})
    assert response.json()['code'] == 'ANONYMOUS_ALBUM_NOT_ALLOWED'
    monkeypatch.delenv('LIMIT_ANONYMOUS_ALBUM_FILES')
    monkeypatch.setattr(me_views, 'ANONYMOUS_ALBUM_WINDOW', -60)  # every file is "older than the window"
    response = client.post('/users/@me/albums', headers=fingerprint, json={'file_ids': ids(files)})
    assert response.json()['code'] == 'ANONYMOUS_ALBUM_NOT_ALLOWED'
    # anonymous album limits
    body = client.get('/users/@me/limits', headers=fingerprint).json()
    assert body['album_max_files'] == 50 and body['albums_max'] is None


# --- editing items ----------------------------------------------------------------------------------------------

def test_put_sets_the_exact_list_and_keeps_captions(client, media_db):
    _, owner = new_user(media_db)
    a, b, c, d = (text_file(client, owner) for _ in range(4))
    album = make_album(client, owner, [a['id'], b['id'], c['id']], cover_file_id=c['id'])
    assert album['cover_file_id'] == c['id']
    url = '/users/@me/albums/{}/files'.format(album['id'])
    response = client.request('PATCH', '{}/{}'.format(url, b['id']), headers=owner,
                              json={'caption': 'Line one\nline\x1b two'})
    assert response.json()['items'][1]['caption'] == 'Line one\nline two'
    response = client.request('PUT', url, headers=owner, json={'file_ids': [d['id'], b['id'], a['id']]})
    body = response.json()
    assert ids(body['items']) == [d['id'], b['id'], a['id']]
    assert [i['position'] for i in body['items']] == [0, 1, 2]
    assert [i['caption'] for i in body['items']] == ['', 'Line one\nline two', '']
    assert body['cover_file_id'] is None  # c left, so the cover is automatic again
    # duplicates in the request are dropped
    body = client.request('PUT', url, headers=owner, json={'file_ids': [a['id'], a['id']]}).json()
    assert ids(body['items']) == [a['id']]
    # a caption on something not in the album
    response = client.request('PATCH', '{}/{}'.format(url, c['id']), headers=owner, json={'caption': 'x'})
    assert (response.status_code, response.json()['code']) == (404, 'UNKNOWN_FILE')


def test_post_inserts_and_delete_removes(client, media_db):
    _, owner = new_user(media_db)
    a, b, c, d = (text_file(client, owner) for _ in range(4))
    album = make_album(client, owner, [a['id'], b['id']])
    url = '/users/@me/albums/{}/files'.format(album['id'])
    body = client.post(url, headers=owner, json={'file_ids': [c['id']]}).json()
    assert ids(body['items']) == [a['id'], b['id'], c['id']]
    body = client.post(url, headers=owner, json={'file_ids': [d['id'], a['id']], 'position': 1}).json()
    assert ids(body['items']) == [a['id'], d['id'], b['id'], c['id']]
    body = client.request('DELETE', '{}/{}'.format(url, d['id']), headers=owner).json()
    assert ids(body['items']) == [a['id'], b['id'], c['id']] and [i['position'] for i in body['items']] == [0, 1, 2]
    # removing something that isn't there is a no-op
    assert ids(client.request('DELETE', '{}/{}'.format(url, d['id']), headers=owner).json()['items']) == \
        [a['id'], b['id'], c['id']]


def test_cover(client, media_db):
    _, owner = new_user(media_db)
    small = image_file(client, owner, size=(100, 60))
    big = image_file(client, owner, size=(900, 600))
    album = make_album(client, owner, [small['id'], big['id']])
    # automatic: the first item with a thumbnail (none until processed)
    assert 'cover' not in album
    process(media_db, small)
    process(media_db, big)
    album = client.get('/users/@me/albums/' + album['id'], headers=owner).json()
    assert album['cover']['type'] == 'thumb'
    assert album['cover']['url'].split('?')[0] == 'https://cdn.files.gg/previews/thumb/{}.webp'.format(big['vanity'])
    # chosen: that item's best image (the small one is shown as itself)
    album = patch_album(client, owner, album['id'], cover_file_id=small['id'])
    assert album['cover'] == {'url': album['items'][0]['cdn_url'], 'type': 'image', 'width': 100, 'height': 60}
    album = patch_album(client, owner, album['id'], cover_file_id=big['id'])
    assert album['cover']['url'].split('?')[0] == 'https://cdn.files.gg/previews/thumb-2x/{}.webp'.format(
        big['vanity'])
    assert patch_album(client, owner, album['id'], cover_file_id=None)['cover_file_id'] is None
    response = client.request('PATCH', '/users/@me/albums/' + album['id'], headers=owner,
                              json={'cover_file_id': '12345'})
    assert response.json()['code'] == 'INVALID_ALBUM_FILES'
    summary = client.get('/users/@me/albums', headers=owner).json()['items'][0]
    assert summary['cover']['type'] == 'thumb'


def test_delete_album_with_and_without_files(client, media_db):
    _, owner = new_user(media_db)
    a, b = text_file(client, owner), text_file(client, owner)
    keep = make_album(client, owner, [a['id']])
    assert client.request('DELETE', '/users/@me/albums/' + keep['id'], headers=owner).status_code == 204
    assert client.get('/albums/' + keep['vanity']).status_code == 404
    assert client.get('/users/@me/albums/' + keep['id'], headers=owner).status_code == 404
    assert client.get('/files/' + a['vanity']).status_code == 200
    drop = make_album(client, owner, [b['id']])
    response = client.request('DELETE', '/users/@me/albums/{}?delete_files=true'.format(drop['id']), headers=owner)
    assert response.status_code == 204
    assert client.get('/files/' + b['vanity']).status_code == 404


def test_pagination(client, media_db):
    _, owner = new_user(media_db)
    files = [text_file(client, owner) for _ in range(102)]
    album = make_album(client, owner, ids(files))
    first = client.get('/albums/' + album['vanity']).json()
    assert len(first['items']) == 100 and first['count'] == 102 and first['next_cursor'] is not None
    second = client.get('/albums/{}?cursor={}'.format(album['vanity'], first['next_cursor'])).json()
    assert ids(second['items']) == ids(files[100:]) and second['next_cursor'] is None
    internal = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    # the ZIP needs every shown item, not just the first page
    assert len(internal['album']['items']) == 100 and len(internal['items_storage']) == 102
    assert client.get('/albums/{}?cursor=abc'.format(album['vanity'])).status_code == 400


# --- upload integration, collage and reaper -------------------------------------------------------------------

def test_upload_into_an_album(client, media_db, monkeypatch):
    from jobs.finalize import finalize
    _, owner = new_user(media_db)
    _, stranger = new_user(media_db)
    seed = text_file(client, owner)
    album = make_album(client, owner, [seed['id']])
    added = text_file(client, owner, album=album['vanity'])
    assert ids(client.get('/albums/' + album['vanity']).json()['items']) == [seed['id'], added['id']]
    before = media_db.fetchone('SELECT count(*) FROM files')[0]
    for headers, vanity in ((stranger, album['vanity']), (owner, 'nope1234')):
        response = client.post('/files', headers=headers, files={'file': ('a.txt', b'nope', 'text/plain')},
                               data={'album': vanity})
        assert (response.status_code, response.json()['code']) == (400, 'INVALID_ALBUM')
    assert media_db.fetchone('SELECT count(*) FROM files')[0] == before
    response = client.post('/files', headers=anonymous(), files={'file': ('a.txt', b'nope', 'text/plain')},
                           data={'album': album['vanity'], 'turnstile_token': TURNSTILE_TOKEN})
    assert response.json()['code'] == 'INVALID_ALBUM'

    # chunked: joins when finalized
    monkeypatch.setenv('UPLOAD_CHUNK_SIZE', str(5 * 1024 * 1024))
    response = client.post('/uploads', headers=stranger, json={'filename': 'b.txt', 'size': 10,
                                                               'album': album['vanity']})
    assert response.json()['code'] == 'INVALID_ALBUM'
    session = client.post('/uploads', headers=owner, json={'filename': 'b.txt', 'size': 10,
                                                           'album': album['vanity']}).json()
    client.request('PUT', '/uploads/{}/chunks/0'.format(session['upload_id']), headers=owner, content=b'0123456789')
    client.post('/uploads/{}/complete'.format(session['upload_id']), headers=owner)
    file_id = finalize(int(session['upload_id']))
    assert ids(client.get('/albums/' + album['vanity']).json()['items'])[-1] == str(file_id)


def test_collage(client, media_db):
    from jobs import media as media_jobs
    _, owner = new_user(media_db)
    pictures = [image_file(client, owner, size=(600, 400)) for _ in range(3)]
    plain = text_file(client, owner)
    for picture in pictures:
        process(media_db, picture)
    album = make_album(client, owner, [plain['id']] + ids(pictures))
    # queued, deduplicated, 5 s later
    queued = media_db.fetchall("SELECT queue, extract(epoch FROM run_at - created_at) FROM jobs "
                               "WHERE kind = 'album_collage' AND payload->>'album_id' = %s AND done_at IS NULL",
                               (album['id'],))
    assert len(queued) == 1 and queued[0][0] == 'media' and 4 <= float(queued[0][1]) <= 6
    key = media_jobs.album_collage(int(album['id']))
    version = media_db.fetchone('SELECT collage_version FROM albums WHERE id = %s', (int(album['id']),))[0]
    assert key == 'derived/albums/{}/collage-{}.webp'.format(album['id'], version)
    assert image_size(s3_object(key))[:2] == ((1200, 630), 'WEBP')
    public = client.get('/albums/' + album['vanity']).json()
    assert public['collage'] == {
        'url': 'https://cdn.files.gg/albums/collage/{}.webp?v={}'.format(album['vanity'], version),
        'width': 1200, 'height': 630}
    internal = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert internal['collage'] == {'key': key, 'version': version}
    # a new collage replaces the old object
    newer = media_jobs.album_collage(int(album['id']))
    assert newer != key and s3_object(key) is None
    # no visual items: no collage
    client.request('PUT', '/users/@me/albums/{}/files'.format(album['id']), headers=owner,
                   json={'file_ids': [plain['id']]})
    assert media_jobs.album_collage(int(album['id'])) is None
    assert 'collage' not in client.get('/albums/' + album['vanity']).json()


def test_album_reaper(client, media_db):
    from jobs import tasks
    _, owner = new_user(media_db)
    a = text_file(client, owner)
    empty = make_album(client, owner, [])
    full = make_album(client, owner, [a['id']])
    tasks.reap_albums(media_db.conn)
    assert media_db.fetchone('SELECT empty_since IS NOT NULL FROM albums WHERE id = %s', (int(empty['id']),))[0]
    assert media_db.fetchone('SELECT empty_since IS NULL FROM albums WHERE id = %s', (int(full['id']),))[0]
    media_db.execute("UPDATE albums SET empty_since = now() - interval '8 days' WHERE id = %s", (int(empty['id']),))
    tasks.reap_albums(media_db.conn)
    assert media_db.fetchone('SELECT deleted_at IS NOT NULL FROM albums WHERE id = %s', (int(empty['id']),))[0]
    assert media_db.fetchone('SELECT deleted_at IS NULL FROM albums WHERE id = %s', (int(full['id']),))[0]
    # an anonymous album goes with its last file
    fingerprint = anonymous()
    f = text_file(client, fingerprint, turnstile_token=TURNSTILE_TOKEN)
    anon = make_album(client, fingerprint, [f['id']])
    media_db.execute("UPDATE files SET expires_at = now() - interval '1 second' WHERE id = %s", (int(f['id']),))
    media_db.execute("UPDATE albums SET expires_at = now() - interval '1 second' WHERE id = %s", (int(anon['id']),))
    assert client.get('/albums/' + anon['vanity']).status_code == 404
    tasks.reap_expired(media_db.conn)
    tasks.reap_albums(media_db.conn)
    assert media_db.fetchone('SELECT deleted_at IS NOT NULL FROM albums WHERE id = %s', (int(anon['id']),))[0]


# --- the library ------------------------------------------------------------------------------------------

def test_library_list_filters_and_totals(client, media_db):
    _, owner = new_user(media_db)
    note = text_file(client, owner, name='Holiday-notes.txt')
    pic = send(client, owner, png(30, 30), 'beach.png', 'image/png', expires_in=7200)
    locked = text_file(client, owner, name='secret.txt', password='hunter222')
    _, stranger = new_user(media_db)
    text_file(client, stranger)

    def get(query=''):
        response = client.get('/users/@me/files' + query, headers=owner)
        assert response.status_code == 200, response.text
        return response.json()

    body = get()
    assert ids(body['items']) == [locked['id'], pic['id'], note['id']]
    total_size = note['size'] + pic['size'] + locked['size']
    assert body['count'] == 3 and body['size'] == total_size and body['total'] == {'count': 3, 'size': total_size}
    owner_item = body['items'][2]
    assert owner_item['access_version'] == 0 and owner_item['albums'] == [] and 'snippet' not in owner_item['media']
    assert ids(get('?sort_by=created')['items']) == [note['id'], pic['id'], locked['id']]
    assert ids(get('?sort_by=name')['items']) == [pic['id'], note['id'], locked['id']]
    assert ids(get('?sort_by=-size')['items'])[0] == max((note, pic, locked), key=lambda f: f['size'])['id']
    found = get('?query=HOLIDAY')
    assert ids(found['items']) == [note['id']] and found['count'] == 1 and found['size'] == note['size']
    assert found['total'] == {'count': 3, 'size': total_size}
    assert ids(get('?query=beach.png')['items']) == [pic['id']]
    assert ids(get('?type=image')['items']) == [pic['id']]
    assert ids(get('?type=text')['items']) == [locked['id'], note['id']]
    assert get('?type=video')['count'] == 0
    assert ids(get('?visibility=password')['items']) == [locked['id']]
    assert ids(get('?temporary=true')['items']) == [pic['id']]
    page = get('?limit=1&offset=1')
    assert ids(page['items']) == [pic['id']] and page['count'] == 3
    for bad in ('?limit=0', '?limit=101', '?sort_by=random', '?type=archive', '?offset=-1'):
        assert client.get('/users/@me/files' + bad, headers=owner).status_code == 400
    assert client.get('/users/@me/files').status_code == 401
    # anonymous callers get their own anonymous files
    fingerprint = anonymous()
    mine = text_file(client, fingerprint, turnstile_token=TURNSTILE_TOKEN)
    assert ids(client.get('/users/@me/files', headers=fingerprint).json()['items']) == [mine['id']]


def test_rename_and_owner_file_shape(client, media_db):
    _, owner = new_user(media_db)
    created = text_file(client, owner, name='draft.txt')
    album = make_album(client, owner, [created['id']], title='Docs')
    url = '/users/@me/files/' + created['id']
    body = client.request('PATCH', url, headers=owner, json={'filename': 'final/report'}).json()
    assert body['name'] == 'final_report' and body['filename'] == 'final_report.txt' and body['extension'] == 'txt'
    assert body['albums'] == [{'id': album['id'], 'vanity': album['vanity'], 'title': 'Docs'}]
    assert body['kind'] == 'text' and 'processing' in body and body['nsfw'] is False
    body = client.request('PATCH', url, headers=owner, json={'filename': 'notes.txt'}).json()
    assert body['filename'] == 'notes.txt'  # the extension stays, and isn't doubled
    response = client.request('PATCH', url, headers=owner, json={'filename': '   '})
    assert response.status_code == 400 and 'filename' in response.json()['errors']
    response = client.request('PATCH', url, headers=owner, json={'filename': 'x' * 129})
    assert response.status_code == 400
    # anonymous owners can manage their own files too
    fingerprint = anonymous()
    anon = text_file(client, fingerprint, turnstile_token=TURNSTILE_TOKEN)
    body = client.request('PATCH', '/users/@me/files/' + anon['id'], headers=fingerprint,
                          json={'filename': 'mine'}).json()
    assert body['filename'] == 'mine.txt'
    response = client.request('PATCH', '/users/@me/files/' + anon['id'], headers=fingerprint,
                              json={'visibility': 'private'})
    assert response.json()['code'] == 'PRIVATE_REQUIRES_ACCOUNT'
    response = client.request('PATCH', '/users/@me/files/' + anon['id'], headers=anonymous(), json={'filename': 'x'})
    assert response.status_code == 404


def test_owner_payloads_carry_signed_urls(client, media_db):
    """The dashboard shows your own password and private files directly: every URL in an
    owner payload is signed for 1 h with the file grant (albums: the album grant). No
    `access_token` field and no /pass call per file."""
    _, owner = new_user(media_db)
    public = image_file(client, owner, size=(400, 300))
    locked = send(client, owner, png(400, 300), 'locked.png', 'image/png', password='owner-pass-1')
    hidden = send(client, owner, png(400, 300), 'hidden.png', 'image/png', visibility='private')
    for created in (public, locked, hidden):
        process(media_db, created)
    items = {i['id']: i for i in client.get('/users/@me/files', headers=owner).json()['items']}
    assert all('access_token' not in item for item in items.values())
    for url in payload_urls(items[public['id']]):
        assert_unsigned(url)
    for created in (locked, hidden):
        item = items[created['id']]
        urls = payload_urls(item)
        assert {'thumb', 'thumb-2x'} <= set(item['assets']) and len(urls) == 4  # cdn_url, 2 assets, thumbnail
        for url in urls:
            expires = assert_signed(url, 'file:{}:{}'.format(item['id'], item['access_version']))
            assert 3590 < expires - time.time() <= 3600
        assert item['assets']['thumb']['url'].startswith(
            'https://cdn.files.gg/previews/thumb/{}.webp?v='.format(created['vanity']))
    # changing access bumps access_version, and the next owner payload is signed for it
    body = client.request('PATCH', '/users/@me/files/' + locked['id'], headers=owner,
                          json={'password': 'owner-pass-2'}).json()
    assert body['access_version'] == 1 and 'access_token' not in body
    assert_signed(body['cdn_url'], 'file:{}:1'.format(locked['id']))
    # bulk endpoints return owner files too
    body = client.post('/users/@me/files/expiry', headers=owner,
                       json={'file_ids': [hidden['id']], 'expires_in': 7200}).json()
    assert_signed(body['items'][0]['cdn_url'], 'file:{}:0'.format(hidden['id']))

    # the first item is protected, so the automatic cover is a signed one
    album = make_album(client, owner, [locked['id'], hidden['id'], public['id']], title='Mixed')
    assert 'access_token' not in album  # a link album's own URLs are plain
    assert_unsigned(album['download_url'])
    album = patch_album(client, owner, album['id'], visibility='password', password='album-pass-9')
    grant = 'album:{}:{}'.format(album['id'], album['access_version'])
    assert 'access_token' not in album
    # the album's own URLs use the album grant (the cover is an item's, so it carries album=)
    assert 3590 < assert_signed(album['download_url'], grant) - time.time() <= 3600
    assert_signed(album['cover']['url'], grant, album=album['vanity'])
    # each item is an owner file, signed with its own file grant (link items stay plain)
    items = {i['id']: i for i in album['items']}
    assert_unsigned(items[public['id']]['cdn_url'])
    assert_signed(items[locked['id']]['cdn_url'], 'file:{}:1'.format(locked['id']))
    assert_signed(items[hidden['id']]['cdn_url'], 'file:{}:0'.format(hidden['id']))
    # the collage and the summary
    from jobs import media as media_jobs
    media_jobs.album_collage(int(album['id']))
    album = client.get('/users/@me/albums/' + album['id'], headers=owner).json()
    assert album['collage']['url'].startswith('https://cdn.files.gg/albums/collage/{}.webp?v='.format(album['vanity']))
    assert_signed(album['collage']['url'], grant)
    summary = next(a for a in client.get('/users/@me/albums', headers=owner).json()['items'] if a['id'] == album['id'])
    assert 'access_token' not in summary
    assert_signed(summary['collage']['url'], grant)
    assert_signed(summary['cover']['url'], grant, album=album['vanity'])
    # strangers never see owner payloads
    _, stranger = new_user(media_db)
    assert client.get('/users/@me/albums/' + album['id'], headers=stranger).status_code == 404


def test_protected_album_signs_previews_collage_and_download(client, media_db):
    """Every URL in a protected album's payload is signed with the album grant; item URLs
    (and the cover, which is an item's) carry album=<vanity>; ?v= stays outside the signature."""
    from jobs import media as media_jobs
    _, owner = new_user(media_db)
    pictures = [send(client, owner, png(600, 400), 'p{}.png'.format(i), 'image/png', visibility='private')
                for i in range(2)]
    for picture in pictures:
        process(media_db, picture)
    album = make_album(client, owner, ids(pictures), title='Trip')
    patch_album(client, owner, album['id'], password='trip-pass-1')
    media_jobs.album_collage(int(album['id']))
    body = unlock_album(client, album['vanity'], 'trip-pass-1').json()
    grant = 'album:{}:1'.format(album['id'])
    payload = body['album']
    assert_album_signed(payload, grant, body['expires_at'])
    assert_signed(payload['collage']['url'], grant, expires=body['expires_at'])
    assert url_query(payload['collage']['url'])['v']
    item = payload['items'][0]
    assert item['thumbnail']['url'].startswith('https://cdn.files.gg/previews/thumb/{}.webp?v='.format(
        pictures[0]['vanity']))
    assert len(payload_urls(item)) == 4
    # the signature covers the path only: the same URL with ?download=true is still valid, and
    # it can't be edited into another file's URL
    url = item['cdn_url']
    other_path = '/files/{}.png'.format(pictures[1]['vanity'])
    query = url_query(url)
    assert query['sig'] != cdn_signing.signature(other_path, int(query['expires']), grant, CDN_SIGNING_SECRET)
    # the internal lookups stay unsigned
    internal = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert_unsigned(internal['album']['download_url'])
    assert_unsigned(internal['album']['collage']['url'])
    for internal_item in internal['album']['items']:
        for url in payload_urls(internal_item):
            assert_unsigned(url)


def test_delete_and_bulk_delete(client, media_db):
    _, owner = new_user(media_db)
    _, stranger = new_user(media_db)
    a, b, c = (text_file(client, owner) for _ in range(3))
    theirs = text_file(client, stranger)
    assert client.request('DELETE', '/users/@me/files/' + a['id'], headers=stranger).status_code == 404
    assert client.request('DELETE', '/users/@me/files/' + a['id'], headers=owner).status_code == 204
    assert client.request('DELETE', '/users/@me/files/' + a['id'], headers=owner).status_code == 404
    response = client.post('/users/@me/files/delete', headers=owner,
                           json={'file_ids': [c['id'], theirs['id'], a['id'], b['id']]})
    assert response.status_code == 200 and response.json() == {'deleted': [c['id'], b['id']]}
    assert client.get('/files/' + theirs['vanity']).status_code == 200
    response = client.post('/users/@me/files/delete', headers=owner, json={'file_ids': [str(i) for i in range(101)]})
    assert response.status_code == 400
    assert client.get('/users/@me/files', headers=owner).json()['count'] == 0


def test_bulk_expiry(client, media_db):
    _, owner = new_user(media_db)
    a, b = text_file(client, owner), text_file(client, owner)
    response = client.post('/users/@me/files/expiry', headers=owner,
                           json={'file_ids': [a['id'], b['id']], 'expires_in': 7200})
    items = response.json()['items']
    assert ids(items) == [a['id'], b['id']] and all(abs(i['expires_at'] - time.time() - 7200) < 10 for i in items)
    items = client.post('/users/@me/files/expiry', headers=owner,
                        json={'file_ids': [a['id']], 'expires_in': None}).json()['items']
    assert items[0]['expires_at'] is None  # keep forever
    response = client.post('/users/@me/files/expiry', headers=owner, json={'file_ids': [a['id']], 'expires_in': 60})
    assert response.json()['code'] == 'EXPIRY_NOT_ALLOWED'
    response = client.post('/users/@me/files/expiry', headers=owner, json={'file_ids': [a['id']]})
    assert response.status_code == 400  # expires_in is required (null means forever)
    fingerprint = anonymous()
    anon = text_file(client, fingerprint, turnstile_token=TURNSTILE_TOKEN)
    response = client.post('/users/@me/files/expiry', headers=fingerprint,
                           json={'file_ids': [anon['id']], 'expires_in': None})
    assert response.json()['code'] == 'EXPIRY_NOT_ALLOWED'
    album = make_album(client, fingerprint, [anon['id']])
    client.post('/users/@me/files/expiry', headers=fingerprint, json={'file_ids': [anon['id']], 'expires_in': 7200})
    # an anonymous album follows its files' expiry
    assert abs(client.get('/albums/' + album['vanity']).json()['expires_at'] - time.time() - 7200) < 10


def test_bulk_access_shares_one_generated_password(client, media_db):
    _, owner = new_user(media_db)
    a, b = text_file(client, owner), text_file(client, owner)
    body = client.post('/users/@me/files/access', headers=owner,
                       json={'file_ids': [a['id'], b['id']], 'visibility': 'password', 'generate_password': True,
                             'unlock_ttl': 86400}).json()
    password = body['password']
    assert len(password.split('-')) == 4
    assert all(i['visibility'] == 'password' and i['access_version'] == 1 and i['unlock_ttl'] == 86400
               for i in body['items'])
    for item in (a, b):
        response = client.post('/files/{}/unlock'.format(item['vanity']),
                               json={'password': password, 'turnstile_token': UNLOCK_TOKEN},
                               headers={'X-Forwarded-For': '10.7.{}.1'.format(uuid.uuid4().int % 250)})
        assert response.status_code == 200
    body = client.post('/users/@me/files/access', headers=owner,
                       json={'file_ids': [a['id']], 'visibility': 'link'}).json()
    assert body['items'][0]['visibility'] == 'link' and 'password' not in body
    response = client.post('/users/@me/files/access', headers=owner,
                           json={'file_ids': [a['id']], 'visibility': 'password'})
    assert response.status_code == 400  # a password is required


# --- signed URLs and the internal lookups (contract §3 and §5) ----------------------------------------

SIGNING_VECTORS = [
    ('/files/abc123.png', 1795603600, 'file:1234567890123456789:0', '2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8'),
    ('/previews/thumb/abc123.webp', 1795603600, 'file:1234567890123456789:0',
     'fMPOSZt5evpHirGRjA7CFTi-t1VKo-Sz_TRY51c0lx0'),
    ('/files/abcd/xyz.png', 1795603600, 'file:1234567890123456790:2', 'oBzsm8vQj1Gu63_mqxqJxnryvfOrRIn_lFlRFzE7TJA'),
    ('/files/abc123.png', 1795603600, 'album:987654321098765432:3', 'qNXFGzboIRTzeqp-2oNTz9TAXrX9iepHVjSh_W_tR68'),
    ('/albums/download/Ab3dE6gH.zip', 1796204800, 'album:987654321098765432:3',
     'wGA5TVhWGADqYzNbG7Og11zjDW3n4A9cw5dKtfI4FFA'),
]


@pytest.mark.parametrize('path, expires, grant, sig', SIGNING_VECTORS)
def test_signing_vectors(path, expires, grant, sig):
    assert cdn_signing.signature(path, expires, grant, CDN_SIGNING_SECRET) == sig


def test_signing_vector_for_a_stale_version_is_rejected():
    """Signed for version 1; the file is at version 0, so the grant the Worker computes differs."""
    stale = 'Fx-ceAVJ1NUckKl8KkrfXvv9EjlAht92rlHCfcN4RUs'
    assert cdn_signing.signature('/files/abc123.png', 1795603600, 'file:1234567890123456789:1',
                                 CDN_SIGNING_SECRET) == stale
    assert cdn_signing.signature('/files/abc123.png', 1795603600, 'file:1234567890123456789:0',
                                 CDN_SIGNING_SECRET) != stale
    # another secret, path or expiry gives another signature
    assert cdn_signing.signature('/files/abc123.png', 1795603600, 'file:1234567890123456789:1', 'x') != stale
    assert cdn_signing.signature('/files/abc124.png', 1795603600, 'file:1234567890123456789:1',
                                 CDN_SIGNING_SECRET) != stale
    assert cdn_signing.signature('/files/abc123.png', 1795603601, 'file:1234567890123456789:1',
                                 CDN_SIGNING_SECRET) != stale


def test_signed_url_shape():
    from types import SimpleNamespace
    fobj = SimpleNamespace(id=1234567890123456789, access_version=0)
    grant = cdn_signing.Grant('file:1234567890123456789:0', 1795603600)
    assert cdn_signing.Grant.for_file(fobj, int(time.time()) + 60).grant == grant.grant
    # Grant() itself doesn't cap; for_file / for_album do (31 days)
    assert grant.sign('https://cdn.files.gg/files/abc123.png') == (
        'https://cdn.files.gg/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8')
    assert grant.sign('https://cdn.files.gg/previews/thumb/abc123.webp?v=5') == (
        'https://cdn.files.gg/previews/thumb/abc123.webp?v=5&expires=1795603600'
        '&sig=fMPOSZt5evpHirGRjA7CFTi-t1VKo-Sz_TRY51c0lx0')
    album_grant = cdn_signing.Grant('album:987654321098765432:3', 1795603600, 'Ab3dE6gH')
    assert album_grant.sign('https://cdn.files.gg/files/abc123.png', item=True) == (
        'https://cdn.files.gg/files/abc123.png?album=Ab3dE6gH&expires=1795603600'
        '&sig=qNXFGzboIRTzeqp-2oNTz9TAXrX9iepHVjSh_W_tR68')
    # the album's own URLs (collage, ZIP) carry no album=
    assert 'album=' not in album_grant.sign('https://cdn.files.gg/albums/download/Ab3dE6gH.zip')
    # vanities are signed as they appear in the URL: percent-encoded, '/' kept (new URL().pathname)
    assert cdn_signing.path_segment('abcd/xyz') == 'abcd/xyz'
    assert cdn_signing.path_segment('a b/\u00fc?#') == 'a%20b/%C3%BC%3F%23'
    far = cdn_signing.Grant.for_file(fobj, int(time.time()) + 365 * 86400)
    assert far.expires <= int(time.time()) + 31 * 86400


def test_internal_lookups(client, media_db):
    _, owner = new_user(media_db)
    created = text_file(client, owner)
    body = client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()
    assert body['file']['id'] == created['id']
    assert set(body) == {'file', 'access', 'owner_user_id', 'albums', 'storage', 'previews', 'previews_version',
                         'safety', 'serve_inline'}
    assert body['storage'] == {'key': 'files/' + hash_of(media_db, created), 'size': created['size']}
    # no lookups by id: every CDN path names a vanity
    for path in ('/internal/file-ids/' + created['id'], '/internal/album-ids/1'):
        assert client.get(path, headers=ORIGIN).status_code == 404

    album = make_album(client, owner, [created['id']])
    body = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert body['album']['id'] == album['id']
    assert set(body) == {'album', 'access', 'items_access', 'items_storage', 'collage', 'safety', 'pending_count'}
    assert body['items_access'] == {created['id']: {'visibility': 'link', 'access_version': 0,
                                                    'safety': {'state': 'ok', 'reason': None},
                                                    'expires_at': created['expires_at']}}
    assert body['items_storage'] == {created['id']: {
        'key': 'files/' + hash_of(media_db, created), 'size': created['size'], 'filename': created['filename']}}
    assert body['access'] == {'visibility': 'link', 'access_version': 0, 'unlock_ttl': 3600,
                              'password_expires_at': None, 'show_name_when_locked': False}
    assert body['collage'] is None
    assert client.get('/internal/albums/' + album['vanity']).json()['code'] == 'UNKNOWN_ALBUM'
    # the secret alone (any request the Worker forwards) is not a lookup
    assert client.get('/internal/albums/' + album['vanity'],
                      headers={'X-Filesgg-Origin-Secret': 'test-origin-secret'}).json()['code'] == 'UNKNOWN_ALBUM'
    # deleted targets are unknown
    client.request('DELETE', '/users/@me/files/' + created['id'], headers=owner)
    assert client.get('/internal/files/' + created['vanity'], headers=ORIGIN).status_code == 404
    assert client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()['code'] == 'UNKNOWN_ALBUM'


def assert_album_signed(album, grant, expires):
    """Every URL in a protected album payload: items (album=<vanity>), cover, collage, download."""
    vanity = album['vanity']
    assert_signed(album['download_url'], grant, expires=expires)
    if album.get('collage'):
        assert_signed(album['collage']['url'], grant, expires=expires)
    if album.get('cover'):
        assert_signed(album['cover']['url'], grant, album=vanity, expires=expires)
    for item in album['items']:
        for url in payload_urls(item):
            if item['visibility'] == 'link':
                assert_unsigned(url)  # public URLs are never signed
            else:
                assert_signed(url, grant, album=vanity, expires=expires)
