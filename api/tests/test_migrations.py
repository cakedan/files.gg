import os
import threading

import pytest

import migrate
from tests.conftest import API_DIR

LEGACY_FIXTURE = os.path.join(API_DIR, 'tests', 'fixtures', 'legacy_peewee_3_8_1_schema.sql')
LEGACY_TABLES = (
    'mimetype_types', 'mimetypes', 'file_hashes', 'users', 'files', 'file_views', 'mimetype_extensions',
)


def snapshot(temp, tables=LEGACY_TABLES):
    """Everything about the given tables that a migration could change."""
    tables = list(tables)
    columns = temp.fetchall(
        """
        SELECT table_name, column_name, ordinal_position, data_type, character_maximum_length,
               is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY(%s)
        ORDER BY table_name, ordinal_position
        """,
        (tables,),
    )
    indexes = temp.fetchall(
        "SELECT tablename, indexname, indexdef FROM pg_indexes "
        "WHERE schemaname = 'public' AND tablename = ANY(%s) ORDER BY tablename, indexname",
        (tables,),
    )
    constraints = temp.fetchall(
        """
        SELECT rel.relname, con.conname, pg_get_constraintdef(con.oid)
        FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = 'public' AND rel.relname = ANY(%s)
        ORDER BY rel.relname, con.conname
        """,
        (tables,),
    )
    return {'columns': columns, 'indexes': indexes, 'constraints': constraints}


