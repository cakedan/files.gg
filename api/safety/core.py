"""Shared trust & safety writes (contract milestone-4 §7-§9): the audit log, cases and flags,
notices, strikes and restrictions, bans, moderation states and collage invalidation.

Synchronous psycopg 3: the worker (scan, rescans, scheduled tasks) calls these directly, and the
API runs them in a thread on a sync connection (safety/run.py), so every rule has one
implementation. Each function expects to run inside the caller's transaction.
"""

import json
import logging

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from safety.settings import safety_settings

log = logging.getLogger(__name__)

PRIORITY = {'csam': 0, 'ncii': 0, 'violence': 1, 'malware': 1, 'adult_unmarked': 2, 'copyright': 2,
            'harassment': 2, 'spam': 3, 'other': 3, 'bug': 3}
# flagged and held scan findings (§5.8): P1 malware, web risk, PDQ near-match (not CSAM); P2 unwanted
# software; P3 PDF JavaScript, polyglot
FLAG_PRIORITY = {'malware': 1, 'web_risk': 1, 'pdq_near_match': 1, 'unwanted_software': 2,
                 'pdf_javascript': 3, 'polyglot_archive': 3, 'blocked_type': 1, 'archive_bomb': 1,
                 'pdf_dangerous': 1, 'hash_list': 1}


@dataclass(frozen=True)
class Actor:
    kind: str                      # staff | system | cli
    user_id: Optional[int] = None


SYSTEM = Actor('system')


def utcnow():
    return datetime.now(timezone.utc)


def one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()


def all_rows(conn, sql, params=()):
    return conn.execute(sql, params).fetchall()


# --- the audit log (§9.5) ---------------------------------------------------------------------------------

def log_action(conn, actor, action, rule=None, file_id=None, album_id=None, user_id=None, hash_id=None,
               report_id=None, case_id=None, warning_id=None, note=None, details=None, child_safety=False,
               reverses=None):
    if case_id is not None and not child_safety:
        row = one(conn, 'SELECT child_safety FROM moderation_cases WHERE id = %s', (case_id,))
        child_safety = bool(row and row[0])
    return one(conn, (
        'INSERT INTO moderation_actions (actor_user_id, actor_kind, action, rule, file_id, album_id, user_id, hash_id, '
        'report_id, case_id, warning_id, note, details, child_safety, reverses_action_id) '
        'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s) RETURNING id'),
        (actor.user_id, actor.kind, action, rule, file_id, album_id, user_id, hash_id, report_id, case_id, warning_id,
         note, json.dumps(details) if details is not None else None, child_safety, reverses))[0]


# --- cases and flags (§9.2) --------------------------------------------------------------------------------

TARGET_COLUMN = {'file': 'file_id', 'album': 'album_id', 'user': 'user_id', 'hash': 'hash_id', 'appeal': 'warning_id'}


def open_case(conn, kind, priority, target_id=None, child_safety=False, needs_second_review=False):
    """The target's open case (created when there's none). Its priority becomes the highest of
    its parts; child safety sticks once set. Bugs get one case each."""
    column = TARGET_COLUMN.get(kind)
    if column is None or target_id is None:
        return one(conn, 'INSERT INTO moderation_cases (kind, priority, child_safety, needs_second_review) '
                         'VALUES (%s, %s, %s, %s) RETURNING id', (kind, priority, child_safety, needs_second_review))[0]
    row = one(conn, (
        'INSERT INTO moderation_cases AS c (kind, priority, {col}, child_safety, needs_second_review) '
        'VALUES (%s, %s, %s, %s, %s) '
        "ON CONFLICT ({col}) WHERE status = 'open' AND kind = '{kind}' DO UPDATE SET "
        'priority = LEAST(c.priority, EXCLUDED.priority), child_safety = c.child_safety OR EXCLUDED.child_safety, '
        'needs_second_review = c.needs_second_review OR EXCLUDED.needs_second_review, updated_at = now() '
        'RETURNING id').format(col=column, kind=kind),
        (kind, priority, target_id, child_safety, needs_second_review))
    return row[0]


