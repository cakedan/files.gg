"""Owner-facing links (contract milestone-6 §10.6, §10.9). Upload responses and owner payloads use the owner's
**link domain** for `url` (and `url_with_password`), and add `direct_url`:

    link domain = the upload key's pinned domain if serving (uploads through that key),
                  else the default domain if serving, else files.gg (no custom domain)

`cdn_url` and the asset URLs stay on cdn.files.gg. While the owner's domain-only mode is effective, owner
payloads sign **every** URL with the owner's grant, `link` files included, so the dashboard keeps working on
files.gg. Public payloads are unchanged (the Worker and the viewer rehost them).

A handler calls `await prepare(conn, user, key)` once; the payload code reads the result through a context
variable, so the many owner payload call sites stay as they are.
"""

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from utils.urls import cdn_url

_current = ContextVar('filesgg_owner_links', default=None)


@dataclass(frozen=True)
class Links:
    host: Optional[str] = None
    sign_all: bool = False


NONE = Links()


async def prepare(conn, user, key=None):
    """The owner's link domain and domain-only state, for this request's owner payloads."""
    from utils import domains
    if user is None:
        _current.set(NONE)
        return NONE
    host = None
    base = ('SELECT d.hostname FROM custom_domains d JOIN users u ON u.id = d.user_id WHERE d.user_id = %s AND '
            + domains.SERVING_SQL)
    if key is not None and getattr(key, 'domain_id', None):
        cursor = await conn.execute(base + ' AND d.id = %s', (user.id, key.domain_id))
        row = await cursor.fetchone()
        host = row[0] if row else None
    if host is None:
        cursor = await conn.execute(base + ' AND d.is_default', (user.id,))
        row = await cursor.fetchone()
        host = row[0] if row else None
    cursor = await conn.execute('SELECT ' + domains.domain_only_sql('u') + ' FROM users u WHERE u.id = %s', (user.id,))
    row = await cursor.fetchone()
    links = Links(host, bool(row and row[0]))
    _current.set(links)
    return links


def current():
    return _current.get() or NONE


def rehost(url, host):
    """§10.9: a files.gg or cdn.files.gg URL with only its hostname replaced. The scheme and port stay those of
    the configured origin (`PUBLIC_URL` / `CDN_URL`), and the path, query and fragment stay byte for byte, as the
    Worker's rehosting does. In production that's `https://<host>`; on a local http stack it keeps `http://` and
    the port, so links reach the same `wrangler dev`."""
    from utils.urls import public_url
    if not host:
        return url
    parts = urlsplit(url)
    origin = '{}://{}'.format(parts.scheme, parts.netloc)
    if origin not in (cdn_url(), public_url()):
        return url
    netloc = '{}:{}'.format(host, parts.port) if parts.port else host
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def apply(data, links=None):
    """`url` on the link domain, and `direct_url` (the bytes, signed like `cdn_url`)."""
    links = links or current()
    if links.host:
        data['url'] = rehost(data['url'], links.host)
        data['direct_url'] = rehost(data['cdn_url'], links.host)
        if data.get('url_with_password'):
            data['url_with_password'] = rehost(data['url_with_password'], links.host)
    else:
        data['direct_url'] = data['cdn_url']
    return data
