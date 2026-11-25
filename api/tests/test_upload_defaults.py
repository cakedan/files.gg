"""Upload defaults (docs/redesign/contracts/milestone-5.md §21): the settings round trip and its validation, the
re-check against the limits when they're used, conversions without output fields, and upload-key uploads (single and
chunked) getting the owner's defaults while request fields win and website uploads stay untouched."""

import dataclasses
import time
import uuid

import pytest

from tests.conftest import make_user, sign_in
from tests.m4 import appdb, png  # noqa: F401
from tests.test_conversions import (  # noqa: F401
    UNLOCK_TOKEN, anon, convert, error_of, fresh_ip, member, quick, quick_worker, row, upload_png,
)
from tests.test_upload_keys import create_key, key_header

HOUR = 3600
DAY = 24 * HOUR
PLAIN = {'expires_in': None, 'visibility': 'link', 'nsfw': False}


def set_defaults(client, headers, status=200, **values):
    response = client.patch('/users/@me', headers=headers, json={'settings': {'upload_defaults': values}})
    assert response.status_code == status, response.text
    return response.json()


def defaults_of(client, headers):
    return client.get('/users/@me', headers=headers).json()['settings']['upload_defaults']


def file_row(appdb, file_id):
    return appdb.fetchone('SELECT visibility, password_hash IS NOT NULL, extract(epoch FROM expires_at - now()), '
                          'nsfw_marked FROM files WHERE id = %s', (int(file_id),))


def key_upload(client, secret, status=200, **fields):
    response = client.post('/files', headers=key_header(secret), data={k: str(v) for k, v in fields.items()},
                           files={'file': ('shot.png', png(), 'image/png')})
    assert response.status_code == status, response.text
    return response.json()


def expiry_close(seconds, expected):
    return seconds is not None and float(seconds) == pytest.approx(expected, abs=60)


# --- the setting --------------------------------------------------------------------------------------------------

