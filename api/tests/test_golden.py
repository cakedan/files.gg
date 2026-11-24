"""Compatibility: replay requests against the Sanic app and compare with the
responses the Flask version gave (captured before it was removed).

fixtures/golden/requests.json    the requests, in order (view counts depend on it)
fixtures/golden/flask_responses.json  status, selected headers and the exact body
fixtures/golden_seed.sql         the data both runs started from

The Flask capture ran with SECRET_KEY=test-secret-key, ALLOWED_ORIGINS
'https://files.gg, https://beta.files.gg', from 127.0.0.1, with reCAPTCHA
answering {"success": false}.
"""

import json
import os

import pytest

from tests.conftest import API_DIR, Client, TempDatabase, create_database, drop_database
from utils.tokens import FingerprintToken, UserToken

GOLDEN_DIR = os.path.join(API_DIR, 'tests', 'fixtures', 'golden')
with open(os.path.join(GOLDEN_DIR, 'requests.json')) as handle:
    REQUESTS = json.load(handle)
with open(os.path.join(GOLDEN_DIR, 'flask_responses.json')) as handle:
    EXPECTED = json.load(handle)

COMPARED_HEADERS = (
    'content-type', 'cache-control', 'access-control-allow-origin', 'access-control-allow-credentials',
    'access-control-allow-headers', 'access-control-allow-methods', 'access-control-max-age', 'vary',
    'allow', 'location',
)


@pytest.fixture(scope='module')
def golden_client():
    import app as app_module
    import migrate
    from utils.generators import Snowflake
    from utils.recaptcha import Recaptcha

    class Reply:
        status_code = 200

        def json(self):
            return {'success': False}

    async def captcha(response, remoteip=None):
        return Reply()

    name = create_database()
    temp = TempDatabase(name)
    migrate.migrate(temp.conn)
    with open(os.path.join(API_DIR, 'tests', 'fixtures', 'golden_seed.sql')) as handle:
        temp.conn.execute(handle.read())

    saved = Snowflake.node_provider
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(Recaptcha, 'verify', captcha)
        try:
            with Client(app_module.create_app('filesgg-golden', database_url=temp.url)) as client:
                yield client
        finally:
            Snowflake.node_provider = saved
            temp.close()
            drop_database(name)


def build(req):
    headers = dict(req.get('headers', {}))
    if 'auth' in req:
        headers['Authorization'] = UserToken.generate(req['auth'])
    if 'fingerprint' in req:
        headers['X-Fingerprint'] = FingerprintToken.generate(req['fingerprint'])
    kwargs = {'headers': headers}
    if 'json' in req:
        kwargs['json'] = req['json']
    if 'form' in req:
        kwargs['data'] = req['form']
    if 'files' in req:
        kwargs['files'] = {field: (name, content.encode(), ctype)
                           for field, (name, ctype, content) in req['files'].items()}
    return kwargs


def normalise(name, value):
    if name == 'allow':
        return sorted(x.strip() for x in value.split(','))
    return value


@pytest.mark.parametrize('req', REQUESTS, ids=[r['name'] for r in REQUESTS])
def test_matches_flask(golden_client, req):
    expected = EXPECTED[req['name']]
    response = golden_client.request(req['method'], req['path'], **build(req))

    assert response.status_code == expected['status']
    assert response.text == expected['body']
    got = {k: normalise(k, response.headers[k]) for k in COMPARED_HEADERS if k in response.headers}
    want = {k: normalise(k, v) for k, v in expected['headers'].items()}
    assert got == want
