"""The report system (contract milestone-4 §7): targets, reasons, rate limits, distinct
reporters, automatic effects, and the reporter's view. Synchronous: the API runs it in a
thread (safety/run.py), one transaction per request.
"""

import re

from datetime import timedelta
from urllib.parse import parse_qs, unquote, urlsplit

from safety import core, states
from safety.settings import safety_settings
from utils import errors

REASONS = {
    # reason: (priority, applies to)
    'csam': (0, ('file', 'album', 'user')),
    'ncii': (0, ('file', 'album', 'user')),
    'violence': (1, ('file', 'album', 'user')),
    'malware': (1, ('file', 'album', 'domain')),
    'adult_unmarked': (2, ('file', 'album')),
    'copyright': (2, ('file', 'album')),
    'harassment': (2, ('file', 'album', 'user', 'domain')),
    'spam': (3, ('file', 'album', 'user', 'domain')),
    'other': (3, ('file', 'album', 'user', 'domain')),
    'bug': (3, ('bug',)),
}
DETAILS_REQUIRED = ('other', 'bug', 'copyright')
ALWAYS_AT_ONE = ('csam', 'ncii')
HIDE_REASONS = ('csam', 'ncii', 'violence', 'malware', 'harassment', 'spam')
ALBUM_PARTS = ('whole', 'title', 'description', 'captions')
DETAILS_MAX = 2000
EMAIL_MAX = 254
DMCA_FIELDS = ('name', 'address', 'phone', 'email', 'work', 'urls', 'good_faith', 'accurate_and_authorised',
               'signature')
COUNTER_NOTICE_FIELDS = ('name', 'address', 'phone', 'email', 'material', 'mistake_statement',
                         'jurisdiction_consent', 'service_consent', 'signature')
EMAIL_PATTERN = re.compile(r'^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$')
_CONTROL = re.compile('[\x00-\x09\x0b-\x1f\x7f-\x9f]')
CANNED_REPORTER_MESSAGE = 'Thank you for your report. We reviewed it and took the action we found appropriate.'
HIDDEN_NOTICE = 'Hidden while we review a report'
CDN_PREVIEW = re.compile(r'^/previews/[a-z0-9-]+/(.+)\.[a-z0-9]+$')


# --- input -----------------------------------------------------------------------------------------------

def clean_text(value, limit=DETAILS_MAX, field='details'):
    if value is None:
        return None
    if not isinstance(value, str):
        raise errors.invalid_parameters({field: 'Must be text'})
    text = _CONTROL.sub('', value.replace('\r\n', '\n')).strip()
    if len(text) > limit:
        raise errors.invalid_parameters({field: 'Must be {} characters or fewer'.format(limit)})
    return text or None


def clean_email(value, field='contact_email'):
    if value in (None, ''):
        return None
    if not isinstance(value, str) or len(value) > EMAIL_MAX or not EMAIL_PATTERN.match(value.strip()):
        raise errors.invalid_parameters({field: 'Not a well formed email address'})
    return value.strip()


def check_dmca(dmca):
    """17 U.S.C. § 512(c)(3) fields: DMCA_FIELDS_REQUIRED with a message per missing field."""
    dmca = dmca if isinstance(dmca, dict) else {}
    problems = {}
    for field in ('name', 'address', 'phone', 'signature'):
        if not isinstance(dmca.get(field), str) or not dmca[field].strip():
            problems[field] = 'Required'
    if not isinstance(dmca.get('email'), str) or not EMAIL_PATTERN.match(dmca['email'].strip()):
        problems['email'] = 'A valid email address is required'
    if not isinstance(dmca.get('work'), str) or not dmca['work'].strip() or len(dmca['work']) > DETAILS_MAX:
        problems['work'] = 'Describe the copyrighted work ({} characters or fewer)'.format(DETAILS_MAX)
    urls = dmca.get('urls')
    if not isinstance(urls, list) or not 1 <= len(urls) <= 50 or not all(isinstance(u, str) for u in urls):
        problems['urls'] = 'List 1 to 50 files.gg links'
    for field in ('good_faith', 'accurate_and_authorised'):
        if dmca.get(field) is not True:
            problems[field] = 'Required'
    if problems:
        raise errors.dmca_fields_required(problems)
    return {k: (v.strip() if isinstance(v, str) else v) for k, v in dmca.items() if k in DMCA_FIELDS}