def table_names(temp):
    return {row[0] for row in temp.fetchall(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


def load_legacy_schema(temp):
    with open(LEGACY_FIXTURE) as handle:
        temp.conn.execute(handle.read())


ALL_VERSIONS = ['0001', '0002', '0003']


def baseline_only(tmp_path):
    """A migrations directory holding just 0001."""
    import shutil
    shutil.copy(os.path.join(migrate.MIGRATIONS_DIR, '0001_baseline.sql'), tmp_path / '0001_baseline.sql')
    return str(tmp_path)


def test_discovers_migrations_in_order():
    found = migrate.discover()
    assert [m.version for m in found] == ALL_VERSIONS
    assert found[0].name == 'baseline'


def test_pending_migrations_are_not_applied():
    assert os.path.exists(os.path.join(migrate.MIGRATIONS_DIR, 'pending', '0004_drop_legacy.sql'))
    assert '0004' not in [m.version for m in migrate.discover()]


def test_applies_once_and_is_idempotent(empty_db):
    applied = migrate.migrate(empty_db.conn)
    assert [m.version for m in applied] == ALL_VERSIONS

    assert migrate.migrate(empty_db.conn) == []
    assert migrate.pending(empty_db.conn) == []

    rows = empty_db.fetchall('SELECT version, name FROM schema_migrations ORDER BY version')
    assert rows == [('0001', 'baseline'), ('0002', 'jobs_and_snowflake_nodes'), ('0003', 'views_timestamps_queues')]
    assert set(LEGACY_TABLES) | {'jobs', 'snowflake_nodes', 'schema_migrations', 'file_view_days',
                                 'file_view_seen'} == table_names(empty_db)


def test_baseline_is_noop_on_existing_create_tables_schema(empty_db, tmp_path):
    load_legacy_schema(empty_db)
    empty_db.execute("INSERT INTO mimetype_types (id) VALUES ('image')")
    empty_db.execute("INSERT INTO mimetypes (id, flags, type_id) VALUES ('image/png', 0, 'image')")
    before = snapshot(empty_db)

    applied = migrate.migrate(empty_db.conn, directory=baseline_only(tmp_path))

    assert [m.version for m in applied] == ['0001']
    assert snapshot(empty_db) == before
    assert empty_db.fetchall('SELECT id, flags, type_id FROM mimetypes') == [('image/png', 0, 'image')]
    # and the rest applies on top of the production-shaped schema
    assert [m.version for m in migrate.migrate(empty_db.conn)] == ['0002', '0003']


def test_baseline_reproduces_create_tables_schema_exactly(empty_db, tmp_path):
    from tests.conftest import TempDatabase, create_database, drop_database
    migrate.migrate(empty_db.conn, directory=baseline_only(tmp_path))
    name = create_database()
    legacy = TempDatabase(name)
    try:
        load_legacy_schema(legacy)
        assert snapshot(empty_db) == snapshot(legacy)
    finally:
        legacy.close()
        drop_database(name)


def test_row_types_match_schema(migrated_db):
    """The db layer's dataclasses name every column of their table, in table
    order, except the legacy columns that pending/0004 drops."""
    from dataclasses import fields
    from db.models import LEGACY_COLUMNS, ROW_TYPES
    for row_type in ROW_TYPES:
        names = [f.name for f in fields(row_type) if not f.metadata.get('virtual')]
        columns = [r[0] for r in migrated_db.fetchall(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' "
            "AND table_name = %s ORDER BY ordinal_position", (row_type.TABLE,))]
        columns = [c for c in columns if c not in LEGACY_COLUMNS.get(row_type.TABLE, ())]
        assert names == columns, row_type.__name__


# --- 0003 on production-shaped data ------------------------------------------------------

def test_0003_backfills_views_timestamps_and_queues(empty_db, tmp_path):
    import random
    from datetime import datetime, timezone

    load_legacy_schema(empty_db)
    migrate.migrate(empty_db.conn, directory=baseline_only(tmp_path))
    pending = tmp_path / 'p2'
    pending.mkdir()
    import shutil
    shutil.copy(os.path.join(migrate.MIGRATIONS_DIR, '0002_jobs_and_snowflake_nodes.sql'), pending)
    migrate.migrate(empty_db.conn, directory=str(pending))

    conn = empty_db.conn
    conn.execute("INSERT INTO mimetype_types (id) VALUES ('text')")
    conn.execute("INSERT INTO mimetypes (id, flags, type_id) VALUES ('text/plain', 0, 'text')")
    conn.execute("INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (1, 'b', 's', 'm', 1)")
    conn.execute(
        "INSERT INTO files (id, vanity, mimetype_id, filename, hash_id, view_count) "
        "SELECT n, 'v' || n, 'text/plain', 'f', 1, 0 FROM generate_series(1, 40) n")
    # 5000 views over 10 UTC days, as Peewee stored them: unix SECONDS, one row per
    # (file, ip) ever, but an IP can show up again for another file
    rng = random.Random(1)
    base = int(datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp())
    rows, seen = [], set()
    while len(rows) < 5000:
        file_id, ip = rng.randint(1, 40), '10.0.{}.{}'.format(rng.randint(0, 3), rng.randint(0, 255))
        if (file_id, ip) in seen:
            continue
        seen.add((file_id, ip))
        rows.append((file_id, ip, base + rng.randint(0, 10 * 86400 - 1)))
    with conn.cursor() as cursor:
        cursor.executemany('INSERT INTO file_views (file_id, ip, "timestamp") VALUES (%s, %s, %s)', rows)
    conn.execute(
        "INSERT INTO users (id, email, bot, username, discriminator, flags, verified, last_email_reset, "
        "last_password_reset) SELECT n, 'u' || n || '@x', false, 'u' || n, 1, 0, true, 1500000000 + n, 1600000000 + n "
        "FROM generate_series(1, 300) n")
    conn.execute("INSERT INTO jobs (kind) VALUES ('ping'), ('ping')")
    conn.execute("INSERT INTO jobs (kind, done_at) VALUES ('scheduled:snowflake_nodes_cleanup', now())")

    expected = {}
    for file_id, ip, ts in rows:
        day = datetime.fromtimestamp(ts, timezone.utc).date()
        views, ips = expected.get((file_id, day), (0, set()))
        expected[(file_id, day)] = (views + 1, ips | {ip})

    assert [m.version for m in migrate.migrate(conn)] == ['0003']

    got = {(f, d): (v, u) for f, d, v, u in empty_db.fetchall(
        'SELECT file_id, day, views, unique_views FROM file_view_days')}
    assert got == {key: (views, len(ips)) for key, (views, ips) in expected.items()}
    assert sum(v for v, _ in got.values()) == 5000
    assert empty_db.fetchone('SELECT count(*) FROM file_views')[0] == 5000  # kept until 0004

    mismatched = empty_db.fetchone(
        'SELECT count(*) FROM users WHERE extract(epoch FROM last_email_reset_at) <> last_email_reset '
        'OR extract(epoch FROM last_password_reset_at) <> last_password_reset '
        'OR last_email_reset_at IS NULL OR last_password_reset_at IS NULL')[0]
    assert mismatched == 0
    assert empty_db.fetchone('SELECT last_password_reset_at FROM users WHERE id = 1')[0] == \
        datetime.fromtimestamp(1600000001, timezone.utc)

    assert empty_db.fetchall('SELECT kind, queue FROM jobs ORDER BY id') == [
        ('ping', 'default'), ('ping', 'default'), ('scheduled:snowflake_nodes_cleanup', 'scheduler')]
    indexdef = empty_db.fetchone("SELECT indexdef FROM pg_indexes WHERE indexname = 'jobs_runnable'")[0]
    assert '(queue, run_at, id)' in indexdef and 'done_at IS NULL' in indexdef


def test_0003_keeps_old_and_new_user_timestamps_in_step(migrated_db):
    """Old servers write only the legacy columns during a rolling deploy."""
    from datetime import datetime, timezone
    at = lambda s: datetime.fromtimestamp(s, timezone.utc)  # noqa: E731
    migrated_db.execute(
        "INSERT INTO users (id, email, bot, username, discriminator, flags, verified, last_email_reset, "
        "last_password_reset) VALUES (1, 'a@x', false, 'a', 1, 0, true, 1500000000, 1500000001)")
    assert migrated_db.fetchone('SELECT last_email_reset_at, last_password_reset_at FROM users') == \
        (at(1500000000), at(1500000001))

    migrated_db.execute('UPDATE users SET last_password_reset = 1700000000')  # old code: reset
    assert migrated_db.fetchone('SELECT last_password_reset_at FROM users')[0] == at(1700000000)

    # new code writes both; the trigger leaves its value alone
    migrated_db.execute('UPDATE users SET last_password_reset = 1700000005, last_password_reset_at = %s',
                        (at(1700000005),))
    assert migrated_db.fetchone('SELECT last_password_reset_at FROM users')[0] == at(1700000005)
    migrated_db.execute('UPDATE users SET verified = false')  # unrelated update: untouched
    assert migrated_db.fetchone('SELECT last_password_reset_at FROM users')[0] == at(1700000005)


def test_pending_0004_drops_the_legacy_objects(migrated_db, tmp_path):
    import shutil
    shutil.copy(os.path.join(migrate.MIGRATIONS_DIR, 'pending', '0004_drop_legacy.sql'), tmp_path)
    # the runner records versions it knows; apply 0004 from its own directory
    assert [m.version for m in migrate.migrate(migrated_db.conn, directory=str(tmp_path))] == ['0004']
    assert 'file_views' not in table_names(migrated_db)
    columns = [r[0] for r in migrated_db.fetchall(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")]
    assert 'last_password_reset' not in columns and 'last_password_reset_at' in columns
    # the code still works against the post-0004 schema
    migrated_db.execute(
        "INSERT INTO users (id, email, bot, username, discriminator, flags, verified, last_email_reset_at, "
        "last_password_reset_at) VALUES (1, 'a@x', false, 'a', 1, 0, true, now(), now())")


def test_failed_migration_rolls_back(empty_db, tmp_path):
    (tmp_path / '0001_ok.sql').write_text('CREATE TABLE ok_table (id int);')
    (tmp_path / '0002_broken.sql').write_text('CREATE TABLE half_table (id int);\nTHIS IS NOT SQL;')

    with pytest.raises(Exception):
        migrate.migrate(empty_db.conn, directory=str(tmp_path))

    assert 'ok_table' in table_names(empty_db)
    assert 'half_table' not in table_names(empty_db)
    assert empty_db.fetchall('SELECT version FROM schema_migrations') == [('0001',)]

    # fixing the file lets the runner continue from where it stopped
    (tmp_path / '0002_broken.sql').write_text('CREATE TABLE half_table (id int);')
    assert [m.version for m in migrate.migrate(empty_db.conn, directory=str(tmp_path))] == ['0002']


def test_rejects_badly_named_files(tmp_path):
    (tmp_path / '1_bad.sql').write_text('SELECT 1;')
    with pytest.raises(ValueError):
        migrate.discover(str(tmp_path))


def test_concurrent_runners_apply_each_migration_once(empty_db):
    from tests.conftest import connect
    results = []
    barrier = threading.Barrier(4)

    def run():
        with connect(empty_db.name) as conn:
            barrier.wait()
            results.append(migrate.migrate(conn))

    threads = [threading.Thread(target=run) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    applied = [m.version for result in results for m in result]
    assert sorted(applied) == ALL_VERSIONS
