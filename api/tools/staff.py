"""Grant, revoke and list staff (contract milestone-4 §9.1). Only on the server; there's no API
to grant staff in Milestone 4. Not a dev tool: it runs in production (needs DATABASE_URL).

    python -m tools.staff grant <user_id> --role moderator|admin [--child-safety] --by <name>
    python -m tools.staff revoke <user_id> --by <name>
    python -m tools.staff list

Each change writes `grant_staff` / `revoke_staff` to the audit log (`actor_kind: cli`, the
operator's `--by <name>` in `details`).
"""

import argparse
import json
import sys


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog='python -m tools.staff', description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    grant = commands.add_parser('grant')
    grant.add_argument('user_id', type=int)
    grant.add_argument('--role', choices=('moderator', 'admin'), required=True)
    grant.add_argument('--child-safety', action='store_true')
    grant.add_argument('--by', required=True, help='who is running this (recorded in the audit log)')
    revoke = commands.add_parser('revoke')
    revoke.add_argument('user_id', type=int)
    revoke.add_argument('--by', required=True)
    commands.add_parser('list')
    return parser.parse_args(argv)


def grant(conn, user_id, role, child_safety, by):
    from safety import core
    with conn.transaction():
        if conn.execute('SELECT 1 FROM users WHERE id = %s', (user_id,)).fetchone() is None:
            raise SystemExit('unknown user {}'.format(user_id))
        previous = conn.execute('SELECT role, child_safety FROM staff WHERE user_id = %s', (user_id,)).fetchone()
        conn.execute('INSERT INTO staff (user_id, role, child_safety) VALUES (%s, %s, %s) ON CONFLICT (user_id) DO '
                     'UPDATE SET role = EXCLUDED.role, child_safety = EXCLUDED.child_safety, granted_at = now()',
                     (user_id, role, child_safety))
        core.log_action(conn, core.Actor('cli'), 'grant_staff', user_id=user_id,
                        details={'by': by, 'role': role, 'child_safety': child_safety,
                                 'previous': {'role': previous[0], 'child_safety': previous[1]} if previous else None})
    return {'user_id': str(user_id), 'role': role, 'child_safety': child_safety}


def revoke(conn, user_id, by):
    from safety import core
    with conn.transaction():
        row = conn.execute('DELETE FROM staff WHERE user_id = %s RETURNING role, child_safety', (user_id,)).fetchone()
        if row is None:
            raise SystemExit('user {} is not staff'.format(user_id))
        conn.execute('UPDATE moderation_cases SET assignee_id = NULL, claimed_at = NULL WHERE assignee_id = %s '
                     "AND status = 'open'", (user_id,))
        core.log_action(conn, core.Actor('cli'), 'revoke_staff', user_id=user_id,
                        details={'by': by, 'role': row[0], 'child_safety': row[1]})
    return {'user_id': str(user_id), 'revoked': True}


def list_staff(conn):
    rows = conn.execute('SELECT s.user_id, u.username, s.role, s.child_safety, s.granted_at FROM staff s JOIN users u '
                        'ON u.id = s.user_id ORDER BY s.granted_at').fetchall()
    return [{'user_id': str(r[0]), 'username': r[1], 'role': r[2], 'child_safety': r[3],
             'granted_at': int(r[4].timestamp())} for r in rows]


def main(argv=None):
    import db
    options = parse_args(argv)
    with db.connect() as conn:
        if options.command == 'grant':
            result = grant(conn, options.user_id, options.role, options.child_safety, options.by)
        elif options.command == 'revoke':
            result = revoke(conn, options.user_id, options.by)
        else:
            result = list_staff(conn)
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