def check_counter_notice(notice):
    """17 U.S.C. § 512(g)(3) fields for a copyright appeal (§8.2)."""
    notice = notice if isinstance(notice, dict) else {}
    problems = {}
    for field in ('name', 'address', 'phone', 'material', 'signature'):
        if not isinstance(notice.get(field), str) or not notice[field].strip():
            problems[field] = 'Required'
    if not isinstance(notice.get('email'), str) or not EMAIL_PATTERN.match(notice['email'].strip()):
        problems['email'] = 'A valid email address is required'
    for field in ('mistake_statement', 'jurisdiction_consent', 'service_consent'):
        if notice.get(field) is not True:
            problems[field] = 'Required'
    if problems:
        raise errors.dmca_fields_required(problems)
    return {k: (v.strip() if isinstance(v, str) else v) for k, v in notice.items() if k in COUNTER_NOTICE_FIELDS}


# --- targets ---------------------------------------------------------------------------------------------

def _hosts():
    from utils.urls import cdn_url, public_url
    return urlsplit(public_url()).hostname, urlsplit(cdn_url()).hostname


def parse_url(url, conn=None):
    """A files.gg, CDN or (milestone-6 §10.12, with `conn`) live custom-domain URL -> {"type": "file" | "album",
    "vanity", "item"?}. Fragments are ignored, and so is every query parameter but an album page's `item`
    (milestone-6 §20.2). INVALID_REPORT_TARGET for anything else."""
    if not isinstance(url, str) or len(url) > 2048:
        raise errors.invalid_report_target()
    parts = urlsplit(url.strip())
    site, cdn = _hosts()
    if parts.scheme not in ('http', 'https') or not parts.hostname:
        raise errors.invalid_report_target()
    path = unquote(parts.path or '/')
    if parts.hostname == site:
        return _page_target(path, parts.query)
    if parts.hostname == cdn:
        return _byte_target(path)
    if conn is not None and core.one(conn, 'SELECT 1 FROM custom_domains WHERE hostname = %s AND deleted_at IS NULL',
                                     (parts.hostname.lower(),)):
        # a custom domain serves the CDN's byte paths and the site's pages (§10.8)
        if path.startswith(('/files/', '/previews/', '/albums/')):
            return _byte_target(path)
        return _page_target(path, parts.query)
    raise errors.invalid_report_target()


def _page_target(path, query=''):
    """The site's pages (milestone-6 §20.2: the vanity is always the last path segment): `/<vanity>[.<ext>]`,
    `/a/<vanity>` with an optional `?item=<n>` (1-based), and the report pages `/report/<vanity>` and
    `/report/a/<vanity>`, which name the file or the album itself. Anything after a vanity is part of it."""
    if path.startswith('/report/'):
        path, query = path[len('/report'):], ''
    if path.startswith('/a/'):
        vanity = path[3:].rstrip('/')
        if not vanity or '/' in vanity:
            raise errors.invalid_report_target()
        item = (parse_qs(query).get('item') or [''])[-1]
        if re.fullmatch('[0-9]{1,9}', item) and int(item) >= 1:
            return {'type': 'album', 'vanity': vanity, 'item': int(item)}
        return {'type': 'album', 'vanity': vanity}
    vanity = path.strip('/').split('.', 1)[0]
    if not vanity or vanity == 'report':
        raise errors.invalid_report_target()
    return {'type': 'file', 'vanity': vanity}


def _byte_target(path):
    if path.startswith('/files/'):
        vanity = path[len('/files/'):].rsplit('.', 1)[0] if '.' in path.rsplit('/', 1)[-1] else path[7:]
        if vanity:
            return {'type': 'file', 'vanity': vanity}
    match = CDN_PREVIEW.match(path)
    if match:
        return {'type': 'file', 'vanity': match.group(1)}
    for prefix in ('/albums/collage/', '/albums/download/'):
        if path.startswith(prefix):
            vanity = path[len(prefix):].rsplit('.', 1)[0]
            if vanity:
                return {'type': 'album', 'vanity': vanity}
    raise errors.invalid_report_target()


LIVE_FILE = '(deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now()))'
LIVE_ALBUM = '(deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now()))'


