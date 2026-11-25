"""Numbered-SQL migration runner.

    python -m migrate            apply pending migrations
    python -m migrate status     list applied and pending migrations

Migrations are `migrations/NNNN_name.sql`. Each pending file runs in its own
transaction, together with the row that records it in `schema_migrations`.

A file whose first line is `-- migrate:no-transaction` (for `CREATE INDEX
CONCURRENTLY`) instead runs statement by statement in autocommit. Its
statements must each end with `;` at the end of a line, and must be safe to
re-run (`IF NOT EXISTS`); an INVALID index left by an interrupted concurrent
build is dropped before its `CREATE INDEX CONCURRENTLY IF NOT EXISTS` is retried.
A session advisory lock stops two release steps from migrating at once.
Run this as a one-off release step before new servers start. Synchronous
psycopg 3, autocommit connection with explicit transactions.
"""

import hashlib
import logging
import os
import re
import sys
import time

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


NO_TRANSACTION = '-- migrate:no-transaction'
STATEMENT_END = re.compile(r';[ \t]*$', re.MULTILINE)
CONCURRENT_INDEX = re.compile(
    r'CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+("?)([A-Za-z0-9_]+)\1', re.IGNORECASE)


def split_statements(sql):
    lines = [line for line in sql.splitlines() if not line.lstrip().startswith('--')]
    return [s.strip() for s in STATEMENT_END.split('\n'.join(lines)) if s.strip()]


def _run_without_transaction(conn, sql):
    for statement in split_statements(sql):
        match = CONCURRENT_INDEX.search(statement)
        if match:
            invalid = conn.execute(
                'SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid '
                'WHERE c.relname = %s AND NOT i.indisvalid', (match.group(2),)).fetchone()
            if invalid:
                log.warning('dropping invalid index %s left by an interrupted build', match.group(2))
                conn.execute('DROP INDEX CONCURRENTLY IF EXISTS "{}"'.format(match.group(2)))
        conn.execute(statement)


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
    def transactional(self):
        return not self.sql.lstrip().startswith(NO_TRANSACTION)

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


class HistoryMismatch(RuntimeError):
    """The database was migrated with a different set of migrations than the ones on disk
    (for example one created before the 2026-11-25 schema squash). Running new code on it
    would silently use the wrong schema, so the runner refuses."""


def _check_history(conn, migrations):
    on_disk = {m.version: m.name for m in migrations}
    recorded = dict(conn.execute('SELECT version, name FROM schema_migrations').fetchall())
    problems = []
    for version, name in sorted(recorded.items()):
        if version not in on_disk:
            problems.append('version {} ({}) is applied but has no file here'.format(version, name))
        elif on_disk[version] != name:
            problems.append('version {} is {!r} in the database but {!r} here'.format(version, name, on_disk[version]))
    if problems:
        raise HistoryMismatch('this database has a different migration history: {}. Recreate it '
                              '(there is no upgrade path from a pre-squash database).'.format('; '.join(problems)))


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
    # Poll with pg_try_advisory_lock instead of waiting inside pg_advisory_lock:
    # a session blocked in a statement holds a snapshot, and CREATE INDEX
    # CONCURRENTLY in the session holding the lock would wait for it (deadlock).
    while not conn.execute('SELECT pg_try_advisory_lock(%s)', (LOCK_KEY,)).fetchone()[0]:
        time.sleep(0.2)
    try:
        applied = _applied(conn)
        _check_history(conn, migrations)
        for migration in migrations:
            if migration.version in applied:
                if applied[migration.version] != migration.checksum:
                    log.warning('%r changed after it was applied (checksum mismatch)', migration)
                continue
            log.info('applying %r', migration)
            if not migration.transactional:
                _run_without_transaction(conn, migration.sql)
            with conn.transaction():
                if migration.transactional:
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
