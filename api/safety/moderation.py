"""Moderation actions, notices and appeals (contract milestone-4 §8, §9.3, §9.4). Synchronous,
run by the API in a thread (safety/run.py). `perform` manages its own transactions because
`confirm_csam` copies evidence to B2 between them.
"""

import json

from datetime import timedelta

from db.models import epoch
from safety import core, states
from safety.settings import safety_settings
from utils import errors

FILE_ALBUM = ('file', 'album')
ACTION_TARGETS = {
    'hide': FILE_ALBUM, 'unhide': FILE_ALBUM, 'remove': FILE_ALBUM, 'restore': FILE_ALBUM,
    'mark_nsfw': FILE_ALBUM, 'unmark_nsfw': FILE_ALBUM, 'delete': FILE_ALBUM,
    'block_hash': ('hash', 'file'), 'unblock_hash': ('hash', 'file'), 'clear_flag': ('hash', 'file'),
    'retry_scan': ('hash', 'file'),
    'confirm_csam': ('file', 'hash'),
    'restrict_uploads': ('user',), 'unrestrict_uploads': ('user',),
    'suspend_user': ('user',), 'unsuspend_user': ('user',),
}
RULE_REQUIRED = ('hide', 'remove', 'delete', 'mark_nsfw', 'block_hash', 'restrict_uploads', 'suspend_user')
ADMIN_ONLY = ('suspend_user', 'unsuspend_user')
CHILD_SAFETY_ONLY = ('confirm_csam',)
# §8.1: (notice?, appealable, strike) per action
NOTICES = {
    'hide': (True, True, False), 'remove': (True, True, True), 'delete': (True, True, True),
    'mark_nsfw': (True, True, False), 'block_hash': (True, True, False),
}
# what granting an appeal runs (§8.2): the reversing action of the original
REVERSALS = {'hide': 'unhide', 'remove': 'restore', 'mark_nsfw': 'unmark_nsfw', 'auto_nsfw': 'unmark_nsfw',
             'block_hash': 'unblock_hash', 'scan_block': 'unblock_hash', 'restrict_uploads': 'unrestrict_uploads',
             'suspend_user': 'unsuspend_user', 'auto_hide': 'unhide'}
BLOCK_REASONS = {'ncii': 'ncii', 'violence': 'terrorism', 'malware': 'malware', 'phishing': 'malware'}
MODERATOR_MAX_DAYS = 30


class Staff:
    def __init__(self, user_id, role, child_safety):
        self.user_id = user_id
        self.role = role
        self.child_safety = child_safety

    @property
    def admin(self):
        return self.role == 'admin'

    @property
    def actor(self):
        return core.Actor('staff', self.user_id)

    def to_dict(self):
        return {'role': self.role, 'child_safety': self.child_safety}


def staff_of(conn, user_id):
    row = core.one(conn, 'SELECT role, child_safety FROM staff WHERE user_id = %s', (user_id,))
    return Staff(user_id, row[0], row[1]) if row else None


def require_admin(staff):
    if not staff.admin:
        raise errors.forbidden()


def require_child_safety(staff):
    if not staff.child_safety:
        raise errors.forbidden()


# --- targets ---------------------------------------------------------------------------------------------------

def _id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise errors.invalid_action('Unknown target')


def load_file(conn, file_id, lock=True):
    row = core.one(conn, 'SELECT f.id, f.user_id, f.fingerprint, f.hash_id, f.moderation_state, f.deleted_at, '
                         'h.scan_state, h.scan_reason, f.moderation_rule FROM files f JOIN file_hashes h '
                         'ON h.id = f.hash_id WHERE f.id = %s{}'.format(' FOR UPDATE OF f' if lock else ''), (file_id,))
    if row is None:
        raise errors.unknown_file()
    keys = ('id', 'user_id', 'fingerprint', 'hash_id', 'moderation_state', 'deleted_at', 'scan_state', 'scan_reason',
            'moderation_rule')
    return dict(zip(keys, row))


def load_album(conn, album_id):
    row = core.one(conn, 'SELECT id, owner_user_id, moderation_state, deleted_at, nsfw, moderation_rule FROM albums '
                         'WHERE id = %s FOR UPDATE', (album_id,))
    if row is None:
        raise errors.unknown_album()
    return dict(zip(('id', 'user_id', 'moderation_state', 'deleted_at', 'nsfw', 'moderation_rule'), row))


def load_hash(conn, hash_id):
    row = core.one(conn, 'SELECT id, blake2b, sha1, md5, size, scan_state, scan_reason, scan FROM file_hashes '
                         'WHERE id = %s FOR UPDATE', (hash_id,))
    if row is None:
        raise errors.invalid_action('Unknown hash')
    return dict(zip(('id', 'blake2b', 'sha1', 'md5', 'size', 'scan_state', 'scan_reason', 'scan'), row))


