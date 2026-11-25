"""Grant, revoke and list premium (contract milestone-6 §9.3), like tools.staff. Not a dev tool: it runs in
production (needs DATABASE_URL).

    python -m tools.entitlements grant <user_id> --kind premium [--days N] --by <name> --note <text>
    python -m tools.entitlements revoke <user_id> --by <name> --note <text>
    python -m tools.entitlements list

Each change writes `grant_entitlement` / `revoke_entitlement` to the audit log (`actor_kind: cli`, the
operator's `--by <name>` in `details`) and sends `premium_changed` when Postmark is configured.
"""

import argparse
import json
import os
import sys

from datetime import datetime, timedelta, timezone


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog='python -m tools.entitlements', description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    grant_cmd = commands.add_parser('grant')
    grant_cmd.add_argument('user_id', type=int)
    grant_cmd.add_argument('--kind', choices=('premium',), default='premium')
    grant_cmd.add_argument('--days', type=int, help='until revoked when left out')
    grant_cmd.add_argument('--by', required=True, help='who is running this (recorded in the audit log)')
    grant_cmd.add_argument('--note', required=True)
    revoke_cmd = commands.add_parser('revoke')
    revoke_cmd.add_argument('user_id', type=int)
    revoke_cmd.add_argument('--by', required=True)
    revoke_cmd.add_argument('--note', required=True)
    commands.add_parser('list')
    return parser.parse_args(argv)


def grant(conn, user_id, days, by, note, kind='premium'):
    """Returns the entitlement; sends its mails (best effort)."""
    from utils import entitlements, mail
    if days is not None and days <= 0:
        raise SystemExit('entitlements: --days must be positive')
    expires_at = datetime.now(timezone.utc) + timedelta(days=days) if days else None
    with conn.transaction():
        row, mails = entitlements.grant(conn, user_id, None, by, note[:2000], kind=kind, expires_at=expires_at)
        result = entitlements.entitlement_dict(conn, row)
    mail.send_sync(mails)
    return result


def revoke(conn, user_id, by, note):
    from utils import entitlements, mail
    with conn.transaction():
        row, mails = entitlements.revoke(conn, user_id, None, note[:2000], by=by)
        result = entitlements.entitlement_dict(conn, row)
    mail.send_sync(mails)
    return result


def list_premium(conn):
    rows = conn.execute("SELECT e.user_id, u.username, e.granted_at, e.expires_at FROM user_entitlements e JOIN users u "
                        "ON u.id = e.user_id WHERE e.kind = 'premium' AND e.revoked_at IS NULL AND (e.expires_at IS "
                        'NULL OR e.expires_at > now()) ORDER BY e.granted_at').fetchall()
    return [{'user_id': str(r[0]), 'username': r[1], 'granted_at': int(r[2].timestamp()),
             'expires_at': int(r[3].timestamp()) if r[3] else None} for r in rows]


def main(argv=None):
    import db
    from utils.email import Email
    from utils.errors import ApiError
    from utils.snowflake_nodes import start_process_lease, stop_process_lease
    options = parse_args(argv)
    Email.configure(token=os.getenv('POSTMARK_SERVER_TOKEN'), sender=os.getenv('EMAIL_FROM'),
                    stream=os.getenv('POSTMARK_MESSAGE_STREAM'))
    start_process_lease()
    try:
        with db.connect() as conn:
            try:
                if options.command == 'grant':
                    result = grant(conn, options.user_id, options.days, options.by, options.note, options.kind)
                elif options.command == 'revoke':
                    result = revoke(conn, options.user_id, options.by, options.note)
                else:
                    result = list_premium(conn)
            except ApiError as error:
                raise SystemExit('entitlements: {} ({})'.format(error.message, error.code))
    finally:
        stop_process_lease()
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
