"""Milestone 6 account jobs and scheduled tasks (contract milestone-6 §15), registered by jobs/tasks.py.

Jobs: `domain_delete` (a Cloudflare custom hostname, retried with the queue's backoff) and `account_export`
(the data export ZIP). Scheduled: `domain_checker` (1 min), `entitlements_expiry` (1 h), `account_deletion`
(1 h, the end of the 14-day grace period), `exports_cleanup` (1 h) and `session_cleanup` (daily).
"""

import io
import json
import logging
import zipfile

from datetime import timedelta

from db.models import epoch
from jobs.queue import register
from utils import cloudflare, domains, entitlements, mail

log = logging.getLogger(__name__)

DOMAIN_CHECKER_INTERVAL = 60
ENTITLEMENTS_INTERVAL = 60 * 60
DELETION_INTERVAL = 60 * 60
EXPORTS_CLEANUP_INTERVAL = 60 * 60
SESSION_CLEANUP_INTERVAL = 24 * 60 * 60
DELETION_BATCH = 20


# --- jobs -------------------------------------------------------------------------------------------------------

@register('domain_delete')
def domain_delete(payload, job):
    """Delete a custom hostname at Cloudflare (404 counts as done), then forget its id."""
    import db
    cf_id = payload.get('cf_hostname_id')
    if not cf_id:
        return
    cloudflare.delete(cf_id)
    with db.connect() as conn:
        conn.execute('UPDATE custom_domains SET cf_hostname_id = NULL WHERE id = %s AND cf_hostname_id = %s',
                     (int(payload['domain_id']), cf_id))


README = """files.gg data export

account.json       your account, as the dashboard sees it
identities.json    login methods linked to your account (Discord)
sessions.json      your signed-in sessions (browser, system and country; no IP addresses)
upload_keys.json   your upload keys (names, prefixes and scopes; never the keys themselves)
domains.json       your custom domains
files.json         your files' details (no file contents; links are unsigned)
albums.json        your albums, with their items in order and their captions
reports.json       reports you filed, with their messages as you see them
notices.json       notices about your account and content, and your appeals

Albums have "Download all" for their files.
"""