def add_flag(conn, source, reason, case_id=None, hash_id=None, file_id=None, album_id=None, details=None):
    return one(conn, 'INSERT INTO content_flags (hash_id, file_id, album_id, source, reason, details, case_id) '
                     'VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s) RETURNING id',
               (hash_id, file_id, album_id, source, reason, json.dumps(details) if details is not None else None,
                case_id))[0]


def flag_hash(conn, hash_id, source, reason, details=None, child_safety=False, priority=None):
    """A scanner finding on a hash: a flag in the hash's open case (§5.8 priorities)."""
    priority = FLAG_PRIORITY.get(reason, 2) if priority is None else priority
    case_id = open_case(conn, 'hash', priority, hash_id, child_safety=child_safety)
    add_flag(conn, source, reason, case_id=case_id, hash_id=hash_id, details=details)
    return case_id


# --- notices (§8) ----------------------------------------------------------------------------------------------

def file_target(conn, file_id):
    row = one(conn, 'SELECT id, vanity, filename, extension FROM files WHERE id = %s', (file_id,))
    if row is None:
        return {'kind': 'file', 'id': str(file_id)}
    name = row[2] + ('.' + row[3] if row[3] else '')
    return {'kind': 'file', 'id': str(row[0]), 'vanity': row[1], 'name': name}


def album_target(conn, album_id):
    row = one(conn, 'SELECT id, vanity, title FROM albums WHERE id = %s', (album_id,))
    if row is None:
        return {'kind': 'album', 'id': str(album_id)}
    return {'kind': 'album', 'id': str(row[0]), 'vanity': row[1], 'name': row[2] or ''}


def account_target(user_id):
    return {'kind': 'account', 'id': str(user_id)}


def notify(conn, user_id, action, rule, target, message=None, appealable=True, strike=False, action_id=None,
           apply_strikes=True):
    """A notice for a signed-in owner (anonymous owners get none). Returns its id."""
    if user_id is None:
        return None
    warning_id = one(conn, (
        'INSERT INTO user_warnings (user_id, action_id, action, rule, message, target, appealable, counts_as_strike) '
        'VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s) RETURNING id'),
        (user_id, action_id, action, rule, message, json.dumps(target), appealable, strike))[0]
    if strike and apply_strikes:
        evaluate_strikes(conn, user_id)
    return warning_id


# --- restrictions, strikes and suspension (§8.4) ---------------------------------------------------------------

ACTIVE_RESTRICTION = 'lifted_at IS NULL AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())'


def active_restrictions(conn, user_id):
    """[(id, kind, rule, ends_at, warning_id)] in force now."""
    return all_rows(conn, 'SELECT id, kind, rule, ends_at, warning_id FROM user_restrictions WHERE user_id = %s AND '
                    + ACTIVE_RESTRICTION + ' ORDER BY id', (user_id,))


def restrict(conn, user_id, kind, rule, actor=SYSTEM, ends_at=None, case_id=None, notify_owner=True, message=None,
             note=None, details=None, child_safety=False):
    """A `user_restrictions` row with its audit row and (unless CSAM) its notice. Returns
    (restriction id, action id, notice id)."""
    action = 'restrict_uploads' if kind == 'uploads' else 'suspend_user'
    action_id = log_action(conn, actor, action, rule=rule, user_id=user_id, case_id=case_id, note=note,
                           details=dict(details or {}, ends_at=int(ends_at.timestamp()) if ends_at else None),
                           child_safety=child_safety)
    warning_id = None
    if notify_owner and rule != 'csam':
        warning_id = notify(conn, user_id, action, rule, account_target(user_id), message=message, appealable=True,
                            strike=False, action_id=action_id)
    restriction_id = one(conn, 'INSERT INTO user_restrictions (user_id, kind, rule, action_id, warning_id, ends_at) '
                               'VALUES (%s, %s, %s, %s, %s, %s) RETURNING id',
                         (user_id, kind, rule, action_id, warning_id, ends_at))[0]
    return restriction_id, action_id, warning_id


