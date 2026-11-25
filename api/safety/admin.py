"""The admin queue and its tools (contract milestone-4 §9.2, §9.5, §9.6, §3.6): cases, the summary,
the audit log, lookups, bans, rescans and the staff list. Synchronous, run in a thread.

Child-safety cases (and audit rows) exist only for child-safety staff; everyone else gets the
same answers as if they didn't exist.
"""

import json

from datetime import timedelta

from db.models import epoch
from safety import core, ip as abuse_ip, moderation, reports as report_rules, states
from safety.settings import safety_settings
from utils import errors
from utils.generators import EPOCH

CASE_COLUMNS = ('id', 'kind', 'priority', 'status', 'file_id', 'album_id', 'user_id', 'hash_id', 'warning_id',
                'child_safety', 'needs_second_review', 'assignee_id', 'claimed_at', 'outcome', 'outcome_reason',
                'cybertip_report_id', 'cybertip_filed_at', 'created_at', 'updated_at', 'closed_at', 'domain_id')
GOAL_P0 = 24 * 3600
GOAL_OTHER = 7 * 86400


def visible_sql(staff, alias='c'):
    return 'true' if staff.child_safety else 'NOT {}.child_safety'.format(alias)


def not_own_sql(staff, alias='c'):
    """Cases about the staff member's own account or content (the same rule as
    `require_not_own_case`): left out of their lists and counts, since they can't open them."""
    uid = int(staff.user_id)
    return ('({a}.user_id IS NULL OR {a}.user_id <> {u}) '
            'AND NOT EXISTS (SELECT 1 FROM files fo WHERE fo.user_id = {u} '
            'AND (fo.id = {a}.file_id OR fo.hash_id = {a}.hash_id)) '
            'AND NOT EXISTS (SELECT 1 FROM albums ao WHERE ao.id = {a}.album_id AND ao.owner_user_id = {u}) '
            'AND NOT EXISTS (SELECT 1 FROM user_warnings wo WHERE wo.id = {a}.warning_id AND wo.user_id = {u}) '
            'AND NOT EXISTS (SELECT 1 FROM custom_domains dmo WHERE dmo.id = {a}.domain_id AND dmo.user_id = {u})'
            ).format(a=alias, u=uid)


def listed_sql(staff, alias='c'):
    """What a staff member's case lists and counts include."""
    return '{} AND {}'.format(visible_sql(staff, alias), not_own_sql(staff, alias))


def get_case(conn, staff, case_id, lock=False):
    try:
        case_id = int(case_id)
    except (TypeError, ValueError):
        raise errors.unknown_case()
    row = core.one(conn, 'SELECT {} FROM moderation_cases c WHERE c.id = %s AND {}{}'.format(
        ', '.join('c.' + c for c in CASE_COLUMNS), visible_sql(staff), ' FOR UPDATE' if lock else ''), (case_id,))
    if row is None:
        raise errors.unknown_case()
    case = dict(zip(CASE_COLUMNS, row))
    require_not_own_case(conn, staff, case)
    return case


def require_not_own_case(conn, staff, case):
    """Staff never open, claim, decide or close a case about their own account or content
    (its reports name the reporters), nor an appeal of their own notice."""
    for kind, column in (('file', 'file_id'), ('album', 'album_id'), ('user', 'user_id'), ('hash', 'hash_id'),
                         ('warning', 'warning_id'), ('domain', 'domain_id')):
        moderation.require_not_own(conn, staff, kind, case[column])