def is_csam_hash(conn, h):
    if h['scan_reason'] in states.CSAM_REASONS:
        return True
    entry = core.one(conn, 'SELECT reason FROM blocked_hashes WHERE blake2b = %s AND sha1 = %s AND md5 = %s',
                     (h['blake2b'], h['sha1'], h['md5']))
    return bool(entry and entry[0] == 'csam')


def case_is_child_safety(conn, case_id):
    if case_id is None:
        return False
    row = core.one(conn, 'SELECT child_safety FROM moderation_cases WHERE id = %s', (case_id,))
    if row is None:
        raise errors.unknown_case()
    return row[0]


def target_child_safety(conn, kind, target_id):
    """Content tied to an open child-safety case: only child-safety staff act on it."""
    column = {'file': 'file_id', 'album': 'album_id', 'hash': 'hash_id', 'user': 'user_id'}[kind]
    row = core.one(conn, 'SELECT 1 FROM moderation_cases WHERE {} = %s AND child_safety AND status = \'open\' '
                         'LIMIT 1'.format(column), (target_id,))
    return row is not None


def owns_target(conn, user_id, kind, target_id):
    """True when `user_id` owns the target: their own account, a file or album of theirs, a
    hash one of their files uses, or a notice addressed to them."""
    if user_id is None or target_id is None:
        return False
    if kind == 'user':
        return int(target_id) == int(user_id)
    sql = {
        'file': 'SELECT 1 FROM files WHERE id = %s AND user_id = %s',
        'album': 'SELECT 1 FROM albums WHERE id = %s AND owner_user_id = %s',
        'hash': 'SELECT 1 FROM files WHERE hash_id = %s AND user_id = %s LIMIT 1',
        'warning': 'SELECT 1 FROM user_warnings WHERE id = %s AND user_id = %s',
    }.get(kind)
    return sql is not None and core.one(conn, sql, (target_id, user_id)) is not None


def require_not_own(conn, staff, kind, target_id):
    """Staff never act on their own account or content (or decide their own appeals)."""
    if owns_target(conn, staff.user_id, kind, target_id):
        raise errors.forbidden("Staff can't act on their own account or content")


def require_permission(staff, action):
    """The §9.1 permission an action needs, by its name alone."""
    if action in ADMIN_ONLY:
        require_admin(staff)
    if action in CHILD_SAFETY_ONLY:
        require_child_safety(staff)


def authorize(conn, staff, action, kind, target_id):
    """Everything a staff member needs to run `action` on a target (§9.1): the action's own
    permission, child-safety access to content tied to an open child-safety case, and never
    their own account or content. Every path that runs an action (POST /admin/actions, and
    granting an appeal) goes through this."""
    require_permission(staff, action)
    if kind in ('file', 'album', 'hash') and not staff.child_safety and target_child_safety(conn, kind, target_id):
        raise errors.forbidden()
    require_not_own(conn, staff, kind, target_id)


def eligible_deciders(conn, staff, warning, action, child_safety):
    """Other staff who could decide this appeal (§9.4): who could have taken (and reversed)
    the original action, isn't suspended, and isn't the one appealing."""
    sql = ('SELECT count(*) FROM staff s WHERE s.user_id <> %s AND s.user_id <> %s AND NOT EXISTS (SELECT 1 FROM '
           "user_restrictions r WHERE r.user_id = s.user_id AND r.kind = 'suspended' AND "
           + core.ACTIVE_RESTRICTION + ')')
    if action in ADMIN_ONLY:
        sql += " AND s.role = 'admin'"
    if action in CHILD_SAFETY_ONLY or child_safety:
        sql += ' AND s.child_safety'
    return core.one(conn, sql, (staff.user_id, warning['user_id']))[0]


# --- actions (§9.3) ------------------------------------------------------------------------------------------

def validate(conn, staff, body):
    if not isinstance(body, dict):
        raise errors.invalid_action()
    action = body.get('action')
    target = body.get('target') if isinstance(body.get('target'), dict) else {}
    kind = target.get('type')
    if action not in ACTION_TARGETS or kind not in ACTION_TARGETS[action]:
        raise errors.invalid_action()
    rule = body.get('rule')
    if rule is not None and rule not in states.RULES:
        raise errors.invalid_action('Unknown rule')
    if action in RULE_REQUIRED and not rule:
        raise errors.invalid_action('Pick a rule')
    require_permission(staff, action)
    case_id = body.get('case_id')
    case_id = _id(case_id) if case_id not in (None, '') else None
    if case_id is not None and case_is_child_safety(conn, case_id) and not staff.child_safety:
        raise errors.forbidden()
    return action, kind, _id(target.get('id')), rule, case_id


