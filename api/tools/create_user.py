"""Dev-only: create (or reset) a verified user and print a login token, with no
email and no Turnstile. For the local e2e stack (e2e/README.md).

    FILESGG_DEV_TOOLS=1 python -m tools.create_user --username e2e --password '<password>'

Refuses to run unless FILESGG_DEV_TOOLS=1. Needs DATABASE_URL and SECRET_KEY,
like the API. Running it again for the same email resets that user's password.
Prints one JSON object: {"id", "username", "email", "token"}. The token is a
normal UserToken: send it as `Authorization`, or set `localStorage.token` to
the JSON string of it on the web app.
"""

import argparse
import asyncio
import json
import os
import sys

from tools import require_dev_tools


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog='python -m tools.create_user', description=__doc__.split('\n\n')[0])
    parser.add_argument('--username', required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--email', help='default: <username>@files.localhost')
    return parser.parse_args(argv)


async def create_or_reset(options):
    import psycopg

    import db
    from db import queries
    from utils import helpers, parameters
    from utils.generators import Snowflake
    from utils.tokens import UserToken

    try:
        username = parameters.username(options.username)
        password = parameters.password(options.password)
        email = parameters.email(options.email or '{}@files.localhost'.format(username))
    except ValueError as error:
        raise SystemExit('create_user: {}'.format(error))
    password_hash = helpers.hash_password(password, salt_length=10)

    async with await psycopg.AsyncConnection.connect(db.conninfo(), autocommit=True) as conn:
        user = await queries.get_user_by_email(conn, email)
        if user is not None:
            await queries.set_password(conn, user.id, password_hash)
            user_id = user.id
        else:
            if await queries.user_exists(conn, username, 1):
                raise SystemExit('create_user: the username {!r} is taken by another email'.format(username))
            user_id = Snowflake.generate()
            async with conn.transaction():
                await queries.create_user(conn, id=user_id, email=email, username=username, discriminator=1,
                                          password=password_hash)
        await queries.mark_email_verified(conn, user_id, email)
    return {'id': str(user_id), 'username': username, 'email': email, 'token': UserToken.generate(user_id)}


def main(argv=None):
    require_dev_tools('tools.create_user')
    options = parse_args(argv)
    for name in ('DATABASE_URL', 'SECRET_KEY'):
        if not os.environ.get(name):
            raise SystemExit('create_user: {} must be set'.format(name))

    from utils import tokens
    from utils.snowflake_nodes import start_process_lease, stop_process_lease

    tokens.set_secret_key(os.environ['SECRET_KEY'])
    # ids come from a leased Snowflake node, like every other process
    start_process_lease()
    try:
        result = asyncio.run(create_or_reset(options))
    finally:
        stop_process_lease()
    sys.stdout.write(json.dumps(result) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
