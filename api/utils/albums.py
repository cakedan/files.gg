"""Album rules and JSON shapes (contract milestone-3 §4 and §6, PLAN.md "Albums").

Which items an album shows: live items (not deleted or expired), and in a `link` album
only items whose own visibility is `link`; a `password` or `private` album shows them
all, served through the album grant.

A protected album's URLs (items, cover, collage, download) are signed with the album grant
(utils/cdn_signing.py); item URLs also carry album=<vanity>. `link` URLs are never signed.
"""

import re

from db.models import epoch
from safety import states, webrisk
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
VISIBILITY_SQL = "(al.visibility <> 'link' OR f.visibility = 'link')"
# milestone-4 §6.4: and the item's effective state is `ok` or `flagged`; milestone-6 §19.6: and it has no view
# limit (opening an album can't count each item), so it's in no album page, collage, ZIP or album grant
VIEW_LIMIT_SQL = '(f.view_limit IS NULL)'
SHOWN_SQL = "({} AND {} AND {} AND {})".format(FILE_LIVE_SQL, VISIBILITY_SQL, VIEW_LIMIT_SQL, states.SHOWN_SQL_SUB)
# the owner editor's reason for an item that isn't shown because of its view limit (§19.6)
HIDDEN_VIEW_LIMIT = 'view_limit'
# not deleted or expired; a hidden or removed album is live (its pages answer 410)
ALBUM_LIVE_SQL = "(al.deleted_at IS NULL AND (al.expires_at IS NULL OR al.expires_at > now()))"
ALBUM_VISIBLE_SQL = "({} AND al.moderation_state = 'visible')".format(ALBUM_LIVE_SQL)

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
    if getattr(fobj, 'view_limit', None) is not None:
        return False
    if fobj.hash is not None and not states.shown(fobj.hash.scan_state, fobj.moderation_state):
        return False
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


def _signer(album, grant, force=False):
    if grant is not None and (album.visibility != 'link' or force):
        return grant.sign
    return lambda url: url


def _sign_all(owner):
    """Owner payloads while domain-only is effective sign every URL (milestone-6 §10.6)."""
    if not owner:
        return False
    from utils import links
    return links.current().sign_all


def collage_of(album, grant=None, force=False):
    """https://cdn.files.gg/albums/collage/<vanity>.webp?v=<collage_version>."""
    if not album.collage_key or album.collage_version is None:
        return None
    url = cdn_url('/albums/collage/{}.webp?v={}'.format(path_segment(album.vanity), album.collage_version))
    return {'url': _signer(album, grant, force)(url), 'width': COLLAGE_SIZE[0], 'height': COLLAGE_SIZE[1]}


def album_url(album):
    return public_url('/a/' + album.vanity)


def download_url(album, grant=None, force=False):
    """https://cdn.files.gg/albums/download/<vanity>.zip, signed for a protected album."""
    return _signer(album, grant, force)(cdn_url('/albums/download/{}.zip'.format(path_segment(album.vanity))))


def item_dict(fobj, position, caption, grant=None, owner=False, album=None, sign_all=False):
    """An album item: the file payload (signed with the album grant, album=<vanity>), or for
    the owner, the owner file (signed with its own file grant), plus position and caption."""
    if owner:
        data = payloads.owner_dict(fobj)
    else:
        data = payloads.public_file(fobj, grant=grant, album_item=True, sign_all=sign_all)
    data['position'] = position
    data['caption'] = caption or ''
    if owner and album is not None:
        data['shown'] = fobj_is_shown(album, fobj)
        if getattr(fobj, 'view_limit', None) is not None:
            # the editor shows "View-limited files aren't shown in albums."
            data['hidden_reason'] = HIDDEN_VIEW_LIMIT
    return data


def fobj_is_shown(album, fobj):
    return fobj.deleted_at is None and not _expired(fobj) and shown(album, fobj)


def _expired(fobj):
    import time
    return fobj.expires_at is not None and epoch(fobj.expires_at) <= int(time.time())


