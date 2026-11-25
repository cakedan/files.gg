"""Worker <-> API lookups (contract milestone-3 §5), only for the Worker's own lookups: requests
carrying its ORIGIN_SHARED_SECRET *and* `X-Filesgg-Internal-Lookup: 1`. The Worker also adds the
secret to every client request it forwards (for the client IP), but strips the lookup header
from them, so a forwarded request never gets here. Otherwise the answer is the same 404 as an
unknown vanity, so the endpoint can't be probed.

    GET /internal/files/<vanity>
    GET /internal/albums/<vanity>

Milestone 4 (§6.3): both carry `safety`; the album lookup also `pending_count`, and the file
lookup `serve_inline`. A hash-matched CSAM file answers 404, exactly like an unknown vanity.

Milestone 6 §19.5: the file lookup adds `view_limit` ({ limit, used, action } or null); view-limited files are
never album items, so they're never in an album lookup.

Milestone 7 (§4.2): `GET /internal/metrics`, Prometheus' scrape (utils/metrics.py), behind the same guard: Prometheus
sends the secret and the lookup header from the compose network (monitoring/prometheus/prometheus.yml).

Milestone 6 (§10.7): `GET /internal/domains/<hostname>` (the custom-host router's lookup), and the file and
album lookups add `owner_state` ("active" | "pending_deletion", null for anonymous owners) and `served_on`
("files.gg" | "custom", domain-only mode); the album lookup also `owner_user_id`.

Every CDN path names a vanity (files, previews, collages, ZIPs), so there are no lookups by
id. Payloads here are unsigned; the Worker verifies signed URLs against `access` and
`albums` and never signs.
"""

from sanic import Blueprint
from sanic.response import HTTPResponse

import db
from db import albums as album_queries
from db import queries
from db.models import epoch
from utils import albums as album_rules
from utils import errors, metrics, payloads, storage as storage_module, view_limits
from safety.states import CSAM_REASONS
from utils.responses import ApiResponse
from utils.wrappers import route

internal = Blueprint('internal', url_prefix='/internal')


async def owner_flags(conn, user_id):
    """(owner_state, served_on) of a file's or album's owner (§8.8, §10.6)."""
    if user_id is None:
        return None, 'files.gg'
    from utils import domains
    cursor = await conn.execute('SELECT u.deleted_at IS NULL AND u.deletion_requested_at IS NULL, {} FROM users u '
                                'WHERE u.id = %s'.format(domains.domain_only_sql('u')), (user_id,))
    row = await cursor.fetchone()
    if row is None:
        return 'pending_deletion', 'files.gg'
    return ('active' if row[0] else 'pending_deletion'), ('custom' if row[1] else 'files.gg')


async def file_lookup(conn, fobj):
    owner_state, served_on = await owner_flags(conn, fobj.user_id)
    return {
        'owner_state': owner_state,
        'served_on': served_on,
        # milestone-4 §6.3: the reduced effective state and the public reason; the Worker treats a
        # lookup without `safety` as pending (fail closed)
        'safety': payloads.lookup_safety(fobj),
        'serve_inline': bool(fobj.hash.serve_inline),
        # milestone-6 §19.5: { limit, used, action }, or null. While it's set the Worker serves the file like a
        # protected one: the `limited` shell, no og media, no CDN redirect, bytes only through signed URLs
        'view_limit': view_limits.lookup_field(fobj),
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
        if body is not None:
            owner_state, served_on = await owner_flags(conn, album.owner_user_id)
            from views.albums import album_owner
            body['album']['owner'] = await album_owner(conn, album)
            body.update({'owner_user_id': str(album.owner_user_id) if album.owner_user_id is not None else None,
                         'owner_state': owner_state, 'served_on': served_on})
    if body is None:
        raise errors.unknown_album()
    return ApiResponse(body)


@route(internal, '/domains/<hostname:str>', ['GET'])
async def lookup_domain(request, hostname):
    """§10.7: { domain: { id, hostname, user_id, scope, serving } }; 404 for an unknown, deleted or malformed
    hostname. Not serving (pending, failed, paused, disabled, or an owner with a pending deletion) is
    `serving: false`."""
    if not request.ctx.internal_lookup:
        raise errors.not_found()
    from safety.run import in_thread
    from utils import domains
    found = await in_thread(domains.lookup_hostname, hostname.lower(), transaction=False)
    if found is None or found['hostname'] != hostname.lower():
        raise errors.not_found()
    return ApiResponse({'domain': found})


@route(internal, '/metrics', ['GET'])
async def scrape_metrics(request):
    """Every files.gg metric in Prometheus' text format; the same 404 as any unknown path otherwise."""
    if not request.ctx.internal_lookup:
        raise errors.not_found()
    return HTTPResponse(await metrics.render(), content_type=metrics.CONTENT_TYPE)
