"""Premium entitlements (contract milestone-6 §9): rows in `user_entitlements`, granted by admins (API or
`python -m tools.entitlements`), audited in `moderation_actions`. Synchronous: the admin API runs these in a
thread, the CLI and the worker call them directly. Each expects to run in the caller's transaction and returns
the mails to send once it has committed."""

from db.models import epoch
from safety import core
from utils import domains, errors, mail
from utils.generators import Snowflake

COLUMNS = ('id', 'user_id', 'kind', 'granted_by', 'granted_at', 'expires_at', 'revoked_at', 'revoked_by', 'note',
           'action_id', 'expired_at')
ACTIVE_SQL = "e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now())"


def load(conn, entitlement_id, user_id=None, lock=False):
    sql = 'SELECT {} FROM user_entitlements e WHERE e.id = %s'.format(', '.join('e.' + c for c in COLUMNS))
    params = [entitlement_id]
    if user_id is not None:
        sql += ' AND e.user_id = %s'
        params.append(user_id)
    row = core.one(conn, sql + (' FOR UPDATE' if lock else ''), params)
    return dict(zip(COLUMNS, row)) if row else None


def entitlement_dict(conn, row, staff=True):
    def who(user_id):
        if user_id is None:
            return None
        name = core.one(conn, 'SELECT username FROM users WHERE id = %s', (user_id,))
        return {'id': str(user_id), 'username': name[0] if name else None}
    now = core.utcnow()
    data = {
        'id': str(row['id']),
        'kind': row['kind'],
        'active': row['revoked_at'] is None and (row['expires_at'] is None or row['expires_at'] > now),
        'granted_at': epoch(row['granted_at']),
        'granted_by': who(row['granted_by']),
        'expires_at': epoch(row['expires_at']),
        'revoked_at': epoch(row['revoked_at']),
        'revoked_by': who(row['revoked_by']),
    }
    if staff:
        data['note'] = row['note']
    return data


def history(conn, user_id):
    rows = core.all_rows(conn, 'SELECT {} FROM user_entitlements e WHERE e.user_id = %s ORDER BY e.id DESC'.format(
        ', '.join('e.' + c for c in COLUMNS)), (user_id,))
    return [entitlement_dict(conn, dict(zip(COLUMNS, r))) for r in rows]


def is_premium(conn, user_id):
    return bool(core.one(conn, "SELECT EXISTS (SELECT 1 FROM user_entitlements e WHERE e.user_id = %s AND "
                               "e.kind = 'premium' AND " + ACTIVE_SQL + ')', (user_id,))[0])


def _user(conn, user_id):
    row = core.one(conn, 'SELECT username, email, email_verified FROM users WHERE id = %s AND deleted_at IS NULL',
                   (user_id,))
    if row is None:
        raise errors.unknown_user()
    return row


def _premium_mail(user_row, event, expires_at=None):
    username, email, verified = user_row
    if not email or not verified:
        return None
    return mail.premium_changed(email, username, event, mail.date_text(expires_at) if expires_at else None)


def record_expired(conn, user_id=None):
    """Lapsed entitlements get `entitlement_expired` (actor system) once, and their owners' domains pause.
    For every user, or one (before a grant). Returns mails."""
    sql = ('UPDATE user_entitlements SET expired_at = now() WHERE revoked_at IS NULL AND expired_at IS NULL AND '
           'expires_at <= now()')
    params = []
    if user_id is not None:
        sql += ' AND user_id = %s'
        params.append(user_id)
    rows = core.all_rows(conn, sql + ' RETURNING id, user_id, kind, expires_at', params)
    mails = []
    for entitlement_id, owner, kind, expires_at in rows:
        core.log_action(conn, core.SYSTEM, 'entitlement_expired', user_id=owner,
                        details={'entitlement_id': str(entitlement_id), 'kind': kind, 'expires_at': epoch(expires_at)})
        if not is_premium(conn, owner):
            row = core.one(conn, 'SELECT username, email, email_verified FROM users WHERE id = %s', (owner,))
            if row is not None:
                mails.append(_premium_mail(row, 'expired'))
            mails += domains.pause_user_domains(conn, owner)
    return [m for m in mails if m is not None]


