"""Numbered-SQL migration runner.

    python -m migrate            apply pending migrations
    python -m migrate status     list applied and pending migrations

Migrations are `migrations/NNNN_name.sql`. Each pending file runs in its own
transaction, together with the row that records it in `schema_migrations`.
A session advisory lock stops two release steps from migrating at once.
Run this as a one-off release step before new servers start. Synchronous
psycopg 3, autocommit connection with explicit transactions.
"""

import hashlib
import logging
import os
import re
import sys

import db

log = logging.getLogger('migrate')

MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'migrations')
FILENAME_REGEX = re.compile(r'^(\d{4})_([a-z0-9_]+)\.sql$')
# arbitrary constant key for pg_advisory_lock
LOCK_KEY = 0x66696c6573  # 'files'

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


class Migration:
    def __init__(self, version, name, path):
        self.version = version
        self.name = name
        self.path = path

    @property
    def sql(self):
        with open(self.path, 'r', encoding='utf-8') as handle:
            return handle.read()

    @property
    def checksum(self):
        return hashlib.sha256(self.sql.encode('utf-8')).hexdigest()

    def __repr__(self):
        return '<Migration {}_{}>'.format(self.version, self.name)


def discover(directory=MIGRATIONS_DIR):
    migrations = []
    seen = set()
    for filename in sorted(os.listdir(directory)):
        if not filename.endswith('.sql'):
            continue
        match = FILENAME_REGEX.match(filename)
        if match is None:
            raise ValueError('Bad migration filename {!r}; expected NNNN_name.sql'.format(filename))
        version, name = match.groups()
        if version in seen:
            raise ValueError('Duplicate migration version {}'.format(version))
        seen.add(version)
        migrations.append(Migration(version, name, os.path.join(directory, filename)))
    return migrations


def _applied(conn):
    conn.execute(CREATE_TABLE_SQL)
    return dict(conn.execute('SELECT version, checksum FROM schema_migrations').fetchall())


def applied_versions(conn):
    return _applied(conn)


def pending(conn, directory=MIGRATIONS_DIR):
    applied = _applied(conn)
    return [m for m in discover(directory) if m.version not in applied]


def migrate(conn, directory=MIGRATIONS_DIR):
    """Apply pending migrations in order on an autocommit connection.
    Returns the list applied."""
    migrations = discover(directory)
    done = []
    conn.execute('SELECT pg_advisory_lock(%s)', (LOCK_KEY,))
    try:
        applied = _applied(conn)
        for migration in migrations:
            if migration.version in applied:
                if applied[migration.version] != migration.checksum:
                    log.warning('%r changed after it was applied (checksum mismatch)', migration)
                continue
            log.info('applying %r', migration)
            with conn.transaction():
                # no parameters: psycopg sends it as one simple query, so a
                # file may hold many statements
                conn.execute(migration.sql)
                conn.execute(
                    'INSERT INTO schema_migrations (version, name, checksum) VALUES (%s, %s, %s)',
                    (migration.version, migration.name, migration.checksum),
                )
            done.append(migration)
    finally:
        if not conn.closed:
            conn.execute('SELECT pg_advisory_unlock(%s)', (LOCK_KEY,))
    return done


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
    command = argv[0] if argv else 'up'
    if command not in ('up', 'status'):
        print(__doc__)
        return 2
    with db.connect() as conn:
        if command == 'up':
            done = migrate(conn)
            log.info('applied %d migration(s)%s', len(done), (': ' + ', '.join(repr(m) for m in done)) if done else '')
        else:
            applied = applied_versions(conn)
            for migration in discover():
                print('{} {}_{}'.format('applied' if migration.version in applied else 'pending',
                                         migration.version, migration.name))
    return 0


if __name__ == '__main__':
    sys.exit(main())
