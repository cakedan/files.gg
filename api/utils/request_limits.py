"""Request-size limits (contract milestone-6 §4.8), checked in request middleware from Content-Length, and
from the body itself for a chunked transfer encoding, before anything is parsed or hashed:

    /auth/*, POST /users/@me/email, PUT /users/@me/password, POST /users/@me/delete   64 KiB
    every other JSON or form endpoint                                                  1 MiB
    POST /files, PUT /uploads/<id>/chunks/<i>                                          their own (streamed)

Sanic's REQUEST_MAX_SIZE is the outer cap for all of them.
"""

from utils import errors
from utils.account_settings import account_settings

STREAMED = ('/files',)


def _auth_sized(method, path):
    if path.startswith('/auth/'):
        return True
    return (method, path) in (('POST', '/users/@me/email'), ('PUT', '/users/@me/password'),
                              ('POST', '/users/@me/delete'))


def limit_for(request, settings=None):
    settings = settings or account_settings()
    method, path = request.method, (request.path.rstrip('/') or '/')
    if method == 'POST' and path in STREAMED:
        return None
    if path.startswith('/uploads/') and '/chunks/' in path:
        return None
    if _auth_sized(method, path):
        return settings.auth_request_max_bytes
    return settings.json_request_max_bytes


def check(request):
    if request.method in ('GET', 'HEAD', 'OPTIONS'):
        return None
    limit = limit_for(request)
    if limit is None:
        return None
    try:
        declared = int(request.headers.get('content-length'))
    except (TypeError, ValueError):
        declared = None
    if declared is not None and declared > limit:
        raise errors.request_too_large(limit)
    # a chunked transfer encoding has no Content-Length: the body Sanic already read (under its own cap)
    body = getattr(request, 'body', None)
    if body is not None and len(body) > limit:
        raise errors.request_too_large(limit)
    return None
