"""The public URLs the API writes into responses and emails.

    PUBLIC_URL   the site, default https://files.gg       (file pages, #pw= and #t= links, email links)
    CDN_URL      the CDN, default https://cdn.files.gg    (file bytes: urls.cdn and cdnUrl)

Read on every call, so the defaults keep production (and the golden responses)
byte-identical, and a local or staging stack only sets two variables.
"""

import os

DEFAULT_PUBLIC_URL = 'https://files.gg'
DEFAULT_CDN_URL = 'https://cdn.files.gg'


def _base(name, default):
    return (os.getenv(name) or default).strip().rstrip('/')


def public_url(path=''):
    """`https://files.gg` + path (path starts with '/')."""
    return _base('PUBLIC_URL', DEFAULT_PUBLIC_URL) + path


def cdn_url(path=''):
    """`https://cdn.files.gg` + path (path starts with '/')."""
    return _base('CDN_URL', DEFAULT_CDN_URL) + path


def validate(environ=os.environ):
    """Refuse to boot with a PUBLIC_URL or CDN_URL that isn't a bare http(s) origin."""
    from urllib.parse import urlsplit
    for name, default in (('PUBLIC_URL', DEFAULT_PUBLIC_URL), ('CDN_URL', DEFAULT_CDN_URL)):
        value = (environ.get(name) or default).strip().rstrip('/')
        parts = urlsplit(value)
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.path or parts.query or parts.fragment:
            raise RuntimeError('{} must be an http(s) origin such as {}, got {!r}'.format(name, default, value))
