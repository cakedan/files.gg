"""JSON shapes for files beyond the old `File.to_dict()` (which stays
byte-identical for the existing endpoints and the golden responses)."""

from db.models import epoch
from utils.generators import Snowflake
from utils.urls import public_url

BROWSER_IMAGES = frozenset((
    'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
    'image/x-icon', 'image/vnd.microsoft.icon', 'image/x-png',
))


def kind_of(mimetype):
    """The viewer's `kind` (web/README.md §3)."""
    mimetype = (mimetype or '').lower()
    if mimetype in BROWSER_IMAGES:
        return 'image'
    if mimetype == 'application/pdf':
        return 'pdf'
    major = mimetype.split('/', 1)[0]
    if major in ('video', 'audio'):
        return major
    if major == 'text' and mimetype not in ('text/html', 'text/xml', 'text/xsl'):
        return 'text'
    return 'file'


def upload_dict(fobj, password=None):
    """`POST /files` and chunked-upload results: today's object plus
    `expires_at` (epoch s or null) and `visibility`; `password` and
    `url_with_password` only right after a password was generated."""
    data = fobj.to_dict()
    data['expires_at'] = epoch(fobj.expires_at)
    data['visibility'] = fobj.visibility
    if password is not None:
        data['password'] = password
        data['url_with_password'] = public_url('/{}#pw={}'.format(fobj.vanity, password))
    return data


def owner_dict(fobj):
    """What the owner sees about a file's access settings."""
    data = upload_dict(fobj)
    data.update({
        'access_version': fobj.access_version,
        'unlock_ttl': fobj.unlock_ttl,
        'password_expires_at': epoch(fobj.password_expires_at),
        'show_name_when_locked': fobj.show_name_when_locked,
    })
    return data


def public_file(fobj):
    """The viewer payload (web/README.md §3): the file object plus the viewer's
    fields. URLs never carry a token."""
    data = upload_dict(fobj)
    expires = epoch(fobj.expires_at)
    data.update({
        'kind': kind_of(fobj.mimetype_id),
        'cdnUrl': data['urls']['cdn'],
        'url': data['urls']['main'],
        'uploadedAt': Snowflake.decode(fobj.id)['timestamp'],
        'expiresAt': expires * 1000 if expires is not None else None,
    })
    return data


def locked_file(fobj, password_expired=False):
    """`GET /files/<vanity>` for a password file without access (PLAN.md)."""
    data = {'vanity': fobj.vanity, 'protected': 'password'}
    if fobj.show_name_when_locked:
        data['filename'] = fobj.to_dict()['filename']
    if password_expired:
        data['password_expired'] = True
    return data


def access_dict(fobj):
    return {
        'visibility': fobj.visibility,
        'access_version': fobj.access_version,
        'unlock_ttl': fobj.unlock_ttl,
        'password_expires_at': epoch(fobj.password_expires_at),
        'show_name_when_locked': fobj.show_name_when_locked,
    }
