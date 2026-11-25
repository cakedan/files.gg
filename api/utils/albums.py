"""Album rules and JSON shapes (contract milestone-3 §4 and §6, PLAN.md "Albums").

Which items an album shows: live items (not deleted or expired), and in a `link` album
only items whose own visibility is `link`; a `password` or `private` album shows them
all, served through the album grant.

A protected album's URLs (items, cover, collage, download) are signed with the album grant
(utils/cdn_signing.py); item URLs also carry album=<vanity>. `link` URLs are never signed.
"""

import re

from db.models import epoch
from utils import payloads
from utils.cdn_signing import Grant, path_segment
from utils.urls import cdn_url, public_url

ALBUM_VANITY_LENGTH = 8
PAGE_SIZE = 100
MAX_OWNER_ITEMS = 500
LAYOUTS = ('auto', 'grid', 'list', 'tracklist')
TITLE_MAX = 100
DESCRIPTION_MAX = 2000
CAPTION_MAX = 500
COLLAGE_SIZE = (1200, 630)

# aliases: f = files, al = albums
FILE_LIVE_SQL = '(f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > now()))'
SHOWN_SQL = "({} AND (al.visibility <> 'link' OR f.visibility = 'link'))".format(FILE_LIVE_SQL)
ALBUM_LIVE_SQL = ("(al.deleted_at IS NULL AND (al.expires_at IS NULL OR al.expires_at > now()) "
                  "AND al.moderation_state = 'visible')")

_CONTROL = re.compile('[\x00-\x09\x0b-\x1f\x7f-\x9f]')


def clean_text(value, limit, field):
    """Plain text: control characters other than \\n stripped; at most `limit` characters.
    Empty becomes None."""
    if value is None:
        return None
    text = _CONTROL.sub('', str(value).replace('\r\n', '\n')).strip()
    if len(text) > limit:
        raise ValueError('{} must be {} characters or fewer'.format(field, limit))
    return text or None


def shown(album, fobj):
    """The Python twin of SHOWN_SQL, for a live file."""
    return album.visibility != 'link' or fobj.visibility == 'link'


def is_tracklist(album, files):
    if album.layout == 'tracklist':
        return True
    return album.layout == 'auto' and bool(files) and all(payloads.kind_of(f.mimetype_id) == 'audio' for f in files)


def cover_of(album, items):
    """`cover`: the cover_file_id item's best image, else automatic (the first visual
    item's thumbnail; for a tracklist, the first `cover`). Only shown items count.
    `items` are [(file, payload)], already signed as the album's payload is."""
    by_id = {f.id: data for f, data in items}
    if album.cover_file_id in by_id:
        best = best_image(by_id[album.cover_file_id])
        if best is not None:
            return best
    files = [f for f, _ in items]
    if is_tracklist(album, files):
        for _, data in items:
            if 'cover' in data['assets']:
                return dict(data['assets']['cover'], type='cover')
    for _, data in items:
        if data.get('thumbnail'):
            return dict(data['thumbnail'])
    return None


# the largest still image of an item, best first: (preview kind, `type`)
BEST_IMAGE = (('poster', 'poster'), ('cover', 'cover'), ('display', 'display'), ('thumb-2x', 'thumb'),
              ('thumb', 'thumb'), ('waveform', 'waveform'))


def best_image(data):
    """The largest still image of an item: poster, cover, display, thumb-2x, thumb,
    waveform, or the original when it's a browser image."""
    assets = data['assets']
    for kind, image_type in BEST_IMAGE:
        if kind in assets:
            return dict(assets[kind], type=image_type)
    if data['kind'] == 'image':
        image = {'url': data['cdn_url'], 'type': 'image'}
        if data.get('width') and data.get('height'):
            image['width'], image['height'] = data['width'], data['height']
        return image
    return None


def _signer(album, grant):
    if grant is not None and album.visibility != 'link':
        return grant.sign
    return lambda url: url


def collage_of(album, grant=None):
    """https://cdn.files.gg/albums/collage/<vanity>.webp?v=<collage_version>."""
    if not album.collage_key or album.collage_version is None:
        return None
    url = cdn_url('/albums/collage/{}.webp?v={}'.format(path_segment(album.vanity), album.collage_version))
    return {'url': _signer(album, grant)(url), 'width': COLLAGE_SIZE[0], 'height': COLLAGE_SIZE[1]}