def resolve(conn, target, reporter):
    """(kind, id, vanity, owner {user_id, guest_id}) of a report target. Private files and
    albums are unknown to everyone but their owner (who can't report them anyway)."""
    if not isinstance(target, dict):
        raise errors.invalid_report_target()
    kind = target.get('type')
    if kind == 'url':
        target = dict(parse_url(target.get('url'), conn), part=target.get('part'))
        kind = target['type']
    if kind == 'bug':
        return 'bug', None, None, {}
    if kind == 'domain':
        hostname = target.get('hostname')
        if not isinstance(hostname, str) or not hostname.strip() or len(hostname) > 253:
            raise errors.invalid_report_target()
        row = core.one(conn, 'SELECT id, hostname, user_id FROM custom_domains WHERE hostname = %s AND '
                             'deleted_at IS NULL', (hostname.strip().rstrip('.').lower(),))
        if row is None:
            raise errors.unknown_domain()
        return 'domain', row[0], row[1], {'user_id': row[2]}
    if kind == 'user':
        if reporter['user_id'] is None:
            raise errors.invalid_report_target('Sign in to report an account')
        try:
            user_id = int(target.get('id'))
        except (TypeError, ValueError):
            raise errors.unknown_user()
        if core.one(conn, 'SELECT 1 FROM users WHERE id = %s', (user_id,)) is None:
            raise errors.unknown_user()
        return 'user', user_id, None, {'user_id': user_id}
    vanity = target.get('vanity')
    if not isinstance(vanity, str) or not vanity.strip():
        raise errors.invalid_report_target()
    vanity = vanity.strip()
    if kind == 'file':
        row = core.one(conn, 'SELECT id, vanity, user_id, guest_id, visibility FROM files WHERE vanity = %s AND '
                       + LIVE_FILE, (vanity.split('.', 1)[0],))
        if row is None:
            raise errors.unknown_file()
        owner = {'user_id': row[2], 'guest_id': row[3] if row[2] is None else None}
        if row[4] == 'private' and not is_owner(owner, reporter):
            raise errors.unknown_file()
        return 'file', row[0], row[1], owner
    if kind == 'album':
        row = core.one(conn, 'SELECT id, vanity, owner_user_id, owner_guest_id, visibility, access_version '
                             'FROM albums WHERE vanity = %s AND ' + LIVE_ALBUM, (vanity,))
        if row is None:
            raise errors.unknown_album()
        owner = {'user_id': row[2], 'guest_id': row[3]}
        if row[4] == 'private' and not is_owner(owner, reporter):
            raise errors.unknown_album()
        item = target.get('item')
        if item is not None:
            if not isinstance(item, int) or isinstance(item, bool) or item < 1:
                raise errors.invalid_report_target()
            # an item of a protected album only with the album's token: its items (and their
            # vanities) are for whoever unlocked it. Checked before the item is looked up, so a
            # locked album answers the same whatever position is asked for.
            if row[4] != 'link' and not album_token_valid(reporter.get('album_claims'), row[0], row[5]):
                raise errors.invalid_report_target('Unlock the album to report one of its items')
            from safety.states import SHOWN_SQL_SUB
            file_row = core.one(conn, (
                'SELECT f.id, f.vanity, f.user_id, f.guest_id FROM album_files af JOIN files f ON f.id = af.file_id '
                'JOIN albums al ON al.id = af.album_id WHERE af.album_id = %s AND f.deleted_at IS NULL AND '
                "(al.visibility <> 'link' OR f.visibility = 'link') AND f.view_limit IS NULL AND " + SHOWN_SQL_SUB +
                ' ORDER BY af.position, af.file_id OFFSET %s LIMIT 1'), (row[0], item - 1))
            if file_row is None:
                raise errors.unknown_file()
            # the reporter's view names the album and the position, never the item's own vanity
            return 'file', file_row[0], item_vanity(row[1], item), {
                'user_id': file_row[2], 'guest_id': file_row[3] if file_row[2] is None else None}
        return 'album', row[0], row[1], owner
    raise errors.invalid_report_target()


# `reports.target_vanity` of an album item: "a/<album vanity>/<position>". `a` is a reserved vanity
# segment (utils/vanity.py), so no file vanity looks like this.
ITEM_PREFIX = 'a/'