def perform(conn, staff, body, settings=None):
    """POST /admin/actions. Returns {"action": <audit row>, "notice_ids": [...]}. `conn` is in
    autocommit; each step opens its own transaction."""
    settings = settings or safety_settings()
    action, kind, target_id, rule, case_id = validate(conn, staff, body)
    with conn.transaction():
        authorize(conn, staff, action, kind, target_id)
    note = body.get('note') if isinstance(body.get('note'), str) else None
    message = body.get('message') if isinstance(body.get('message'), str) else None
    if note and len(note) > 2000 or message and len(message) > 2000:
        raise errors.invalid_parameters({'note' if note and len(note) > 2000 else 'message': 'Too long'})
    notify = body.get('notify', True) is not False
    if action == 'confirm_csam':
        return confirm_csam(conn, staff, kind, target_id, case_id, note)
    with conn.transaction():
        ctx = Context(conn, staff, rule, note, message, notify, case_id, settings)
        handler = HANDLERS[action]
        action_id = handler(ctx, kind, target_id, body)
        if body.get('also_block_hash') and action == 'delete' and kind == 'file':
            file = load_file(conn, target_id, lock=False)
            block_hash(ctx, 'hash', file['hash_id'], body)
        return {'action': audit_row(conn, action_id), 'notice_ids': [str(i) for i in ctx.notices]}


class Context:
    def __init__(self, conn, staff, rule, note, message, notify, case_id, settings):
        self.conn = conn
        self.staff = staff
        self.rule = rule
        self.note = note
        self.message = message
        self.notify = notify
        self.case_id = case_id
        self.settings = settings
        self.notices = []
        self.reverses = None

    def log(self, action, **targets):
        return core.log_action(self.conn, self.staff.actor, action, rule=self.rule, note=self.note,
                               case_id=self.case_id, reverses=self.reverses, **targets)

    def notice(self, action, user_id, target, action_id):
        flags = NOTICES.get(action)
        if not self.notify or flags is None or user_id is None or self.rule == 'csam':
            return None
        _, appealable, strike = flags
        notice_id = core.notify(self.conn, user_id, action, self.rule, target, message=self.message,
                                appealable=appealable, strike=strike, action_id=action_id)
        if notice_id:
            self.notices.append(notice_id)
        return notice_id


def set_state(ctx, kind, target_id, body, state, action):
    conn = ctx.conn
    if kind == 'file':
        file = load_file(conn, target_id)
        if file['deleted_at'] is not None:
            raise errors.unknown_file()
        if state == 'visible' and file['moderation_rule'] == 'csam' and not ctx.staff.child_safety:
            raise errors.forbidden()
        core.set_file_state(conn, [target_id], state, ctx.rule)
        action_id = ctx.log(action, file_id=target_id, user_id=file['user_id'])
        ctx.notice(action, file['user_id'], core.file_target(conn, target_id), action_id)
        if state == 'visible':
            # it's shown again: its albums get a collage that may include it
            from jobs.media import queue_collage
            for album_id in core.albums_of_files(conn, [target_id]):
                queue_collage(conn, album_id)
        return action_id
    album = load_album(conn, target_id)
    if album['deleted_at'] is not None:
        raise errors.unknown_album()
    if state == 'visible' and album['moderation_rule'] == 'csam' and not ctx.staff.child_safety:
        raise errors.forbidden()
    core.set_album_state(conn, [target_id], state, ctx.rule)
    action_id = ctx.log(action, album_id=target_id, user_id=album['user_id'])
    ctx.notice(action, album['user_id'], core.album_target(conn, target_id), action_id)
    return action_id


def hide(ctx, kind, target_id, body):
    return set_state(ctx, kind, target_id, body, 'hidden', 'hide')


def unhide(ctx, kind, target_id, body):
    return set_state(ctx, kind, target_id, body, 'visible', 'unhide')


def remove(ctx, kind, target_id, body):
    return set_state(ctx, kind, target_id, body, 'removed', 'remove')


def restore(ctx, kind, target_id, body):
    return set_state(ctx, kind, target_id, body, 'visible', 'restore')