def lift_restrictions(conn, user_id, kind, actor, rule=None, note=None, reverses=None, case_id=None):
    """Lift the user's active restrictions of `kind` (never a CSAM suspension). Returns the lifted ids."""
    action = 'unrestrict_uploads' if kind == 'uploads' else 'unsuspend_user'
    rows = all_rows(conn, "SELECT id FROM user_restrictions WHERE user_id = %s AND kind = %s AND rule <> 'csam' AND "
                    + ACTIVE_RESTRICTION, (user_id, kind))
    if not rows:
        return [], None
    action_id = log_action(conn, actor, action, rule=rule, user_id=user_id, note=note, reverses=reverses,
                           case_id=case_id)
    ids = [r[0] for r in rows]
    conn.execute('UPDATE user_restrictions SET lifted_at = now(), lifted_by_action_id = %s WHERE id = ANY(%s)',
                 (action_id, ids))
    return ids, action_id


def evaluate_strikes(conn, user_id, settings=None):
    """3 strikes in 90 days restrict uploads for 30 days; a further strike while restricted, or
    within 90 days after, suspends; 3 upheld copyright notices ever suspend (repeat infringers)."""
    settings = settings or safety_settings()
    window = timedelta(days=settings.strikes_window_days)
    if any(r[1] == 'suspended' for r in active_restrictions(conn, user_id)):
        return None
    strikes = all_rows(conn, "SELECT id, rule, created_at FROM user_warnings WHERE user_id = %s AND counts_as_strike "
                             "AND appeal_state <> 'granted' ORDER BY created_at", (user_id,))
    copyright_strikes = [s for s in strikes if s[1] == 'copyright']
    recent = [s for s in strikes if s[2] > utcnow() - window]
    if len(copyright_strikes) >= 3:
        return _strike_suspend(conn, user_id, 'copyright')
    # the last automatic upload restriction, if it was in force within the window
    last = one(conn, "SELECT starts_at, COALESCE(lifted_at, ends_at) FROM user_restrictions WHERE user_id = %s "
                     "AND kind = 'uploads' ORDER BY starts_at DESC LIMIT 1", (user_id,))
    if last is not None and (last[1] is None or last[1] > utcnow() - window):
        newer = [s for s in recent if s[2] > last[0]]
        if newer:
            return _strike_suspend(conn, user_id, newer[-1][1])
        return None
    if len(recent) >= settings.strikes_restrict:
        ends_at = utcnow() + timedelta(days=settings.restrict_days)
        return restrict(conn, user_id, 'uploads', recent[-1][1], ends_at=ends_at, details={'strikes': len(recent)})
    return None


def _strike_suspend(conn, user_id, rule):
    case_id = open_case(conn, 'user', 2, user_id)
    return restrict(conn, user_id, 'suspended', rule, case_id=case_id, details={'reason': 'strikes'})


# --- bans (§9.3) ------------------------------------------------------------------------------------------------

def active_ban(conn, fingerprint=None, ip_hash=None):
    clauses, params = [], []
    if fingerprint is not None:
        clauses.append('fingerprint = %s')
        params.append(fingerprint)
    if ip_hash is not None:
        clauses.append('abuse_ip_hash = %s')
        params.append(ip_hash)
    if not clauses:
        return None
    return one(conn, 'SELECT id FROM bans WHERE ({}) AND lifted_at IS NULL AND (expires_at IS NULL OR '
                     'expires_at > now()) LIMIT 1'.format(' OR '.join(clauses)), params)


def ban(conn, actor, rule, fingerprint=None, ip_hash=None, expires_at=None, source=None, case_id=None, note=None,
        child_safety=False):
    """A `bans` row and its audit row; an existing open-ended ban of the same key is reused."""
    existing = one(conn, 'SELECT id FROM bans WHERE {} = %s AND lifted_at IS NULL AND expires_at IS NULL'.format(
        'fingerprint' if fingerprint is not None else 'abuse_ip_hash'),
        (fingerprint if fingerprint is not None else ip_hash,)) if expires_at is None else None
    if existing is not None:
        return existing[0], None
    action_id = log_action(conn, actor, 'ban', rule=rule, case_id=case_id, note=note, child_safety=child_safety,
                           details={'kind': 'fingerprint' if fingerprint is not None else 'ip', 'source': source,
                                    'expires_at': int(expires_at.timestamp()) if expires_at else None})
    ban_id = one(conn, 'INSERT INTO bans (fingerprint, abuse_ip_hash, rule, action_id, source, expires_at) '
                       'VALUES (%s, %s, %s, %s, %s::jsonb, %s) RETURNING id',
                 (fingerprint, ip_hash, rule, action_id, json.dumps(source) if source else None, expires_at))[0]
    return ban_id, action_id