def album_payload(album, items, count, total_size, next_cursor=None, cover_items=None, grant=None, nsfw=None,
                  owner=False):
    """The public album payload (contract §4). `items` are [(file, position, caption)]
    already filtered to shown items. `grant` (the album grant of an unlock, a token or the
    owner) signs a protected album's URLs; without one they're plain."""
    force = _sign_all(owner)
    if album.visibility == 'link' and not force:
        grant = None
    rendered = [(f, item_dict(f, position, caption, grant=grant, sign_all=force)) for f, position, caption in items]
    data = {
        'id': str(album.id),
        'vanity': album.vanity,
        'url': album_url(album),
        'title': album.title or '',
        'description': album.description or '',
        'layout': album.layout,
        # milestone-4 §4.4: the album's own mark, or any shown item being NSFW
        'nsfw': bool(album.nsfw or nsfw),
        'visibility': album.visibility,
        'expires_at': epoch(album.expires_at),
        'count': count,
        'total_size': total_size,
        'next_cursor': next_cursor,
        'download_url': download_url(album, grant, force),
        'items': [data for _, data in rendered],
    }
    data['link_warnings'], data['link_warning_types'] = webrisk.payload_fields(album.link_warnings)
    cover_source = rendered if cover_items is None else [
        (f, payloads.public_file(f, grant=grant, album_item=True, sign_all=force)) for f in cover_items]
    cover = cover_of(album, cover_source)
    if cover is not None:
        data['cover'] = cover
    collage = collage_of(album, grant, force)
    # a public NSFW album omits its collage (milestone-4 §4.6); owner payloads keep it
    if collage is not None and (owner or not data['nsfw']):
        data['collage'] = collage
    return data


def album_state(album):
    """`ok`, `hidden` or `removed` (milestone-4 §6.3)."""
    return {'visible': 'ok'}.get(album.moderation_state, album.moderation_state)


def album_safety(album, notice_id=None, owner=False):
    state = album_state(album)
    if owner:
        reason = None
        if state != 'ok':
            reason = 'review' if album.moderation_auto or album.moderation_rule == 'csam' else album.moderation_rule
        return {'state': state, 'reason': reason, 'notice_id': None if album.moderation_rule == 'csam' else notice_id}
    return {'state': state, 'reason': states.public_reason(state, album.moderation_rule)}


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


def owner_album(album, items, notice_id=None):
    """The owner album (contract §6): every item (shown or not) as an owner file with
    `position`, `caption` and `shown`; counts and cover follow what the public sees. The
    album's own URLs (cover, collage, download) are signed for 1 h with the album grant,
    each item's with its own file grant."""
    grant = Grant.owner_album(album)
    visible = [(f, p, c) for f, p, c in items if fobj_is_shown(album, f)]
    nsfw = any(payloads.nsfw_of(f)[0] for f, _, _ in visible)
    data = album_payload(album, visible, len(visible), sum(f.size or 0 for f, _, _ in visible), grant=grant,
                         nsfw=nsfw, owner=True)
    data['items'] = [item_dict(f, p, c, owner=True, album=album) for f, p, c in items]
    data.update(owner_fields(album))
    # milestone-4 §6.2
    data['nsfw_marked'] = bool(album.nsfw)
    data['safety'] = album_safety(album, notice_id, owner=True)
    data['link_warnings'], data['link_warning_types'] = webrisk.payload_fields(album.link_warnings)
    from utils import links
    data['url'] = links.rehost(data['url'], links.current().host)
    return data


def owner_summary(album, count, shown_files=()):
    """The owner album summary (contract §6), its cover and collage signed for 1 h."""
    from utils import links
    force = _sign_all(True)
    grant = Grant.owner_album(album) if album.visibility != 'link' or force else None
    cover = cover_of(album, [(f, payloads.public_file(f, grant=grant, album_item=True, sign_all=force))
                             for f in shown_files])
    return {
        'id': str(album.id),
        'vanity': album.vanity,
        'url': links.rehost(album_url(album), links.current().host),
        'title': album.title or '',
        'layout': album.layout,
        'visibility': album.visibility,
        'count': count,
        'cover': cover,
        'collage': collage_of(album, grant, force),
        'created_at': epoch(album.created_at),
        'updated_at': epoch(album.updated_at),
    }
