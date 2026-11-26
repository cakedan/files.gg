"""Regional rules (docs/redesign/contracts/milestone-7.md §11.1, §11.3): the country the Worker forwards is believed
only with the origin secret and only as two letters; adult content isn't uploaded or marked from a blocked country
(ADULT_BLOCKED_COUNTRIES, GB by default), defaults and upload keys included, while unmarking still works; `/auth/config`
gives the minimum age (16 in the EU and EEA and for an unknown country, else 13) and whether adult content is
available, and `/users/@me/limits` says when the region is why adult content isn't allowed."""

import uuid

import pytest

from tests.conftest import make_user, sign_in
from tests.m4 import appdb, png, send  # noqa: F401
from tests.test_upload_keys import create_key, key_header

ORIGIN_SECRET = 'test-origin-secret'  # conftest sets ORIGIN_SHARED_SECRET to this
COUNTRY_HEADER = 'X-Filesgg-Client-Country'
UNAVAILABLE = 'ADULT_CONTENT_UNAVAILABLE'


def worker(country=None, headers=None):
    """A request the Worker forwarded (with the origin secret), from `country` (or with no country header)."""
    headers = dict(headers or {}, **{'X-Filesgg-Origin-Secret': ORIGIN_SECRET})
    if country is not None:
        headers[COUNTRY_HEADER] = country
    return headers


def signed_in(appdb, country=None):
    """A signed-in website request from `country` (sign_in's headers carry the origin secret already)."""
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    if country is not None:
        headers[COUNTRY_HEADER] = country
    return user_id, headers


def from_country(headers, country):
    headers = {k: v for k, v in headers.items() if k != COUNTRY_HEADER}
    if country is not None:
        headers[COUNTRY_HEADER] = country
    return headers


