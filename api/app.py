"""files.gg API on Sanic.

    sanic app:create_app --factory --host 0.0.0.0 --port 8080 --workers 4

`create_app()` runs in the main process and in every worker process. Per
worker (`before_server_start`): the psycopg pool, the Snowflake node lease
(heartbeat as an asyncio task), the outbound httpx client, the Redis clients
(milestone-5 §18) and blob storage.
All of it is released in `after_server_stop`. Nothing is leased in the main
process.
"""

import logging
import math
import os
import socket


log = logging.getLogger('files.gg')

REQUIRED_SECRETS = (
    'SECRET_KEY', 'RPC_KEY', 'VIEW_HASH_SECRET',
    # signs CDN URLs for protected files and albums, shared with the Worker (milestone-3 §3);
    # Turnstile; the B2 files bucket
    'CDN_SIGNING_SECRET', 'TURNSTILE_SECRET',
    'S3_ENDPOINT', 'S3_BUCKET_FILES', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
)
# public, credential-less CORS only (milestone-6 §12): no origin gets credentials, and the CSRF header
# (X-Filesgg-Csrf) is never allowed cross-origin
CORS_ALLOW_HEADERS = 'Authorization, Content-Type, X-Filesgg-Access'
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


def truthy(value):
    return (value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def create_app(name='filesgg', database_url=None, storage=None):
    # Fail before anything else (DB, leases) if secrets are absent.
    require_secrets()
    # PUBLIC_URL and CDN_URL (default https://files.gg, https://cdn.files.gg) must be origins
    from utils import urls
    urls.validate()
    # milestone-4 §13: CSAM_MATCHER (standin only with FILESGG_DEV_TOOLS=1), ABUSE_HASH_SECRET and
    # EVIDENCE_PUBLIC_KEY are required
    from safety.settings import check_api
    check_api()
    # milestone-6 §15: SESSION_COOKIE_INSECURE only with FILESGG_DEV_TOOLS, Discord's id and secret together
    from utils import account_settings as account_config
    account_config.check_api()
    # milestone-5 §14: REDIS_URL is required, and RATE_LIMITS must parse
    from utils import ratelimit, redis as redis_clients
    redis_clients.url()
    ratelimit.check_config()

    from sanic import Sanic
    from sanic.exceptions import MethodNotAllowed, SanicException
    from sanic.response import HTTPResponse
    from sanic_ext import Extend

    import db
    from utils import auth as auth_module, cdn_signing, client_ip, http, metrics, regions, tokens
    from utils.generators import EPOCH, Snowflake
    from utils.email import Email
    from utils.access import ACCESS_HEADER
    from utils.storage import S3Storage
    from utils.turnstile import Turnstile
    from utils.responses import ApiError
    from utils.snowflake_nodes import AsyncNodeLease
    from utils.wrappers import allowed_methods

    from views.auth import auth
    from views.files import access_routes, files
    from views.albums import albums
    from views.internal import internal
    from views.uploads import uploads
    from views.health import health
    from views.me import me
    from views.mimetypes import mimetypes
    from views.users import users
    from views.reports import reports, my_safety
    from views.admin import admin
    from views.account import account
    from views.integrations import integrations
    from views.conversions import conversions, my_conversions

    debug = truthy(os.getenv('DEBUG'))
    app = Sanic(name, strict_slashes=True)
    app.config.update({
        # The client IP is resolved by utils/client_ip.py (worker secret, then
        # our nginx's X-Forwarded-For). Sanic's own proxy handling trusts no
        # client-IP header: CF-Connecting-IP can be spoofed at the origin.
        'REAL_IP_HEADER': None,
        'FORWARDED_SECRET': None,
        'PROXIES_COUNT': int(os.getenv('PROXIES_COUNT', '1')),
        # the outer cap (milestone-6 §9.5): a premium single-request upload (500 MB) plus multipart framing.
        # The per-endpoint limits (§4.8) sit inside it, and PROXY_BODY_LIMIT_BYTES caps single uploads.
        'REQUEST_MAX_SIZE': int(os.getenv('REQUEST_MAX_SIZE', str(501 * 1024 * 1024))),
        # milestone-7 §3.1: on SIGTERM (a deploy stopping the old container) in-flight requests get this long, so a
        # 10 MiB chunk being sent finishes; the container's stop_grace_period (60 s) is longer
        'GRACEFUL_SHUTDOWN_TIMEOUT': 50.0,
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
    # the website's session is an HttpOnly cookie; tools send upload keys as `Authorization: Key fgg_…`
    app.ext.openapi.add_security_scheme('token', 'apiKey', location='header', name='Authorization')

    app.ctx.version = VERSION
    app.ctx.rpc_key = os.environ['RPC_KEY']
    # keys the daily IP hashes for unique views; the same on every API server
    app.ctx.view_hash_secret = os.environ['VIEW_HASH_SECRET']
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
    # Turnstile (milestone-2 §8): tokens must be issued for these hostnames
    hostnames = [h.strip() for h in os.getenv('TURNSTILE_HOSTNAMES', 'files.gg').split(',') if h.strip()]
    if debug:
        hostnames.append('localhost')
    Turnstile.configure(os.environ['TURNSTILE_SECRET'], hostnames)
    # the API's own unlock tokens (X-Filesgg-Access, refresh, #t= owner passes) are signed with
    # SECRET_KEY; CDN URLs with CDN_SIGNING_SECRET (milestone-3 §3)
    app.ctx.access_secret = os.environ['SECRET_KEY']
    cdn_signing.configure(os.environ['CDN_SIGNING_SECRET'])
    Snowflake.set_epoch(EPOCH)

    for blueprint in (auth, files, access_routes, health, me, mimetypes, users, uploads, internal, albums, reports,
                      my_safety, admin, account, integrations, conversions, my_conversions):
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
        # milestone-5 §18: app.ctx.redis and app.ctx.redis_sync, as notsobot has them
        redis_clients.open_clients(app)
        if app.ctx.storage is None:
            app.ctx.storage = await S3Storage().open()
            app.ctx.own_storage = True

    @app.after_server_start
    async def announce_ready(app):
        # ops/deploy.sh waits for this line from every worker before it stops the old container (milestone-7 §3.1)
        print('[api] worker {} ready'.format(os.getpid()), flush=True)

    @app.before_server_stop
    async def stop_accepting(app):
        # On SIGTERM, refuse new connections at once, while in-flight requests finish: Sanic's main process keeps the
        # listening socket open until every worker has drained, and meanwhile the kernel would accept connections
        # nobody answers. Refused, nginx sends them to the other api container (milestone-7 §3.1).
        for info in app.state.server_info:
            sock = info.settings.get('sock')
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    @app.after_server_stop
    async def close_resources(app):
        lease = getattr(app.ctx, 'lease', None)
        if lease is not None:
            await lease.stop()
            app.ctx.lease = None
        if getattr(app.ctx, 'own_storage', False):
            await app.ctx.storage.close()
            app.ctx.storage = None
            app.ctx.own_storage = False
        await http.close_client(getattr(app.ctx, 'http', None))
        await redis_clients.close_clients(app)
        await db.close_pool(getattr(app.ctx, 'pool', None))

    # --- request / response handling -------------------------------------------

    @app.on_request(priority=100)
    async def resolve_client(request):
        request.ctx.from_worker = client_ip.from_trusted_worker(request.headers, app.ctx.origin_secret)
        # only the Worker's own lookups, never a client request it forwarded (views/internal.py)
        request.ctx.internal_lookup = client_ip.internal_lookup(request.headers, app.ctx.origin_secret)
        request.ctx.client_ip = client_ip.resolve(
            request.headers, request.ip, app.ctx.origin_secret, app.ctx.proxies_count)
        # milestone-7 §11.1: the visitor's country, only from the Worker (never stored or logged)
        request.ctx.client_country = regions.from_headers(request.headers, request.ctx.from_worker)
        client_ip.scrub(request.headers)
        # access tokens never stay in the headers (nothing can log them)
        request.ctx.access_token = request.headers.get(ACCESS_HEADER)
        while ACCESS_HEADER in request.headers:
            del request.headers[ACCESS_HEADER]

    @app.on_request(priority=90)
    async def request_size(request):
        """Milestone-6 §4.8: 64 KiB for the auth and password endpoints, 1 MiB for every other JSON or form
        endpoint (413 REQUEST_TOO_LARGE { limit }), before anything is parsed or hashed. The upload routes
        stream and check their own limits."""
        from utils import request_limits
        return request_limits.check(request)

    @app.on_request(priority=80)
    async def authenticate(request):
        """Milestone-6 §3.4, §3.6, §7.4: the session cookie (only via files.gg/api), upload keys (only on the
        upload endpoints) and CSRF. Leaves `request.ctx.auth`."""
        await auth_module.resolve(request)

    # milestone-5 §18.1: the global limit and the route limits (priority 70, after the session and key lookups)
    ratelimit.limiter.init_app(app)
    # milestone-7 §4.2: requests counted by route pattern, method and status class, and this worker's pool reported
    metrics.init_app(app)

    @app.on_request(priority=50)
    async def account_standing(request):
        """Milestone-4 §8.4 as amended by milestone-6 §11.1 (suspended accounts) and §8.8 (an account with a
        pending deletion is locked): 403 ACCOUNT_SUSPENDED / ACCOUNT_PENDING_DELETION outside the allowlists."""
        from utils import standing
        return await standing.check_request(request)

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
        if 'cache-control' not in response.headers:
            response.headers['cache-control'] = 'no-cache, no-store'
        # the session cookie (milestone-6 §3.2): set by a sign-in, cleared by logout or a dead cookie
        set_cookie = getattr(request.ctx, 'set_cookie', None)
        if set_cookie is not None:
            response.headers.add('set-cookie', auth_module.set_cookie_header(*set_cookie))
        elif getattr(request.ctx, 'clear_cookie', False):
            response.headers.add('set-cookie', auth_module.clear_cookie_header())

    @app.exception(Exception)
    async def on_error(request, error):
        if not isinstance(error, ApiError):
            if isinstance(error, MethodNotAllowed) and vanity_lookup_path(request.path):
                # milestone-6 §20.1: nothing comes after a vanity, so `POST /files/<vanity>/unlock` and the
                # other old action paths are simply gone (404), not a method the vanity lookup lacks
                error = ApiError(status=404)
            elif isinstance(error, SanicException):
                error = ApiError(status=error.status_code)
            else:
                # never the exception's own text: it can carry internals
                log.exception('unhandled error', exc_info=error)
                error = ApiError(status=500)
        response = error.response
        retry_after = error.data.get('retry_after')
        if error.status == 429 and isinstance(retry_after, (int, float)):
            # milestone-5 §18.1: every 429 carries `Retry-After`, in whole seconds and at least 1
            response.headers['retry-after'] = str(max(math.ceil(retry_after), 1))
        return response

    return app


def vanity_lookup_path(path):
    """`/files/<vanity>`: GET only, and the vanity is always the last path segment (milestone-6 §20.1), so any
    other method there is a path that doesn't exist."""
    return path.startswith('/files/') and len(path) > len('/files/')


def apply_cors(app, request, response):
    origin = request.headers.get('origin')
    if not origin:
        return
    headers = response.headers
    headers['access-control-allow-headers'] = CORS_ALLOW_HEADERS
    headers['access-control-allow-methods'] = CORS_ALLOW_METHODS
    headers['access-control-max-age'] = '300'
    headers['vary'] = 'Origin'
    # public, credential-less access only: the website calls files.gg/api same-origin
    headers['access-control-allow-origin'] = '*'