def mark_nsfw(ctx, kind, target_id, body, value=True):
    conn = ctx.conn
    action = 'mark_nsfw' if value else 'unmark_nsfw'
    if kind == 'file':
        file = load_file(conn, target_id)
        conn.execute("UPDATE files SET nsfw_override = %s, nsfw_override_source = 'moderator' WHERE id = %s",
                     ('nsfw' if value else 'safe', target_id))
        # an owner's review request is decided by this
        conn.execute("UPDATE content_flags SET resolved_at = now() WHERE file_id = %s AND source = 'owner' "
                     'AND resolved_at IS NULL', (target_id,))
        action_id = ctx.log(action, file_id=target_id, user_id=file['user_id'])
        ctx.notice(action, file['user_id'], core.file_target(conn, target_id), action_id)
        return action_id
    album = load_album(conn, target_id)
    conn.execute('UPDATE albums SET nsfw = %s, nsfw_source = %s, updated_at = now() WHERE id = %s',
                 (value, 'moderator' if value else None, target_id))
    action_id = ctx.log(action, album_id=target_id, user_id=album['user_id'])
    ctx.notice(action, album['user_id'], core.album_target(conn, target_id), action_id)
    return action_id


def unmark_nsfw(ctx, kind, target_id, body):
    return mark_nsfw(ctx, kind, target_id, body, value=False)


def delete(ctx, kind, target_id, body):
    """A soft delete (`deleted_reason = 'moderator'`), plus an evidence hold in the files bucket
    for `hold_days` (default 90, at most 365) so blob GC keeps the bytes."""
    conn = ctx.conn
    hold_days = body.get('hold_days', ctx.settings.hold_days_default)
    if not isinstance(hold_days, int) or isinstance(hold_days, bool) or not 1 <= hold_days <= ctx.settings.hold_days_max:
        raise errors.invalid_action('hold_days must be 1 to {}'.format(ctx.settings.hold_days_max))
    if kind == 'file':
        file = load_file(conn, target_id)
        if file['deleted_at'] is not None:
            raise errors.unknown_file()
        target = core.file_target(conn, target_id)
        h = core.one(conn, 'SELECT blake2b, sha1, md5, size FROM file_hashes WHERE id = %s', (file['hash_id'],))
        action_id = ctx.log('delete', file_id=target_id, user_id=file['user_id'], hash_id=file['hash_id'])
        from utils import storage as storage_module
        conn.execute("INSERT INTO evidence_holds (case_id, hash_id, blake2b, sha1, md5, size, bucket, storage_key, "
                     "reason, retain_until, snapshot) VALUES (%s, %s, %s, %s, %s, %s, 'files', %s, 'moderator', %s, "
                     "%s::jsonb)", (ctx.case_id, file['hash_id'], h[0], h[1], h[2], h[3],
                                    storage_module.blob_key(file['hash_id']), core.utcnow() + timedelta(days=hold_days),
                                    json.dumps({'file': target, 'action_id': action_id})))
        core.soft_delete_files(conn, [target_id], 'moderator')
        ctx.notice('delete', file['user_id'], target, action_id)
        return action_id
    album = load_album(conn, target_id)
    if album['deleted_at'] is not None:
        raise errors.unknown_album()
    target = core.album_target(conn, target_id)
    conn.execute("UPDATE albums SET deleted_at = now(), deleted_reason = 'moderator' WHERE id = %s", (target_id,))
    action_id = ctx.log('delete', album_id=target_id, user_id=album['user_id'])
    ctx.notice('delete', album['user_id'], target, action_id)
    return action_id


def _hash_of(ctx, kind, target_id):
    if kind == 'file':
        return load_file(ctx.conn, target_id, lock=False)['hash_id']
    return target_id


def block_hash(ctx, kind, target_id, body):
    """`blocked` (`hash_list`), a `blocked_hashes` row with the PDQs, and a notice to every owner."""
    from safety.scan import delete_assets_later, queue_pdq_sweep
    conn = ctx.conn
    h = load_hash(conn, _hash_of(ctx, kind, target_id))
    if is_csam_hash(conn, h):
        raise errors.invalid_action('CSAM blocks are handled with confirm_csam')
    reason = BLOCK_REASONS.get(ctx.rule, 'moderator')
    entry = core.one(conn, "INSERT INTO blocked_hashes (blake2b, sha1, md5, size, reason, source) VALUES "
                           "(%s, %s, %s, %s, %s, 'staff') ON CONFLICT (blake2b, sha1, md5) DO UPDATE SET reason = "
                           "EXCLUDED.reason RETURNING id", (h['blake2b'], h['sha1'], h['md5'], h['size'], reason))
    if reason in ('ncii', 'terrorism', 'moderator'):
        conn.execute('INSERT INTO blocked_hash_pdq (blocked_hash_id, frame, pdq, quality) SELECT %s, frame, pdq, '
                     'quality FROM file_hash_pdq WHERE hash_id = %s ON CONFLICT DO NOTHING', (entry[0], h['id']))
        queue_pdq_sweep(conn, entry[0])
    was_public = h['scan_state'] in ('passed', 'flagged')
    conn.execute("UPDATE file_hashes SET scan_state = 'blocked', scan_reason = 'hash_list', next_rescan_at = NULL "
                 'WHERE id = %s', (h['id'],))
    action_id = ctx.log('block_hash', hash_id=h['id'], file_id=target_id if kind == 'file' else None)
    conn.execute('UPDATE blocked_hashes SET action_id = %s WHERE id = %s', (action_id, entry[0]))
    if was_public:
        core.invalidate_collages(conn, core.albums_of_hash(conn, h['id']))
        delete_assets_later(conn, h['id'])
    for file_id, user_id, _, _, _ in core.hash_files(conn, h['id']):
        ctx.notice('block_hash', user_id, core.file_target(conn, file_id), action_id)
    return action_id