def config(client, headers=None):
    response = client.get('/auth/config', headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def assert_unavailable(response):
    assert response.status_code == 451, response.text
    body = response.json()
    assert body == {'code': UNAVAILABLE, 'message': "Adult content isn't available in your region", 'status': 451}


def file_nsfw(appdb, file_id):
    return appdb.fetchone('SELECT nsfw_marked FROM files WHERE id = %s', (int(file_id),))[0]


# --- the country and the setting (§11.1) ------------------------------------------------------------------------

def test_the_setting_parsing(monkeypatch):
    from utils import regions
    monkeypatch.delenv('ADULT_BLOCKED_COUNTRIES', raising=False)
    assert regions.blocked_countries() == {'GB'}
    for value, expected in [('', {'GB'}), (' , ,', {'GB'}), ('US', {'US'}), ('us', {'US'}),
                            (' GB, us ,fr ', {'GB', 'US', 'FR'}), ('GB,,DE', {'GB', 'DE'}),
                            # malformed entries are dropped, and with none valid it's GB (the Worker's rule too)
                            ('GBR', {'GB'}), ('GBR,US', {'US'}), ('UK', {'UK'}), ('G B', {'GB'})]:
        monkeypatch.setenv('ADULT_BLOCKED_COUNTRIES', value)
        assert regions.blocked_countries() == expected, value
    monkeypatch.setenv('ADULT_BLOCKED_COUNTRIES', 'GB,US')
    assert regions.adult_blocked('GB') and regions.adult_blocked('US')
    assert not regions.adult_blocked('DE')
    # an unknown country is never blocked
    assert not regions.adult_blocked(None)


def test_minimum_age_and_the_eea_list():
    from utils import regions
    eea = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split()
    assert regions.EEA == set(eea)
    for country in eea + [None]:
        assert regions.minimum_age(country) == 16, country
    for country in ('US', 'GB', 'CH', 'CA', 'JP', 'BR'):
        assert regions.minimum_age(country) == 13, country


@pytest.mark.parametrize('value, expected', [
    ('GB', 'GB'), ('DE', 'DE'), ('gb', None), (' GB', None), ('GBR', None), ('G', None), ('', None), ('T1', None),
    ('XX', None), ('G1', None), ('ÄB', None),
])
def test_the_header_is_validated(value, expected):
    from utils import regions
    assert regions.from_headers({'x-filesgg-client-country': value}, True) == expected
    # never from anyone but the Worker
    assert regions.from_headers({'x-filesgg-client-country': value}, False) is None
    assert regions.from_headers({}, True) is None


def test_the_header_is_believed_only_with_the_origin_secret(client, monkeypatch):
    monkeypatch.delenv('ADULT_BLOCKED_COUNTRIES', raising=False)
    # through the Worker: believed
    assert config(client, worker('US'))['minimum_age'] == 13
    assert config(client, worker('GB'))['adult_content_available'] is False
    # a client's own copy, without the secret or with a wrong one: unknown (16, adult content available)
    for headers in ({COUNTRY_HEADER: 'US'}, {COUNTRY_HEADER: 'GB'},
                    {'X-Filesgg-Origin-Secret': 'wrong', COUNTRY_HEADER: 'US'},
                    {'X-Filesgg-Origin-Secret': '', COUNTRY_HEADER: 'US'},
                    {'X-Filesgg-Origin-Secret': ORIGIN_SECRET + 'x', COUNTRY_HEADER: 'GB'},
                    {'CF-IPCountry': 'US'}):
        body = config(client, headers)
        assert (body['minimum_age'], body['adult_content_available']) == (16, True), headers
    # with the secret but not two letters A-Z: unknown
    for value in ('us', 'USA', 'T1', 'XX', '1', ''):
        assert config(client, worker(value))['minimum_age'] == 16, value


def test_the_header_needs_a_configured_secret(client, monkeypatch):
    monkeypatch.setattr(client.app.ctx, 'origin_secret', None)
    body = config(client, worker('US'))
    assert (body['minimum_age'], body['adult_content_available']) == (16, True)


# --- GET /auth/config ----------------------------------------------------------------------------------------------

@pytest.mark.parametrize('country, age, available', [
    ('DE', 16, True), ('NO', 16, True), (None, 16, True), ('US', 13, True), ('GB', 13, False),
])
def test_auth_config(client, monkeypatch, country, age, available):
    monkeypatch.delenv('ADULT_BLOCKED_COUNTRIES', raising=False)
    body = config(client, worker(country))
    assert body == {'discord': body['discord'], 'minimum_age': age, 'adult_content_available': available}
    assert isinstance(body['discord'], bool)


def test_auth_config_follows_the_setting(client, monkeypatch):
    monkeypatch.setenv('ADULT_BLOCKED_COUNTRIES', 'us, de')
    assert config(client, worker('US'))['adult_content_available'] is False
    assert config(client, worker('DE'))['adult_content_available'] is False
    assert config(client, worker('GB'))['adult_content_available'] is True
    assert config(client, worker())['adult_content_available'] is True


# --- refusals (§11.3) ----------------------------------------------------------------------------------------------

ALLOWED = ['US', None]


@pytest.fixture(autouse=True)
def default_setting(monkeypatch):
    monkeypatch.delenv('ADULT_BLOCKED_COUNTRIES', raising=False)


def test_single_uploads(client, appdb):
    _, headers = signed_in(appdb, 'GB')
    before = appdb.fetchone('SELECT count(*) FROM files')[0]
    # multipart
    response = client.post('/files', headers=headers, files={'file': ('a.png', png(), 'image/png')},
                           data={'nsfw': 'true'})
    assert_unavailable(response)
    # raw: refused before the body is read
    response = client.post('/files?type=raw&filename=a.txt&nsfw=true',
                           headers=dict(headers, **{'Content-Type': 'text/plain'}), content=uuid.uuid4().bytes)
    assert_unavailable(response)
    assert appdb.fetchone('SELECT count(*) FROM files')[0] == before
    # not adult: uploaded as before
    created = send(client, headers, png(), 'b.png', 'image/png', nsfw=False)
    assert file_nsfw(appdb, created['id']) is False
    created = send(client, headers, png(), 'c.png', 'image/png')
    assert file_nsfw(appdb, created['id']) is False
    for country in ALLOWED:
        created = send(client, from_country(headers, country), png(), 'd.png', 'image/png', nsfw=True)
        assert file_nsfw(appdb, created['id']) is True


def test_raw_uploads_are_refused_before_the_body_is_read(client, appdb, monkeypatch):
    from utils import uploading
    _, headers = signed_in(appdb, 'GB')

    async def never(*args, **kwargs):
        raise AssertionError('the body was read')

    monkeypatch.setattr(uploading, 'spool_body', never)
    response = client.post('/files?type=raw&filename=a.txt&nsfw=true',
                           headers=dict(headers, **{'Content-Type': 'text/plain'}), content=b'x' * 4096)
    assert_unavailable(response)


def test_chunked_uploads(client, appdb):
    _, headers = signed_in(appdb, 'GB')
    before = appdb.fetchone('SELECT count(*) FROM upload_sessions')[0]
    response = client.post('/uploads', headers=headers, json={'filename': 'a.bin', 'size': 10, 'nsfw': True})
    assert_unavailable(response)
    assert appdb.fetchone('SELECT count(*) FROM upload_sessions')[0] == before
    response = client.post('/uploads', headers=headers, json={'filename': 'a.bin', 'size': 10, 'nsfw': False})
    assert response.status_code == 201, response.text
    for country in ALLOWED:
        response = client.post('/uploads', headers=from_country(headers, country),
                               json={'filename': 'a.bin', 'size': 10, 'nsfw': True})
        assert response.status_code == 201, response.text
        assert appdb.fetchone('SELECT nsfw_marked FROM upload_sessions WHERE id = %s',
                              (int(response.json()['upload_id']),))[0] is True


def test_refusals_are_counted_by_code(client, appdb, monkeypatch):
    from utils import metrics
    _, headers = signed_in(appdb, 'GB')
    seen = []
    original = metrics.incr

    def incr(name, labels=None, value=1):
        seen.append((name, labels))
        return original(name, labels, value)

    monkeypatch.setattr(metrics, 'incr', incr)
    assert_unavailable(client.post('/uploads', headers=headers, json={'filename': 'a.bin', 'size': 10, 'nsfw': True}))
    assert ('filesgg_upload_refusals_total', {'kind': 'chunked', 'code': UNAVAILABLE}) in seen


def test_marking_a_file(client, appdb):
    _, headers = signed_in(appdb, 'US')
    created = send(client, headers, png(), 'a.png', 'image/png')
    gb = from_country(headers, 'GB')
    assert_unavailable(client.patch('/users/@me/files/' + created['id'], headers=gb, json={'nsfw': True}))
    assert_unavailable(client.post('/users/@me/files/nsfw', headers=gb,
                                   json={'file_ids': [created['id']], 'nsfw': True}))
    assert file_nsfw(appdb, created['id']) is False
    # other changes from GB are fine
    response = client.patch('/users/@me/files/' + created['id'], headers=gb, json={'filename': 'renamed'})
    assert response.status_code == 200, response.text
    for country in ALLOWED:
        here = from_country(headers, country)
        response = client.patch('/users/@me/files/' + created['id'], headers=here, json={'nsfw': True})
        assert response.status_code == 200, response.text
        assert file_nsfw(appdb, created['id']) is True
        response = client.patch('/users/@me/files/' + created['id'], headers=here, json={'nsfw': False})
        assert response.status_code == 200, response.text
        response = client.post('/users/@me/files/nsfw', headers=here, json={'file_ids': [created['id']], 'nsfw': True})
        assert response.status_code == 200, response.text
        assert response.json()['skipped'] == [] and file_nsfw(appdb, created['id']) is True
        client.patch('/users/@me/files/' + created['id'], headers=here, json={'nsfw': False})


def test_unmarking_from_a_blocked_country(client, appdb):
    _, headers = signed_in(appdb, 'US')
    first = send(client, headers, png(), 'a.png', 'image/png', nsfw=True)
    second = send(client, headers, png(), 'b.png', 'image/png', nsfw=True)
    album = client.post('/users/@me/albums', headers=headers, json={'file_ids': [first['id']]}).json()
    assert client.patch('/users/@me/albums/' + album['id'], headers=headers, json={'nsfw': True}).status_code == 200
    gb = from_country(headers, 'GB')
    response = client.patch('/users/@me/files/' + first['id'], headers=gb, json={'nsfw': False})
    assert response.status_code == 200, response.text
    assert file_nsfw(appdb, first['id']) is False
    response = client.post('/users/@me/files/nsfw', headers=gb, json={'file_ids': [second['id']], 'nsfw': False})
    assert response.status_code == 200, response.text
    assert file_nsfw(appdb, second['id']) is False
    response = client.patch('/users/@me/albums/' + album['id'], headers=gb, json={'nsfw': False})
    assert response.status_code == 200, response.text
    assert response.json()['nsfw_marked'] is False
    response = client.patch('/users/@me', headers=gb, json={'settings': {'upload_defaults': {'nsfw': False}}})
    assert response.status_code == 200, response.text


def test_marking_an_album(client, appdb):
    _, headers = signed_in(appdb, 'US')
    created = send(client, headers, png(), 'a.png', 'image/png')
    album = client.post('/users/@me/albums', headers=headers, json={'file_ids': [created['id']]}).json()
    gb = from_country(headers, 'GB')
    assert_unavailable(client.patch('/users/@me/albums/' + album['id'], headers=gb, json={'nsfw': True}))
    assert appdb.fetchone('SELECT nsfw FROM albums WHERE id = %s', (int(album['id']),))[0] is False
    response = client.patch('/users/@me/albums/' + album['id'], headers=gb, json={'title': 'Fine'})
    assert response.status_code == 200, response.text
    for country in ALLOWED:
        here = from_country(headers, country)
        response = client.patch('/users/@me/albums/' + album['id'], headers=here, json={'nsfw': True})
        assert response.status_code == 200, response.text
        assert response.json()['nsfw_marked'] is True
        client.patch('/users/@me/albums/' + album['id'], headers=here, json={'nsfw': False})


def stored_defaults(appdb, user_id):
    return appdb.fetchone('SELECT upload_defaults FROM users WHERE id = %s', (user_id,))[0]


def test_saving_adult_upload_defaults(client, appdb):
    user_id, headers = signed_in(appdb, 'GB')
    response = client.patch('/users/@me', headers=headers,
                            json={'display_name': 'Changed', 'settings': {'upload_defaults': {'nsfw': True}}})
    assert_unavailable(response)
    # nothing in the request was saved
    assert not stored_defaults(appdb, user_id)
    assert appdb.fetchone('SELECT display_name FROM users WHERE id = %s', (user_id,))[0] is None
    response = client.patch('/users/@me', headers=headers,
                            json={'settings': {'upload_defaults': {'visibility': 'private', 'nsfw': False}}})
    assert response.status_code == 200, response.text
    for country in ALLOWED:
        response = client.patch('/users/@me', headers=from_country(headers, country),
                                json={'settings': {'upload_defaults': {'nsfw': True}}})
        assert response.status_code == 200, response.text
        assert stored_defaults(appdb, user_id)['nsfw'] is True


def test_creating_an_upload_key_with_an_adult_default(client, appdb):
    user_id, headers = signed_in(appdb, 'GB')
    assert_unavailable(client.post('/users/@me/upload-keys', headers=headers, json={'sharex': {'nsfw': True}}))
    assert appdb.fetchone('SELECT count(*) FROM upload_keys WHERE user_id = %s', (user_id,))[0] == 0
    created = create_key(client, headers, sharex={'nsfw': False, 'visibility': 'private'})
    assert 'nsfw' not in created['sharex']['Arguments']
    # changing a key (name, domain) has no adult default to refuse
    response = client.patch('/users/@me/upload-keys/' + created['key']['id'], headers=headers, json={'name': 'Renamed'})
    assert response.status_code == 200, response.text
    for country in ALLOWED:
        created = create_key(client, from_country(headers, country), sharex={'nsfw': True})
        assert created['sharex']['Arguments']['nsfw'] == 'true'


def key_request(secret, country):
    """A tool's upload through the Worker (api.files.gg), from `country`."""
    return worker(country, key_header(secret))


def test_key_uploads_with_adult_defaults(client, appdb):
    user_id, headers = signed_in(appdb, 'US')
    response = client.patch('/users/@me', headers=headers, json={'settings': {'upload_defaults': {'nsfw': True}}})
    assert response.status_code == 200, response.text
    secret = create_key(client, headers)['secret']
    before_files = appdb.fetchone('SELECT count(*) FROM files WHERE user_id = %s', (user_id,))[0]
    before_sessions = appdb.fetchone('SELECT count(*) FROM upload_sessions WHERE owner_user_id = %s', (user_id,))[0]
    # from GB: refused, never uploaded unmarked
    response = client.post('/files', headers=key_request(secret, 'GB'), files={'file': ('a.png', png(), 'image/png')})
    assert_unavailable(response)
    response = client.post('/uploads', headers=key_request(secret, 'GB'), json={'filename': 'a.bin', 'size': 10})
    assert_unavailable(response)
    assert appdb.fetchone('SELECT count(*) FROM files WHERE user_id = %s', (user_id,))[0] == before_files
    assert appdb.fetchone('SELECT count(*) FROM upload_sessions WHERE owner_user_id = %s',
                          (user_id,))[0] == before_sessions
    # the tool saying nsfw=false wins over the default, so it's uploaded
    response = client.post('/files', headers=key_request(secret, 'GB'), files={'file': ('a.png', png(), 'image/png')},
                           data={'nsfw': 'false'})
    assert response.status_code == 200, response.text
    assert file_nsfw(appdb, response.json()['id']) is False
    # elsewhere, the default marks it
    for country in ALLOWED:
        response = client.post('/files', headers=key_request(secret, country),
                               files={'file': ('a.png', png(), 'image/png')})
        assert response.status_code == 200, response.text
        assert file_nsfw(appdb, response.json()['id']) is True
        response = client.post('/uploads', headers=key_request(secret, country), json={'filename': 'a.bin', 'size': 10})
        assert response.status_code == 201, response.text
        assert appdb.fetchone('SELECT nsfw_marked FROM upload_sessions WHERE id = %s',
                              (int(response.json()['upload_id']),))[0] is True


def test_the_setting_moves_the_block(client, appdb, monkeypatch):
    monkeypatch.setenv('ADULT_BLOCKED_COUNTRIES', 'US')
    _, headers = signed_in(appdb, 'US')
    response = client.post('/files', headers=headers, files={'file': ('a.png', png(), 'image/png')},
                           data={'nsfw': 'true'})
    assert_unavailable(response)
    created = send(client, from_country(headers, 'GB'), png(), 'a.png', 'image/png', nsfw=True)
    assert file_nsfw(appdb, created['id']) is True


# --- GET /users/@me/limits -----------------------------------------------------------------------------------------

@pytest.mark.parametrize('country, allowed, blocked', [('GB', False, True), ('US', True, False), (None, True, False)])
def test_limits(client, appdb, country, allowed, blocked):
    _, headers = signed_in(appdb, country)
    body = client.get('/users/@me/limits', headers=headers).json()
    assert (body['nsfw_allowed'], body['adult_region_blocked']) == (allowed, blocked)


def test_an_adult_default_saved_elsewhere_can_be_re_saved(client, appdb):
    """Settings → Uploads sends every default: from a blocked country, only turning nsfw on is refused."""
    user_id, headers = signed_in(appdb, 'US')
    assert client.patch('/users/@me', headers=headers,
                        json={'settings': {'upload_defaults': {'nsfw': True}}}).status_code == 200
    gb = from_country(headers, 'GB')
    response = client.patch('/users/@me', headers=gb,
                            json={'settings': {'upload_defaults': {'visibility': 'private', 'nsfw': True}}})
    assert response.status_code == 200, response.text
    assert stored_defaults(appdb, user_id)['visibility'] == 'private'
    assert stored_defaults(appdb, user_id)['nsfw'] is True


def test_adult_sources_aren_t_converted_from_a_blocked_country(client, appdb):
    """An output inherits its sources' NSFW (milestone-5 §5.4), so converting one is making adult content."""
    from tests.test_conversions import convert, error_of, member, upload_png
    _, owner = member(appdb)
    adult, clean = upload_png(client, owner), upload_png(client, owner)
    appdb.execute('UPDATE files SET nsfw_marked = true WHERE id = %s', (int(adult['id']),))
    gb = from_country(owner, 'GB')
    assert error_of(convert(client, gb, source=adult['vanity'], target='webp')) == (451, UNAVAILABLE)
    assert convert(client, gb, source=clean['vanity'], target='webp').status_code in (200, 202)
    assert convert(client, from_country(owner, 'US'), source=adult['vanity'], target='webp').status_code in (200, 202)
    # a batch skips it like any other source this caller can't use
    body = convert(client, gb, path='/conversions/batch', files=[adult['vanity'], clean['vanity']], target='png',
                   status=202).json()
    assert body['skipped'] == [{'source': adult['vanity'], 'code': UNAVAILABLE}]
    assert len(body['items']) == 1