def item_vanity(album_vanity, position):
    return '{}{}/{}'.format(ITEM_PREFIX, album_vanity, position)


def album_token_valid(claims, album_id, access_version):
    """An album token (decoded by the view from X-Filesgg-Access) valid for this album now."""
    from utils import access_token
    return claims is not None and access_token.valid_for(claims, 'album', album_id, access_version)


def is_owner(owner, reporter):
    if reporter['user_id'] is not None and owner.get('user_id') == reporter['user_id']:
        return True
    return owner.get('user_id') is None and reporter['guest_id'] is not None \
        and owner.get('guest_id') == reporter['guest_id']


# --- rate limits (§7.7), on Redis (milestone-5 §18.3) ----------------------------------------------------------

def rate_keys(reporter):
    if reporter['user_id'] is not None:
        return ['user:{}'.format(reporter['user_id'])]
    keys = []
    if reporter['guest_id'] is not None:
        keys.append('guest:{:x}'.format(reporter['guest_id']))
    if reporter['ip_hash']:
        keys.append('ip:' + reporter['ip_hash'].hex())
    return keys


def check_report_rate(reporter, reason):
    """REPORT_RATE_PER_HOUR (10) an hour per account, guest and IP hash, closed: 429 MAX_REPORTS. CSAM
    reports aren't limited (anonymous ones only by Turnstile)."""
    from utils import ratelimit_sync
    if reason == 'csam':
        return
    ratelimit_sync.hit_many([('report', key) for key in rate_keys(reporter)])


# --- distinct reporters and automatic effects (§7.4) ---------------------------------------------------------

def reporter_key(user_id, guest_id):
    if user_id is not None:
        return 'user:{}'.format(user_id)
    return 'anon:{}'.format(guest_id if guest_id is not None else 'none')


def distinct_reporters(rows):
    """Reports count as distinct when their reporter keys differ and they don't share an IP hash."""
    keys, ips, count = set(), set(), 0
    for user_id, guest_id, ip_hash in rows:
        key = reporter_key(user_id, guest_id)
        ip = bytes(ip_hash) if ip_hash else None
        if key in keys or (ip is not None and ip in ips):
            continue
        keys.add(key)
        if ip is not None:
            ips.add(ip)
        count += 1
    return count


def target_column(kind):
    return {'file': 'file_id', 'album': 'album_id', 'user': 'user_id', 'domain': 'domain_id'}[kind]


def reporters_for(conn, kind, target_id, reason):
    return core.all_rows(conn, "SELECT reporter_user_id, reporter_guest_id, reporter_abuse_ip_hash FROM reports "
                               "WHERE {} = %s AND reason = %s AND status = 'open' ORDER BY id".format(
                                   target_column(kind)), (target_id, reason))


def threshold(reason, settings):
    if reason in ALWAYS_AT_ONE:
        return 1
    return settings.report_thresholds.get(reason)


def automatic_effects(conn, kind, target_id, reason, case_id, settings, part=None):
    """Hide, mark NSFW or rescan by the target's distinct reporter count. User reports never act."""
    if kind not in ('file', 'album'):
        return None
    limit = threshold(reason, settings)
    if limit is None or distinct_reporters(reporters_for(conn, kind, target_id, reason)) < limit:
        if reason == 'malware' and kind == 'file':
            queue_malware_rescan(conn, target_id)
        return None
    if reason == 'malware' and kind == 'file':
        queue_malware_rescan(conn, target_id)
    if reason in HIDE_REASONS:
        return auto_hide(conn, kind, target_id, reason, case_id)
    if reason == 'adult_unmarked':
        return auto_nsfw(conn, kind, target_id, case_id)
    return None


def queue_malware_rescan(conn, file_id):
    from safety.scan import queue_rescan
    row = core.one(conn, 'SELECT hash_id FROM files WHERE id = %s', (file_id,))
    if row is not None:
        queue_rescan(conn, row[0], ['clamav'])


