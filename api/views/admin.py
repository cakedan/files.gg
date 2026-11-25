"""The admin API (contract milestone-4 §9). Every `/admin/*` endpoint answers a non-staff caller
(signed out, a bad token, or no `staff` row) with the same 404 as an unknown route; a staff
member without the needed permission gets 403 FORBIDDEN.
"""

from functools import wraps

from sanic import Blueprint

import db
from db import albums as album_queries
from db import queries
from safety import admin as admin_rules, core, moderation, states, webrisk
from safety.run import in_thread
from safety.settings import safety_settings
from utils import albums as album_rules
from utils import errors, parameters, params, payloads, standing
from utils.cdn_signing import sign_staff
from utils.generators import EPOCH
from utils.helpers import client_ip, get_user
from utils.responses import ApiError, ApiResponse
from utils.wrappers import route

admin = Blueprint('admin', url_prefix='/admin')


def staff_only(func):
    @wraps(func)
    async def wrapper(request, *args, **kwargs):
        authorization = request.headers.get('authorization')
        if not authorization:
            raise errors.not_found()
        async with db.connection() as conn:
            try:
                user = await get_user(conn, authorization)
            except ApiError:
                raise errors.not_found()
            cursor = await conn.execute('SELECT role, child_safety FROM staff WHERE user_id = %s', (user.id,))
            row = await cursor.fetchone()
            # a suspended staff member is no staff member (§8.4): the same 404 as everyone else
            suspended = row is not None and await standing.suspension(conn, user.id) is not None
        if row is None or suspended:
            raise errors.not_found()
        return await func(request, moderation.Staff(user.id, row[0], row[1]), *args, **kwargs)
    return wrapper


def requester_of(request):
    """The staff member's own device and network for this request (ban self-checks, §9.1)."""
    raw = request.headers.get('x-fingerprint')
    return {'ip': client_ip(request), 'fingerprint': parameters.fingerprint(raw) if raw else None}


def body_of(request):
    body = params.request_json(request)
    return body if isinstance(body, dict) else {}


def _id(value, error=errors.unknown_case):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise error()


# --- the queue (§9.2) -------------------------------------------------------------------------------------

@route(admin, '/summary', ['GET'])
@staff_only
async def summary(request, staff):
    return ApiResponse(await in_thread(admin_rules.summary, staff))


@route(admin, '/cases', ['GET'])
@staff_only
async def list_cases(request, staff):
    args = request.get_args()

    def flag(value):
        return None if value in (None, '') else value.lower() in ('1', 'true', 'yes')
    try:
        cursor = int(args.get('cursor') or 0)
        limit = min(100, max(1, int(args.get('limit') or 50)))
        priority = int(args.get('priority')) if args.get('priority') not in (None, '') else None
        assignee = args.get('assignee') or None
        if assignee not in (None, 'me', 'none'):
            int(assignee)
    except ValueError:
        raise errors.invalid_parameters({'query': 'Invalid filter'})
    return ApiResponse(await in_thread(
        admin_rules.list_cases, staff, args.get('status') or 'open', priority, args.get('reason') or None,
        args.get('kind') or None, assignee, flag(args.get('needs_second_review')), cursor, limit))


@route(admin, '/cases/<case_id:str>', ['GET'])
@staff_only
async def get_case(request, staff, case_id):
    def work(conn):
        return admin_rules.case_detail(conn, staff, admin_rules.get_case(conn, staff, case_id))
    return ApiResponse(await in_thread(work))


@route(admin, '/cases/<case_id:str>', ['PATCH'])
@staff_only
async def patch_case(request, staff, case_id):
    body = body_of(request)
    if not isinstance(body.get('needs_second_review'), bool):
        raise errors.invalid_parameters({'needs_second_review': 'true or false'})
    return ApiResponse(await in_thread(admin_rules.patch_case, staff, case_id, body['needs_second_review']))


@route(admin, '/cases/<case_id:str>/claim', ['POST'])
@staff_only
async def claim_case(request, staff, case_id):
    return ApiResponse(await in_thread(admin_rules.claim, staff, case_id, body_of(request).get('force') is True))


@route(admin, '/cases/<case_id:str>/release', ['POST'])
@staff_only
async def release_case(request, staff, case_id):
    return ApiResponse(await in_thread(admin_rules.release, staff, case_id))


@route(admin, '/cases/<case_id:str>/messages', ['POST'])
@staff_only
async def case_message(request, staff, case_id):
    body = body_of(request)
    return ApiResponse(await in_thread(admin_rules.post_message, staff, case_id, body.get('report_id'),
                                       body.get('body')), status=201)


