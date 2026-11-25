"""Signed CDN URLs (contract milestone-3 §3): how protected files and albums are served.

    signature = base64url_nopad(HMAC-SHA256(CDN_SIGNING_SECRET,
                  "filesgg-cdn-1" + "\\n" + <path> + "\\n" + <expires> + "\\n" + <grant>))
    grant     = "file:<file id>:<file access_version>"
              | "album:<album id>:<album access_version>"

Only the API signs; the CDN Worker verifies with the same secret. `path` is the URL's
path exactly as it appears in the URL (percent-encoded), without the host or query, so a
signed URL is good for that one path. `expires` and `sig` are appended to the query; `v`
and `download` aren't signed. Items of a protected album also carry `album=<vanity>` and
use the album grant. Public (`link`) URLs are never signed.
"""

import base64
import hashlib
import hmac
import time

from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit

VERSION = 'filesgg-cdn-1'
# the Worker refuses anything that expires later than this from now
MAX_SECONDS = 31 * 86400
# what an owner payload's URLs last (contract §6)
OWNER_SECONDS = 3600

# set once per process by app.py from CDN_SIGNING_SECRET
_secret = None


def configure(secret):
    global _secret
    _secret = secret or None


def signature(path, expires, grant, secret=None):
    secret = secret if secret is not None else _secret
    if not secret:
        raise RuntimeError('CDN_SIGNING_SECRET is not configured')
    message = '{}\n{}\n{}\n{}'.format(VERSION, path, int(expires), grant)
    digest = hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode('ascii')


def path_segment(vanity):
    """A vanity as it appears in a CDN URL path: percent-encoded except '/', so the path we
    sign is exactly what `new URL(url).pathname` returns in the Worker."""
    from urllib.parse import quote
    return quote(vanity, safe='/')


def file_grant(fobj):
    return 'file:{}:{}'.format(fobj.id, int(fobj.access_version))


def album_grant(album):
    return 'album:{}:{}'.format(album.id, int(album.access_version))


@dataclass(frozen=True)
class Grant:
    """Who a payload's URLs are signed for: a file grant, or an album grant (whose item
    URLs carry `album=<vanity>`), valid until `expires` (epoch s)."""
    grant: str
    expires: int
    album_vanity: Optional[str] = None

    @classmethod
    def for_file(cls, fobj, expires):
        return cls(file_grant(fobj), cap(expires))

    @classmethod
    def for_album(cls, album, expires):
        return cls(album_grant(album), cap(expires), album.vanity)

    @classmethod
    def owner_file(cls, fobj, now=None):
        return cls.for_file(fobj, _now(now) + OWNER_SECONDS)

    @classmethod
    def owner_album(cls, album, now=None):
        return cls.for_album(album, _now(now) + OWNER_SECONDS)

    def sign(self, url, item=False):
        """`url` with `[album=<vanity>&]expires=<e>&sig=<s>` appended. `item` marks the URL
        of an album item (only album grants add `album=`)."""
        params = []
        if item and self.album_vanity is not None:
            params.append(('album', self.album_vanity))
        params += [('expires', str(self.expires)),
                   ('sig', signature(urlsplit(url).path, self.expires, self.grant))]
        return append_query(url, params)


def append_query(url, params):
    from urllib.parse import urlencode
    separator = '&' if '?' in url else '?'
    return url + separator + urlencode(params)


def cap(expires, now=None):
    """Never past the Worker's sanity cap."""
    return min(int(expires), _now(now) + MAX_SECONDS)


def _now(now=None):
    return int(time.time()) if now is None else int(now)