def auto_hide(conn, kind, target_id, reason, case_id):
    """`hidden` (rule = the reason, public reason `review`), `auto_hide`, and a non-appealable
    notice, except for CSAM which sends nothing. A CSAM report on an album hides every item too."""
    csam = reason == 'csam'
    if kind == 'file':
        row = core.one(conn, 'SELECT moderation_state, user_id FROM files WHERE id = %s FOR UPDATE', (target_id,))
        if row is None or row[0] != 'visible':
            return None
        core.set_file_state(conn, [target_id], 'hidden', reason, auto=True)
        # milestone-5 §5.4: the file's conversion outputs are hidden with it
        from safety import cascade
        cascade.queue(conn, 'hide', [target_id])
        action_id = core.log_action(conn, core.SYSTEM, 'auto_hide', rule=reason, file_id=target_id, case_id=case_id,
                                    child_safety=csam)
        if not csam:
            core.notify(conn, row[1], 'auto_hide', reason, core.file_target(conn, target_id), message=HIDDEN_NOTICE,
                        appealable=False, action_id=action_id)
        return action_id
    row = core.one(conn, 'SELECT moderation_state, owner_user_id FROM albums WHERE id = %s FOR UPDATE', (target_id,))
    if row is None or row[0] != 'visible':
        return None
    core.set_album_state(conn, [target_id], 'hidden', reason, auto=True)
    items = []
    if csam:
        items = [r[0] for r in core.all_rows(conn, "SELECT f.id FROM album_files af JOIN files f ON f.id = af.file_id "
                                                   "WHERE af.album_id = %s AND f.moderation_state = 'visible'",
                                             (target_id,))]
        core.set_file_state(conn, items, 'hidden', reason, auto=True)
        from safety import cascade
        cascade.queue(conn, 'hide', items)
    action_id = core.log_action(conn, core.SYSTEM, 'auto_hide', rule=reason, album_id=target_id, case_id=case_id,
                                child_safety=csam, details={'files': [str(i) for i in items]} if items else None)
    if not csam:
        core.notify(conn, row[1], 'auto_hide', reason, core.album_target(conn, target_id), message=HIDDEN_NOTICE,
                    appealable=False, action_id=action_id)
    return action_id


def auto_nsfw(conn, kind, target_id, case_id):
    """`nsfw_override = 'nsfw'` (source `reports`), `auto_nsfw`, and a notice; the case stays open."""
    if kind == 'file':
        row = core.one(conn, 'UPDATE files SET nsfw_override = \'nsfw\', nsfw_override_source = \'reports\' '
                             'WHERE id = %s AND nsfw_override IS NULL RETURNING user_id', (target_id,))
        target = core.file_target(conn, target_id) if row else None
    else:
        # an album has no override: reports mark it like staff do (albums.nsfw_source has no `reports`)
        row = core.one(conn, "UPDATE albums SET nsfw = true, nsfw_source = 'moderator' WHERE id = %s AND NOT nsfw "
                             'RETURNING owner_user_id', (target_id,))
        target = core.album_target(conn, target_id) if row else None
    if row is None:
        return None
    action_id = core.log_action(conn, core.SYSTEM, 'auto_nsfw', rule='adult_unmarked', case_id=case_id,
                                **{target_column(kind): target_id})
    core.notify(conn, row[0], 'auto_nsfw', 'adult_unmarked', target, appealable=True, action_id=action_id)
    return action_id


# --- submitting (§7.3, §7.4) ------------------------------------------------------------------------------------