def grant(conn, user_id, actor_user_id, by, note, kind='premium', expires_at=None, actor=None):
    """`grant_entitlement`. 409 ENTITLEMENT_EXISTS when one is active. Returns (row, mails)."""
    user_row = _user(conn, user_id)
    mails = record_expired(conn, user_id)
    if core.one(conn, 'SELECT 1 FROM user_entitlements WHERE user_id = %s AND kind = %s AND revoked_at IS NULL AND '
                      'expired_at IS NULL', (user_id, kind)):
        raise errors.entitlement_exists()
    actor = actor or (core.Actor('staff', actor_user_id) if actor_user_id else core.Actor('cli'))
    entitlement_id = Snowflake.generate()
    details = {'entitlement_id': str(entitlement_id), 'kind': kind, 'expires_at': epoch(expires_at)}
    if by:
        details['by'] = by
    action_id = core.log_action(conn, actor, 'grant_entitlement', user_id=user_id, note=note, details=details)
    conn.execute('INSERT INTO user_entitlements (id, user_id, kind, granted_by, expires_at, note, action_id) '
                 'VALUES (%s, %s, %s, %s, %s, %s, %s)',
                 (entitlement_id, user_id, kind, actor_user_id, expires_at, note, action_id))
    mails += domains.resume_user_domains(conn, user_id)
    mails.append(_premium_mail(user_row, 'granted', expires_at))
    return load(conn, entitlement_id), [m for m in mails if m is not None]


def change(conn, user_id, entitlement_id, actor_user_id, expires_at, note):
    """`change_entitlement`: a new expiry (None = until revoked)."""
    _user(conn, user_id)
    row = load(conn, entitlement_id, user_id, lock=True)
    if row is None or row['revoked_at'] is not None:
        raise errors.unknown_entitlement()
    was_premium = is_premium(conn, user_id)
    conn.execute('UPDATE user_entitlements SET expires_at = %s, expired_at = NULL WHERE id = %s',
                 (expires_at, entitlement_id))
    core.log_action(conn, core.Actor('staff', actor_user_id), 'change_entitlement', user_id=user_id, note=note,
                    details={'entitlement_id': str(entitlement_id), 'kind': row['kind'], 'expires_at': epoch(expires_at)})
    mails = domains.resume_user_domains(conn, user_id) if not was_premium and is_premium(conn, user_id) else []
    return load(conn, entitlement_id), mails


def revoke(conn, user_id, actor_user_id, note, entitlement_id=None, by=None, actor=None):
    """`revoke_entitlement`: premium ends at once, domains pause."""
    user_row = _user(conn, user_id)
    if entitlement_id is None:
        found = core.one(conn, "SELECT id FROM user_entitlements WHERE user_id = %s AND kind = 'premium' AND "
                               'revoked_at IS NULL ORDER BY id DESC LIMIT 1', (user_id,))
        if found is None:
            raise errors.unknown_entitlement()
        entitlement_id = found[0]
    row = load(conn, entitlement_id, user_id, lock=True)
    if row is None or row['revoked_at'] is not None:
        raise errors.unknown_entitlement()
    conn.execute('UPDATE user_entitlements SET revoked_at = now(), revoked_by = %s WHERE id = %s',
                 (actor_user_id, entitlement_id))
    details = {'entitlement_id': str(entitlement_id), 'kind': row['kind'], 'expires_at': epoch(row['expires_at'])}
    if by:
        details['by'] = by
    actor = actor or (core.Actor('staff', actor_user_id) if actor_user_id else core.Actor('cli'))
    core.log_action(conn, actor, 'revoke_entitlement', user_id=user_id, note=note, details=details)
    mails = []
    if not is_premium(conn, user_id):
        mails += domains.pause_user_domains(conn, user_id)
        mails.append(_premium_mail(user_row, 'revoked'))
    return load(conn, entitlement_id), [m for m in mails if m is not None]