def case_target(conn, case):
    kind = case['kind']
    if kind == 'file' and case['file_id']:
        row = core.one(conn, 'SELECT vanity, filename, extension FROM files WHERE id = %s', (case['file_id'],))
        return {'type': 'file', 'id': str(case['file_id']), 'vanity': row and row[0],
                'name': row and (row[1] + ('.' + row[2] if row[2] else '')),
                'state': report_rules.states_of_target(conn, 'file', case['file_id'])}
    if kind == 'album' and case['album_id']:
        row = core.one(conn, 'SELECT vanity, title FROM albums WHERE id = %s', (case['album_id'],))
        return {'type': 'album', 'id': str(case['album_id']), 'vanity': row and row[0], 'name': row and (row[1] or ''),
                'state': report_rules.states_of_target(conn, 'album', case['album_id'])}
    if kind == 'user' and case['user_id']:
        row = core.one(conn, 'SELECT username FROM users WHERE id = %s', (case['user_id'],))
        return {'type': 'user', 'id': str(case['user_id']), 'name': row and row[0],
                'state': report_rules.states_of_target(conn, 'user', case['user_id'])}
    if kind == 'domain' and case.get('domain_id'):
        row = core.one(conn, 'SELECT hostname, status FROM custom_domains WHERE id = %s', (case['domain_id'],))
        return {'type': 'domain', 'id': str(case['domain_id']), 'name': row and row[0], 'state': row and row[1]}
    if kind == 'hash':
        return {'type': 'hash', 'id': str(case['hash_id']) if case['hash_id'] else None,
                'state': report_rules.states_of_target(conn, 'hash', case['hash_id'])}
    if kind == 'appeal' and case['warning_id']:
        row = core.one(conn, 'SELECT appeal_state FROM user_warnings WHERE id = %s', (case['warning_id'],))
        return {'type': 'notice', 'id': str(case['warning_id']), 'state': row and row[0]}
    return None


def case_summary(conn, case):
    reasons = {}
    rows = core.all_rows(conn, "SELECT reason, reporter_user_id, reporter_fingerprint, reporter_abuse_ip_hash FROM "
                               "reports WHERE case_id = %s ORDER BY id", (case['id'],))
    for reason, *_ in rows:
        reasons[reason] = reasons.get(reason, 0) + 1
    flags = [r[0] for r in core.all_rows(conn, 'SELECT reason FROM content_flags WHERE case_id = %s ORDER BY id',
                                         (case['id'],))]
    for flag in flags:
        reasons.setdefault(flag, 0)
    assignee = None
    if case['assignee_id']:
        name = core.one(conn, 'SELECT username FROM users WHERE id = %s', (case['assignee_id'],))
        assignee = {'id': str(case['assignee_id']), 'username': name and name[0]}
    return {
        'id': str(case['id']),
        'kind': case['kind'],
        'priority': case['priority'],
        'status': case['status'],
        'target': case_target(conn, case),
        'reasons': reasons,
        'report_count': len(rows),
        'distinct_reporters': report_rules.distinct_reporters([r[1:] for r in rows]),
        'flags': flags,
        'assignee': assignee,
        'needs_second_review': case['needs_second_review'],
        'child_safety': case['child_safety'],
        'outcome': case['outcome'],
        'cybertip_report_id': case['cybertip_report_id'],
        'created_at': epoch(case['created_at']),
        'age_seconds': int((core.utcnow() - case['created_at']).total_seconds()),
    }


def list_cases(conn, staff, status='open', priority=None, reason=None, kind=None, assignee=None,
               needs_second_review=None, cursor=0, limit=50):
    where, params = [listed_sql(staff)], []
    if status in ('open', 'closed'):
        where.append('c.status = %s')
        params.append(status)
    if priority is not None:
        where.append('c.priority = %s')
        params.append(int(priority))
    if kind:
        where.append('c.kind = %s')
        params.append(kind)
    if reason:
        where.append('(EXISTS (SELECT 1 FROM reports r WHERE r.case_id = c.id AND r.reason = %s) OR EXISTS '
                     '(SELECT 1 FROM content_flags f WHERE f.case_id = c.id AND f.reason = %s))')
        params += [reason, reason]
    if assignee == 'me':
        where.append('c.assignee_id = %s')
        params.append(staff.user_id)
    elif assignee == 'none':
        where.append('c.assignee_id IS NULL')
    elif assignee:
        where.append('c.assignee_id = %s')
        params.append(int(assignee))
    if needs_second_review is not None:
        where.append('c.needs_second_review = %s')
        params.append(bool(needs_second_review))
    rows = core.all_rows(conn, 'SELECT {} FROM moderation_cases c WHERE {} ORDER BY c.priority, c.created_at, c.id '
                               'LIMIT %s OFFSET %s'.format(', '.join('c.' + c for c in CASE_COLUMNS),
                                                           ' AND '.join(where)), params + [limit + 1, cursor])
    cases = [dict(zip(CASE_COLUMNS, r)) for r in rows]
    more = len(cases) > limit
    return {'items': [case_summary(conn, c) for c in cases[:limit]],
            'next_cursor': str(cursor + limit) if more else None}