# --- moderation states and collages (§6.4) -----------------------------------------------------------------

def invalidate_collages(conn, album_ids):
    """Content left these albums for a moderation or scan reason: drop their collage now (the
    payload stops pointing at it) and make a new one."""
    from jobs.media import queue_collage
    album_ids = sorted(set(album_ids))
    if not album_ids:
        return
    rows = all_rows(conn, 'UPDATE albums a SET collage_key = NULL, collage_version = NULL FROM albums old '
                          'WHERE a.id = old.id AND a.id = ANY(%s) RETURNING a.id, old.collage_key', (album_ids,))
    for album_id, old_key in rows:
        queue_collage(conn, album_id, delay=0, old_key=old_key)


def albums_of_files(conn, file_ids):
    return [r[0] for r in all_rows(conn, 'SELECT DISTINCT album_id FROM album_files WHERE file_id = ANY(%s)',
                                    (list(file_ids),))]


def albums_of_hash(conn, hash_id):
    return [r[0] for r in all_rows(conn, 'SELECT DISTINCT af.album_id FROM album_files af JOIN files f ON '
                                         'f.id = af.file_id WHERE f.hash_id = %s', (hash_id,))]


def set_file_state(conn, file_ids, state, rule=None, auto=False):
    """files.moderation_state for these files; leaving `visible` invalidates their albums' collages."""
    file_ids = list(file_ids)
    if not file_ids:
        return []
    rows = all_rows(conn, 'UPDATE files SET moderation_state = %s, moderation_rule = %s, moderated_at = now(), '
                          'moderation_auto = %s WHERE id = ANY(%s) RETURNING id',
                    (state, rule if state != 'visible' else None, auto and state != 'visible', file_ids))
    invalidate_collages(conn, albums_of_files(conn, file_ids))
    return [r[0] for r in rows]


def set_album_state(conn, album_ids, state, rule=None, auto=False):
    album_ids = list(album_ids)
    if not album_ids:
        return []
    return [r[0] for r in all_rows(conn, (
        'UPDATE albums SET moderation_state = %s, moderation_rule = %s, moderated_at = now(), moderation_auto = %s, '
        'updated_at = now() WHERE id = ANY(%s) RETURNING id'),
        (state, rule if state != 'visible' else None, auto and state != 'visible', album_ids))]


def soft_delete_files(conn, file_ids, reason):
    """The normal delete path (jobs/gc.py), with `deleted_reason`."""
    from jobs.gc import after_delete
    rows = all_rows(conn, 'UPDATE files SET deleted_at = now(), deleted_reason = %s WHERE id = ANY(%s) AND '
                          'deleted_at IS NULL RETURNING id, hash_id', (reason, list(file_ids)))
    after_delete(conn, [r[0] for r in rows], [r[1] for r in rows])
    return [r[0] for r in rows]


def queue_probe(conn, hash_id):
    """A hash that just became public gets its media processing (strict order, §2.1)."""
    from jobs.media import queue_probe as enqueue
    state = one(conn, 'SELECT processing_state FROM file_hashes WHERE id = %s', (hash_id,))
    if state is not None and state[0] in ('pending', 'failed'):
        if one(conn, "SELECT 1 FROM jobs WHERE kind = 'probe' AND payload->>'hash_id' = %s AND done_at IS NULL "
                     "AND failed_at IS NULL", (str(hash_id),)) is None:
            enqueue(conn, hash_id)


def hash_files(conn, hash_id, live=True):
    """[(id, user_id, fingerprint, vanity, deleted_at)] of the hash's files."""
    return all_rows(conn, 'SELECT id, user_id, fingerprint, vanity, deleted_at FROM files WHERE hash_id = %s{} '
                          'ORDER BY id'.format(' AND deleted_at IS NULL' if live else ''), (hash_id,))


def json_dumps(value):
    return json.dumps(value, separators=(',', ':'))