def submit(conn, reporter, body, settings=None):
    """`reporter`: {user_id, guest_id, ip_hash}. Returns (status, response)."""
    settings = settings or safety_settings()
    if not isinstance(body, dict):
        raise errors.invalid_report_target()
    reason = body.get('reason')
    if reason not in REASONS:
        raise errors.invalid_parameters({'reason': 'Pick a reason'})
    check_report_rate(reporter, reason)
    target = body.get('target')
    details = clean_text(body.get('details'))
    if reason in DETAILS_REQUIRED and not details:
        raise errors.details_required()
    contact_email = clean_email(body.get('contact_email')) if reporter['user_id'] is None else None
    dmca = check_dmca(body.get('dmca')) if reason == 'copyright' else None

    targets = []
    if reason == 'copyright':
        seen = set()
        candidates = [target] + [{'type': 'url', 'url': u} for u in dmca['urls']]
        for candidate in candidates:
            if candidate is None:
                continue
            resolved = resolve(conn, candidate, reporter)
            if resolved[0] not in ('file', 'album'):
                raise errors.invalid_report_target()
            if (resolved[0], resolved[1]) not in seen:
                seen.add((resolved[0], resolved[1]))
                targets.append((resolved, 'whole' if resolved[0] == 'album' else None))
    else:
        resolved = resolve(conn, target, reporter)
        part = None
        if resolved[0] == 'album':
            part = (target.get('part') if isinstance(target, dict) else None) or 'whole'
            if part not in ALBUM_PARTS:
                raise errors.invalid_parameters({'part': 'Pick whole, title, description or captions'})
        targets.append((resolved, part))

    for (kind, _, _, owner), _ in targets:
        if kind not in REASONS[reason][1]:
            raise errors.invalid_report_target("That reason doesn't apply here")
        if kind != 'bug' and is_owner(owner, reporter):
            raise errors.cannot_report_yourself()

    created = []
    for (kind, target_id, vanity, owner), part in targets:
        created.append(store(conn, reporter, kind, target_id, vanity, part, reason, details, contact_email, dmca,
                             settings))
    report, duplicate = created[0]
    escalated = reason == 'csam'
    if reporter['user_id'] is not None:
        response = {'report': report_dict(conn, report, reporter['user_id'])}
    else:
        response = {'id': str(report['id']), 'status': report['status']}
    if duplicate:
        response['duplicate'] = True
    if escalated:
        response['escalated'] = True
    if len(created) > 1:
        response['report_ids'] = [str(r['id']) for r, _ in created]
    return (200 if duplicate else 201), response


REPORT_COLUMNS = ('id', 'kind', 'file_id', 'album_id', 'user_id', 'target_vanity', 'album_part', 'reason', 'priority',
                  'status', 'reporter_user_id', 'reporter_guest_id', 'details', 'case_id', 'reopen_count',
                  'created_at', 'updated_at', 'resolved_at', 'reopened_at', 'closed_at')


def get_report(conn, report_id, user_id=None):
    sql = 'SELECT {} FROM reports WHERE id = %s'.format(', '.join(REPORT_COLUMNS))
    params = [report_id]
    if user_id is not None:
        sql += ' AND reporter_user_id = %s'
        params.append(user_id)
    row = core.one(conn, sql, params)
    return dict(zip(REPORT_COLUMNS, row)) if row else None


def store(conn, reporter, kind, target_id, vanity, part, reason, details, contact_email, dmca, settings):
    """A report (or the duplicate it is). Returns (report, duplicate)."""
    from utils.generators import Snowflake
    import json
    column = target_column(kind) if kind != 'bug' else None
    if column is not None:
        if reporter['user_id'] is not None:
            existing = core.one(conn, "SELECT id FROM reports WHERE reporter_user_id = %s AND {} = %s AND status = 'open' "
                                      "AND reason = %s ORDER BY id DESC LIMIT 1".format(column),
                                (reporter['user_id'], target_id, reason))
            if existing is not None:
                if details:
                    conn.execute('INSERT INTO report_messages (report_id, author_user_id, is_staff, body) '
                                 'VALUES (%s, %s, false, %s)', (existing[0], reporter['user_id'], details))
                    conn.execute('UPDATE reports SET updated_at = now() WHERE id = %s', (existing[0],))
                return get_report(conn, existing[0]), True
        else:
            clauses, params = [], []
            if reporter['guest_id'] is not None:
                clauses.append('reporter_guest_id = %s')
                params.append(reporter['guest_id'])
            if reporter['ip_hash']:
                clauses.append('reporter_abuse_ip_hash = %s')
                params.append(reporter['ip_hash'])
            if clauses:
                existing = core.one(conn, "SELECT id FROM reports WHERE reporter_user_id IS NULL AND ({}) AND {} = %s "
                                          "AND status = 'open' ORDER BY id DESC LIMIT 1".format(
                                              ' OR '.join(clauses), column), params + [target_id])
                if existing is not None:
                    return get_report(conn, existing[0]), True
    priority = REASONS[reason][0]
    child_safety = reason == 'csam'
    if kind == 'bug':
        case_id = core.open_case(conn, 'bug', priority)
    else:
        case_id = core.open_case(conn, kind, priority, target_id, child_safety=child_safety)
    report_id = Snowflake.generate()
    conn.execute(
        'INSERT INTO reports (id, kind, file_id, album_id, user_id, target_vanity, album_part, reason, priority, '
        'reporter_user_id, reporter_guest_id, reporter_abuse_ip_hash, contact_email, details, dmca, case_id, '
        'domain_id) '
        'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)',
        (report_id, kind, target_id if kind == 'file' else None, target_id if kind == 'album' else None,
         target_id if kind == 'user' else None, vanity, part if kind == 'album' else None, reason, priority,
         reporter['user_id'], reporter['guest_id'] if reporter['user_id'] is None else None, reporter['ip_hash'],
         contact_email, details, json.dumps(dmca) if dmca else None, case_id, target_id if kind == 'domain' else None))
    automatic_effects(conn, kind, target_id, reason, case_id, settings, part)
    return get_report(conn, report_id), False


