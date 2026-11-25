-- migrate:no-transaction
-- The files indexes from PLAN.md Phase 1, built CONCURRENTLY so writes to files
-- continue while they build. The runner executes each statement on its own,
-- outside a transaction, and drops an INVALID leftover index of the same name
-- (from an interrupted build) before retrying it.
-- (hash_id) already exists as file_hash_id from the baseline.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- SHARE UPDATE EXCLUSIVE only: reads and writes continue during the scan
ALTER TABLE files VALIDATE CONSTRAINT files_visibility_check;

ALTER TABLE files VALIDATE CONSTRAINT files_unlock_ttl_check;

CREATE INDEX CONCURRENTLY IF NOT EXISTS files_user_id_desc ON files (user_id, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS files_fingerprint_id_desc ON files (fingerprint, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS files_user_mimetype ON files (user_id, mimetype_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS files_user_size ON files (user_id, size);

CREATE INDEX CONCURRENTLY IF NOT EXISTS files_expires_at ON files (expires_at)
    WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS files_filename_trgm ON files USING gin (lower(filename) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS files_uploader_ip ON files (uploader_ip_hash, id)
    WHERE uploader_ip_hash IS NOT NULL;
