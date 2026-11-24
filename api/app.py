"""files.gg API on Sanic.

    sanic app:create_app --factory --host 0.0.0.0 --port 8080 --workers 4

`create_app()` runs in the main process and in every worker process. Per
worker (`before_server_start`): the psycopg pool, the Snowflake node lease
(heartbeat as an asyncio task), the outbound httpx client and blob storage.
All of it is released in `after_server_stop`. Nothing is leased in the main
process.
"""

import logging
import os


log = logging.getLogger('files.gg')

REQUIRED_SECRETS = ('SECRET_KEY', 'RPC_KEY', 'VIEW_HASH_SECRET')
DEFAULT_ALLOWED_ORIGINS = 'https://files.gg'
CORS_ALLOW_HEADERS = 'Authorization, Content-Type, X-Fingerprint'
CORS_ALLOW_METHODS = 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, TRACE'
JSON = 'application/json'
VERSION = '0.0.1'


def require_secrets(environ=os.environ):
    missing = [name for name in REQUIRED_SECRETS if not environ.get(name)]
    if missing:
        raise RuntimeError(
            'Refusing to start: missing required secret(s) {}. '
            'Set them in the environment; there are no defaults.'.format(', '.join(missing))
        )


def parse_origins(value):
    return frozenset(x.strip().rstrip('/') for x in (value or '').split(',') if x.strip())