def unblock_hash(ctx, kind, target_id, body):
    """`passed`, the `blocked_hashes` row gone, and media processing queued. Never for CSAM."""
    conn = ctx.conn
    h = load_hash(conn, _hash_of(ctx, kind, target_id))
    if is_csam_hash(conn, h):
        raise errors.invalid_action("CSAM blocks can't be lifted")
    if h['scan_state'] != 'blocked':
        raise errors.invalid_action("This hash isn't blocked")
    conn.execute('DELETE FROM blocked_hashes WHERE blake2b = %s AND sha1 = %s AND md5 = %s',
                 (h['blake2b'], h['sha1'], h['md5']))
    document = dict(h['scan'] or {})
    document['cleared'] = (document.get('cleared') or []) + [
        {'check': f.get('check'), 'detail': f.get('detail')} for f in document.get('findings') or ()]
    conn.execute("UPDATE file_hashes SET scan_state = 'passed', scan_reason = NULL, scan = %s::jsonb, "
                 "processing_state = CASE WHEN processing_state = 'skipped' THEN 'pending' ELSE processing_state END "
                 'WHERE id = %s', (json.dumps(document), h['id']))
    core.queue_probe(conn, h['id'])
    _requeue_collages(conn, h['id'])
    return ctx.log('unblock_hash', hash_id=h['id'])


def clear_flag(ctx, kind, target_id, body):
    """`flagged` or `held` -> `passed`, the findings recorded in `scan.cleared` (rescans ignore
    them), and the hash's flags closed."""
    conn = ctx.conn
    h = load_hash(conn, _hash_of(ctx, kind, target_id))
    if h['scan_state'] not in ('flagged', 'held'):
        raise errors.invalid_action('Nothing to clear')
    if h['scan_state'] == 'held' and target_child_safety(conn, 'hash', h['id']) and not ctx.staff.child_safety:
        raise errors.forbidden()
    document = dict(h['scan'] or {})
    cleared = document.get('cleared') or []
    for finding in document.get('findings') or ():
        if finding.get('code') != 'csam_match':
            cleared.append({'check': finding.get('check'), 'detail': finding.get('detail')})
    document['cleared'] = cleared
    document['link_warnings'] = []
    conn.execute("UPDATE file_hashes SET scan_state = 'passed', scan_reason = NULL, scan = %s::jsonb, "
                 "processing_state = CASE WHEN processing_state = 'skipped' THEN 'pending' ELSE processing_state END "
                 'WHERE id = %s', (json.dumps(document), h['id']))
    conn.execute('UPDATE content_flags SET resolved_at = now() WHERE hash_id = %s AND resolved_at IS NULL', (h['id'],))
    core.queue_probe(conn, h['id'])
    _requeue_collages(conn, h['id'])
    return ctx.log('clear_flag', hash_id=h['id'])


def retry_scan(ctx, kind, target_id, body):
    """A hash held because its scan kept failing (`scan_failing`, milestone-4 §5): reset the failure
    count and queue a fresh scan. The hash stays `pending` (nothing is published) until that scan
    finishes; if it keeps failing, the sweeper holds it again."""
    from safety import scan as scan_rules  # scan imports the job queue; keep moderation light
    conn = ctx.conn
    h = load_hash(conn, _hash_of(ctx, kind, target_id))
    stuck = core.one(conn, 'SELECT scan_stuck_at FROM file_hashes WHERE id = %s', (h['id'],))
    if h['scan_state'] != 'pending' or stuck is None or stuck[0] is None:
        raise errors.invalid_action('This scan is not held')
    scan_rules.retry_failing(conn, h['id'])
    conn.execute("UPDATE content_flags SET resolved_at = now() WHERE hash_id = %s AND reason = 'scan_failing' "
                 'AND resolved_at IS NULL', (h['id'],))
    return ctx.log('retry_scan', hash_id=h['id'])


