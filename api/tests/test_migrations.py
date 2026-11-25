import threading

import psycopg
import pytest

import media
import migrate
from utils import filetypes

VERSIONS = [('0001', 'schema'), ('0002', 'mimetypes'), ('0003', 'trust_safety'), ('0004', 'scan_hardening'),
            ('0005', 'accounts'), ('0006', 'view_limits')]
TABLES = {
    'schema_migrations', 'mimetype_types', 'mimetypes', 'mimetype_extensions', 'users', 'file_hashes',
    'file_hash_assets', 'files', 'file_view_days', 'file_view_seen', 'albums', 'album_files', 'upload_sessions',
    'upload_parts', 'unlock_attempts', 'jobs', 'snowflake_nodes',
    # Milestone 4 (contract §1)
    'file_hash_pdq', 'staff', 'moderation_actions', 'blocked_hashes', 'blocked_hash_pdq', 'user_warnings',
    'user_restrictions', 'bans', 'moderation_cases', 'reports', 'report_messages', 'report_reads', 'content_flags',
    'safety_rate_limits', 'evidence_holds',
    # Milestone 6 (contract §1)
    'username_holds', 'user_identities', 'sessions', 'account_tokens', 'custom_domains', 'upload_keys',
    'user_entitlements', 'data_exports',
    # Milestone 6 §19.2
    'file_limit_viewers',
}
# PLAN.md "Accepted file types", the v1 blocklist: none of these may be accepted
# one list for the code and the tests: utils/filetypes.py
BLOCKED_EXTENSIONS = sorted(filetypes.BLOCKED_EXTENSIONS)
BLOCKED_MIMETYPES = sorted(filetypes.BLOCKED_MIMETYPES)


