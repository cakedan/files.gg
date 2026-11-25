"""Test setup. Needs a real Postgres; run through docker-compose.test.yml.

TEST_DATABASE_ADMIN_URL points at a superuser connection; every test that
needs isolation gets its own throwaway database.
"""

import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid

from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
import pytest

ADMIN_URL = os.environ.get(
    'TEST_DATABASE_ADMIN_URL', 'postgresql://postgres:postgres@localhost:5432/postgres'
)
APP_DATABASE = 'filesgg_test_app'
API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRET_KEY = 'test-secret-key'
# the contract's test-vector secret (milestone-3 §3)
CDN_SIGNING_SECRET = 'test-cdn-signing-secret'


def database_url(name):
    parts = urlsplit(ADMIN_URL)
    return urlunsplit(parts._replace(path='/' + name))


def admin_execute(sql):
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(sql)


def create_database(name=None):
    name = name or 'filesgg_test_' + uuid.uuid4().hex[:12]
    admin_execute('DROP DATABASE IF EXISTS "{}" WITH (FORCE)'.format(name))
    admin_execute('CREATE DATABASE "{}"'.format(name))
    return name


def drop_database(name):
    admin_execute('DROP DATABASE IF EXISTS "{}" WITH (FORCE)'.format(name))


def connect(name):
    return psycopg.connect(database_url(name), autocommit=True)


# --- environment for the app ----------------------------------------------------
create_database(APP_DATABASE)
# B2 is MinIO in tests (docker-compose.test.yml); these defaults match it
for _name, _value in {
    'S3_ENDPOINT': 'http://localhost:9000',
    'S3_REGION': 'us-east-1',
    'S3_BUCKET_FILES': 'filesgg-test',
    'S3_ACCESS_KEY_ID': 'filesgg-test',
    'S3_SECRET_ACCESS_KEY': 'filesgg-test-secret',
}.items():
    os.environ.setdefault(_name, _value)
# Not one of Cloudflare's testing secrets (those skip the action and hostname
# checks), so the mocked siteverify below exercises the full checks. This
# overrides the compose file's value on purpose.
os.environ['TURNSTILE_SECRET'] = 'test-turnstile-secret'
os.environ.update({
    'DATABASE_URL': database_url(APP_DATABASE),
    'SECRET_KEY': SECRET_KEY,
    'RPC_KEY': 'test-rpc-key',
    'ALLOWED_ORIGINS': 'https://files.gg, https://beta.files.gg',
    'ORIGIN_SHARED_SECRET': 'test-origin-secret',
    'VIEW_HASH_SECRET': os.environ.get('VIEW_HASH_SECRET', 'test-view-hash-secret'),
    'PROXIES_COUNT': '1',
    'CDN_SIGNING_SECRET': CDN_SIGNING_SECRET,
})
os.environ.pop('DEBUG', None)
# the public URLs keep their production defaults
for _name in ('PUBLIC_URL', 'CDN_URL', 'TURNSTILE_HOSTNAMES', 'FILESGG_DEV_TOOLS'):
    os.environ.pop(_name, None)

import migrate  # noqa: E402

with connect(APP_DATABASE) as _conn:
    migrate.migrate(_conn)

from utils import tokens  # noqa: E402

tokens.set_secret_key(SECRET_KEY)

# --- Turnstile: siteverify is mocked, so tests don't need the internet --------------------
# The mock answers like Cloudflare does for a real secret: a token minted by
# turnstile_token(action, hostname) verifies with that action and hostname,
# anything else fails. Action and hostname checks stay fully enforced. One
# opt-in test (FILESGG_NETWORK_TESTS=1) calls the real siteverify with
# Cloudflare's testing keys.

def turnstile_token(action, hostname='files.gg'):
    return 'mock:{}:{}'.format(action, hostname)


UPLOAD_TOKEN = turnstile_token('upload')
UNLOCK_TOKEN = turnstile_token('unlock')
LOGIN_TOKEN = turnstile_token('login')
REGISTER_TOKEN = turnstile_token('register')
TURNSTILE_TOKEN = UPLOAD_TOKEN
FAILING_TOKEN = 'mock-fail'


