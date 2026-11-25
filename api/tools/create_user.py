"""Dev-only: create (or reset) a verified user and print a session for it, with no email and no Turnstile. For
the local e2e stack (e2e/README.md).

    FILESGG_DEV_TOOLS=1 python -m tools.create_user --username e2e --password '<password>' [--premium]

Refuses to run unless FILESGG_DEV_TOOLS=1. Needs DATABASE_URL, like the API. Running it again for the same
email resets that user's password. Prints one JSON object:

    {"id", "username", "email", "session": {"name": <cookie name>, "value": "fgs_…", "max_age"}}

The session is a normal web session (milestone-6 §3): set it as the cookie `name` on the site's host (the local
stack uses `filesgg_session`, SESSION_COOKIE_INSECURE=1), and the Worker forwards it on `/api` requests. Signing
in through `/app/login` works too.
"""

import argparse
import json
import os
import sys

from tools import require_dev_tools


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog='python -m tools.create_user', description=__doc__.split('\n\n')[0])
    parser.add_argument('--username', required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--email', help='default: <username>@files.localhost')
    parser.add_argument('--display-name')
    parser.add_argument('--premium', action='store_true', help='also grant premium (logged with actor_kind cli)')
    return parser.parse_args(argv)


def create_or_reset(conn, options):
    from datetime import datetime, timedelta, timezone

    from utils import credentials, passwords, parameters, usernames
    from utils.account_settings import account_settings
    from utils.generators import Snowflake

    username, reason = usernames.check(options.username)
    if reason:
        raise SystemExit('create_user: username: {}'.format(usernames.REASON_MESSAGES[reason]))
    reason = passwords.account_password_reason(options.password, username)
    if reason:
        raise SystemExit('create_user: password: {}'.format(reason))
    try:
        email = parameters.email(options.email or '{}@files.localhost'.format(username))
    except ValueError as error:
        raise SystemExit('create_user: {}'.format(error))
    password_hash = passwords.hash_sync(options.password)
    settings = account_settings()
    with conn.transaction():
        row = conn.execute('SELECT id FROM users WHERE lower(email) = lower(%s) AND deleted_at IS NULL',
                           (email,)).fetchone()
        if row is not None:
            user_id = row[0]
            conn.execute('UPDATE users SET password_hash = %s, email_verified = true WHERE id = %s',
                         (password_hash, user_id))
        else:
            if conn.execute('SELECT 1 FROM users WHERE username = %s', (username,)).fetchone():
                raise SystemExit('create_user: the username {!r} is taken by another email'.format(username))
            user_id = Snowflake.generate()
            conn.execute('INSERT INTO users (id, email, email_verified, username, display_name, password_hash) '
                         'VALUES (%s, %s, true, %s, %s, %s)',
                         (user_id, email, username, usernames.clean_display_name(options.display_name),
                          password_hash))
        if options.premium and not conn.execute(
                "SELECT 1 FROM user_entitlements WHERE user_id = %s AND kind = 'premium' AND revoked_at IS NULL "
                'AND expired_at IS NULL', (user_id,)).fetchone():
            from tools import entitlements
            entitlements.grant(conn, user_id, None, 'create_user', 'dev premium')
        token = credentials.generate(credentials.SESSION_PREFIX)
        now = datetime.now(timezone.utc)
        max_expires = now + timedelta(days=settings.session_max_days)
        conn.execute('INSERT INTO sessions (id, user_id, token_hash, method, expires_at, max_expires_at, user_agent) '
                     "VALUES (%s, %s, %s, 'password', %s, %s, 'tools.create_user')",
                     (Snowflake.generate(), user_id, credentials.token_hash(token),
                      now + timedelta(days=settings.session_idle_days), max_expires))
    return {'id': str(user_id), 'username': username, 'email': email,
            'session': {'name': settings.cookie_name, 'value': token,
                        'max_age': int((max_expires - now).total_seconds())}}


def main(argv=None):
    require_dev_tools('tools.create_user')
    options = parse_args(argv)
    if not os.environ.get('DATABASE_URL'):
        raise SystemExit('create_user: DATABASE_URL must be set')

    import db
    from utils.snowflake_nodes import start_process_lease, stop_process_lease

    # ids come from a leased Snowflake node, like every other process
    start_process_lease()
    try:
        with db.connect() as conn:
            result = create_or_reset(conn, options)
    finally:
        stop_process_lease()
    sys.stdout.write(json.dumps(result) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
