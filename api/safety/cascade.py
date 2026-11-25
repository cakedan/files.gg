"""The moderation cascade (contract milestone-5 §5.4): what happens to a source's conversion outputs.

- **Removed** (`moderation_state = 'removed'`, or deleted with `deleted_reason = 'moderator'`): every file derived
  from it (`derived_from_file_id`, or an output of a conversion listing it in `conversion_sources`) is removed the
  same way, recursively, with `moderation_rule = 'derived_from_removed'` and an audit entry per file.
- **Hidden:** the same, hidden with `derived_from_hidden`; **un-hidden:** outputs hidden by the cascade (that rule)
  only are shown again.
- **A source hash becoming `blocked`** (a rescan, a hash-list match, staff): the removal cascade from every file of
  that hash.
- Albums made by PDF -> images go with their pages: removed (or hidden, or shown again) when all their pages are.

It runs as the `moderation_cascade` job on the Postgres queue (`default`), queued in the transaction of the action
that started it, so a large tree never blocks the staff request.
"""

import json
import logging

import db
from jobs.queue import register
from safety import core

log = logging.getLogger(__name__)

ACTIONS = ('remove', 'delete', 'hide', 'unhide')
REMOVED_RULE = 'derived_from_removed'
HIDDEN_RULE = 'derived_from_hidden'
MAX_ATTEMPTS = 5

CHILDREN_SQL = (
    'SELECT f.id, f.user_id, f.moderation_state, f.moderation_rule, f.deleted_at FROM files f '
    'WHERE f.derived_from_file_id = ANY(%(ids)s) '
    'UNION SELECT f.id, f.user_id, f.moderation_state, f.moderation_rule, f.deleted_at FROM conversion_sources s '
    'JOIN files f ON f.conversion_id = s.conversion_id WHERE s.file_id = ANY(%(ids)s)')


def queue(conn, action, file_ids=(), hash_id=None):
    """Queue the cascade from these files (or every file of `hash_id`), in the caller's transaction."""
    if action not in ACTIONS:
        raise ValueError(action)
    payload = {'action': action}
    if hash_id is not None:
        payload['hash_id'] = str(hash_id)
    else:
        file_ids = [str(i) for i in file_ids]
        if not file_ids:
            return None
        payload['file_ids'] = file_ids
    return conn.execute("INSERT INTO jobs (kind, payload, queue, max_attempts) VALUES ('moderation_cascade', "
                        "%s::jsonb, 'default', %s) RETURNING id", (json.dumps(payload), MAX_ATTEMPTS)).fetchone()[0]


def _apply(conn, action, children):
    """Apply `action` to the derived files it concerns; returns those ids (the next level comes from them)."""
    if action == 'unhide':
        targets = [c for c in children if c[2] == 'hidden' and c[3] == HIDDEN_RULE and c[4] is None]
    elif action == 'hide':
        targets = [c for c in children if c[2] == 'visible' and c[4] is None]
    elif action == 'remove':
        targets = [c for c in children if c[2] != 'removed' and c[4] is None]
    else:
        targets = [c for c in children if c[4] is None]
    ids = [c[0] for c in targets]
    if not ids:
        return []
    if action == 'delete':
        core.soft_delete_files(conn, ids, 'moderator')
    else:
        state = {'remove': 'removed', 'hide': 'hidden', 'unhide': 'visible'}[action]
        core.set_file_state(conn, ids, state, REMOVED_RULE if action == 'remove' else HIDDEN_RULE)
    for file_id, user_id, _, _, _ in targets:
        core.log_action(conn, core.SYSTEM, action, rule=None if action == 'unhide' else (
            HIDDEN_RULE if action == 'hide' else REMOVED_RULE), file_id=file_id, user_id=user_id,
            details={'cascade': True})
    return ids


def _albums(conn, action, file_ids):
    """PDF page albums whose pages now all share the state: the album follows (§5.4)."""
    if action == 'delete':
        action, state = 'remove', 'removed'
    else:
        state = {'remove': 'removed', 'hide': 'hidden', 'unhide': 'visible'}[action]
    rows = conn.execute(
        'SELECT DISTINCT a.id, a.owner_user_id FROM conversions c JOIN albums a ON a.id = c.output_album_id '
        'JOIN files f ON f.conversion_id = c.id WHERE f.id = ANY(%s) AND a.deleted_at IS NULL '
        'AND a.moderation_state <> %s AND NOT EXISTS (SELECT 1 FROM album_files af JOIN files p ON p.id = af.file_id '
        'WHERE af.album_id = a.id AND p.deleted_at IS NULL AND p.moderation_state <> %s)',
        (list(file_ids), state, state)).fetchall()
    if action == 'unhide':
        rows = [r for r in rows if conn.execute('SELECT moderation_rule FROM albums WHERE id = %s',
                                                (r[0],)).fetchone()[0] == HIDDEN_RULE]
    if not rows:
        return
    rule = None if action == 'unhide' else (HIDDEN_RULE if action == 'hide' else REMOVED_RULE)
    core.set_album_state(conn, [r[0] for r in rows], state, rule)
    for album_id, user_id in rows:
        core.log_action(conn, core.SYSTEM, action, rule=rule, album_id=album_id, user_id=user_id,
                        details={'cascade': True})


def cascade(conn, action, file_ids):
    """Walk the derived tree from `file_ids`, one level at a time (each level in its own transaction). Returns every
    file changed."""
    frontier, seen, changed = set(file_ids), set(file_ids), []
    while frontier:
        with conn.transaction():
            children = [c for c in conn.execute(CHILDREN_SQL, {'ids': list(frontier)}).fetchall() if c[0] not in seen]
            seen.update(c[0] for c in children)
            ids = _apply(conn, action, children)
            if ids:
                _albums(conn, action, ids)
        changed += ids
        frontier = set(ids)
    return changed


def run(payload):
    action = payload['action']
    with db.connect() as conn:
        if payload.get('hash_id') is not None:
            file_ids = [r[0] for r in conn.execute('SELECT id FROM files WHERE hash_id = %s',
                                                   (int(payload['hash_id']),)).fetchall()]
            action = 'remove'
        else:
            file_ids = [int(i) for i in payload.get('file_ids') or ()]
        changed = cascade(conn, action, file_ids)
    if changed:
        log.info('moderation cascade (%s) changed %d derived file(s)', action, len(changed))
    return changed


@register('moderation_cascade')
def moderation_cascade_job(payload, job):
    run(payload)
