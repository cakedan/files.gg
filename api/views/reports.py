"""Reports, notices and badges (contract milestone-4 §7, §8):

    POST /reports                                   signed in
    POST /reports/anonymous                         Authorization: Guest optional, turnstile_token required
    GET  /users/@me/reports?status&query&offset&limit
    GET  /users/@me/reports/<id>
    GET  /users/@me/reports/<id>/messages           (marks it read)
    POST /users/@me/reports/<id>/messages { body }
    PATCH /users/@me/reports/<id> { "status": "open" }
    GET  /users/@me/warnings?unacknowledged&offset&limit
    POST /users/@me/warnings/acknowledge { ids }
    POST /users/@me/warnings/<id>/appeal { message, counter_notice? }
    GET  /users/@me/badges

The rules live in safety/reports.py and safety/moderation.py (synchronous, run in a thread).
"""

from functools import wraps

from sanic import Blueprint
from sanic.exceptions import NotFound

import db
from safety import moderation, reports as report_rules
from safety.run import in_thread
from utils import access_token, errors, params, standing
from utils.email import Email
from utils.auth import guest_of, require_session
from utils.helpers import client_ip
from utils.responses import ApiResponse
from utils.turnstile import Turnstile
from utils.wrappers import route


reports = Blueprint('reports', url_prefix='/reports')
my_safety = Blueprint('my_safety', url_prefix='/users/<me:str>')


def body_of(request):
    body = params.request_json(request)
    if body is None and request.form:
        body = {k: v[0] if isinstance(v, list) and len(v) == 1 else v for k, v in request.form.items()}
    return body if isinstance(body, dict) else {}


def reporter_of(request, user=None, guest_id=None):
    """Who is reporting, plus the claims of the album token they sent (X-Filesgg-Access), which an
    item of a protected album needs."""
    return {'user_id': user.id if user else None, 'guest_id': guest_id if user is None else None,
            'ip_hash': report_rules.reporter_ip(client_ip(request)),
            'album_claims': access_token.decode(getattr(request.ctx, 'access_token', None),
                                                request.app.ctx.access_secret)}


@route(reports, '', ['POST'])
async def create_report(request):
    user, _ = require_session(request)
    async with db.connection() as conn:
        await standing.check_not_suspended(conn, user)
    status, body = await in_thread(report_rules.submit, reporter_of(request, user), body_of(request))
    return ApiResponse(body, status=status)


@route(reports, '/anonymous', ['POST'])
async def create_anonymous_report(request):
    body = body_of(request)
    if not await Turnstile.verify(body.get('turnstile_token'), 'report', client_ip(request)):
        raise errors.captcha_invalid()
    status, response = await in_thread(report_rules.submit, reporter_of(request, None, guest_of(request)), body)
    return ApiResponse(response, status=status)


# --- the signed-in user's reports, notices and badges ------------------------------------------------------

def signed_in(func):
    @wraps(func)
    async def wrapper(request, *args, me, **kwargs):
        if me != '@me':
            raise NotFound('Not Found')
        user, _ = require_session(request)
        return await func(request, user, *args, **kwargs)
    return wrapper


def _int(value, default, low, high, field):
    if value in (None, ''):
        return default
    try:
        number = int(value)
    except ValueError:
        raise errors.invalid_parameters({field: 'Must be a number'})
    if not low <= number <= high:
        raise errors.invalid_parameters({field: 'Must be between {} and {}'.format(low, high)})
    return number


def _report_id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise errors.unknown_report()


@route(my_safety, '/reports', ['GET'])
@signed_in
async def my_reports(request, user):
    args = request.get_args()
    status = args.get('status') or None
    if status not in (None, 'open', 'resolved', 'dismissed'):
        raise errors.invalid_parameters({'status': 'open, resolved or dismissed'})
    offset = _int(args.get('offset'), 0, 0, 10 ** 9, 'offset')
    limit = _int(args.get('limit'), 25, 1, 100, 'limit')
    return ApiResponse(await in_thread(report_rules.list_reports, user.id, status, args.get('query'), offset, limit))


def _own_report(conn, report_id, user_id):
    report = report_rules.get_report(conn, report_id, user_id)
    if report is None:
        raise errors.unknown_report()
    return report