def truthy(value):
    return (value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def create_app(name='filesgg', database_url=None, storage=None):
    # Fail before anything else (DB, leases) if secrets are absent.
    require_secrets()

    from sanic import Sanic
    from sanic.exceptions import SanicException
    from sanic.response import HTTPResponse
    from sanic_ext import Extend

    import db
    from utils import client_ip, http, tokens
    from utils import storage as storage_module
    from utils.generators import EPOCH, Snowflake
    from utils.email import Email
    from utils.recaptcha import Recaptcha
    from utils.responses import ApiError
    from utils.snowflake_nodes import AsyncNodeLease
    from utils.wrappers import allowed_methods

    from views.auth import auth
    from views.files import files
    from views.google import google
    from views.health import health
    from views.me import me
    from views.mimetypes import mimetypes
    from views.users import users

    debug = truthy(os.getenv('DEBUG'))
    app = Sanic(name, strict_slashes=True)
    app.config.update({
        # The client IP is resolved by utils/client_ip.py (worker secret, then
        # our nginx's X-Forwarded-For). Sanic's own proxy handling trusts no
        # client-IP header: CF-Connecting-IP can be spoofed at the origin.
        'REAL_IP_HEADER': None,
        'FORWARDED_SECRET': None,
        'PROXIES_COUNT': int(os.getenv('PROXIES_COUNT', '1')),
        'REQUEST_MAX_SIZE': int(os.getenv('REQUEST_MAX_SIZE', str(100 * 1024 * 1024))),
        # sanic-ext: our own CORS, OPTIONS and HEAD handling (Flask-compatible)
        'CORS': False,
        'HTTP_AUTO_OPTIONS': False,
        'HTTP_AUTO_HEAD': False,
        'HTTP_AUTO_TRACE': False,
        # OpenAPI spec at /openapi.json; Swagger UI at /docs only with DEBUG
        'OAS_URL_PREFIX': '',
        'OAS_URI_TO_JSON': '/openapi.json',
        'OAS_UI_DEFAULT': None,
        'OAS_UI_REDOC': False,
        'OAS_UI_SWAGGER': debug,
        'OAS_URI_TO_SWAGGER': '/docs',
        'OAS_URI_TO_CONFIG': '/docs/swagger-config',
        'OAS_UI_SWAGGER_OAUTH2_REDIRECT': '/docs/oauth2-redirect.html',
        'OAS_IGNORE_HEAD': True,
        'OAS_IGNORE_OPTIONS': True,
        'OAS_AUTODOC': True,
        'API_TITLE': 'files.gg API',
        'API_VERSION': VERSION,
    })
    # The startup banner labels the OpenAPI extension with the URL of its UI
    # index, which does not exist without DEBUG; point it at the spec instead.
    from sanic_ext.extensions.openapi.extension import OpenAPIExtension
    OpenAPIExtension.label = lambda self: '/openapi.json'
    Extend(app)
    app.ext.openapi.add_security_scheme('token', 'apiKey', location='header', name='Authorization')

    app.ctx.version = VERSION
    app.ctx.rpc_key = os.environ['RPC_KEY']
    # keys the daily IP hashes for unique views; the same on every API server
    app.ctx.view_hash_secret = os.environ['VIEW_HASH_SECRET']
    app.ctx.allowed_origins = parse_origins(os.getenv('ALLOWED_ORIGINS', DEFAULT_ALLOWED_ORIGINS))
    app.ctx.storage = storage
    # shared with the Cloudflare Worker (its ORIGIN_SHARED_SECRET binding)
    app.ctx.origin_secret = os.getenv('ORIGIN_SHARED_SECRET') or None
    app.ctx.proxies_count = app.config.PROXIES_COUNT

    tokens.set_secret_key(os.environ['SECRET_KEY'])
    # account email through Postmark (utils/email.py); sending fails with 503 until the token is set
    Email.configure(
        token=os.getenv('POSTMARK_SERVER_TOKEN'),
        sender=os.getenv('EMAIL_FROM'),
        stream=os.getenv('POSTMARK_MESSAGE_STREAM'),
    )
    Recaptcha.set_secret(os.getenv('RECAPTCHA_SECRET', ''))
    Snowflake.set_epoch(EPOCH)

    for blueprint in (auth, files, google, health, me, mimetypes, users):
        app.blueprint(blueprint)

    # --- per-worker resources ------------------------------------------------

    @app.before_server_start
    async def open_resources(app):
        pool = app.ctx.pool = await db.open_pool(database_url)
        # Lease this worker's Snowflake node id. Raises (the worker does not
        # start) if none is free.
        lease = AsyncNodeLease(pool)
        await lease.start(install=True)
        app.ctx.lease = lease
        app.ctx.http = http.open_client()
        if app.ctx.storage is None:
            app.ctx.storage = storage_module.from_env()

    @app.after_server_stop
    async def close_resources(app):
        lease = getattr(app.ctx, 'lease', None)
        if lease is not None:
            await lease.stop()
            app.ctx.lease = None
        await http.close_client(getattr(app.ctx, 'http', None))
        await db.close_pool(getattr(app.ctx, 'pool', None))

    # --- request / response handling -------------------------------------------

    @app.on_request(priority=100)
    async def resolve_client(request):
        request.ctx.client_ip = client_ip.resolve(
            request.headers, request.ip, app.ctx.origin_secret, app.ctx.proxies_count)
        client_ip.scrub(request.headers)

    @app.on_request
    async def preflight(request):
        # Flask answered OPTIONS on every route itself: 204 + Allow, no view.
        if request.method == 'OPTIONS' and request.route is not None:
            allowed = allowed_methods(request.route)
            return HTTPResponse(b'', status=204,
                                headers={'allow': ', '.join(sorted(allowed)), 'content-type': JSON})

    @app.on_response
    async def finish(request, response):
        apply_cors(app, request, response)
        response.headers['cache-control'] = 'no-cache, no-store'

    @app.exception(Exception)
    async def on_error(request, error):
        if not isinstance(error, ApiError):
            if isinstance(error, SanicException):
                error = ApiError(status=error.status_code)
            else:
                log.exception('unhandled error', exc_info=error)
                error = ApiError(str(error), 500)
        return error.response

    return app


def apply_cors(app, request, response):
    origin = request.headers.get('origin')
    if not origin:
        return
    headers = response.headers
    headers['access-control-allow-headers'] = CORS_ALLOW_HEADERS
    headers['access-control-allow-methods'] = CORS_ALLOW_METHODS
    headers['access-control-max-age'] = '300'
    headers['vary'] = 'Origin'
    if origin.rstrip('/') in app.ctx.allowed_origins:
        headers['access-control-allow-origin'] = origin
        headers['access-control-allow-credentials'] = 'true'
    else:
        # public, credential-less access only
        headers['access-control-allow-origin'] = '*'
