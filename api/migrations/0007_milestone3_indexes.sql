-- migrate:no-transaction
-- Milestone 3 indexes, built CONCURRENTLY so writes continue while they build (see 0005).
-- The runner executes each statement on its own, outside a transaction, and drops an
-- INVALID leftover index of the same name before retrying it.

-- SHARE UPDATE EXCLUSIVE only: reads and writes continue during the scan
ALTER TABLE file_hashes VALIDATE CONSTRAINT file_hashes_processing_state_check;

ALTER TABLE unlock_attempts VALIDATE CONSTRAINT unlock_attempts_one_target;

-- "which albums is this file in" (internal lookup, owner list, delete)
CREATE INDEX CONCURRENTLY IF NOT EXISTS album_files_file_id ON album_files (file_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS album_files_album_position ON album_files (album_id, position);

CREATE INDEX CONCURRENTLY IF NOT EXISTS albums_owner_user ON albums (owner_user_id, id DESC)
    WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS albums_owner_fingerprint ON albums (owner_fingerprint, id DESC)
    WHERE owner_fingerprint IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS albums_expires_at ON albums (expires_at)
    WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS albums_cover_file ON albums (cover_file_id) WHERE cover_file_id IS NOT NULL;

-- the owner library's "temporary" filter and sorts by size and name
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_user_filename ON files (user_id, lower(filename));

CREATE INDEX CONCURRENTLY IF NOT EXISTS files_deleted_hash ON files (hash_id) WHERE deleted_at IS NULL;
