"""The file payload (contract milestone-3 §4): one shape for every endpoint that returns a
file (`GET /files/<vanity>`, uploads, /access unlock, view and refresh, the internal lookup, album
items and the owner's library). snake_case, times in epoch seconds.

URLs are ready to use. `link` files get plain URLs. A protected file's URLs are signed
(utils/cdn_signing.py) for whoever may see it, through the `grant` the caller passes: an
unlock, an owner (1 h), or an album grant. Without a grant they're plain, and the CDN
refuses them.
"""

from db.models import epoch
from safety import states, webrisk
from media import BROWSER_IMAGES, base_kind, is_other_image, preview_extension  # noqa: F401  (re-exported)
from utils.cdn_signing import path_segment
from utils.generators import Snowflake
from utils.urls import cdn_url, public_url

# the media keys copied to the payload's top level
TOP_LEVEL_MEDIA = ('width', 'height', 'duration', 'framecount')
# contract §4 "thumbnail": the best preview for the kind, in order
THUMBNAIL_ORDER = {
    'video': ('poster',),
    'audio': ('cover', 'waveform'),
}
DEFAULT_THUMBNAIL_ORDER = ('thumb',)


def kind_of(mimetype):
    """The viewer's `kind` from the mimetype alone."""
    return base_kind(mimetype)


def needs_signing(target, grant, sign_all=False):
    """A protected target's URLs are signed; with `sign_all` (an owner payload while domain-only is
    effective, milestone-6 §10.6) every URL is. A view-limited file is served like a protected one
    (milestone-6 §19.4): its URLs are always signed, and without a grant they're plain, which the CDN refuses."""
    from utils import view_limits
    return grant is not None and (target.visibility != 'link' or sign_all or view_limits.limited(target))


def file_url(fobj):
    return public_url('/' + fobj.vanity + fobj.suffix)


def file_cdn_url(fobj):
    return cdn_url('/files/' + path_segment(fobj.vanity) + fobj.suffix)


def preview_url(fobj, kind, version):
    """https://cdn.files.gg/previews/<kind>/<vanity>.<ext>?v=<derived_at> (contract §3)."""
    return cdn_url('/previews/{}/{}.{}?v={}'.format(kind, path_segment(fobj.vanity), preview_extension(kind), version))


def assets_dict(fobj, sign=None):
    """{"thumb": {"url", "width", "height"}, "peaks": {"url"}, ...}: every ready preview."""
    fhash = fobj.hash
    if fhash is None or fhash.derived_at is None or not fhash.assets:
        return {}
    version = epoch(fhash.derived_at)
    out = {}
    for asset in fhash.assets:
        url = preview_url(fobj, asset.kind, version)
        entry = {'url': sign(url) if sign else url}
        if asset.width is not None and asset.height is not None:
            entry['width'], entry['height'] = asset.width, asset.height
        out[asset.kind] = entry
    return out


def thumbnail_of(kind, assets):
    for name in THUMBNAIL_ORDER.get(kind, DEFAULT_THUMBNAIL_ORDER):
        if name in assets:
            return dict(assets[name], type=name)
    return None


def processing(fobj):
    return fobj.hash is not None and fobj.hash.processing_state in ('pending', 'probed')


def viewer_kind(fobj, assets):
    if fobj.hash is not None and not fobj.hash.serve_inline:
        # milestone-4 §2.3: our decoders couldn't read it, so it's never shown inline
        return 'file'
    kind = kind_of(fobj.mimetype_id)
    # HEIC, TIFF, PSD, ...: shown through their `display` preview (contract §4)
    if kind == 'file' and is_other_image(fobj.mimetype_id) and 'display' in assets:
        return 'image'
    return kind


def public_media(fobj, owner=False):
    media = dict((fobj.hash.media if fobj.hash is not None else None) or {})
    if not owner:
        media.pop('snippet', None)
    return media


def public_file(fobj, grant=None, owner=False, album_item=False, sign_all=False):
    """The file payload. `grant` (a cdn_signing.Grant) signs a protected file's URLs;
    `album_item` marks it as an album item (album grants then add album=)."""
    sign = (lambda url: grant.sign(url, item=album_item)) if needs_signing(fobj, grant, sign_all) else None
    assets = assets_dict(fobj, sign)
    media = public_media(fobj, owner=owner)
    kind = viewer_kind(fobj, assets)
    raw_cdn = file_cdn_url(fobj)
    data = {
        'id': str(fobj.id),
        'vanity': fobj.vanity,
        'kind': kind,
        'name': fobj.filename,
        'extension': fobj.extension,
        'filename': fobj.full_filename,
        'mimetype': fobj.mimetype_id,
        'size': fobj.size if fobj.size is not None else (fobj.hash.size if fobj.hash is not None else 0),
        'url': file_url(fobj),
        'cdn_url': sign(raw_cdn) if sign else raw_cdn,
        'visibility': fobj.visibility,
        'uploaded_at': Snowflake.decode(fobj.id)['timestamp'] // 1000,
        'expires_at': epoch(fobj.expires_at),
        'views': fobj.view_count,
        'media': media,
        'width': None,
        'height': None,
        'duration': None,
        'framecount': None,
        'processing': processing(fobj),
        'assets': assets,
        'nsfw': nsfw_of(fobj)[0],
        # milestone-4 §6.1: visitor warnings and the links Web Risk flagged; never why it's flagged
        'warnings': list(scan_doc(fobj).get('warnings') or []),
    }
    # only matches within Google's expireTime may be shown (§5.7): plain URLs, plus their threat types
    data['link_warnings'], data['link_warning_types'] = webrisk.payload_fields(scan_doc(fobj).get('link_warnings'))
    for key in TOP_LEVEL_MEDIA:
        if media.get(key) is not None:
            data[key] = media[key]
    thumbnail = thumbnail_of(kind_of(fobj.mimetype_id), assets)
    if thumbnail is not None:
        data['thumbnail'] = thumbnail
    if 'hover' in assets:
        data['hover_url'] = assets['hover']['url']
    # milestone-6 §19.6: { remaining }, only when the file has a view limit
    from utils import view_limits
    if view_limits.limited(fobj):
        data['view_limit'] = view_limits.public_field(fobj)
    return data


