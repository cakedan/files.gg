-- Mimetypes for the local e2e stack. Production has these rows from the old database, but the
-- migrations create the tables empty, and POST /files refuses any type it can't find here.
-- Loaded by e2e/up.sh after `python -m migrate`; safe to run again.
INSERT INTO mimetype_types (id) VALUES ('application'), ('audio'), ('image'), ('text'), ('video')
ON CONFLICT DO NOTHING;

INSERT INTO mimetypes (id, flags, type_id) VALUES
    ('application/octet-stream', 0, 'application'),
    ('application/json', 0, 'application'),
    ('application/pdf', 0, 'application'),
    ('application/zip', 0, 'application'),
    ('audio/mpeg', 0, 'audio'),
    ('audio/ogg', 0, 'audio'),
    ('audio/wav', 0, 'audio'),
    ('image/gif', 0, 'image'),
    ('image/jpeg', 0, 'image'),
    ('image/png', 0, 'image'),
    ('image/svg+xml', 0, 'image'),
    ('image/webp', 0, 'image'),
    ('text/css', 0, 'text'),
    ('text/csv', 0, 'text'),
    ('text/html', 0, 'text'),
    ('text/markdown', 0, 'text'),
    ('text/plain', 0, 'text'),
    ('video/mp4', 0, 'video'),
    ('video/quicktime', 0, 'video'),
    ('video/webm', 0, 'video')
ON CONFLICT DO NOTHING;

INSERT INTO mimetype_extensions (mimetype_id, extension, priority) VALUES
    ('application/octet-stream', 'bin', 0),
    ('application/json', 'json', 1),
    ('application/pdf', 'pdf', 1),
    ('application/zip', 'zip', 1),
    ('audio/mpeg', 'mp3', 1),
    ('audio/ogg', 'ogg', 1),
    ('audio/wav', 'wav', 1),
    ('image/gif', 'gif', 1),
    ('image/jpeg', 'jpg', 1),
    ('image/jpeg', 'jpeg', 0),
    ('image/png', 'png', 1),
    ('image/svg+xml', 'svg', 1),
    ('image/webp', 'webp', 1),
    ('text/css', 'css', 1),
    ('text/csv', 'csv', 1),
    ('text/html', 'html', 1),
    ('text/html', 'htm', 0),
    ('text/markdown', 'md', 1),
    ('text/plain', 'txt', 1),
    ('video/mp4', 'mp4', 1),
    ('video/quicktime', 'mov', 1),
    ('video/webm', 'webm', 1)
ON CONFLICT DO NOTHING;