@route(admin, '/cases/<case_id:str>/close', ['POST'])
@staff_only
async def close_case(request, staff, case_id):
    from views.reports import email_reporters
    body = body_of(request)
    case, emails = await in_thread(admin_rules.close, staff, case_id, body.get('outcome'), body.get('reason'),
                                   body.get('reporter_message'))
    await email_reporters(emails)
    return ApiResponse(case)


@route(admin, '/cases/<case_id:str>/appeal', ['POST'])
@staff_only
async def decide_appeal(request, staff, case_id):
    body = body_of(request)
    return ApiResponse(await in_thread(admin_rules.decide_appeal, staff, case_id, body.get('decision'),
                                       body.get('message')))


@route(admin, '/cases/<case_id:str>/cybertip', ['POST'])
@staff_only
async def record_cybertip(request, staff, case_id):
    return ApiResponse(await in_thread(admin_rules.record_cybertip, staff, case_id, body_of(request).get('report_id')))


# --- actions and bans (§9.3) -----------------------------------------------------------------------------------

@route(admin, '/actions', ['POST'])
@staff_only
async def take_action(request, staff):
    return ApiResponse(await in_thread(moderation.perform, staff, body_of(request), transaction=False))


@route(admin, '/bans', ['POST'])
@staff_only
async def create_ban(request, staff):
    return ApiResponse(await in_thread(admin_rules.create_ban, staff, body_of(request), requester=requester_of(request)),
                       status=201)


@route(admin, '/bans', ['GET'])
@staff_only
async def list_bans(request, staff):
    args = request.get_args()
    active = (args.get('active') or 'true').lower() not in ('0', 'false', 'no')
    return ApiResponse(await in_thread(admin_rules.list_bans, active, args.get('cursor') or None))


@route(admin, '/bans/<ban_id:str>', ['DELETE'])
@staff_only
async def lift_ban(request, staff, ban_id):
    return ApiResponse(await in_thread(admin_rules.lift_ban, staff, _id(ban_id, errors.invalid_action),
                                       requester=requester_of(request)))


# --- the audit log, rescans and staff (§9.5, §9.6) ---------------------------------------------------------

@route(admin, '/audit', ['GET'])
@staff_only
async def audit(request, staff):
    args = request.get_args()
    filters = {k: args.get(k) for k in ('actor_id', 'action', 'file_id', 'album_id', 'user_id', 'case_id')
               if args.get(k)}
    try:
        for key in ('actor_id', 'file_id', 'album_id', 'user_id', 'case_id'):
            if key in filters:
                int(filters[key])
        limit = min(100, max(1, int(args.get('limit') or 50)))
        cursor = int(args['cursor']) if args.get('cursor') else None
    except ValueError:
        raise errors.invalid_parameters({'query': 'Invalid filter'})
    return ApiResponse(await in_thread(admin_rules.audit, staff, filters, cursor, limit))


@route(admin, '/rescans', ['POST'])
@staff_only
async def rescans(request, staff):
    body = body_of(request)
    kinds = body.get('kinds')
    if kinds is not None and (not isinstance(kinds, list) or not all(isinstance(k, str) for k in kinds)):
        raise errors.invalid_parameters({'kinds': 'A list of kinds'})
    after = body.get('uploaded_after')
    if after is not None and (not isinstance(after, int) or isinstance(after, bool)):
        raise errors.invalid_parameters({'uploaded_after': 'Epoch seconds'})
    return ApiResponse(await in_thread(admin_rules.request_rescans, staff, body.get('checks'), kinds, after),
                       status=202)


@route(admin, '/staff', ['GET'])
@staff_only
async def staff_list(request, staff):
    return ApiResponse(await in_thread(admin_rules.staff_list, staff))


# --- lookup and target detail (§9.6) ---------------------------------------------------------------------------

LOOKUP_LIMIT = 10


