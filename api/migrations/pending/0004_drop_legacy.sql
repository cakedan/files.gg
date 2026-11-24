-- Applied one release after 0003 (see README.md here): only once no server
-- runs code that reads or writes file_views or the users' unix-seconds columns.
-- Dropping file_views deletes the stored raw IPs.

DROP TABLE IF EXISTS file_views;

DROP TRIGGER IF EXISTS users_sync_legacy_timestamps ON users;
DROP FUNCTION IF EXISTS users_sync_legacy_timestamps();

ALTER TABLE users
    DROP COLUMN IF EXISTS last_email_reset,
    DROP COLUMN IF EXISTS last_password_reset;