def mock_siteverify(request):
    from urllib.parse import parse_qs
    form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
    if form.get('secret') != os.environ['TURNSTILE_SECRET']:
        return httpx.Response(200, json={'success': False, 'error-codes': ['invalid-input-secret']})
    token = form.get('response', '')
    parts = token.split(':')
    if len(parts) != 3 or parts[0] != 'mock':
        code = 'missing-input-response' if not token else 'invalid-input-response'
        return httpx.Response(200, json={'success': False, 'error-codes': [code]})
    return httpx.Response(200, json={
        'success': True, 'challenge_ts': '2026-11-24T00:00:00.000Z', 'hostname': parts[2], 'action': parts[1],
        'cdata': '', 'error-codes': [], 'metadata': {'interactive': False},
    })


from utils.turnstile import Turnstile  # noqa: E402

Turnstile.http = httpx.AsyncClient(transport=httpx.MockTransport(mock_siteverify))
# as create_app() configures it, so tests that use Turnstile directly don't depend on order
Turnstile.configure(os.environ['TURNSTILE_SECRET'], ['files.gg'])


def s3_client():
    from utils.storage import sync_client
    return sync_client()


def _create_bucket():
    client = s3_client()
    bucket = os.environ['S3_BUCKET_FILES']
    deadline = time.time() + 60
    while True:
        try:
            client.head_bucket(Bucket=bucket)
            return
        except Exception:
            try:
                client.create_bucket(Bucket=bucket)
                return
            except Exception:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)


_create_bucket()
BUCKET = os.environ['S3_BUCKET_FILES']


def s3_object(key):
    """The bytes of an object in the files bucket, or None."""
    try:
        return s3_client().get_object(Bucket=BUCKET, Key=key)['Body'].read()
    except Exception:
        return None


def s3_keys(prefix):
    keys, token = [], None
    client = s3_client()
    while True:
        kwargs = {'Bucket': BUCKET, 'Prefix': prefix}
        if token:
            kwargs['ContinuationToken'] = token
        page = client.list_objects_v2(**kwargs)
        keys += [item['Key'] for item in page.get('Contents', [])]
        if not page.get('IsTruncated'):
            return keys
        token = page['NextContinuationToken']


class TempDatabase:
    def __init__(self, name):
        self.name = name
        self.url = database_url(name)
        self._conn = None

    @property
    def conn(self):
        if self._conn is None or self._conn.closed:
            self._conn = connect(self.name)
        return self._conn

    def connect(self):
        return connect(self.name)

    def execute(self, sql, params=None):
        return self.conn.execute(sql, params).rowcount

    def fetchone(self, sql, params=None):
        return self.conn.execute(sql, params).fetchone()

    def fetchall(self, sql, params=None):
        return self.conn.execute(sql, params).fetchall()

    def close(self):
        if self._conn is not None and not self._conn.closed:
            self._conn.close()


@pytest.fixture
def empty_db():
    name = create_database()
    temp = TempDatabase(name)
    try:
        yield temp
    finally:
        temp.close()
        drop_database(name)


@pytest.fixture
def migrated_db(empty_db):
    migrate.migrate(empty_db.conn)
    return empty_db


@pytest.fixture
def snowflake_state():
    """Save and restore Snowflake's class-level state around a test."""
    from utils.generators import Snowflake
    saved = {k: getattr(Snowflake, k) for k in
             ('epoch', 'worker_id', 'datacenter_id', 'sequence', 'node_provider', '_last_timestamp')}
    Snowflake.node_provider = None
    Snowflake.sequence = 0
    Snowflake._last_timestamp = -1
    try:
        yield Snowflake
    finally:
        for key, value in saved.items():
            setattr(Snowflake, key, value)


def subprocess_env(**overrides):
    env = dict(os.environ)
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


# --- the app under test ----------------------------------------------------------