def _requeue_collages(conn, hash_id):
    from jobs.media import queue_collage
    for album_id in core.albums_of_hash(conn, hash_id):
        queue_collage(conn, album_id)


def _duration(ctx, body, default_days):
    duration = body.get('duration')
    if duration is None:
        return default_days * 86400 if default_days else None
    if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0:
        raise errors.invalid_action('duration must be a positive number of seconds')
    return duration


def restrict_uploads(ctx, kind, target_id, body):
    seconds = _duration(ctx, body, ctx.settings.restrict_days)
    if seconds > MODERATOR_MAX_DAYS * 86400:
        require_admin(ctx.staff)
    _user(ctx.conn, target_id)
    _, action_id, notice_id = core.restrict(ctx.conn, target_id, 'uploads', ctx.rule, actor=ctx.staff.actor,
                                            ends_at=core.utcnow() + timedelta(seconds=seconds), case_id=ctx.case_id,
                                            notify_owner=ctx.notify, message=ctx.message, note=ctx.note)
    if notice_id:
        ctx.notices.append(notice_id)
    return action_id


def suspend_user(ctx, kind, target_id, body):
    seconds = _duration(ctx, body, None)
    _user(ctx.conn, target_id)
    ends_at = core.utcnow() + timedelta(seconds=seconds) if seconds else None
    _, action_id, notice_id = core.restrict(ctx.conn, target_id, 'suspended', ctx.rule, actor=ctx.staff.actor,
                                            ends_at=ends_at, case_id=ctx.case_id, notify_owner=ctx.notify,
                                            message=ctx.message, note=ctx.note)
    if notice_id:
        ctx.notices.append(notice_id)
    return action_id


def _lift(ctx, target_id, kind):
    _user(ctx.conn, target_id)
    ids, action_id = core.lift_restrictions(ctx.conn, target_id, kind, ctx.staff.actor, rule=ctx.rule, note=ctx.note,
                                            reverses=ctx.reverses, case_id=ctx.case_id)
    if not ids:
        raise errors.invalid_action('Nothing to lift')
    return action_id


def unrestrict_uploads(ctx, kind, target_id, body):
    return _lift(ctx, target_id, 'uploads')


def unsuspend_user(ctx, kind, target_id, body):
    return _lift(ctx, target_id, 'suspended')


def _user(conn, user_id):
    if core.one(conn, 'SELECT 1 FROM users WHERE id = %s', (user_id,)) is None:
        raise errors.unknown_user()


HANDLERS = {
    'hide': hide, 'unhide': unhide, 'remove': remove, 'restore': restore, 'mark_nsfw': mark_nsfw,
    'unmark_nsfw': unmark_nsfw, 'delete': delete, 'block_hash': block_hash, 'unblock_hash': unblock_hash,
    'clear_flag': clear_flag, 'retry_scan': retry_scan, 'restrict_uploads': restrict_uploads, 'unrestrict_uploads': unrestrict_uploads,
    'suspend_user': suspend_user, 'unsuspend_user': unsuspend_user,
}


def confirm_csam(conn, staff, kind, target_id, case_id, note):
    """§3.6 steps 1-6 with source `staff`."""
    from safety import csam
    with conn.transaction():
        hash_id = load_file(conn, target_id, lock=False)['hash_id'] if kind == 'file' else load_hash(conn, target_id)['id']
    case = csam.handle_match(hash_id, source='staff', outcome=None, actor=staff.actor)
    with conn.transaction():
        action_id = core.log_action(conn, staff.actor, 'confirm_csam', rule='csam', hash_id=hash_id,
                                    file_id=target_id if kind == 'file' else None, case_id=case or case_id,
                                    note=note, child_safety=True)
        if case_id is not None and case_id != case:
            conn.execute('UPDATE moderation_cases SET child_safety = true, priority = 0, updated_at = now() '
                         'WHERE id = %s', (case_id,))
    return {'action': audit_row(conn, action_id), 'notice_ids': []}


# --- the audit row ------------------------------------------------------------------------------------------

AUDIT_COLUMNS = ('id', 'actor_user_id', 'actor_kind', 'action', 'rule', 'file_id', 'album_id', 'user_id', 'hash_id',
                 'report_id', 'case_id', 'warning_id', 'note', 'details', 'reverses_action_id', 'created_at',
                 'child_safety')


def audit_rows(conn, where='true', params=(), limit=50):
    rows = core.all_rows(conn, 'SELECT {}, u.username FROM moderation_actions a LEFT JOIN users u ON '
                               'u.id = a.actor_user_id WHERE {} ORDER BY a.id DESC LIMIT %s'.format(
                                   ', '.join('a.' + c for c in AUDIT_COLUMNS), where), list(params) + [limit])
    return [audit_dict(dict(zip(AUDIT_COLUMNS + ('username',), r))) for r in rows]