def table_names(temp):
    return {row[0] for row in temp.fetchall("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


def column_names(temp, table):
    return [r[0] for r in temp.fetchall(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s "
        "ORDER BY ordinal_position", (table,))]


# --- the runner ----------------------------------------------------------------------------------------------

def test_discovers_migrations_in_order():
    assert [(m.version, m.name) for m in migrate.discover()] == VERSIONS


def test_applies_to_an_empty_database_once(empty_db):
    applied = migrate.migrate(empty_db.conn)
    assert [(m.version, m.name) for m in applied] == VERSIONS
    assert table_names(empty_db) == TABLES

    # idempotent: nothing left to apply, and nothing changes
    counts = empty_db.fetchone('SELECT (SELECT count(*) FROM mimetypes), (SELECT count(*) FROM mimetype_extensions)')
    assert migrate.migrate(empty_db.conn) == []
    assert migrate.pending(empty_db.conn) == []
    assert empty_db.fetchone(
        'SELECT (SELECT count(*) FROM mimetypes), (SELECT count(*) FROM mimetype_extensions)') == counts

    # each version is recorded with its name and checksum
    rows = empty_db.fetchall('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
    assert [(v, n) for v, n, _, _ in rows] == VERSIONS
    assert [c for _, _, c, _ in rows] == [m.checksum for m in migrate.discover()]
    assert all(at is not None for _, _, _, at in rows)
    assert migrate.applied_versions(empty_db.conn) == {m.version: m.checksum for m in migrate.discover()}


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


def test_refuses_a_database_with_a_different_history(empty_db, tmp_path):
    """A database migrated before the squash records 0001 as `baseline`: running today's
    code on it would mean the wrong schema, so the runner stops instead of warning."""
    (tmp_path / '0001_baseline.sql').write_text('CREATE TABLE old_table (id int);')
    (tmp_path / '0002_jobs.sql').write_text('CREATE TABLE old_jobs (id int);')
    migrate.migrate(empty_db.conn, directory=str(tmp_path))

    with pytest.raises(migrate.HistoryMismatch, match="'baseline' in the database but 'schema' here"):
        migrate.migrate(empty_db.conn)
    assert 'mimetypes' not in table_names(empty_db)  # nothing new was applied

    (tmp_path / '0001_baseline.sql').unlink()
    (tmp_path / '0002_jobs.sql').unlink()
    (tmp_path / '0001_baseline.sql').write_text('CREATE TABLE old_table (id int);')
    with pytest.raises(migrate.HistoryMismatch, match='0002 \\(jobs\\) is applied but has no file here'):
        migrate.migrate(empty_db.conn, directory=str(tmp_path))


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

    assert sorted(m.version for result in results for m in result) == [v for v, _ in VERSIONS]


def test_no_transaction_migration_recovers_an_invalid_index(empty_db, tmp_path):
    empty_db.execute('CREATE TABLE t (id int)')
    empty_db.execute('INSERT INTO t VALUES (1), (1)')
    # an interrupted/failed concurrent build leaves an INVALID index behind
    with pytest.raises(Exception):
        empty_db.execute('CREATE UNIQUE INDEX CONCURRENTLY t_id ON t (id)')
    assert empty_db.fetchone("SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                             "WHERE c.relname = 't_id'")[0] is False
    empty_db.execute('DELETE FROM t')
    (tmp_path / '0001_index.sql').write_text(
        '-- migrate:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_id ON t (id);\n')
    assert [m.version for m in migrate.migrate(empty_db.conn, directory=str(tmp_path))] == ['0001']
    assert empty_db.fetchone("SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                             "WHERE c.relname = 't_id'")[0] is True


# --- the schema ------------------------------------------------------------------------------------------------

def test_row_types_match_schema(migrated_db):
    """The db layer's dataclasses name every column of their table, in table order."""
    from dataclasses import fields
    from db.models import ROW_TYPES
    for row_type in ROW_TYPES:
        names = [f.name for f in fields(row_type) if not f.metadata.get('virtual')]
        assert names == column_names(migrated_db, row_type.TABLE), row_type.__name__


def test_no_legacy_objects(migrated_db):
    assert 'file_views' not in table_names(migrated_db)
    users = column_names(migrated_db, 'users')
    # milestone-6 §1.1: no token versions (sessions are rows), no discriminator, no Werkzeug hash
    assert not {'last_email_reset', 'last_password_reset', 'last_email_reset_at', 'last_password_reset_at',
                'discriminator', 'bot', 'flags', 'password', 'verified'} & set(users)
    assert {'password_hash', 'email_verified', 'deletion_scheduled_for', 'deleted_at'} <= set(users)
    for table, column in (('file_hashes', 'storage_backend'), ('file_hashes', 'width'), ('file_hashes', 'height'),
                          ('file_hashes', 'duration')):
        assert column not in column_names(migrated_db, table)
    # no triggers, and no functions of our own (pg_trgm's belong to the extension)
    assert migrated_db.fetchall("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal") == []
    assert migrated_db.fetchall(
        "SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND NOT EXISTS "
        "(SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')"
    ) == []
    # every constraint is validated, and every index valid
    assert migrated_db.fetchall("SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace "
                                "AND NOT convalidated") == []
    assert migrated_db.fetchall("SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid") == []


def test_column_types_are_idiomatic(migrated_db):
    types = migrated_db.fetchall(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'")
    assert [t for t in types if t[2] in ('character varying', 'character', 'timestamp without time zone')] == []
    by_column = {(t, c): d for t, c, d in types}
    # Snowflake ids are bigint
    for table in ('users', 'file_hashes', 'files', 'albums', 'upload_sessions'):
        assert by_column[(table, 'id')] == 'bigint', table
    for table, column in (('files', 'hash_id'), ('files', 'user_id'), ('files', 'size'), ('file_hashes', 'size'),
                          ('album_files', 'file_id'), ('unlock_attempts', 'album_id')):
        assert by_column[(table, column)] == 'bigint', (table, column)


def foreign_keys(temp):
    """{(table, column): (referenced table, on delete)} for single-column foreign keys."""
    rows = temp.fetchall(
        """
        SELECT con.conrelid::regclass::text, a.attname, con.confrelid::regclass::text, con.confdeltype
        FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
        WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace AND cardinality(con.conkey) = 1
        """)
    actions = {'a': 'no action', 'r': 'restrict', 'c': 'cascade', 'n': 'set null', 'd': 'set default'}
    return {(t, c): (ref, actions[action]) for t, c, ref, action in rows}


def test_foreign_keys(migrated_db):
    assert foreign_keys(migrated_db) == {
        ('mimetypes', 'type_id'): ('mimetype_types', 'no action'),
        ('mimetype_extensions', 'mimetype_id'): ('mimetypes', 'cascade'),
        ('file_hash_assets', 'hash_id'): ('file_hashes', 'cascade'),
        # blob garbage collection deletes the files before their hash (jobs/gc.py)
        ('files', 'hash_id'): ('file_hashes', 'no action'),
        ('files', 'mimetype_id'): ('mimetypes', 'no action'),
        ('files', 'user_id'): ('users', 'no action'),
        ('file_view_days', 'file_id'): ('files', 'cascade'),
        ('file_view_seen', 'file_id'): ('files', 'cascade'),
        ('albums', 'owner_user_id'): ('users', 'cascade'),
        ('albums', 'cover_file_id'): ('files', 'set null'),
        ('album_files', 'album_id'): ('albums', 'cascade'),
        ('album_files', 'file_id'): ('files', 'cascade'),
        ('upload_sessions', 'owner_user_id'): ('users', 'cascade'),
        ('upload_sessions', 'mimetype_id'): ('mimetypes', 'no action'),
        ('upload_sessions', 'file_id'): ('files', 'set null'),
        ('upload_sessions', 'album_id'): ('albums', 'set null'),
        ('upload_parts', 'session_id'): ('upload_sessions', 'cascade'),
        ('unlock_attempts', 'file_id'): ('files', 'cascade'),
        ('unlock_attempts', 'album_id'): ('albums', 'cascade'),
        # Milestone 4: targets of the audit trail, cases, reports and flags are SET NULL so the trail
        # survives deletions (PLAN.md schema fix 3); a user's own notices and restrictions go with them
        ('bans', 'action_id'): ('moderation_actions', 'set null'),
        ('blocked_hash_pdq', 'blocked_hash_id'): ('blocked_hashes', 'cascade'),
        ('blocked_hashes', 'action_id'): ('moderation_actions', 'set null'),
        ('content_flags', 'album_id'): ('albums', 'set null'),
        ('content_flags', 'case_id'): ('moderation_cases', 'set null'),
        ('content_flags', 'file_id'): ('files', 'set null'),
        ('content_flags', 'hash_id'): ('file_hashes', 'set null'),
        ('evidence_holds', 'case_id'): ('moderation_cases', 'set null'),
        ('evidence_holds', 'hash_id'): ('file_hashes', 'set null'),
        ('file_hash_pdq', 'hash_id'): ('file_hashes', 'cascade'),
        ('moderation_actions', 'actor_user_id'): ('users', 'set null'),
        ('moderation_actions', 'album_id'): ('albums', 'set null'),
        ('moderation_actions', 'case_id'): ('moderation_cases', 'set null'),
        ('moderation_actions', 'file_id'): ('files', 'set null'),
        ('moderation_actions', 'hash_id'): ('file_hashes', 'set null'),
        ('moderation_actions', 'report_id'): ('reports', 'set null'),
        ('moderation_actions', 'reverses_action_id'): ('moderation_actions', 'set null'),
        ('moderation_actions', 'user_id'): ('users', 'set null'),
        ('moderation_actions', 'warning_id'): ('user_warnings', 'set null'),
        ('moderation_cases', 'album_id'): ('albums', 'set null'),
        ('moderation_cases', 'assignee_id'): ('users', 'set null'),
        ('moderation_cases', 'file_id'): ('files', 'set null'),
        ('moderation_cases', 'hash_id'): ('file_hashes', 'set null'),
        ('moderation_cases', 'user_id'): ('users', 'set null'),
        ('moderation_cases', 'warning_id'): ('user_warnings', 'set null'),
        ('report_messages', 'author_user_id'): ('users', 'set null'),
        ('report_messages', 'report_id'): ('reports', 'cascade'),
        ('report_reads', 'report_id'): ('reports', 'cascade'),
        ('report_reads', 'user_id'): ('users', 'cascade'),
        ('reports', 'album_id'): ('albums', 'set null'),
        ('reports', 'case_id'): ('moderation_cases', 'set null'),
        ('reports', 'file_id'): ('files', 'set null'),
        ('reports', 'reporter_user_id'): ('users', 'set null'),
        ('reports', 'user_id'): ('users', 'set null'),
        ('staff', 'granted_by'): ('users', 'set null'),
        ('staff', 'user_id'): ('users', 'cascade'),
        ('user_restrictions', 'action_id'): ('moderation_actions', 'set null'),
        ('user_restrictions', 'lifted_by_action_id'): ('moderation_actions', 'set null'),
        ('user_restrictions', 'user_id'): ('users', 'cascade'),
        ('user_restrictions', 'warning_id'): ('user_warnings', 'set null'),
        ('user_warnings', 'action_id'): ('moderation_actions', 'set null'),
        ('user_warnings', 'user_id'): ('users', 'cascade'),
        # Milestone 6 (contract §1): an account's own rows go with it (accounts are tombstoned, never deleted,
        # §8.8); audit and moderation references are SET NULL
        ('username_holds', 'user_id'): ('users', 'cascade'),
        ('user_identities', 'user_id'): ('users', 'cascade'),
        ('sessions', 'user_id'): ('users', 'cascade'),
        ('account_tokens', 'user_id'): ('users', 'cascade'),
        ('custom_domains', 'user_id'): ('users', 'cascade'),
        ('custom_domains', 'disabled_action_id'): ('moderation_actions', 'set null'),
        ('upload_keys', 'user_id'): ('users', 'cascade'),
        ('upload_keys', 'domain_id'): ('custom_domains', 'set null'),
        ('files', 'upload_key_id'): ('upload_keys', 'set null'),
        ('upload_sessions', 'upload_key_id'): ('upload_keys', 'set null'),
        ('user_entitlements', 'user_id'): ('users', 'cascade'),
        ('user_entitlements', 'granted_by'): ('users', 'set null'),
        ('user_entitlements', 'revoked_by'): ('users', 'set null'),
        ('user_entitlements', 'action_id'): ('moderation_actions', 'set null'),
        ('data_exports', 'user_id'): ('users', 'cascade'),
        ('moderation_actions', 'domain_id'): ('custom_domains', 'set null'),
        ('reports', 'domain_id'): ('custom_domains', 'set null'),
        ('moderation_cases', 'domain_id'): ('custom_domains', 'set null'),
        # milestone-6 §19.2: a file's viewers go with it
        ('file_limit_viewers', 'file_id'): ('files', 'cascade'),
    }


def insert_file(temp, file_id, **columns):
    values = {'id': file_id, 'vanity': 'v{}'.format(file_id), 'mimetype_id': 'text/plain', 'filename': 'f',
              'hash_id': 1, 'size': 1, **columns}
    temp.execute('INSERT INTO files ({}) VALUES ({})'.format(', '.join(values), ', '.join(['%s'] * len(values))),
                 list(values.values()))


@pytest.mark.parametrize('sql', [
    "UPDATE files SET visibility = 'public'",
    'UPDATE files SET unlock_ttl = 0',
    'UPDATE files SET size = NULL',
    'UPDATE files SET size = -1',
    "UPDATE files SET filename = repeat('a', 129)",
    "UPDATE files SET vanity = repeat('a', 129)",
    "UPDATE files SET extension = 'abcdefghijklm'",
    "UPDATE files SET mimetype_id = 'application/x-msdownload'",
    "UPDATE file_hashes SET processing_state = 'unknown'",
    "INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (2, 'b', 's', 'm', 1)",
    "INSERT INTO unlock_attempts (file_id, album_id, scope, ip_hash, window_start) VALUES (1, NULL, 'nope', '\\x00', now())",
    "INSERT INTO unlock_attempts (file_id, album_id, scope, ip_hash, window_start) VALUES (NULL, NULL, 'unlock', '\\x00', now())",
    "INSERT INTO mimetypes (id, type_id) VALUES ('Image/X-Thing', 'image')",
    "INSERT INTO mimetypes (id, type_id) VALUES ('image/x-thing', 'video')",
    "INSERT INTO mimetype_extensions (mimetype_id, extension) VALUES ('text/plain', 'TXT2')",
    "INSERT INTO mimetype_extensions (mimetype_id, extension) VALUES ('text/plain', '.txt2')",
    "INSERT INTO users (id, email, username) VALUES (2, 'a@x', repeat('u', 33))",
    # milestone-6 §1: usernames, password hashes, sessions, keys, domains and entitlements
    "INSERT INTO users (id, email, username) VALUES (2, 'a@x', 'Upper')",
    "INSERT INTO users (id, email, username) VALUES (2, 'a@x', 'da..n')",
    "INSERT INTO users (id, email, username) VALUES (2, 'a@x', '.dan')",
    "INSERT INTO users (id, email, username, password_hash) VALUES (2, 'a@x', 'dan', 'pbkdf2:sha256:1$x$y')",
    "INSERT INTO users (id, email, username, deletion_requested_at) VALUES (2, 'a@x', 'dan', now())",
    "INSERT INTO upload_keys (id, user_id, name, prefix, key_hash, scopes) VALUES (1, 9, 'k', 'fgg_01234567', "
    "sha256('x'::bytea), ARRAY['albums:append'])",
    "INSERT INTO custom_domains (id, user_id, hostname, verify_token, status) VALUES (1, 9, 'i.example.com', "
    "'aaaqeayeaudaocajbifqydiob4', 'gone')",
    "INSERT INTO user_entitlements (id, user_id, kind) VALUES (1, 9, 'gold')",
    "UPDATE albums SET moderation_state = 'gone'",
    # milestone-6 §19.2: view limits
    'UPDATE files SET view_limit = 0',
    'UPDATE files SET view_limit = 1001',
    "UPDATE files SET view_limit_action = 'delete'",
    'UPDATE files SET views_used = -1',
    'UPDATE files SET view_limit = 2, views_used = 3',
    "INSERT INTO file_limit_viewers (file_id, viewer) VALUES (1, '\\x01'), (1, '\\x01')",
    "INSERT INTO file_limit_viewers (file_id, viewer) VALUES (2, '\\x01')",
])
def test_constraints(migrated_db, sql):
    migrated_db.execute("INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (1, 'b', 's', 'm', 1)")
    insert_file(migrated_db, 1, extension='txt')
    migrated_db.execute("INSERT INTO albums (id, vanity, owner_fingerprint) VALUES (1, 'a1', 7)")
    migrated_db.execute("INSERT INTO users (id, email, username) VALUES (9, 'nine@x', 'nine')")
    with pytest.raises(psycopg.errors.IntegrityError):
        migrated_db.execute(sql)


def test_deleting_a_blobs_rows(migrated_db):
    """What jobs/gc.py relies on: a hash can't go while a file uses it, and a file's rows
    go with it."""
    migrated_db.execute("INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (1, 'b', 's', 'm', 1)")
    migrated_db.execute("INSERT INTO file_hash_assets (hash_id, kind, storage_key, content_type, size) "
                        "VALUES (1, 'thumb', 'derived/1/thumb.webp', 'image/webp', 1)")
    insert_file(migrated_db, 1)
    migrated_db.execute("INSERT INTO albums (id, vanity, owner_fingerprint, cover_file_id) VALUES (1, 'a1', 7, 1)")
    migrated_db.execute('INSERT INTO album_files (album_id, file_id, position) VALUES (1, 1, 0)')
    migrated_db.execute("INSERT INTO file_view_days (file_id, day, views) VALUES (1, '2026-11-25', 1)")
    migrated_db.execute("INSERT INTO unlock_attempts (file_id, scope, ip_hash, window_start) "
                        "VALUES (1, 'unlock', '\\x00', now())")
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        migrated_db.execute('DELETE FROM file_hashes WHERE id = 1')

    migrated_db.execute('DELETE FROM files WHERE hash_id = 1')
    migrated_db.execute('DELETE FROM file_hashes WHERE id = 1')
    assert migrated_db.fetchone(
        'SELECT (SELECT count(*) FROM album_files) + (SELECT count(*) FROM file_view_days) + '
        '(SELECT count(*) FROM unlock_attempts) + (SELECT count(*) FROM file_hash_assets)')[0] == 0
    assert migrated_db.fetchone('SELECT cover_file_id FROM albums WHERE id = 1')[0] is None


# --- the mimetype seed ---------------------------------------------------------------------------------------

def extensions_by_mimetype(temp):
    out = {}
    for mimetype, extension, priority in temp.fetchall(
            'SELECT mimetype_id, extension, priority FROM mimetype_extensions ORDER BY ctid'):
        out.setdefault(mimetype, []).append((extension, priority))
    return out


def first_mimetype(temp, extension):
    """What an extension on its own resolves to (db/queries.py get_extension)."""
    row = temp.fetchone('SELECT mimetype_id FROM mimetype_extensions WHERE extension = %s ORDER BY ctid LIMIT 1',
                        (extension,))
    return row and row[0]


def test_seed_accepts_a_wide_set_of_types(migrated_db):
    extensions = extensions_by_mimetype(migrated_db)
    for mimetype, extension in (
            ('image/heic', 'heic'), ('image/heif', 'heif'), ('image/avif', 'avif'), ('image/tiff', 'tif'),
            ('image/vnd.adobe.photoshop', 'psd'), ('image/svg+xml', 'svg'), ('video/mp4', 'mp4'),
            ('video/quicktime', 'mov'), ('video/x-matroska', 'mkv'), ('audio/flac', 'flac'), ('audio/mp4', 'm4a'),
            ('application/pdf', 'pdf'),
            ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'),
            ('application/zip', 'zip'), ('application/x-7z-compressed', '7z'), ('application/vnd.rar', 'rar'),
            ('text/plain', 'txt'), ('text/x-python', 'py'), ('text/javascript', 'js'), ('text/html', 'html'),
            ('application/xml', 'xml'), ('application/json', 'json'), ('font/woff2', 'woff2'),
            ('model/gltf-binary', 'glb'), ('model/stl', 'stl'), ('application/octet-stream', 'bin')):
        assert extension in [e for e, _ in extensions.get(mimetype, [])], mimetype


def test_seed_has_no_executables(migrated_db):
    mimetypes = {r[0] for r in migrated_db.fetchall('SELECT id FROM mimetypes')}
    assert mimetypes.isdisjoint(BLOCKED_MIMETYPES)
    assert not any('macroenabled' in m for m in mimetypes)
    blocked = migrated_db.fetchall('SELECT mimetype_id, extension FROM mimetype_extensions WHERE extension = ANY(%s)',
                                   (BLOCKED_EXTENSIONS,))
    assert blocked == []


def test_seed_covers_the_media_code_and_the_viewer(migrated_db):
    extensions = extensions_by_mimetype(migrated_db)
    # every name the media pipeline treats as an image
    for mimetype in media.BROWSER_IMAGES | {'application/x-photoshop', 'application/photoshop', 'application/psd'}:
        assert mimetype in extensions, mimetype
        assert media.probe_kind(mimetype) == 'image', mimetype
    # each viewer kind (web: image, pdf, video, audio, text) has types, and so do the other images
    kinds = {}
    for mimetype in extensions:
        kinds.setdefault(media.base_kind(mimetype), set()).add(mimetype)
        if media.is_other_image(mimetype):
            kinds.setdefault('other image', set()).add(mimetype)
    assert {'image', 'pdf', 'video', 'audio', 'text', 'file', 'other image'} <= set(kinds)
    assert {'image/heic', 'image/tiff', 'image/vnd.adobe.photoshop'} <= kinds['other image']
    # HTML and XML are uploadable, but not `kind: text` (the CDN serves them as text/plain)
    assert media.base_kind('text/html') == 'file' and 'text/html' in extensions
    # every highlighted language's extension is accepted, as text (minus the blocked Windows scripts)
    for extension in set(media.LANGUAGES) - set(BLOCKED_EXTENSIONS):
        mimetype = first_mimetype(migrated_db, extension)
        assert mimetype is not None, extension
        assert media.base_kind(mimetype) == 'text' or mimetype in ('application/xml', 'text/html'), (extension, mimetype)
    # JSON and subtitles are text even though their types aren't text/* (the viewer highlights them)
    for mimetype in ('application/json', 'application/ld+json', 'application/x-ipynb+json', 'application/x-subrip'):
        assert mimetype in extensions and media.base_kind(mimetype) == 'text', mimetype
        assert media.probe_kind(mimetype) == 'text', mimetype


def test_seed_extensions(migrated_db):
    extensions = extensions_by_mimetype(migrated_db)
    for mimetype, rows in extensions.items():
        # one preferred extension per type, listed first (GET /mimetypes/<type> shows that order)
        assert [p for _, p in rows].count(1) == 1 and rows[0][1] == 1, mimetype
    assert extensions['text/plain'][0] == ('txt', 1)
    assert migrated_db.fetchall('SELECT id FROM mimetypes WHERE NOT EXISTS '
                                '(SELECT 1 FROM mimetype_extensions WHERE mimetype_id = id)') == []
    # an extension on its own resolves to the canonical type, never an alias
    for extension, mimetype in (('jpg', 'image/jpeg'), ('png', 'image/png'), ('ico', 'image/vnd.microsoft.icon'),
                                ('psd', 'image/vnd.adobe.photoshop'), ('csv', 'text/csv'), ('py', 'text/x-python'),
                                ('ts', 'text/typescript'), ('m4a', 'audio/mp4'), ('xml', 'application/xml')):
        assert first_mimetype(migrated_db, extension) == mimetype, extension


@pytest.mark.parametrize('filename, declared, expected', [
    ('photo.heic', 'image/heic', ('photo', 'heic', 'image/heic')),
    ('photo.HEIC', 'application/octet-stream', ('photo', 'heic', 'image/heic')),
    ('clip.mov', 'video/quicktime', ('clip', 'mov', 'video/quicktime')),
    # names browsers send that aren't listed fall back to the extension
    ('song.m4a', 'audio/x-m4a', ('song', 'm4a', 'audio/mp4')),
    ('archive.zip', 'application/x-zip-compressed', ('archive', 'zip', 'application/zip')),
    ('app.ts', 'video/mp2t', ('app', 'ts', 'text/typescript')),
    ('main.rs', 'application/octet-stream', ('main', 'rs', 'text/x-rust')),
    # a text file sent as text/plain keeps its extension
    ('notes.py', 'text/plain', ('notes', 'py', 'text/plain')),
    ('data.csv', 'application/vnd.ms-excel', ('data', 'csv', 'application/vnd.ms-excel')),
    # no extension: the type's preferred one
    ('screenshot', 'image/jpg', ('screenshot', 'jpg', 'image/jpg')),
    ('page', 'text/html', ('page', 'html', 'text/html')),
])
async def test_seed_resolves_upload_names(migrated_db, filename, declared, expected):
    from utils.uploading import resolve_name
    async with await psycopg.AsyncConnection.connect(migrated_db.url, autocommit=True) as conn:
        assert await resolve_name(conn, filename, None, declared) == expected


@pytest.mark.parametrize('filename, declared', [
    ('setup.exe', 'application/x-msdownload'),
    ('setup.exe', 'application/vnd.microsoft.portable-executable'),
    ('installer.msi', 'application/x-ms-installer'),
    ('run.bat', 'application/x-bat'),
    ('script.ps1', 'application/x-powershell'),
    ('app.apk', 'application/vnd.android.package-archive'),
    ('tool.jar', 'application/java-archive'),
    ('disk.iso', 'application/x-iso9660-image'),
    ('report.docm', 'application/vnd.ms-word.document.macroenabled.12'),
    ('blob', 'application/x-msdownload'),
    # sent as a generic binary: used to be stored as setup.exe.bin
    ('setup.exe', 'application/octet-stream'),
    ('Setup.EXE', 'application/octet-stream'),
])
async def test_seed_refuses_executables(migrated_db, filename, declared):
    from utils.responses import ApiError
    from utils.uploading import resolve_name
    async with await psycopg.AsyncConnection.connect(migrated_db.url, autocommit=True) as conn:
        with pytest.raises(ApiError) as error:
            await resolve_name(conn, filename, None, declared)
    assert error.value.code == 'FILE_TYPE_NOT_ALLOWED'