class Client:
    """sanic-testing's ReusableClient (one real server for the whole session)
    with a plain `request()` returning the httpx response."""

    def __init__(self, app):
        from sanic_testing.reusable import ReusableClient
        self.app = app
        self.inner = ReusableClient(app, port=free_port())

    def request(self, method, path, **kwargs):
        _, response = self.inner._sanic_endpoint_test(
            'request', path, http_method=method.upper(), gather_request=False, **kwargs)
        response.__class__ = httpx.Response  # plain httpx API (.json() is a method)
        return response

    def get(self, path, **kwargs):
        return self.request('GET', path, **kwargs)

    def post(self, path, **kwargs):
        return self.request('POST', path, **kwargs)

    def options(self, path, **kwargs):
        return self.request('OPTIONS', path, **kwargs)

    def __enter__(self):
        self.inner.run()
        return self

    def __exit__(self, *exc):
        self.inner.stop()


@pytest.fixture(scope='session')
def app():
    import app as app_module
    return app_module.create_app('filesgg-test')


@pytest.fixture(scope='session')
def client(app):
    from utils.generators import Snowflake
    saved = Snowflake.node_provider
    with Client(app) as client:
        yield client
    Snowflake.node_provider = saved


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class ServerProcess:
    """The real server, started with the `sanic` CLI as in production."""

    def __init__(self, database, *args, env=None):
        self.port = free_port()
        self.url = 'http://127.0.0.1:{}'.format(self.port)
        # a file, not a pipe: a full pipe would block the server's logging
        self.log = tempfile.TemporaryFile(mode='w+')
        self.proc = subprocess.Popen(
            [sys.executable, '-m', 'sanic', 'app:create_app', '--factory', '--host', '127.0.0.1',
             '--port', str(self.port), *args],
            cwd=API_DIR, env=subprocess_env(DATABASE_URL=database.url, **(env or {})),
            stdout=self.log, stderr=subprocess.STDOUT, text=True,
        )

    def output(self):
        self.log.seek(0)
        return self.log.read()

    def wait_ready(self, timeout=60, settle=2.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError('server exited early:\n' + self.output())
            try:
                if httpx.get(self.url + '/health', timeout=1).status_code == 200:
                    # Sanic 25.12's main process keeps working for a moment
                    # after the first worker answers; a SIGTERM in that window
                    # hangs it (reproduced with a bare Sanic app). Let it settle.
                    time.sleep(settle)
                    return self
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        raise RuntimeError('server did not become ready')

    def stop(self, sig=None, timeout=60):
        import signal
        if self.proc.poll() is None:
            self.proc.send_signal(sig or signal.SIGTERM)
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        return self.proc.returncode, self.output()


def hash_of(temp, file):
    """The blob id behind a file object (public responses no longer carry it)."""
    return str(temp.fetchone('SELECT hash_id FROM files WHERE id = %s', (int(file['id']),))[0])


# --- signed CDN URLs (contract milestone-3 §3) ------------------------------------------------------

def url_query(url):
    from urllib.parse import parse_qs, urlsplit
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def assert_signed(url, grant, album=None, expires=None):
    """`url` carries a valid signature for `grant` ("file:<id>:<v>" or "album:<id>:<v>"),
    as the Worker checks it, with `album=` exactly when given. Returns its expiry."""
    import time as time_module
    from urllib.parse import urlsplit
    from utils.cdn_signing import signature
    query = url_query(url)
    assert 'expires' in query and 'sig' in query, url
    assert query.get('album') == album, url
    assert 't' not in query, url
    expiry = int(query['expires'])
    assert time_module.time() < expiry <= time_module.time() + 31 * 86400, url
    if expires is not None:
        assert expiry == expires, url
    assert query['sig'] == signature(urlsplit(url).path, expiry, grant, CDN_SIGNING_SECRET), url
    return expiry


def assert_unsigned(url):
    query = url_query(url)
    assert not {'expires', 'sig', 'album', 't'} & set(query), url


def payload_urls(payload):
    """Every CDN URL in a file payload: cdn_url, assets, thumbnail and hover_url."""
    urls = [payload['cdn_url']] + [entry['url'] for entry in payload.get('assets', {}).values()]
    if payload.get('thumbnail'):
        urls.append(payload['thumbnail']['url'])
    if payload.get('hover_url'):
        urls.append(payload['hover_url'])
    return urls
