"""Worker <-> API lookups (contract milestone-3 §5), only for the Worker's own lookups: requests
carrying its ORIGIN_SHARED_SECRET *and* `X-Filesgg-Internal-Lookup: 1`. The Worker also adds the
secret to every client request it forwards (for the client IP), but strips the lookup header
from them, so a forwarded request never gets here. Otherwise the answer is the same 404 as an
unknown vanity, so the endpoint can't be probed.

    GET /internal/files/<vanity>
    GET /internal/albums/<vanity>

Milestone 4 (§6.3): both carry `safety`; the album lookup also `pending_count`, and the file
lookup `serve_inline`. A hash-matched CSAM file answers 404, exactly like an unknown vanity.

Every CDN path names a vanity (files, previews, collages, ZIPs), so there are no lookups by
id. Payloads here are unsigned; the Worker verifies signed URLs against `access` and
`albums` and never signs.
"""

from sanic import Blueprint

import db
from db import albums as album_queries
from db import queries
from db.models import epoch
from utils import albums as album_rules
from utils import errors, payloads, storage as storage_module
from safety.states import CSAM_REASONS
from utils.responses import ApiResponse
from utils.wrappers import route

internal = Blueprint('internal', url_prefix='/internal')


async def file_lookup(conn, fobj):
    return {
        # milestone-4 §6.3: the reduced effective state and the public reason; the Worker treats a
        # lookup without `safety` as pending (fail closed)
        'safety': payloads.lookup_safety(fobj),
        'serve_inline': bool(fobj.hash.serve_inline),
        'file': payloads.public_file(fobj),
        'access': payloads.access_dict(fobj),
        'owner_user_id': str(fobj.user_id) if fobj.user_id is not None else None,
        # albums the file is a shown item of, as [{"id", "vanity", "access_version"}]: the Worker
        # accepts a URL signed through an album grant (album=<vanity>) only through this list
        'albums': await album_queries.shown_in_albums(conn, fobj.id),
        'storage': {'key': storage_module.blob_key(fobj.hash_id), 'size': fobj.hash.size},
        # previews by kind (contract §5); previews_version is their ?v=
        'previews': payloads.previews_dict(fobj),
        'previews_version': epoch(fobj.hash.derived_at),
    }


@route(internal, '/files/<vanity:path>', ['GET'])
async def lookup_file(request, vanity):
    if not request.ctx.internal_lookup:
        raise errors.unknown_file()
    async with db.connection() as conn:
        fobj = await queries.get_file_by_vanity(conn, vanity.split('.').pop(0))
        # hash-matched CSAM looks exactly like an unknown vanity: nothing to serve or sign for (§6.3)
        if fobj is None or fobj.hash.scan_reason in CSAM_REASONS:
            raise errors.unknown_file()
        return ApiResponse(await file_lookup(conn, fobj))


async def album_lookup(conn, album):
    """{album, access, items_access, items_storage, collage, safety, pending_count}, or None when
    the album shows no items and none are being checked (the Worker renders `missing`). Items are
    only those whose effective state is ok (flagged counts as ok), milestone-4 §6.3."""
    safety = album_rules.album_safety(album)
    if safety['state'] != 'ok':
        payload = album_rules.album_payload(album, [], 0, 0, None, cover_items=[])
        payload.pop('collage', None)
        return {'album': payload, 'access': payloads.access_dict(album), 'items_access': {}, 'items_storage': {},
                'collage': None, 'safety': safety, 'pending_count': 0}
    every, _ = await album_queries.shown_items(conn, album, limit=None)
    pending = await album_queries.pending_count(conn, album.id)
    if not every and not pending:
        return None
    page, cursor = every[:album_rules.PAGE_SIZE], (
        str(every[album_rules.PAGE_SIZE - 1][1]) if len(every) > album_rules.PAGE_SIZE else None)
    nsfw = await album_queries.any_shown_nsfw(conn, album.id) if every else False
    payload = album_rules.album_payload(
        album, page, len(every), sum(f.size or 0 for f, _, _ in every), cursor,
        cover_items=[f for f, _, _ in every], nsfw=nsfw)
    return {
        'safety': safety,
        'pending_count': pending,
        'album': payload,
        'access': payloads.access_dict(album),
        # `safety` and `expires_at` let the Worker check every ZIP item itself (fail closed): an
        # item without an entry, not ok, or expired is never zipped
        'items_access': {str(f.id): {'visibility': f.visibility, 'access_version': f.access_version,
                                     'safety': payloads.lookup_safety(f), 'expires_at': epoch(f.expires_at)}
                         for f, _, _ in every},
        # every shown item, in album order, for "Download all"
        'items_storage': {str(f.id): {'key': storage_module.blob_key(f.hash_id), 'size': f.hash.size,
                                      'filename': f.full_filename}
                          for f, _, _ in every},
        'collage': ({'key': album.collage_key, 'version': album.collage_version}
                    if album.collage_key else None),
    }


@route(internal, '/albums/<vanity:path>', ['GET'])
async def lookup_album(request, vanity):
    if not request.ctx.internal_lookup:
        raise errors.unknown_album()
    async with db.connection() as conn:
        album = await album_queries.get_album_by_vanity(conn, vanity)
        if album is None:
            raise errors.unknown_album()
        body = await album_lookup(conn, album)
    if body is None:
        raise errors.unknown_album()
    return ApiResponse(body)