def _rows(conn, sql, params):
    cursor = conn.execute(sql, params)
    names = [c.name for c in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def _plain(value):
    from datetime import datetime
    if isinstance(value, datetime):
        return epoch(value)
    if isinstance(value, (bytes, memoryview)):
        return None
    if isinstance(value, int) and abs(value) > 2 ** 53:
        return str(value)
    return value


def _clean(rows):
    return [{k: _plain(v) for k, v in row.items()} for row in rows]


def build_export(conn, user_id):
    """{filename: object} of the account's data (§8.7)."""
    from utils import accounts
    from utils.generators import Snowflake
    from utils.urls import public_url
    user = conn.execute('SELECT id, username, display_name, email, email_verified, pending_email, password_hash IS NOT '
                        'NULL, created_at, username_changed_at, show_name_on_albums, domain_only, '
                        'deletion_requested_at, deletion_scheduled_for FROM users WHERE id = %s', (user_id,)).fetchone()
    account = {'id': str(user[0]), 'username': user[1], 'display_name': user[2], 'email': user[3],
               'email_verified': user[4], 'pending_email': user[5], 'has_password': user[6],
               'created_at': epoch(user[7]), 'username_changed_at': epoch(user[8]),
               'settings': {'show_name_on_albums': user[9], 'domain_only': user[10]},
               'premium': entitlements.is_premium(conn, user_id),
               'deletion': {'requested_at': epoch(user[11]), 'scheduled_for': epoch(user[12])} if user[11] else None}
    identities = [accounts.identity_dict(r) for r in conn.execute(
        'SELECT {} FROM user_identities WHERE user_id = %s'.format(accounts.IDENTITY_COLUMNS), (user_id,)).fetchall()]
    sessions = _clean(_rows(conn, 'SELECT id, method, created_at, last_used_at, expires_at, revoked_at, revoked_reason, '
                                  'user_agent, country, last_country FROM sessions WHERE user_id = %s ORDER BY id',
                            (user_id,)))
    keys = _clean(_rows(conn, 'SELECT id, name, prefix, scopes, domain_id, created_at, expires_at, last_used_at, '
                              'revoked_at, revoked_reason FROM upload_keys WHERE user_id = %s ORDER BY id', (user_id,)))
    domain_rows = _clean(_rows(conn, 'SELECT id, hostname, status, status_reason, is_default, scope, verified_at, '
                                     'created_at, deleted_at FROM custom_domains WHERE user_id = %s ORDER BY id',
                               (user_id,)))
    files = []
    for row in _rows(conn, 'SELECT id, vanity, filename, extension, mimetype_id, size, visibility, view_count, '
                           'expires_at, deleted_at, nsfw_marked, moderation_state FROM files WHERE user_id = %s AND '
                           'deleted_at IS NULL ORDER BY id', (user_id,)):
        suffix = '.' + row['extension'] if row['extension'] else ''
        files.append({'id': str(row['id']), 'vanity': row['vanity'], 'filename': row['filename'] + suffix,
                      'mimetype': row['mimetype_id'], 'size': row['size'], 'visibility': row['visibility'],
                      'views': row['view_count'], 'url': public_url('/' + row['vanity'] + suffix),
                      'uploaded_at': Snowflake.decode(row['id'])['timestamp'] // 1000,
                      'expires_at': epoch(row['expires_at']), 'nsfw': row['nsfw_marked'],
                      'state': row['moderation_state']})
    albums = []
    for row in _rows(conn, 'SELECT id, vanity, title, description, layout, visibility, created_at, updated_at FROM '
                           'albums WHERE owner_user_id = %s AND deleted_at IS NULL ORDER BY id', (user_id,)):
        items = [{'file_id': str(r[0]), 'position': r[1], 'caption': r[2]} for r in conn.execute(
            'SELECT file_id, position, caption FROM album_files WHERE album_id = %s ORDER BY position, file_id',
            (row['id'],)).fetchall()]
        albums.append(dict(_clean([row])[0], id=str(row['id']), url=public_url('/a/' + row['vanity']), items=items))
    reports = []
    for row in _rows(conn, 'SELECT id, kind, reason, target_vanity, status, details, created_at, resolved_at FROM '
                           'reports WHERE reporter_user_id = %s ORDER BY id', (user_id,)):
        messages = [{'from': 'files.gg' if r[0] else 'you', 'body': r[1], 'created_at': epoch(r[2])}
                    for r in conn.execute('SELECT is_staff, body, created_at FROM report_messages WHERE report_id = %s '
                                          'ORDER BY id', (row['id'],)).fetchall()]
        reports.append(dict(_clean([row])[0], id=str(row['id']), messages=messages))
    notices = _clean(_rows(conn, 'SELECT id, action, rule, message, target, appealable, acknowledged_at, appeal_state, '
                                 'appeal_message, appeal_reply, appealed_at, appeal_decided_at, created_at FROM '
                                 'user_warnings WHERE user_id = %s ORDER BY id', (user_id,)))
    return {'account.json': account, 'identities.json': identities, 'sessions.json': sessions,
            'upload_keys.json': keys, 'domains.json': domain_rows, 'files.json': files, 'albums.json': albums,
            'reports.json': reports, 'notices.json': notices}


def zip_export(documents):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, value in documents.items():
            archive.writestr(name, json.dumps(value, indent=2, ensure_ascii=False, default=str))
        archive.writestr('README.txt', README)
    return out.getvalue()


@register('account_export')
def account_export(payload, job):
    import db
    from jobs.finalize import bucket, s3
    from utils.account_settings import account_settings
    export_id = int(payload['export_id'])
    with db.connect() as conn:
        row = conn.execute("UPDATE data_exports SET status = 'running' WHERE id = %s AND status IN ('queued', "
                           "'running') RETURNING user_id", (export_id,)).fetchone()
        if row is None:
            return
        user_id = row[0]
        try:
            data = zip_export(build_export(conn, user_id))
            key = 'exports/{}/{}.zip'.format(user_id, export_id)
            s3().put_object(Bucket=bucket(), Key=key, Body=data, ContentType='application/zip')
        except Exception:
            if job is None or job.attempts >= job.max_attempts:
                conn.execute("UPDATE data_exports SET status = 'failed' WHERE id = %s", (export_id,))
            raise
        conn.execute("UPDATE data_exports SET status = 'ready', storage_key = %s, size = %s, ready_at = now(), "
                     'expires_at = now() + make_interval(days => %s) WHERE id = %s',
                     (key, len(data), account_settings().export_keep_days, export_id))


# --- the permanent deletion (§8.8) --------------------------------------------------------------------------------

def delete_account(conn, user_id):
    """One account whose grace period is over, in one transaction. Returns the mails (sent before the address
    is scrubbed, as far as the caller is concerned: they're built from the row as it was)."""
    import jobs.gc
    from safety import core
    from utils.account_settings import account_settings
    settings = account_settings()
    mails = []
    exports = []
    with conn.transaction():
        user = conn.execute('SELECT username, email, email_verified FROM users WHERE id = %s AND deleted_at IS NULL '
                            'AND deletion_scheduled_for <= now() FOR UPDATE', (user_id,)).fetchone()
        if user is None:
            return [], []
        username, email, verified = user
        if email and verified:
            mails.append(mail.account_deleted(email, username))
        conn.execute("UPDATE users SET deleted_at = now(), email = NULL, pending_email = NULL, password_hash = NULL, "
                     "display_name = NULL, deletion_requested_at = NULL, deletion_scheduled_for = NULL, "
                     "username = 'deleted-' || id, email_verified = false, domain_only = false, needs_username = false "
                     'WHERE id = %s', (user_id,))
        conn.execute('INSERT INTO username_holds (username, user_id, held_until) VALUES (%s, %s, now() + '
                     'make_interval(days => %s)) ON CONFLICT (username) DO UPDATE SET user_id = EXCLUDED.user_id, '
                     'released_at = now(), held_until = EXCLUDED.held_until',
                     (username, user_id, settings.username_hold_days))
        conn.execute("UPDATE sessions SET revoked_at = now(), revoked_reason = 'account_deleted' WHERE user_id = %s "
                     'AND revoked_at IS NULL', (user_id,))
        conn.execute("UPDATE upload_keys SET revoked_at = now(), revoked_reason = 'account_deleted' WHERE user_id = %s "
                     'AND revoked_at IS NULL', (user_id,))
        conn.execute('DELETE FROM account_tokens WHERE user_id = %s', (user_id,))
        conn.execute('DELETE FROM user_identities WHERE user_id = %s', (user_id,))
        for (entitlement_id, kind, expires_at) in conn.execute(
                'UPDATE user_entitlements SET revoked_at = now() WHERE user_id = %s AND revoked_at IS NULL AND '
                'expired_at IS NULL RETURNING id, kind, expires_at', (user_id,)).fetchall():
            core.log_action(conn, core.SYSTEM, 'revoke_entitlement', user_id=user_id,
                            details={'entitlement_id': str(entitlement_id), 'kind': kind,
                                     'expires_at': epoch(expires_at), 'reason': 'account_deleted'})
        rows = conn.execute("UPDATE files SET deleted_at = now(), deleted_reason = 'account_deleted' WHERE user_id = %s "
                            'AND deleted_at IS NULL RETURNING id, hash_id', (user_id,)).fetchall()
        jobs.gc.after_delete(conn, [r[0] for r in rows], [r[1] for r in rows])
        conn.execute("UPDATE albums SET deleted_at = now(), deleted_reason = 'account_deleted' WHERE owner_user_id = %s "
                     'AND deleted_at IS NULL', (user_id,))
        # staff-disabled domains keep their row (and hostname), so nobody can re-add it (§10.12)
        for domain_id, cf_id in conn.execute(
                "UPDATE custom_domains SET deleted_at = now(), is_default = false WHERE user_id = %s AND deleted_at IS "
                "NULL AND status <> 'disabled' RETURNING id, cf_hostname_id", (user_id,)).fetchall():
            domains.queue_cf_delete(conn, domain_id, cf_id)
        # open uploads are aborted by the upload reaper
        conn.execute("UPDATE upload_sessions SET status = 'failed', error = 'ACCOUNT_DELETED', expires_at = now() "
                     "WHERE owner_user_id = %s AND status = 'open'", (user_id,))
        exports = [r[0] for r in conn.execute('DELETE FROM data_exports WHERE user_id = %s RETURNING storage_key',
                                              (user_id,)).fetchall() if r[0]]
    return mails, exports


def run_deletions(conn, limit=DELETION_BATCH):
    from jobs.finalize import bucket, s3
    rows = conn.execute('SELECT id FROM users WHERE deletion_scheduled_for <= now() AND deleted_at IS NULL '
                        'ORDER BY deletion_scheduled_for LIMIT %s', (limit,)).fetchall()
    done = 0
    for (user_id,) in rows:
        try:
            mails, exports = delete_account(conn, user_id)
        except Exception:
            log.exception('permanent deletion failed for user %s', user_id)
            continue
        mail.send_sync(mails)
        for key in exports:
            try:
                s3().delete_object(Bucket=bucket(), Key=key)
            except Exception:
                log.warning('export object %s not deleted', key)
        done += 1
    return done


def cleanup_exports(conn):
    from jobs.finalize import bucket, s3
    rows = conn.execute("UPDATE data_exports SET status = 'expired' WHERE status = 'ready' AND expires_at <= now() "
                        'RETURNING storage_key').fetchall()
    for (key,) in rows:
        if key:
            try:
                s3().delete_object(Bucket=bucket(), Key=key)
            except Exception:
                log.warning('export object %s not deleted', key)
    return len(rows)


def cleanup_sessions(conn):
    """Sessions ended more than 30 days ago, used or expired email links older than 7 days, and username
    holds that have passed."""
    sessions = conn.execute("DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval "
                            "'30 days') OR least(expires_at, max_expires_at) < now() - interval '30 days'").rowcount
    tokens = conn.execute("DELETE FROM account_tokens WHERE (used_at IS NOT NULL OR expires_at < now()) AND "
                          "created_at < now() - interval '7 days'").rowcount
    holds = conn.execute('DELETE FROM username_holds WHERE held_until <= now()').rowcount
    return sessions, tokens, holds


def register_scheduled(scheduler):
    conn = scheduler.conn

    @scheduler.register('domain_checker', DOMAIN_CHECKER_INTERVAL)
    def domain_checker():
        mail.send_sync(domains.run_checker(conn))

    @scheduler.register('entitlements_expiry', ENTITLEMENTS_INTERVAL)
    def entitlements_expiry():
        with conn.transaction():
            mails = entitlements.record_expired(conn)
        mail.send_sync(mails)

    @scheduler.register('account_deletion', DELETION_INTERVAL)
    def account_deletion():
        log.info('account deletion removed %d account(s)', run_deletions(conn))

    @scheduler.register('exports_cleanup', EXPORTS_CLEANUP_INTERVAL)
    def exports_cleanup():
        log.info('exports cleanup expired %d export(s)', cleanup_exports(conn))

    @scheduler.register('session_cleanup', SESSION_CLEANUP_INTERVAL)
    def session_cleanup():
        log.info('session cleanup removed %d session(s), %d link(s), %d hold(s)', *cleanup_sessions(conn))
