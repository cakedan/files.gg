"""Request authentication (contract milestone-6 §3, §7.4), replacing `helpers.get_user` and the old
`Authorization` user tokens.

- **Sessions** come only from the HttpOnly session cookie, and only on a request the Worker forwarded from
  `files.gg/api/*`: the origin secret matched (`request.ctx.from_worker`) **and** `X-Filesgg-Via: main`,
  which the Worker sets only there. A cookie on any other request is ignored.
- **Upload keys** (`Authorization: Key fgg_…`) authenticate only the upload endpoints; elsewhere they're
  `403 UPLOAD_KEY_NOT_ALLOWED` (the plain 404 on `/admin/*`). Any other `Authorization` (`Bearer` included)
  is `401 UNAUTHORIZED`, never a session.
- **CSRF** (§3.6): every POST, PUT, PATCH and DELETE carrying the session cookie, and every POST under
  `/auth/`, needs `X-Filesgg-Csrf: 1`, a same-origin `Origin` when one is sent, and `Sec-Fetch-Site:
  same-origin` when that is sent. Else `403 CSRF`, before the handler runs.

`resolve()` runs as request middleware and leaves `request.ctx.auth`; handlers ask `require_session()`,
`optional_user()` or `uploader()`. The cookie and the `Authorization` header are removed from the request
once read, so nothing later can log them. Responses set or clear the cookie from `request.ctx.set_cookie`
and `request.ctx.clear_cookie` (app.py).
"""

from urllib.parse import urlsplit

import db
from utils import accounts, credentials, errors
from utils.account_settings import account_settings
from utils.urls import public_url

VIA_HEADER = 'x-filesgg-via'
CSRF_HEADER = 'x-filesgg-csrf'
WRITE_METHODS = frozenset(('POST', 'PUT', 'PATCH', 'DELETE'))
KEY_HELP = 'Upload keys use `Authorization: Key fgg_…`'


class Auth:
    """What authenticated this request: nothing, the session cookie, or an upload key."""

    def __init__(self, kind=None, user=None, session=None, key=None):
        self.kind = kind
        self.user = user
        self.session = session
        self.key = key
        # a session cookie came with the request (valid or not)
        self.cookie = False
        # the cookie named no live session: the response clears it
        self.dead = False


# --- the cookie (§3.2) ------------------------------------------------------------------------------------------

def cookie_value(name, value, max_age, insecure=False):
    parts = ['{}={}'.format(name, value), 'Path=/']
    if not insecure:
        parts.append('Secure')
    parts += ['HttpOnly', 'SameSite=Lax', 'Max-Age={}'.format(int(max_age))]
    return '; '.join(parts)


def set_cookie_header(token, max_age, settings=None):
    settings = settings or account_settings()
    return cookie_value(settings.cookie_name, token, max_age, settings.cookie_insecure)


def clear_cookie_header(settings=None):
    settings = settings or account_settings()
    return cookie_value(settings.cookie_name, '', 0, settings.cookie_insecure)


def via_main(request):
    return bool(getattr(request.ctx, 'from_worker', False)) and request.headers.get(VIA_HEADER) == 'main'


def read_cookie(request, name):
    """The session cookie's value, only on a Worker-forwarded `files.gg/api` request."""
    if not via_main(request):
        return None
    for header in request.headers.getall('cookie', []):
        for part in header.split(';'):
            key, _, value = part.strip().partition('=')
            if key == name:
                return value.strip()
    return None


def scrub(request):
    for name in ('cookie', 'authorization'):
        while name in request.headers:
            del request.headers[name]


# --- CSRF (§3.6) --------------------------------------------------------------------------------------------------

def main_origin():
    parts = urlsplit(public_url())
    return '{}://{}'.format(parts.scheme, parts.netloc)


