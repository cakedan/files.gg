-- Deterministic data for the golden-response compatibility tests
-- (tests/test_golden.py). Loaded into a freshly migrated database.
INSERT INTO mimetype_types (id) VALUES ('image'), ('text'), ('application');
INSERT INTO mimetypes (id, flags, type_id) VALUES
    ('image/png', 0, 'image'),
    ('text/plain', 0, 'text'),
    ('application/octet-stream', 0, 'application'),
    ('application/x-thing', 4, 'application');
INSERT INTO mimetype_extensions (mimetype_id, extension, priority) VALUES
    ('image/png', 'png', 1),
    ('text/plain', 'txt', 1),
    ('text/plain', 'text', 0),
    ('application/octet-stream', 'bin', 0);
INSERT INTO users (id, email, bot, username, discriminator, password, flags, verified, last_email_reset, last_password_reset) VALUES
    (100000000000000001, 'alice@example.com', false, 'alice', 1, 'pbkdf2:sha256:50000$abcdefgh$0000000000000000000000000000000000000000000000000000000000000000', 0, true, 1500000000, 1500000000),
    (100000000000000002, 'bob@example.com', false, 'bob', 42, NULL, 3, false, 1500000000, 1500000000),
    (100000000000000003, 'robot@example.com', true, 'robot', 7, NULL, 1, true, 1500000000, 1500000000);
INSERT INTO file_hashes (id, blake2b, sha1, md5, size, height, width, duration) VALUES
    (400000000000000001, 'b2-one', 'sha1-one', 'md5-one', 12345, 480, 640, NULL),
    (400000000000000002, 'b2-two', 'sha1-two', 'md5-two', 42, NULL, NULL, NULL),
    (400000000000000003, 'b2-three', 'sha1-three', 'md5-three', 9876543210, 1080, 1920, 61);
INSERT INTO files (id, vanity, mimetype_id, extension, filename, hash_id, user_id, fingerprint, view_count) VALUES
    (200000000000000001, 'abc', 'image/png', 'png', 'cat', 400000000000000001, 100000000000000001, NULL, 5),
    (200000000000000002, 'deep/path', 'text/plain', 'txt', 'notes', 400000000000000002, 100000000000000001, NULL, 0),
    (200000000000000003, 'noext', 'application/x-thing', NULL, 'thing', 400000000000000002, 100000000000000001, NULL, 0),
    (200000000000000004, 'anon1', 'application/octet-stream', 'bin', 'blob', 400000000000000003, NULL, 300000000000000001, 2),
    (200000000000000005, 'botfile', 'text/plain', 'txt', 'beep', 400000000000000002, 100000000000000003, NULL, 0),
    (200000000000000006, 'uni', 'image/png', 'png', 'ünïcødé "quoted" 😀', 400000000000000001, 100000000000000001, NULL, 0);