def scan_doc(fobj):
    return (fobj.hash.scan if fobj.hash is not None else None) or {}


def nsfw_of(fobj):
    """(nsfw, nsfw_source) per milestone-4 §4.4."""
    nsfw_auto = fobj.hash.nsfw_auto if fobj.hash is not None else False
    return states.file_nsfw(fobj.nsfw_override, fobj.nsfw_override_source, fobj.nsfw_marked, nsfw_auto)


def file_state(fobj):
    scan_state = fobj.hash.scan_state if fobj.hash is not None else 'pending'
    return states.owner_state(scan_state, fobj.moderation_state)


def lookup_safety(fobj):
    """The internal lookup's `safety` (milestone-4 §6.3): the reduced state, and the public
    reason for hidden and removed."""
    state = file_state(fobj)
    state = 'ok' if state == 'flagged' else state
    return {'state': state, 'reason': states.public_reason(state, fobj.moderation_rule)}


def safety_dict(fobj):
    """The owner's `safety` (milestone-4 §6.2)."""
    h = fobj.hash
    state = file_state(fobj)
    extra = fobj.safety_extra or {}
    _, source = nsfw_of(fobj)
    reason = states.owner_reason(state, h.scan_reason if h else None, fobj.moderation_rule, fobj.moderation_auto,
                                 h.scan_state if h else None)
    csam = h is not None and h.scan_reason in states.CSAM_REASONS or fobj.moderation_rule == 'csam'
    return {
        'state': state,
        'reason': reason,
        'notice_id': None if csam else extra.get('notice_id'),
        'nsfw_source': source,
        'nsfw_locked': states.nsfw_locked(fobj.nsfw_override, h.nsfw_auto if h else False),
        'nsfw_review': extra.get('nsfw_review') or 'none',
    }


def with_safety(data, fobj):
    data['safety'] = safety_dict(fobj)
    return data


def with_password(data, fobj, password):
    """Right after a password was generated: shown once (on the owner's link domain, milestone-6 §10.9)."""
    from utils import links
    if password is not None:
        data['password'] = password
        data['url_with_password'] = links.rehost(public_url('/{}#pw={}'.format(fobj.vanity, password)),
                                                 links.current().host)
    return data


def owner_upload(fobj, grant=None):
    """An upload response (POST /files, a finished chunked upload): the public payload signed for the
    uploader, with `safety`, on the owner's link domain with `direct_url` (milestone-6 §10.9)."""
    from utils import links
    from utils.cdn_signing import Grant
    current = links.current()
    from utils import view_limits
    data = with_safety(public_file(fobj, grant=grant or Grant.owner_file(fobj), sign_all=current.sign_all), fobj)
    # milestone-6 §19.6: the owner's view-limit fields (replacing the public `view_limit`)
    data.update(view_limits.owner_fields(fobj))
    return links.apply(data, current)


def owner_dict(fobj, grant=None):
    """The owner file (contract §6): the public payload signed for 1 h with the file grant,
    plus the access settings, `media.snippet`, and the albums the file is in."""
    from utils import links
    from utils.cdn_signing import Grant
    current = links.current()
    data = public_file(fobj, grant=grant or Grant.owner_file(fobj), owner=True, sign_all=current.sign_all)
    links.apply(data, current)
    with_safety(data, fobj)
    data.update({
        'access_version': fobj.access_version,
        'unlock_ttl': fobj.unlock_ttl,
        'password_expires_at': epoch(fobj.password_expires_at),
        'show_name_when_locked': fobj.show_name_when_locked,
        'albums': [{'id': str(album_id), 'vanity': vanity, 'title': title}
                   for album_id, vanity, title in (fobj.albums or ())],
    })
    # milestone-6 §19.6: the owner's view-limit fields (replacing the public `view_limit`)
    from utils import view_limits
    data.update(view_limits.owner_fields(fobj))
    return data


def locked_file(fobj, password_expired=False):
    """`GET /files/<vanity>` for a password file without access."""
    data = {'vanity': fobj.vanity, 'protected': 'password'}
    if fobj.show_name_when_locked:
        data['filename'] = fobj.full_filename
    if password_expired:
        data['password_expired'] = True
    return data


def access_dict(target):
    """A file's or an album's access settings (the internal lookups' `access`)."""
    return {
        'visibility': target.visibility,
        'access_version': target.access_version,
        'unlock_ttl': target.unlock_ttl,
        'password_expires_at': epoch(target.password_expires_at),
        'show_name_when_locked': target.show_name_when_locked,
    }


def previews_dict(fobj):
    """The internal lookup's `previews` (contract §5): storage keys by kind."""
    if fobj.hash is None:
        return {}
    return {a.kind: {'key': a.storage_key, 'content_type': a.content_type, 'size': a.size}
            for a in fobj.hash.assets}