def audit_row(conn, action_id):
    rows = audit_rows(conn, 'a.id = %s', (action_id,), 1)
    return rows[0] if rows else None


def audit_dict(row):
    def sid(value):
        return str(value) if value is not None else None
    target = {k: sid(row[k]) for k in ('file_id', 'album_id', 'user_id', 'hash_id', 'report_id', 'case_id',
                                       'warning_id') if row[k] is not None}
    return {
        'id': str(row['id']),
        'actor': {'id': sid(row['actor_user_id']), 'username': row.get('username'), 'kind': row['actor_kind']},
        'action': row['action'],
        'rule': row['rule'],
        'target': target,
        'note': row['note'],
        'details': row['details'],
        'reverses_action_id': sid(row['reverses_action_id']),
        'created_at': epoch(row['created_at']),
    }


# --- notices (§8.2) --------------------------------------------------------------------------------------

WARNING_COLUMNS = ('id', 'user_id', 'action_id', 'action', 'rule', 'message', 'target', 'appealable', 'counts_as_strike',
                   'acknowledged_at', 'appeal_state', 'appeal_message', 'appeal_counter_notice', 'appeal_reply',
                   'appealed_at', 'appeal_decided_at', 'created_at')


def get_warning(conn, warning_id, user_id=None, lock=False):
    sql = 'SELECT {} FROM user_warnings WHERE id = %s'.format(', '.join(WARNING_COLUMNS))
    params = [warning_id]
    if user_id is not None:
        sql += ' AND user_id = %s'
        params.append(user_id)
    row = core.one(conn, sql + (' FOR UPDATE' if lock else ''), params)
    return dict(zip(WARNING_COLUMNS, row)) if row else None


def can_appeal(warning):
    return warning['appealable'] and warning['appeal_state'] == 'none' and warning['rule'] != 'csam'


def notice_dict(warning):
    """§8.2's notice. CSAM never shows detail (and has no notices but its restriction)."""
    target = dict(warning['target'] or {})
    return {
        'id': str(warning['id']),
        'action': warning['action'],
        'rule': warning['rule'],
        'rule_text': states.RULES.get(warning['rule']),
        'message': warning['message'],
        'target': target,
        'created_at': epoch(warning['created_at']),
        'acknowledged_at': epoch(warning['acknowledged_at']),
        'counts_as_strike': warning['counts_as_strike'] and warning['appeal_state'] != 'granted',
        'appeal': {'state': warning['appeal_state'], 'can_appeal': can_appeal(warning),
                   'appealed_at': epoch(warning['appealed_at']), 'decided_at': epoch(warning['appeal_decided_at']),
                   'message': warning['appeal_reply']},
    }


def list_warnings(conn, user_id, unacknowledged=False, offset=0, limit=25):
    where = 'user_id = %s' + (' AND acknowledged_at IS NULL' if unacknowledged else '')
    count = core.one(conn, 'SELECT count(*) FROM user_warnings WHERE ' + where, (user_id,))[0]
    pending = core.one(conn, 'SELECT count(*) FROM user_warnings WHERE user_id = %s AND acknowledged_at IS NULL',
                       (user_id,))[0]
    rows = core.all_rows(conn, 'SELECT {} FROM user_warnings WHERE {} ORDER BY id DESC LIMIT %s OFFSET %s'.format(
        ', '.join(WARNING_COLUMNS), where), (user_id, limit, offset))
    return {'count': count, 'unacknowledged': pending,
            'items': [notice_dict(dict(zip(WARNING_COLUMNS, r))) for r in rows]}


def acknowledge(conn, user_id, ids):
    rows = core.all_rows(conn, 'UPDATE user_warnings SET acknowledged_at = COALESCE(acknowledged_at, now()) '
                               'WHERE user_id = %s AND id = ANY(%s) RETURNING id', (user_id, list(ids)))
    done = {r[0] for r in rows}
    return {'acknowledged': [str(i) for i in ids if i in done]}