# --- the reporter's view (§7.5, §7.6) ---------------------------------------------------------------------------

def target_dict(report):
    from utils.urls import public_url
    kind = report['kind']
    if kind == 'bug':
        return {'type': 'bug', 'vanity': None, 'url': None, 'part': None}
    if kind == 'user':
        return {'type': 'user', 'id': str(report['user_id']) if report['user_id'] else None, 'url': None, 'part': None}
    vanity = report['target_vanity']
    if kind == 'file' and vanity and vanity.startswith(ITEM_PREFIX):
        # an album item: the album and the position only (the item's vanity could be inside a
        # protected album)
        album_vanity, _, position = vanity[len(ITEM_PREFIX):].rpartition('/')
        return {'type': 'file', 'vanity': None, 'url': public_url('/a/{}?item={}'.format(album_vanity, position)),
                'part': None, 'album': {'vanity': album_vanity, 'item': int(position)}}
    url = public_url(('/a/' if kind == 'album' else '/') + vanity) if vanity else None
    return {'type': kind, 'vanity': vanity, 'url': url, 'part': report['album_part']}


def unread_count(conn, report, user_id):
    row = core.one(conn, 'SELECT last_read_at FROM report_reads WHERE report_id = %s AND user_id = %s',
                   (report['id'], user_id))
    last = row[0] if row else None
    if last is None:
        messages = core.one(conn, 'SELECT count(*) FROM report_messages WHERE report_id = %s AND is_staff',
                            (report['id'],))[0]
        return messages + (1 if report['resolved_at'] is not None else 0)
    messages = core.one(conn, 'SELECT count(*) FROM report_messages WHERE report_id = %s AND is_staff AND '
                              'created_at > %s', (report['id'], last))[0]
    return messages + (1 if report['resolved_at'] is not None and report['resolved_at'] > last else 0)


def can_reopen(report, settings=None):
    settings = settings or safety_settings()
    return (report['status'] == 'dismissed' and report['closed_at'] is None and report['reopen_count'] < 1
            and report['resolved_at'] is not None
            and report['resolved_at'] > core.utcnow() - timedelta(days=settings.report_reopen_days))


def report_dict(conn, report, user_id):
    from db.models import epoch
    last = core.one(conn, 'SELECT max(created_at) FROM report_messages WHERE report_id = %s', (report['id'],))[0]
    return {
        'id': str(report['id']),
        'kind': report['kind'],
        'target': target_dict(report),
        'reason': report['reason'],
        'status': report['status'],
        'closed': report['closed_at'] is not None,
        'escalated': report['reason'] == 'csam',
        'can_reopen': can_reopen(report),
        'unread': unread_count(conn, report, user_id),
        'created_at': epoch(report['created_at']),
        'updated_at': epoch(report['updated_at']),
        'resolved_at': epoch(report['resolved_at']),
        'last_message_at': epoch(last),
    }