def album_url(album):
    return public_url('/a/' + album.vanity)


def download_url(album, grant=None):
    """https://cdn.files.gg/albums/download/<vanity>.zip, signed for a protected album."""
    return _signer(album, grant)(cdn_url('/albums/download/{}.zip'.format(path_segment(album.vanity))))


def item_dict(fobj, position, caption, grant=None, owner=False, album=None):
    """An album item: the file payload (signed with the album grant, album=<vanity>), or for
    the owner, the owner file (signed with its own file grant), plus position and caption."""
    if owner:
        data = payloads.owner_dict(fobj)
    else:
        data = payloads.public_file(fobj, grant=grant, album_item=True)
    data['position'] = position
    data['caption'] = caption or ''
    if owner and album is not None:
        data['shown'] = fobj_is_shown(album, fobj)
    return data


def fobj_is_shown(album, fobj):
    return fobj.deleted_at is None and not _expired(fobj) and shown(album, fobj)


def _expired(fobj):
    import time
    return fobj.expires_at is not None and epoch(fobj.expires_at) <= int(time.time())


def album_payload(album, items, count, total_size, next_cursor=None, cover_items=None, grant=None):
    """The public album payload (contract §4). `items` are [(file, position, caption)]
    already filtered to shown items. `grant` (the album grant of an unlock, a token or the
    owner) signs a protected album's URLs; without one they're plain."""
    if album.visibility == 'link':
        grant = None
    rendered = [(f, item_dict(f, position, caption, grant=grant)) for f, position, caption in items]
    data = {
        'id': str(album.id),
        'vanity': album.vanity,
        'url': album_url(album),
        'title': album.title or '',
        'description': album.description or '',
        'layout': album.layout,
        'nsfw': False,
        'visibility': album.visibility,
        'expires_at': epoch(album.expires_at),
        'count': count,
        'total_size': total_size,
        'next_cursor': next_cursor,
        'download_url': download_url(album, grant),
        'items': [data for _, data in rendered],
    }
    cover_source = rendered if cover_items is None else [
        (f, payloads.public_file(f, grant=grant, album_item=True)) for f in cover_items]
    cover = cover_of(album, cover_source)
    if cover is not None:
        data['cover'] = cover
    collage = collage_of(album, grant)
    if collage is not None:
        data['collage'] = collage
    return data


def locked_album(album, password_expired=False):
    data = {'vanity': album.vanity, 'protected': 'password'}
    if album.show_name_when_locked and album.title:
        data['title'] = album.title
    if password_expired:
        data['password_expired'] = True
    return data


def owner_fields(album):
    return {
        'access_version': album.access_version,
        'unlock_ttl': album.unlock_ttl,
        'password_expires_at': epoch(album.password_expires_at),
        'show_name_when_locked': album.show_name_when_locked,
        'cover_file_id': str(album.cover_file_id) if album.cover_file_id is not None else None,
        'created_at': epoch(album.created_at),
        'updated_at': epoch(album.updated_at),
    }


def owner_album(album, items):
    """The owner album (contract §6): every item (shown or not) as an owner file with
    `position`, `caption` and `shown`; counts and cover follow what the public sees. The
    album's own URLs (cover, collage, download) are signed for 1 h with the album grant,
    each item's with its own file grant."""
    grant = Grant.owner_album(album)
    visible = [(f, p, c) for f, p, c in items if fobj_is_shown(album, f)]
    data = album_payload(album, visible, len(visible), sum(f.size or 0 for f, _, _ in visible), grant=grant)
    data['items'] = [item_dict(f, p, c, owner=True, album=album) for f, p, c in items]
    data.update(owner_fields(album))
    return data


def owner_summary(album, count, shown_files=()):
    """The owner album summary (contract §6), its cover and collage signed for 1 h."""
    grant = Grant.owner_album(album) if album.visibility != 'link' else None
    cover = cover_of(album, [(f, payloads.public_file(f, grant=grant, album_item=True)) for f in shown_files])
    return {
        'id': str(album.id),
        'vanity': album.vanity,
        'url': album_url(album),
        'title': album.title or '',
        'layout': album.layout,
        'visibility': album.visibility,
        'count': count,
        'cover': cover,
        'collage': collage_of(album, grant),
        'created_at': epoch(album.created_at),
        'updated_at': epoch(album.updated_at),
    }