def appeal(conn, user_id, warning_id, message, counter_notice=None):
    """Once per notice; opens an appeal case (P2, needs second review). A `copyright` notice's
    appeal needs the counter-notice fields (§8.2)."""
    from safety.reports import check_counter_notice, clean_text
    warning = get_warning(conn, warning_id, user_id, lock=True)
    if warning is None:
        raise errors.unknown_warning()
    if not can_appeal(warning):
        raise errors.appeal_not_allowed()
    message = clean_text(message, field='message')
    if not message:
        raise errors.invalid_parameters({'message': 'Tell us why'})
    notice = check_counter_notice(counter_notice) if warning['rule'] == 'copyright' else None
    conn.execute("UPDATE user_warnings SET appeal_state = 'open', appeal_message = %s, appeal_counter_notice = "
                 '%s::jsonb, appealed_at = now() WHERE id = %s', (message, json.dumps(notice) if notice else None,
                                                                  warning_id))
    case_id = core.open_case(conn, 'appeal', 2, warning_id, needs_second_review=True)
    # the owner's appeal: logged as a system row (owners aren't staff), with the user it came from
    core.log_action(conn, core.SYSTEM, 'appeal_opened', rule=warning['rule'],
                    user_id=user_id, warning_id=warning_id, case_id=case_id)
    return notice_dict(get_warning(conn, warning_id))


def decide_appeal(conn, staff, case, decision, message):
    """§8.2, §9.4: grant reverses the original action (its reversing action, `reverses_action_id`
    set) and the notice stops counting as a strike; deny keeps everything. Deciding needs the
    permission of the reversing action (an admin-only suspension needs an admin), never on the
    staff member's own notice or content, and the staff member who took the original action
    can't decide while another eligible staff member exists (SAME_MODERATOR)."""
    if decision not in ('grant', 'deny'):
        raise errors.invalid_parameters({'decision': 'grant or deny'})
    warning = get_warning(conn, case['warning_id'], lock=True) if case.get('warning_id') else None
    if warning is None or warning['appeal_state'] != 'open':
        raise errors.invalid_action('There is no open appeal on this case')
    require_not_own(conn, staff, 'warning', warning['id'])
    original = core.one(conn, 'SELECT actor_user_id, action, file_id, album_id, user_id, hash_id, rule, child_safety '
                              'FROM moderation_actions WHERE id = %s', (warning['action_id'],)) \
        if warning['action_id'] else None
    reversal, kind, target_id = None, None, None
    if original is not None:
        reversal = REVERSALS.get(original[1])
        kind, target_id = _original_target(warning, original)
        # the reversing action's own permission (§9.1), whatever the decision: deciding an appeal
        # is for staff who could have taken the action
        authorize(conn, staff, reversal or original[1], kind, target_id)
        if original[7] and not staff.child_safety:
            raise errors.forbidden()
        if original[0] == staff.user_id and eligible_deciders(conn, staff, warning, reversal or original[1],
                                                              original[7]) > 0:
            raise errors.same_moderator()
    message = (message or '').strip()[:2000] or None
    if decision == 'grant' and reversal is not None and kind is not None:
        ctx = Context(conn, staff, original[6], None, None, False, case['id'], safety_settings())
        ctx.reverses = warning['action_id']
        try:
            HANDLERS[reversal](ctx, kind, target_id, {})
        except Exception as error:
            # already reversed by hand, or the target is gone: the appeal still decides. Anything
            # else (a permission error above all) stops it.
            from utils.responses import ApiError
            if not isinstance(error, ApiError) or error.code not in ALREADY_REVERSED:
                raise
    conn.execute('UPDATE user_warnings SET appeal_state = %s, appeal_reply = %s, appeal_decided_at = now() '
                 'WHERE id = %s', ('granted' if decision == 'grant' else 'denied', message, warning['id']))
    core.log_action(conn, staff.actor, 'appeal_' + ('granted' if decision == 'grant' else 'denied'),
                    rule=warning['rule'], warning_id=warning['id'], case_id=case['id'], user_id=warning['user_id'],
                    reverses=warning['action_id'] if decision == 'grant' else None)
    conn.execute("UPDATE moderation_cases SET status = 'closed', closed_at = now(), outcome = %s, outcome_reason = %s, "
                 'updated_at = now() WHERE id = %s', ('actioned' if decision == 'grant' else 'dismissed', message,
                                                      case['id']))


# a reversal that fails with one of these was already done (or has nothing left to act on)
ALREADY_REVERSED = ('INVALID_ACTION', 'UNKNOWN_FILE', 'UNKNOWN_ALBUM', 'UNKNOWN_USER')


def _original_target(warning, original):
    action, file_id, album_id, user_id, hash_id = original[1], original[2], original[3], original[4], original[5]
    if action in ('restrict_uploads', 'suspend_user'):
        return 'user', user_id
    if action in ('block_hash', 'scan_block'):
        if hash_id is not None:
            return 'hash', hash_id
        target = warning['target'] or {}
        return ('file', int(target['id'])) if target.get('kind') == 'file' else (None, None)
    if file_id is not None:
        return 'file', file_id
    if album_id is not None:
        return 'album', album_id
    target = warning['target'] or {}
    if target.get('kind') in ('file', 'album') and target.get('id'):
        return target['kind'], int(target['id'])
    return None, None