@route(admin, '/lookup', ['GET'])
@staff_only
async def lookup(request, staff):
    q = (request.get_args().get('q') or '').strip()
    out = {'files': [], 'albums': [], 'users': []}
    if not q:
        return ApiResponse(out)
    file_vanities, album_vanities = [], []
    if '://' in q:
        from safety.reports import parse_url
        try:
            target = parse_url(q)
        except ApiError:
            return ApiResponse(out)
        (file_vanities if target['type'] == 'file' else album_vanities).append(target['vanity'])
    else:
        file_vanities.append(q.split('.', 1)[0])
        album_vanities.append(q)
    async with db.connection() as conn:
        files = await queries.files_where(conn, 'f.vanity = ANY(%s)', (file_vanities,), limit=LOOKUP_LIMIT, live=False)
        if q.isdigit():
            files += await queries.files_where(conn, 'f.id = %s', (int(q),), live=False)
        await album_queries.attach_albums(conn, files)
        cursor = await conn.execute('SELECT id, vanity, title, moderation_state, owner_user_id FROM albums WHERE '
                                    'vanity = ANY(%s) OR id = %s LIMIT %s',
                                    (album_vanities, int(q) if q.isdigit() else -1, LOOKUP_LIMIT))
        albums = await cursor.fetchall()
        cursor = await conn.execute(
            'SELECT id, username, email FROM users WHERE id = %s OR lower(email) = lower(%s) OR lower(username) = '
            'lower(%s) ORDER BY id LIMIT %s', (int(q) if q.isdigit() and len(q) < 20 else -1, q, q, LOOKUP_LIMIT))
        users = await cursor.fetchall()
    out['files'] = [admin_file_summary(f) for f in files][:LOOKUP_LIMIT]
    out['albums'] = [{'id': str(a[0]), 'vanity': a[1], 'title': a[2] or '', 'moderation_state': a[3],
                      'owner_user_id': str(a[4]) if a[4] else None} for a in albums]
    out['users'] = [{'id': str(u[0]), 'username': u[1], 'email': u[2]} for u in users]
    return ApiResponse(out)


def admin_file_summary(fobj):
    return {'id': str(fobj.id), 'vanity': fobj.vanity, 'filename': fobj.full_filename, 'mimetype': fobj.mimetype_id,
            'state': payloads.file_state(fobj), 'deleted': fobj.deleted_at is not None,
            'owner_user_id': str(fobj.user_id) if fobj.user_id else None}


class _Unsigned:
    """A grant that signs nothing. Admin payloads carry plain URLs only, never an owner's or an
    album's grant: staff see protected media solely through `staff_urls` (the 10-minute staff
    grant, logged as `view_content`, gated for child safety; §9.6, §10.3)."""

    def sign(self, url, item=False):
        return url


UNSIGNED = _Unsigned()


def admin_file(fobj):
    """The owner file shape (§9.6), with plain URLs."""
    return payloads.owner_dict(fobj, grant=UNSIGNED)


def admin_album(album, items):
    """The owner album shape (§9.6) with plain URLs: utils/albums.owner_album, minus its grants."""
    visible = [(f, p, c) for f, p, c in items if album_rules.fobj_is_shown(album, f)]
    nsfw = any(payloads.nsfw_of(f)[0] for f, _, _ in visible)
    data = album_rules.album_payload(album, visible, len(visible), sum(f.size or 0 for f, _, _ in visible),
                                     grant=UNSIGNED, nsfw=nsfw, owner=True)
    data['items'] = []
    for fobj, position, caption in items:
        item = admin_file(fobj)
        item.update({'position': position, 'caption': caption or '', 'shown': album_rules.fobj_is_shown(album, fobj)})
        data['items'].append(item)
    data.update(album_rules.owner_fields(album))
    data['nsfw_marked'] = bool(album.nsfw)
    data['safety'] = album_rules.album_safety(album, None, owner=True)
    data['link_warnings'], data['link_warning_types'] = webrisk.payload_fields(album.link_warnings)
    return data


def staff_urls(fobj, staff, child_safety_case, ttl):
    """The staff grant (§10.3): content and previews for 10 minutes. Never for hash-matched
    content, and for child-safety cases only for child-safety staff."""
    if fobj.hash is None or fobj.hash.scan_reason in states.CSAM_REASONS or fobj.deleted_at is not None:
        return None
    if child_safety_case and not staff.child_safety:
        return None
    content = sign_staff(payloads.file_cdn_url(fobj), staff.user_id, fobj.id, ttl)
    previews = {}
    if fobj.hash.derived_at is not None:
        from db.models import epoch
        version = epoch(fobj.hash.derived_at)
        for asset in fobj.hash.assets:
            previews[asset.kind] = sign_staff(payloads.preview_url(fobj, asset.kind, version), staff.user_id, fobj.id,
                                              ttl)
    return {'content': content, 'previews': previews}


def _scan_for_staff(fhash):
    """The hash's scan, findings included, with CSAM details omitted."""
    document = dict(fhash.scan or {})
    checks = dict(document.get('checks') or {})
    if 'csam' in checks:
        checks['csam'] = {'result': checks['csam'].get('result')}
    document['checks'] = checks
    return document