def check_csrf(request):
    if request.headers.get(CSRF_HEADER) != '1':
        raise errors.csrf()
    origin = request.headers.get('origin')
    if origin is not None and origin.rstrip('/') != main_origin():
        raise errors.csrf()
    site = request.headers.get('sec-fetch-site')
    if site is not None and site != 'same-origin':
        raise errors.csrf()


# --- which endpoints a key may use (§7.2) ---------------------------------------------------------------------

def is_upload_endpoint(request):
    path, method = request.path.rstrip('/') or '/', request.method
    if path == '/files':
        return method == 'POST'
    if path == '/uploads':
        return method == 'POST'
    return path.startswith('/uploads/') and method in ('GET', 'HEAD', 'PUT', 'POST', 'DELETE')


def _quiet_path(path):
    """Where any credential problem answers like an unknown route (milestone-4 §9.1, milestone-3 §5)."""
    return path.startswith(('/admin/', '/internal/')) or path in ('/admin', '/internal')


# --- the middleware ---------------------------------------------------------------------------------------------

async def resolve(request):
    request.ctx.auth = Auth()
    if request.method == 'OPTIONS':
        scrub(request)
        return
    settings = account_settings()
    path = request.path
    authorization = request.headers.get('authorization')
    token = read_cookie(request, settings.cookie_name)
    scrub(request)

    # every /auth/* POST is checked, cookie or not, so nobody can be signed into someone else's account
    if request.method == 'POST' and path.startswith('/auth/'):
        check_csrf(request)

    if authorization is not None:
        if _quiet_path(path):
            raise errors.not_found()
        scheme, _, value = authorization.strip().partition(' ')
        if scheme.lower() != 'key':
            raise errors.unauthorized(KEY_HELP if is_upload_endpoint(request) else 'Sign in to do that')
        if not is_upload_endpoint(request):
            raise errors.upload_key_not_allowed()
        from utils import upload_keys
        async with db.connection() as conn:
            key, user = await upload_keys.authenticate(conn, value.strip())
        # a key wins over a cookie, which is then ignored (and needs no CSRF header)
        request.ctx.auth = Auth('key', user, key=key)
        return

    if token is None:
        return
    auth = request.ctx.auth
    auth.cookie = True
    if request.method in WRITE_METHODS:
        check_csrf(request)
    if not credentials.well_formed(token, credentials.SESSION_PREFIX):
        auth.dead = request.ctx.clear_cookie = True
        return
    async with db.connection() as conn:
        found = await accounts.load_session(conn, token)
        if found is None:
            auth.dead = request.ctx.clear_cookie = True
            return
        user, session = found
        await accounts.touch_session(conn, session, accounts.country_of(request), settings)
    request.ctx.auth = Auth('session', user, session)
    request.ctx.auth.cookie = True


def auth_of(request):
    auth = getattr(request.ctx, 'auth', None)
    return auth if auth is not None else Auth()


def require_session(request):
    """(user, session) of a signed-in website request; 401 UNAUTHORIZED otherwise (a dead cookie is
    cleared). Upload keys never get here (the middleware refused them already)."""
    auth = auth_of(request)
    if auth.kind != 'session':
        raise errors.unauthorized()
    return auth.user, auth.session


def optional_user(request):
    """The signed-in user (session or key), or None."""
    return auth_of(request).user


def uploader(request):
    """(user, key) on the upload endpoints: the session cookie or an upload key; (None, None) signed out.
    A dead cookie is a 401, never a silent fall back to anonymous."""
    auth = auth_of(request)
    if auth.dead:
        raise errors.unauthorized()
    return auth.user, auth.key


async def require_fresh(request, conn=None):
    """§3.5: the session proved the password (or Discord) in the last REAUTH_SECONDS; else
    403 REAUTH_REQUIRED { methods }."""
    user, session = require_session(request)
    if session.fresh():
        return user, session
    if conn is not None:
        methods = await accounts.login_methods(conn, user)
    else:
        async with db.connection() as conn:
            methods = await accounts.login_methods(conn, user)
    raise errors.reauth_required(methods)