def test_settings_round_trip(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    assert defaults_of(client, headers) == PLAIN
    body = set_defaults(client, headers, expires_in=7 * DAY, visibility='password', nsfw=True)
    assert body['settings']['upload_defaults'] == {'expires_in': 7 * DAY, 'visibility': 'password', 'nsfw': True}
    assert defaults_of(client, headers) == {'expires_in': 7 * DAY, 'visibility': 'password', 'nsfw': True}
    # any one field, over the rest; `null` is never
    assert set_defaults(client, headers, visibility='private')['settings']['upload_defaults'] == \
        {'expires_in': 7 * DAY, 'visibility': 'private', 'nsfw': True}
    assert set_defaults(client, headers, expires_in=None)['settings']['upload_defaults']['expires_in'] is None
    stored = appdb.fetchone('SELECT upload_defaults FROM users WHERE id = %s', (user_id,))[0]
    assert stored == {'expires_in': None, 'visibility': 'private', 'nsfw': True}
    # the other settings stay as they were
    assert client.get('/users/@me', headers=headers).json()['settings']['show_name_on_albums'] is False


@pytest.mark.parametrize('values, field', [
    ({'expires_in': 60, 'visibility': 'password'}, 'expires_in'),
    ({'expires_in': '3600'}, 'expires_in'),
    ({'expires_in': True}, 'expires_in'),
    ({'expires_in': 7200.5}, 'expires_in'),
    ({'visibility': 'public', 'nsfw': True}, 'visibility'),
    ({'nsfw': 'yes'}, 'nsfw'),
    ({'album': 'Ab3dE6gH', 'expires_in': DAY}, 'album'),
])
def test_settings_validation(client, appdb, values, field):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    body = set_defaults(client, headers, status=400, **values)
    # only the bad field is named, and the good ones beside it aren't stored either
    assert body['code'] == 'INVALID_PARAMETERS' and list(body['errors']) == ['settings.upload_defaults.' + field]
    # nothing is stored from a refused request
    assert defaults_of(client, headers) == PLAIN
    response = client.patch('/users/@me', headers=headers, json={'settings': {'upload_defaults': 'password'}})
    assert response.json()['errors'] == {'settings.upload_defaults': 'Must be an object'}


def test_defaults_are_checked_against_the_limits(client, appdb, monkeypatch):
    """Set while allowed, used after the limits changed: the plain default instead (and a stored value that was never
    valid is ignored too)."""
    from utils import limits
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    set_defaults(client, headers, expires_in=7 * DAY, visibility='password')
    real = limits.get_limits

    def capped(user=None):
        found = real(user)
        return found if user is None else dataclasses.replace(found, max_expiry=DAY, allow_no_expiry=False)
    monkeypatch.setattr(limits, 'get_limits', capped)
    assert defaults_of(client, headers) == {'expires_in': DAY, 'visibility': 'password', 'nsfw': False}
    body = set_defaults(client, headers, status=400, expires_in=2 * DAY)
    assert body['errors'] == {'settings.upload_defaults.expires_in': 'Must be at most 1 day'}
    assert set_defaults(client, headers, status=400, expires_in=None)['errors'] == \
        {'settings.upload_defaults.expires_in': 'Pick when files expire'}
    secret = create_key(client, headers)['secret']
    created = key_upload(client, secret)
    visibility, _, seconds, _ = file_row(appdb, created['id'])
    assert visibility == 'password' and expiry_close(seconds, DAY)
    monkeypatch.setattr(limits, 'get_limits', real)
    appdb.execute('UPDATE users SET upload_defaults = %s::jsonb WHERE id = %s',
                  ('{"expires_in": 60, "visibility": "public", "nsfw": "yes"}', user_id))
    assert defaults_of(client, headers) == PLAIN


# --- conversions --------------------------------------------------------------------------------------------------

def test_conversions_use_the_callers_defaults(client, appdb, quick_worker):
    _, owner = member(appdb)
    _, uploader = member(appdb)
    link = upload_png(client, uploader)
    protected = upload_png(client, uploader, visibility='password', password='correct horse')
    token = client.post('/access/unlock/files/' + protected['vanity'], headers={'X-Forwarded-For': fresh_ip()},
                        json={'password': 'correct horse', 'turnstile_token': UNLOCK_TOKEN}).json()['token']
    set_defaults(client, owner, expires_in=2 * HOUR, visibility='password')
    # nothing sent: a link source's output takes the defaults, with a generated password shown once
    made = convert(client, owner, source=link['vanity'], status=200).json()
    assert made['output']['file']['visibility'] == 'password' and len(made['output']['password']) > 10
    assert made['output']['file']['expires_at'] - time.time() == pytest.approx(2 * HOUR, abs=30)
    # a protected source's output stays private, with the default expiry
    made = convert(client, owner, source=protected['vanity'], access_token=token, status=200).json()
    assert made['output']['file']['visibility'] == 'private' and 'password' not in made['output']
    assert made['output']['file']['expires_at'] - time.time() == pytest.approx(2 * HOUR, abs=30)
    # each field the request sends wins; `expires_in: null` is never
    made = convert(client, owner, source=link['vanity'], visibility='link', expires_in=None, status=200).json()
    assert made['output']['file']['visibility'] == 'link' and made['output']['file']['expires_at'] is None
    made = convert(client, owner, source=link['vanity'], expires_in=DAY, status=200).json()
    assert made['output']['file']['visibility'] == 'password'
    assert made['output']['file']['expires_at'] - time.time() == pytest.approx(DAY, abs=30)
    # the uploader's adult mark isn't a conversion default: outputs follow their source (§5.4)
    set_defaults(client, owner, visibility='private', nsfw=True)
    made = convert(client, owner, source=link['vanity'], status=200).json()
    assert made['output']['file']['visibility'] == 'private'
    assert appdb.fetchone('SELECT nsfw_marked FROM files WHERE id = %s', (int(made['output']['file']['id']),))[0] \
        is False
    # batches too, one generated password for the batch
    set_defaults(client, owner, visibility='password')
    images = [upload_png(client, owner) for _ in range(2)]
    body = convert(client, owner, path='/conversions/batch', files=[i['vanity'] for i in images], status=202).json()
    assert len({i['output']['password'] for i in body['items']}) == 1
    settings = [row(appdb, i['id'])['output_settings'] for i in body['items']]
    assert settings[0]['visibility'] == 'password' and settings[0]['expires_in'] == 2 * HOUR


def test_anonymous_conversions_are_unchanged(client, appdb, quick_worker):
    _, uploader = member(appdb)
    link = upload_png(client, uploader)
    made = convert(client, anon(), source=link['vanity'], status=200).json()
    assert made['output']['file']['visibility'] == 'link'
    assert made['output']['file']['expires_at'] - time.time() == pytest.approx(21 * DAY, abs=60)
    made = convert(client, anon(), source=link['vanity'], visibility='password', generate_password=True,
                   expires_in=HOUR, status=200).json()
    assert made['output']['file']['visibility'] == 'password' and made['output']['password']
    # never needs an account
    assert error_of(convert(client, anon(), source=link['vanity'], expires_in=None)) == (400, 'EXPIRY_NOT_ALLOWED')


# --- uploads --------------------------------------------------------------------------------------------------------

def test_key_uploads_use_the_owners_defaults(client, appdb):
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    set_defaults(client, headers, expires_in=5 * HOUR, visibility='password', nsfw=True)
    secret = create_key(client, headers)['secret']
    created = key_upload(client, secret)
    visibility, has_password, seconds, nsfw = file_row(appdb, created['id'])
    assert (visibility, has_password, nsfw) == ('password', True, True) and expiry_close(seconds, 5 * HOUR)
    assert created['password'] and created['url_with_password'].endswith('#pw=' + created['password'])
    # what the request sends wins, field by field
    created = key_upload(client, secret, visibility='link', expires_in=2 * HOUR, nsfw='false')
    visibility, has_password, seconds, nsfw = file_row(appdb, created['id'])
    assert (visibility, has_password, nsfw) == ('link', False, False) and expiry_close(seconds, 2 * HOUR)
    # the `.sxcu` copies `url_with_password`, which is the plain link without a password
    assert created['url_with_password'] == created['url'] and 'password' not in created
    created = key_upload(client, secret, password='hunter22')
    visibility, has_password, seconds, nsfw = file_row(appdb, created['id'])
    assert (visibility, has_password, nsfw) == ('password', True, True) and 'password' not in created
    created = key_upload(client, secret, visibility='private')
    assert file_row(appdb, created['id'])[:2] == ('private', False)
    # chunked sessions started with a key too
    session = client.post('/uploads', headers=key_header(secret), json={'filename': 'a.bin', 'size': 10}).json()
    assert len(session['password']) > 10
    assert appdb.fetchone('SELECT visibility, expires_in, nsfw_marked FROM upload_sessions WHERE id = %s',
                          (int(session['upload_id']),)) == ('password', 5 * HOUR, True)
    session = client.post('/uploads', headers=key_header(secret), json={'filename': 'a.bin', 'size': 10,
                                                                        'visibility': 'link', 'nsfw': False}).json()
    assert 'password' not in session
    assert appdb.fetchone('SELECT visibility, expires_in, nsfw_marked FROM upload_sessions WHERE id = %s',
                          (int(session['upload_id']),)) == ('link', 5 * HOUR, False)


def test_website_uploads_get_no_server_defaults(client, appdb):
    """The Upload page sends what it shows (§21), so a session upload that sends nothing is the plain upload."""
    from tests.m4 import send
    user_id = make_user(appdb)
    headers = sign_in(user_id, appdb)
    set_defaults(client, headers, expires_in=5 * HOUR, visibility='password', nsfw=True)
    created = send(client, headers, png(), 'photo.png', 'image/png')
    assert file_row(appdb, created['id']) == ('link', False, None, False)
    assert 'password' not in created and 'url_with_password' not in created
    session = client.post('/uploads', headers=headers, json={'filename': 'b.bin', 'size': 10}).json()
    assert 'password' not in session
    assert appdb.fetchone('SELECT visibility, expires_in, nsfw_marked FROM upload_sessions WHERE id = %s',
                          (int(session['upload_id']),)) == ('link', None, False)