@route(admin, '/files/<file_id:str>', ['GET'])
@staff_only
async def file_detail(request, staff, file_id):
    file_id = _id(file_id, errors.unknown_file)
    async with db.connection() as conn:
        fobj = await queries.get_file(conn, file_id)
        if fobj is None:
            raise errors.unknown_file()
        await album_queries.attach_albums(conn, [fobj])
    data = admin_file(fobj)
    ttl = safety_settings().staff_url_ttl

    def work(conn):
        cases = core.all_rows(conn, 'SELECT id, kind, status, priority, child_safety FROM moderation_cases WHERE '
                                    '(file_id = %s OR hash_id = %s) ORDER BY id DESC LIMIT 50', (fobj.id, fobj.hash_id))
        child_safety = any(c[4] for c in cases)
        if child_safety and not staff.child_safety and any(c[4] and c[2] == 'open' for c in cases):
            raise errors.forbidden()
        owner_row = core.one(conn, 'SELECT username FROM users WHERE id = %s', (fobj.user_id,)) if fobj.user_id else None
        same = core.all_rows(conn, 'SELECT id FROM files WHERE hash_id = %s AND id <> %s ORDER BY id LIMIT 100',
                             (fobj.hash_id, fobj.id))
        reports = core.all_rows(conn, 'SELECT id, reason, status, case_id, created_at FROM reports WHERE file_id = %s '
                                      'ORDER BY id DESC LIMIT 50', (fobj.id,))
        urls = staff_urls(fobj, staff, child_safety, ttl)
        if urls is not None:
            core.log_action(conn, staff.actor, 'view_content', file_id=fobj.id, hash_id=fobj.hash_id,
                            details={'kinds': ['content'] + sorted(urls['previews'])})
        actions = moderation.audit_rows(
            conn, '(a.file_id = %s OR a.hash_id = %s)' + ('' if staff.child_safety else ' AND NOT a.child_safety'),
            (fobj.id, fobj.hash_id), 100)
        from db.models import epoch
        return {
            'owner': {'user_id': str(fobj.user_id) if fobj.user_id else None,
                      'username': owner_row and owner_row[0],
                      'fingerprint': str(fobj.fingerprint) if fobj.fingerprint is not None and fobj.user_id is None
                      else None,
                      'account_created_at': ((fobj.user_id >> 22) + EPOCH) // 1000 if fobj.user_id else None,
                      'anonymous': fobj.user_id is None},
            'same_hash': {'count': len(same), 'ids': [str(r[0]) for r in same] if staff.admin else None},
            'reports': [{'id': str(r[0]), 'reason': r[1], 'status': r[2], 'case_id': str(r[3]) if r[3] else None,
                         'created_at': epoch(r[4])} for r in reports],
            'cases': [{'id': str(c[0]), 'kind': c[1], 'status': c[2], 'priority': c[3], 'child_safety': c[4]}
                      for c in cases if staff.child_safety or not c[4]],
            'actions': actions,
            'staff_urls': urls,
        }
    extra = await in_thread(work)
    data.update({k: v for k, v in extra.items() if k != 'staff_urls' or v is not None})
    data['scan'] = _scan_for_staff(fobj.hash)
    data['scan_state'] = fobj.hash.scan_state
    # held because its scan kept failing (`scan_failing`); staff can retry it (`retry_scan`)
    data['scan_stuck'] = fobj.hash.scan_stuck_at is not None
    data['scan_reason'] = fobj.hash.scan_reason
    data['nsfw_score'] = fobj.hash.nsfw_score
    data['moderation_state'] = fobj.moderation_state
    data['moderation_rule'] = fobj.moderation_rule
    data['deleted_reason'] = fobj.deleted_reason
    return ApiResponse(data)