@route(my_safety, '/reports/<report_id:str>', ['GET'])
@signed_in
async def my_report(request, user, report_id):
    report_id = _report_id(report_id)

    def work(conn):
        return report_rules.report_dict(conn, _own_report(conn, report_id, user.id), user.id)
    return ApiResponse(await in_thread(work))


@route(my_safety, '/reports/<report_id:str>', ['PATCH'])
@signed_in
async def reopen_report(request, user, report_id):
    report_id = _report_id(report_id)
    body = body_of(request)
    if body.get('status') != 'open':
        raise errors.invalid_parameters({'status': 'Only "open" (reopen) is allowed'})

    def work(conn):
        return report_rules.reopen(conn, _own_report(conn, report_id, user.id), user.id)
    return ApiResponse(await in_thread(work))


@route(my_safety, '/reports/<report_id:str>/messages', ['GET'])
@signed_in
async def report_messages(request, user, report_id):
    report_id = _report_id(report_id)

    def work(conn):
        return report_rules.messages(conn, _own_report(conn, report_id, user.id), user.id)
    return ApiResponse(await in_thread(work))


@route(my_safety, '/reports/<report_id:str>/messages', ['POST'])
@signed_in
async def post_report_message(request, user, report_id):
    report_id = _report_id(report_id)
    body = body_of(request)

    def work(conn):
        return report_rules.add_message(conn, _own_report(conn, report_id, user.id), user.id, body.get('body'))
    return ApiResponse(await in_thread(work), status=201)


@route(my_safety, '/warnings', ['GET'])
@signed_in
async def my_warnings(request, user):
    args = request.get_args()
    unacknowledged = (args.get('unacknowledged') or '').lower() in ('1', 'true', 'yes')
    offset = _int(args.get('offset'), 0, 0, 10 ** 9, 'offset')
    limit = _int(args.get('limit'), 25, 1, 100, 'limit')
    return ApiResponse(await in_thread(moderation.list_warnings, user.id, unacknowledged, offset, limit))


@route(my_safety, '/warnings/acknowledge', ['POST'])
@signed_in
async def acknowledge_warnings(request, user):
    ids = body_of(request).get('ids')
    if not isinstance(ids, list) or len(ids) > 100:
        raise errors.invalid_parameters({'ids': 'A list of up to 100 notice ids'})
    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        raise errors.invalid_parameters({'ids': 'A list of up to 100 notice ids'})
    return ApiResponse(await in_thread(moderation.acknowledge, user.id, ids))


@route(my_safety, '/warnings/<warning_id:str>/appeal', ['POST'])
@signed_in
async def appeal_warning(request, user, warning_id):
    try:
        warning_id = int(warning_id)
    except ValueError:
        raise errors.unknown_warning()
    body = body_of(request)
    return ApiResponse(await in_thread(moderation.appeal, user.id, warning_id, body.get('message'),
                                       body.get('counter_notice')))


@route(my_safety, '/badges', ['GET'])
@signed_in
async def badges(request, user):
    """{reports_unread, notices_unacknowledged, restrictions, staff} (§8.3)."""
    from safety import admin as admin_rules
    from db.models import epoch

    def work(conn):
        unread = 0
        for (report_id,) in conn.execute('SELECT id FROM reports WHERE reporter_user_id = %s AND closed_at IS NULL',
                                         (user.id,)).fetchall():
            unread += report_rules.unread_count(conn, report_rules.get_report(conn, report_id), user.id)
        notices = conn.execute('SELECT count(*) FROM user_warnings WHERE user_id = %s AND acknowledged_at IS NULL',
                               (user.id,)).fetchone()[0]
        from safety import core
        restrictions = [{'kind': kind, 'until': epoch(ends_at), 'notice_id': str(notice) if notice else None}
                        for _, kind, _, ends_at, notice in core.active_restrictions(conn, user.id)]
        staff = moderation.staff_of(conn, user.id)
        return {'reports_unread': unread, 'notices_unacknowledged': notices, 'restrictions': restrictions,
                'staff': admin_rules.badges_staff(conn, staff) if staff else None}
    return ApiResponse(await in_thread(work))


async def email_reporters(emails):
    """Anonymous reporters with a contact address hear once when their report is resolved or
    dismissed: neutral, no details of the action or the uploader (§7.6)."""
    from utils import email_templates
    for address, status in emails:
        subject, html, text = email_templates.report_update(status=status)
        try:
            await Email.send(to=address, subject=subject, html=html, text=text, tag='report-update')
        except Exception:
            pass