def case_detail(conn, staff, case):
    data = case_summary(conn, case)
    reports = []
    for row in core.all_rows(conn, 'SELECT r.id, r.reason, r.details, r.album_part, r.dmca, r.created_at, r.status, '
                                   'r.reporter_user_id FROM reports r WHERE r.case_id = %s ORDER BY r.id', (case['id'],)):
        reporter = {'signed_in': row[7] is not None}
        if row[7] is not None:
            reporter['user_id'] = str(row[7])
            reporter['account_age_days'] = int((core.utcnow().timestamp() - ((row[7] >> 22) + EPOCH) / 1000)
                                               // 86400)
        reports.append({'id': str(row[0]), 'reason': row[1], 'details': row[2], 'album_part': row[3], 'dmca': row[4],
                        'created_at': epoch(row[5]), 'status': row[6], 'reporter': reporter})
    data['reports'] = reports
    data['flags'] = [{'id': str(r[0]), 'source': r[1], 'reason': r[2], 'details': r[3], 'created_at': epoch(r[4]),
                      'resolved_at': epoch(r[5])} for r in core.all_rows(
        conn, 'SELECT id, source, reason, details, created_at, resolved_at FROM content_flags WHERE case_id = %s '
              'ORDER BY id', (case['id'],))]
    data['actions'] = case_actions(conn, staff, case)
    if case['kind'] == 'appeal' and case['warning_id']:
        warning = moderation.get_warning(conn, case['warning_id'])
        if warning is not None:
            notice = moderation.notice_dict(warning)
            notice['appeal']['request'] = warning['appeal_message']
            notice['appeal']['counter_notice'] = warning['appeal_counter_notice']
            data['notice'] = notice
            data['original_action'] = moderation.audit_row(conn, warning['action_id']) if warning['action_id'] else None
    if case['kind'] == 'hash' and case['child_safety'] and staff.child_safety:
        hold = core.one(conn, "SELECT snapshot FROM evidence_holds WHERE case_id = %s AND reason = 'csam' "
                              'ORDER BY id DESC LIMIT 1', (case['id'],))
        if hold and hold[0]:
            snapshot = json.loads(json.dumps(hold[0]))
            for item in snapshot.get('files') or ():
                item.pop('ip_sealed', None)
            data['evidence'] = snapshot
    return data


def case_actions(conn, staff, case):
    clauses, params = ['a.case_id = %s'], [case['id']]
    for column in ('file_id', 'album_id', 'user_id', 'hash_id', 'warning_id'):
        if case[column]:
            clauses.append('a.{} = %s'.format(column))
            params.append(case[column])
    where = '({})'.format(' OR '.join(clauses))
    if not staff.child_safety:
        where += ' AND NOT a.child_safety'
    return moderation.audit_rows(conn, where, params, 200)


def claim(conn, staff, case_id, force=False):
    case = get_case(conn, staff, case_id, lock=True)
    if case['assignee_id'] and case['assignee_id'] != staff.user_id:
        if not (force and staff.admin):
            raise errors.case_claimed(case['assignee_id'])
    conn.execute('UPDATE moderation_cases SET assignee_id = %s, claimed_at = now(), updated_at = now() WHERE id = %s',
                 (staff.user_id, case['id']))
    core.log_action(conn, staff.actor, 'claim', case_id=case['id'],
                    details={'from': str(case['assignee_id'])} if case['assignee_id'] else None)
    return case_detail(conn, staff, get_case(conn, staff, case['id']))


def release(conn, staff, case_id):
    case = get_case(conn, staff, case_id, lock=True)
    if case['assignee_id'] and case['assignee_id'] != staff.user_id and not staff.admin:
        raise errors.case_claimed(case['assignee_id'])
    conn.execute('UPDATE moderation_cases SET assignee_id = NULL, claimed_at = NULL, updated_at = now() WHERE id = %s',
                 (case['id'],))
    core.log_action(conn, staff.actor, 'release', case_id=case['id'])
    return case_detail(conn, staff, get_case(conn, staff, case['id']))


def post_message(conn, staff, case_id, report_id, body):
    case = get_case(conn, staff, case_id)
    try:
        report_id = int(report_id)
    except (TypeError, ValueError):
        raise errors.unknown_report()
    report = core.one(conn, 'SELECT reason, closed_at FROM reports WHERE id = %s AND case_id = %s', (report_id,
                                                                                                    case['id']))
    if report is None:
        raise errors.unknown_report()
    if report[0] == 'csam':
        raise errors.invalid_action('Staff never post into escalated reports')
    if report[1] is not None:
        raise errors.report_closed()
    body = report_rules.clean_text(body, field='body')
    if not body:
        raise errors.invalid_parameters({'body': 'Write a message'})
    row = core.one(conn, 'INSERT INTO report_messages (report_id, author_user_id, is_staff, body) VALUES '
                         '(%s, %s, true, %s) RETURNING id, created_at', (report_id, staff.user_id, body))
    conn.execute('UPDATE reports SET updated_at = now() WHERE id = %s', (report_id,))
    core.log_action(conn, staff.actor, 'staff_message', case_id=case['id'], report_id=report_id)
    return {'id': str(row[0]), 'author': 'staff', 'body': body, 'created_at': epoch(row[1])}


def close(conn, staff, case_id, outcome, reason=None, reporter_message=None):
    """Its reports become `resolved` (actioned) or `dismissed`; signed-in reporters get a message
    (escalated reports don't); anonymous reporters with an address are emailed by the caller.
    Returns (case, [contact emails])."""
    if outcome not in ('actioned', 'dismissed'):
        raise errors.invalid_parameters({'outcome': 'actioned or dismissed'})
    case = get_case(conn, staff, case_id, lock=True)
    if case['status'] != 'open':
        raise errors.invalid_action('This case is closed')
    status = 'resolved' if outcome == 'actioned' else 'dismissed'
    message = report_rules.clean_text(reporter_message, field='reporter_message') or \
        report_rules.CANNED_REPORTER_MESSAGE
    emails = []
    for report_id, reporter_id, reason_code, email in core.all_rows(
            conn, "SELECT id, reporter_user_id, reason, contact_email FROM reports WHERE case_id = %s "
                  "AND status = 'open'", (case['id'],)):
        conn.execute('UPDATE reports SET status = %s, resolved_at = now(), resolution_action = %s, updated_at = now() '
                     'WHERE id = %s', (status, outcome, report_id))
        if reporter_id is not None and reason_code != 'csam':
            conn.execute('INSERT INTO report_messages (report_id, author_user_id, is_staff, body) VALUES '
                         '(%s, %s, true, %s)', (report_id, staff.user_id, message))
        if reporter_id is None and email:
            emails.append((email, status))
    conn.execute('UPDATE content_flags SET resolved_at = now() WHERE case_id = %s AND resolved_at IS NULL',
                 (case['id'],))
    conn.execute("UPDATE moderation_cases SET status = 'closed', closed_at = now(), outcome = %s, outcome_reason = %s, "
                 'updated_at = now() WHERE id = %s', (outcome, (reason or '')[:2000] or None, case['id']))
    core.log_action(conn, staff.actor, 'close_case', case_id=case['id'], details={'outcome': outcome},
                    note=(reason or None))
    return case_detail(conn, staff, get_case(conn, staff, case['id'])), emails


def record_cybertip(conn, staff, case_id, report_id):
    moderation.require_child_safety(staff)
    case = get_case(conn, staff, case_id, lock=True)
    if not isinstance(report_id, (str, int)) or not str(report_id).strip() or len(str(report_id)) > 64:
        raise errors.invalid_parameters({'report_id': 'The CyberTipline report id'})
    conn.execute('UPDATE moderation_cases SET cybertip_report_id = %s, cybertip_filed_at = now(), updated_at = now() '
                 'WHERE id = %s', (str(report_id).strip(), case['id']))
    core.log_action(conn, staff.actor, 'cybertip_filed', case_id=case['id'], child_safety=True,
                    details={'report_id': str(report_id).strip()})
    return case_detail(conn, staff, get_case(conn, staff, case['id']))


def patch_case(conn, staff, case_id, needs_second_review):
    case = get_case(conn, staff, case_id, lock=True)
    conn.execute('UPDATE moderation_cases SET needs_second_review = %s, updated_at = now() WHERE id = %s',
                 (bool(needs_second_review), case['id']))
    core.log_action(conn, staff.actor, 'flag_second_review', case_id=case['id'],
                    details={'needs_second_review': bool(needs_second_review)})
    return case_detail(conn, staff, get_case(conn, staff, case['id']))


def decide_appeal(conn, staff, case_id, decision, message):
    case = get_case(conn, staff, case_id, lock=True)
    if case['kind'] != 'appeal':
        raise errors.invalid_action('This case is not an appeal')
    moderation.decide_appeal(conn, staff, case, decision, message)
    return case_detail(conn, staff, get_case(conn, staff, case['id']))


# --- the summary (§9.2) ----------------------------------------------------------------------------------------

def summary(conn, staff, settings=None):
    settings = settings or safety_settings()
    visible = listed_sql(staff)
    open_rows = core.all_rows(conn, "SELECT priority, count(*) FROM moderation_cases c WHERE status = 'open' AND {} "
                                    'GROUP BY priority'.format(visible))
    counts = {'p{}'.format(p): 0 for p in range(4)}
    for priority, count in open_rows:
        counts['p{}'.format(priority)] = count

    def scalar(sql, params=()):
        return core.one(conn, sql, params)[0]

    base = "FROM moderation_cases c WHERE status = 'open' AND " + visible
    stalled_since = core.utcnow() - timedelta(seconds=settings.scan_stalled_after)
    from utils.uploading import snowflake_since
    newest = scalar('SELECT max(created_at) ' + base + ' AND priority = 0')
    return {
        'open': counts,
        'unassigned': scalar('SELECT count(*) ' + base + ' AND assignee_id IS NULL'),
        'mine': scalar('SELECT count(*) ' + base + ' AND assignee_id = %s', (staff.user_id,)),
        'past_goal': {
            'p0': scalar('SELECT count(*) ' + base + " AND priority = 0 AND created_at < now() - interval '24 hours'"),
            'other': scalar('SELECT count(*) ' + base + " AND priority > 0 AND created_at < now() - interval '7 days'"),
        },
        'appeals': scalar('SELECT count(*) ' + base + " AND kind = 'appeal'"),
        'bugs': scalar('SELECT count(*) ' + base + " AND kind = 'bug'"),
        'scans_stalled': scalar("SELECT count(*) FROM file_hashes WHERE scan_state = 'pending' AND id < %s",
                                (snowflake_since(settings.scan_stalled_after),)),
        'cybertip_unrecorded': scalar("SELECT count(*) FROM moderation_cases WHERE child_safety AND "
                                      "cybertip_report_id IS NULL AND (kind = 'hash' OR outcome = 'actioned')")
        if staff.child_safety else 0,
        'newest_p0_at': epoch(newest),
        'stalled_since': epoch(stalled_since),
    }


def badges_staff(conn, staff):
    """`staff` in GET /users/@me/badges: {open, p0, mine}. P0 counts child-safety cases only for
    child-safety staff, NCII P0s for everyone."""
    visible = listed_sql(staff)
    row = core.one(conn, "SELECT count(*), count(*) FILTER (WHERE priority = 0), count(*) FILTER (WHERE assignee_id = %s) "
                         "FROM moderation_cases c WHERE status = 'open' AND " + visible, (staff.user_id,))
    return {'open': row[0], 'p0': row[1], 'mine': row[2]}


# --- the audit log (§9.5) ----------------------------------------------------------------------------------

def audit(conn, staff, filters, cursor=None, limit=50):
    """Admins see everything; moderators only a case's rows (`case_id`), through a case they can
    open. Child-safety rows are visible only to child-safety staff."""
    where, params = [], []
    if not staff.admin:
        if not filters.get('case_id'):
            raise errors.forbidden()
        get_case(conn, staff, filters['case_id'])
    for name, column in (('actor_id', 'actor_user_id'), ('file_id', 'file_id'), ('album_id', 'album_id'),
                         ('user_id', 'user_id'), ('case_id', 'case_id')):
        if filters.get(name):
            where.append('a.{} = %s'.format(column))
            params.append(int(filters[name]))
    if filters.get('action'):
        where.append('a.action = %s')
        params.append(filters['action'])
    if not staff.child_safety:
        where.append('NOT a.child_safety')
    if cursor:
        where.append('a.id < %s')
        params.append(int(cursor))
    items = moderation.audit_rows(conn, ' AND '.join(where) or 'true', params, limit + 1)
    more = len(items) > limit
    items = items[:limit]
    return {'items': items, 'next_cursor': items[-1]['id'] if more and items else None}


# --- bans (§9.3) -------------------------------------------------------------------------------------------

def own_ban_keys(conn, staff, requester=None, settings=None):
    """The fingerprints and abuse IP hashes that are the staff member's own: this request's device
    and network, and those recorded on their own uploads and reports."""
    settings = settings or safety_settings()
    requester = requester or {}
    fingerprints, ip_hashes = set(), set()
    if requester.get('fingerprint') is not None:
        fingerprints.add(int(requester['fingerprint']))
    current = abuse_ip.abuse_ip_hash(requester.get('ip'), settings.abuse_hash_secret)
    if current:
        ip_hashes.add(bytes(current))
    rows = core.all_rows(conn, 'SELECT DISTINCT fingerprint, uploader_abuse_ip_hash FROM files WHERE user_id = %s '
                               'AND (fingerprint IS NOT NULL OR uploader_abuse_ip_hash IS NOT NULL)', (staff.user_id,))
    rows += core.all_rows(conn, 'SELECT DISTINCT reporter_fingerprint, reporter_abuse_ip_hash FROM reports '
                                'WHERE reporter_user_id = %s', (staff.user_id,))
    for fingerprint, ip_hash in rows:
        if fingerprint is not None:
            fingerprints.add(int(fingerprint))
        if ip_hash:
            ip_hashes.add(bytes(ip_hash))
    return fingerprints, ip_hashes


def require_not_own_ban(conn, staff, fingerprint, ip_hash, requester=None, settings=None):
    """Staff never ban, or lift a ban on, their own device or network (§9.1: no acting on your
    own account or content)."""
    fingerprints, ip_hashes = own_ban_keys(conn, staff, requester, settings)
    if (fingerprint is not None and int(fingerprint) in fingerprints) or (ip_hash and bytes(ip_hash) in ip_hashes):
        raise errors.forbidden("Staff can't ban or unban their own device or network")


def require_not_own_ban_source(conn, staff, source):
    """A ban taken from the staff member's own upload or report is about themselves."""
    source = source if isinstance(source, dict) else {}
    if source.get('file_id'):
        moderation.require_not_own(conn, staff, 'file', int(source['file_id']))
    if source.get('report_id'):
        row = core.one(conn, 'SELECT reporter_user_id FROM reports WHERE id = %s', (int(source['report_id']),))
        if row is not None and row[0] is not None and int(row[0]) == int(staff.user_id):
            raise errors.forbidden("Staff can't ban or unban their own device or network")


def create_ban(conn, staff, body, settings=None, requester=None):
    settings = settings or safety_settings()
    if not isinstance(body, dict) or body.get('kind') not in ('fingerprint', 'ip'):
        raise errors.invalid_action('kind must be fingerprint or ip')
    rule = body.get('rule')
    if rule not in states.RULES:
        raise errors.invalid_action('Pick a rule')
    duration = body.get('duration')
    if duration is not None and (not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0):
        raise errors.invalid_action('duration must be a positive number of seconds')
    if duration is None or duration > moderation.MODERATOR_MAX_DAYS * 86400:
        moderation.require_admin(staff)
    source = body.get('from') if isinstance(body.get('from'), dict) else {}
    try:
        require_not_own_ban_source(conn, staff, source)
    except (TypeError, ValueError):
        raise errors.invalid_action('Name where the ban comes from')
    fingerprint = ip_hash = None
    cutoff = core.utcnow() - timedelta(days=settings.abuse_ip_keep_days)
    if source.get('file_id'):
        row = core.one(conn, 'SELECT fingerprint, user_id, uploader_abuse_ip_hash FROM files WHERE id = %s',
                       (int(source['file_id']),))
        if row is None:
            raise errors.unknown_file()
        fingerprint = row[0] if row[1] is None else None
        ip_hash = row[2]
        label = {'file_id': str(source['file_id'])}
    elif source.get('report_id'):
        row = core.one(conn, 'SELECT reporter_fingerprint, reporter_abuse_ip_hash, created_at FROM reports '
                             'WHERE id = %s', (int(source['report_id']),))
        if row is None:
            raise errors.unknown_report()
        fingerprint = row[0]
        ip_hash = row[1] if row[2] > cutoff else None
        label = {'report_id': str(source['report_id'])}
    elif source.get('fingerprint') and body['kind'] == 'fingerprint':
        try:
            fingerprint = int(source['fingerprint'])
        except (TypeError, ValueError):
            raise errors.invalid_action('Unknown fingerprint')
        label = {'fingerprint': str(fingerprint)}
    else:
        raise errors.invalid_action('Name where the ban comes from')
    if body['kind'] == 'ip':
        if not ip_hash:
            raise errors.invalid_action('That source has no IP hash any more')
        fingerprint = None
    else:
        if fingerprint is None:
            raise errors.invalid_action('That source has no fingerprint')
        ip_hash = None
    require_not_own_ban(conn, staff, fingerprint, ip_hash, requester, settings)
    expires_at = core.utcnow() + timedelta(seconds=duration) if duration else None
    ban_id, action_id = core.ban(conn, staff.actor, rule, fingerprint=fingerprint, ip_hash=bytes(ip_hash) if ip_hash else None,
                                 expires_at=expires_at, source=label, note=body.get('note') if isinstance(
                                     body.get('note'), str) else None)
    return ban_dict(conn, ban_id)


def ban_dict(conn, ban_id):
    row = core.one(conn, 'SELECT id, fingerprint IS NOT NULL, source, rule, created_at, expires_at, lifted_at FROM bans '
                         'WHERE id = %s', (ban_id,))
    return {'id': str(row[0]), 'kind': 'fingerprint' if row[1] else 'ip', 'source': row[2], 'rule': row[3],
            'created_at': epoch(row[4]), 'expires_at': epoch(row[5]), 'lifted_at': epoch(row[6])}


def list_bans(conn, active=True, cursor=None, limit=50):
    where, params = [], []
    if active:
        where.append('lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())')
    if cursor:
        where.append('id < %s')
        params.append(int(cursor))
    rows = core.all_rows(conn, 'SELECT id FROM bans WHERE {} ORDER BY id DESC LIMIT %s'.format(
        ' AND '.join(where) or 'true'), params + [limit + 1])
    items = [ban_dict(conn, r[0]) for r in rows[:limit]]
    return {'items': items, 'next_cursor': items[-1]['id'] if len(rows) > limit else None}


def lift_ban(conn, staff, ban_id, requester=None, settings=None):
    moderation.require_admin(staff)
    ban = core.one(conn, 'SELECT fingerprint, abuse_ip_hash, source FROM bans WHERE id = %s AND lifted_at IS NULL '
                         'FOR UPDATE', (int(ban_id),))
    if ban is None:
        raise errors.invalid_action('Unknown or lifted ban')
    require_not_own_ban_source(conn, staff, ban[2])
    require_not_own_ban(conn, staff, ban[0], ban[1], requester, settings)
    row = core.one(conn, 'UPDATE bans SET lifted_at = now() WHERE id = %s AND lifted_at IS NULL RETURNING id, rule, '
                         'action_id', (int(ban_id),))
    if row is None:
        raise errors.invalid_action('Unknown or lifted ban')
    core.log_action(conn, staff.actor, 'unban', rule=row[1], reverses=row[2], details={'ban_id': str(row[0])})
    return ban_dict(conn, row[0])


# --- rescans and staff (§9.6) ------------------------------------------------------------------------------

def request_rescans(conn, staff, checks, kinds=None, uploaded_after=None, limit=10000):
    from safety.scan import RESCAN_CHECKS, queue_rescan
    moderation.require_admin(staff)
    if not isinstance(checks, list) or not checks or not set(checks) <= set(RESCAN_CHECKS):
        raise errors.invalid_parameters({'checks': 'Pick from {}'.format(', '.join(RESCAN_CHECKS))})
    where, params = ["h.scan_state IN ('passed', 'flagged', 'held')",
                     'EXISTS (SELECT 1 FROM files f WHERE f.hash_id = h.id AND f.deleted_at IS NULL{})'], []
    after = ''
    if uploaded_after:
        from utils.generators import EPOCH
        after = ' AND f.id >= %s'
        params.append(max(0, int(uploaded_after) * 1000 - EPOCH) << 22)
    where[1] = where[1].format(after)
    if kinds:
        where.append("h.scan->>'kind' = ANY(%s)")
        params.append(list(kinds))
    rows = core.all_rows(conn, 'SELECT h.id FROM file_hashes h WHERE {} ORDER BY h.id LIMIT %s'.format(
        ' AND '.join(where)), params + [limit])
    for (hash_id,) in rows:
        queue_rescan(conn, hash_id, checks)
    core.log_action(conn, staff.actor, 'rescan_request', details={'checks': checks, 'kinds': kinds,
                                                                  'uploaded_after': uploaded_after,
                                                                  'queued': len(rows)})
    return {'queued': len(rows)}


def staff_list(conn, staff):
    moderation.require_admin(staff)
    rows = core.all_rows(conn, 'SELECT s.user_id, u.username, s.role, s.child_safety, s.granted_at FROM staff s '
                               'JOIN users u ON u.id = s.user_id ORDER BY s.granted_at, s.user_id')
    return {'items': [{'user_id': str(r[0]), 'username': r[1], 'role': r[2], 'child_safety': r[3],
                       'granted_at': epoch(r[4])} for r in rows]}