def list_reports(conn, user_id, status=None, query=None, offset=0, limit=25):
    where, params = ['reporter_user_id = %s'], [user_id]
    if status:
        where.append('status = %s')
        params.append(status)
    if query:
        where.append("lower(coalesce(target_vanity, '')) LIKE %s")
        text = query.strip().lower()
        if '://' in text:
            try:
                text = parse_url(query)['vanity'].lower()
            except Exception:
                pass
        params.append('%' + text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%')
    where_sql = ' AND '.join(where)
    count = core.one(conn, 'SELECT count(*) FROM reports WHERE ' + where_sql, params)[0]
    rows = core.all_rows(conn, 'SELECT id FROM reports WHERE {} ORDER BY id DESC LIMIT %s OFFSET %s'.format(where_sql),
                         params + [limit, offset])
    return {'count': count, 'items': [report_dict(conn, get_report(conn, r[0]), user_id) for r in rows]}


def messages(conn, report, user_id):
    from db.models import epoch
    rows = core.all_rows(conn, 'SELECT id, is_staff, body, created_at FROM report_messages WHERE report_id = %s '
                               'ORDER BY id', (report['id'],))
    conn.execute('INSERT INTO report_reads (report_id, user_id, last_read_at) VALUES (%s, %s, now()) '
                 'ON CONFLICT (report_id, user_id) DO UPDATE SET last_read_at = now()', (report['id'], user_id))
    # staff messages show as "files.gg staff", never by name (§7.6)
    return {'items': [{'id': str(r[0]), 'author': 'staff' if r[1] else 'you', 'body': r[2],
                       'created_at': epoch(r[3])} for r in rows]}


def add_message(conn, report, user_id, body):
    from db.models import epoch
    from utils import ratelimit_sync
    if report['closed_at'] is not None:
        raise errors.report_closed()
    body = clean_text(body, field='body')
    if not body:
        raise errors.invalid_parameters({'body': 'Write a message'})
    # REPORT_MESSAGE_RATE_PER_HOUR (30) an hour per account, closed (milestone-5 §18.3): 429 MAX_MESSAGES
    ratelimit_sync.hit('report_message', 'user:{}'.format(user_id))
    row = core.one(conn, 'INSERT INTO report_messages (report_id, author_user_id, is_staff, body) VALUES '
                         '(%s, %s, false, %s) RETURNING id, created_at', (report['id'], user_id, body))
    conn.execute('UPDATE reports SET updated_at = now() WHERE id = %s', (report['id'],))
    return {'id': str(row[0]), 'author': 'you', 'body': body, 'created_at': epoch(row[1])}


def reopen(conn, report, user_id, settings=None):
    """Only from `dismissed`, once, within REPORT_REOPEN_DAYS of `resolved_at`; it rejoins (or
    reopens) the target's case."""
    if not can_reopen(report, settings):
        raise errors.reopen_not_allowed()
    kind = report['kind']
    target_id = report['file_id'] or report['album_id'] or report['user_id']
    if kind == 'bug' or target_id is None:
        case_id = core.open_case(conn, 'bug' if kind == 'bug' else kind, report['priority'])
    else:
        case_id = core.open_case(conn, kind, report['priority'], target_id, child_safety=report['reason'] == 'csam')
    conn.execute("UPDATE reports SET status = 'open', reopen_count = reopen_count + 1, reopened_at = now(), "
                 'resolved_at = NULL, resolution_action = NULL, case_id = %s, updated_at = now() WHERE id = %s',
                 (case_id, report['id']))
    return report_dict(conn, get_report(conn, report['id']), user_id)


def reporter_ip(ip, settings=None):
    from safety import ip as abuse_ip
    settings = settings or safety_settings()
    return abuse_ip.abuse_ip_hash(ip, settings.abuse_hash_secret)


def states_of_target(conn, kind, target_id):
    """The target's state for staff (`ok`, `pending`, `flagged`, `hidden`, `removed`, `blocked`)."""
    if kind == 'file' and target_id is not None:
        row = core.one(conn, 'SELECT h.scan_state, f.moderation_state, f.deleted_at FROM files f JOIN file_hashes h '
                             'ON h.id = f.hash_id WHERE f.id = %s', (target_id,))
        if row is None:
            return 'deleted'
        return 'deleted' if row[2] is not None else states.owner_state(row[0], row[1])
    if kind == 'album' and target_id is not None:
        row = core.one(conn, 'SELECT moderation_state, deleted_at FROM albums WHERE id = %s', (target_id,))
        if row is None or row[1] is not None:
            return 'deleted'
        return {'visible': 'ok'}.get(row[0], row[0])
    if kind == 'hash' and target_id is not None:
        row = core.one(conn, 'SELECT scan_state FROM file_hashes WHERE id = %s', (target_id,))
        return row[0] if row else 'deleted'
    if kind == 'user' and target_id is not None:
        rows = core.active_restrictions(conn, target_id)
        return 'suspended' if any(r[1] == 'suspended' for r in rows) else (
            'restricted' if rows else 'ok')
    return None