@route(admin, '/albums/<album_id:str>', ['GET'])
@staff_only
async def album_detail(request, staff, album_id):
    album_id = _id(album_id, errors.unknown_album)
    async with db.connection() as conn:
        cursor = await conn.execute('SELECT {} FROM albums AS al WHERE al.id = %s'.format(album_queries.ALBUM_COLUMNS),
                                    (album_id,))
        row = await cursor.fetchone()
        if row is None:
            raise errors.unknown_album()
        from db.models import Album, from_row
        album = from_row(Album, row)
        items = await album_queries.owner_items(conn, album.id)
        await album_queries.attach_albums(conn, [f for f, _, _ in items])
    data = admin_album(album, items)
    ttl = safety_settings().staff_url_ttl

    def work(conn):
        child_safety = core.one(conn, "SELECT 1 FROM moderation_cases WHERE album_id = %s AND child_safety AND "
                                      "status = 'open'", (album.id,)) is not None
        if child_safety and not staff.child_safety:
            raise errors.forbidden()
        signed = {}
        # an item tied to a child-safety case (any, like file detail) is signed only for child-safety staff
        flagged = {r[0] for r in core.all_rows(
            conn, 'SELECT f.id FROM files f WHERE f.id = ANY(%s) AND EXISTS (SELECT 1 FROM moderation_cases c WHERE '
                  'c.child_safety AND (c.file_id = f.id OR c.hash_id = f.hash_id))', ([f.id for f, _, _ in items],))}
        for fobj, _, _ in items:
            urls = staff_urls(fobj, staff, child_safety or fobj.id in flagged, ttl)
            if urls is not None:
                signed[fobj.id] = urls
        if signed:
            core.log_action(conn, staff.actor, 'view_content', album_id=album.id,
                            details={'files': [str(i) for i in signed], 'kinds': ['content', 'previews']})
        return signed
    signed = await in_thread(work)
    for item in data['items']:
        urls = signed.get(int(item['id']))
        if urls is not None:
            item['staff_urls'] = urls
    data.update({'moderation_state': album.moderation_state, 'moderation_rule': album.moderation_rule,
                 'moderated_at': album.moderated_at and int(album.moderated_at.timestamp()),
                 'nsfw_source': album.nsfw_source, 'deleted': album.deleted_at is not None,
                 'owner_user_id': str(album.owner_user_id) if album.owner_user_id else None})
    return ApiResponse(data)


@route(admin, '/users/<user_id:str>', ['GET'])
@staff_only
async def user_detail(request, staff, user_id):
    user_id = _id(user_id, errors.unknown_user)
    async with db.connection() as conn:
        user = await queries.get_user(conn, user_id)
        if user is None:
            raise errors.unknown_user()
        files = await queries.files_where(conn, 'f.user_id = %s', (user_id,), limit=50, live=False)
        await album_queries.attach_albums(conn, files)

    def work(conn):
        from db.models import epoch
        settings = safety_settings()
        # like file and album detail: an account tied to an open child-safety case (as its
        # target, or through its files, albums or their hashes) is for child-safety staff only
        if not staff.child_safety and core.one(conn, (
                "SELECT 1 FROM moderation_cases c WHERE c.child_safety AND c.status = 'open' AND (c.user_id = %s "
                'OR c.file_id IN (SELECT id FROM files WHERE user_id = %s) '
                'OR c.album_id IN (SELECT id FROM albums WHERE owner_user_id = %s) '
                'OR c.hash_id IN (SELECT hash_id FROM files WHERE user_id = %s)) LIMIT 1'), (user_id,) * 4):
            raise errors.forbidden()
        staff_row = moderation.staff_of(conn, user_id)
        restrictions = core.all_rows(conn, 'SELECT id, kind, rule, starts_at, ends_at, lifted_at FROM user_restrictions '
                                           'WHERE user_id = %s ORDER BY id DESC', (user_id,))
        strikes = core.one(conn, "SELECT count(*) FROM user_warnings WHERE user_id = %s AND counts_as_strike AND "
                                 "appeal_state <> 'granted' AND created_at > now() - make_interval(days => %s)",
                           (user_id, settings.strikes_window_days))[0]
        warnings = core.one(conn, 'SELECT count(*) FROM user_warnings WHERE user_id = %s', (user_id,))[0]
        counts = core.one(conn, (
            'SELECT (SELECT count(*) FROM files WHERE user_id = %s AND deleted_at IS NULL), '
            '(SELECT count(*) FROM albums WHERE owner_user_id = %s AND deleted_at IS NULL), '
            '(SELECT count(*) FROM reports WHERE reporter_user_id = %s), '
            '(SELECT count(*) FROM reports r WHERE r.user_id = %s OR r.file_id IN (SELECT id FROM files '
            'WHERE user_id = %s) OR r.album_id IN (SELECT id FROM albums WHERE owner_user_id = %s))'),
            (user_id,) * 6)
        return {
            'user': {'id': str(user.id), 'username': user.username, 'email': user.email,
                     'created_at': ((user.id >> 22) + EPOCH) // 1000, 'verified': user.verified},
            'staff': staff_row.to_dict() if staff_row else None,
            'restrictions': [{'id': str(r[0]), 'kind': r[1], 'rule': r[2] if r[2] != 'csam' or staff.child_safety
                              else 'review', 'starts_at': epoch(r[3]), 'ends_at': epoch(r[4]),
                              'lifted_at': epoch(r[5])} for r in restrictions],
            'warnings': {'count': warnings, 'strikes': strikes},
            'counts': {'files': counts[0], 'albums': counts[1], 'reports_made': counts[2],
                       'reports_against': counts[3]},
        }
    data = await in_thread(work)
    data['files'] = [admin_file(f) for f in files]
    return ApiResponse(data)

