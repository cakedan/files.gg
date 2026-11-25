-- Milestone 2 (docs/redesign/contracts/milestone-2.md, PLAN.md Phase 1): chunked uploads
-- to B2, expiry, limits and access control.
-- Safe on production data: every ALTER is metadata-only (nullable columns or
-- constant defaults; CHECKs are added NOT VALID and validated without blocking
-- writes, in 0005) and each backfill is one statement. The new files indexes are built
-- CONCURRENTLY by 0005, outside a transaction.

-- files ------------------------------------------------------------------------------

ALTER TABLE files
    ADD COLUMN size BIGINT,
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN deleted_at TIMESTAMPTZ,
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'link',
    ADD COLUMN password_hash TEXT,
    ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN unlock_ttl INTEGER NOT NULL DEFAULT 3600,
    ADD COLUMN password_expires_at TIMESTAMPTZ,
    ADD COLUMN show_name_when_locked BOOLEAN NOT NULL DEFAULT false,
    -- HMAC of the uploader's IP under that UTC day's key (utils/ip_hash.py), for the
    -- anonymous rolling 24 h cap per IP. Unlinkable once the day's key is gone, and
    -- cleared by the reaper after 2 days.
    ADD COLUMN uploader_ip_hash BYTEA;

-- NOT VALID: checked for new and updated rows now; 0005 validates existing rows
-- without holding this transaction's exclusive lock.
ALTER TABLE files ADD CONSTRAINT files_visibility_check
    CHECK (visibility IN ('link', 'password', 'private')) NOT VALID;
ALTER TABLE files ADD CONSTRAINT files_unlock_ttl_check CHECK (unlock_ttl > 0) NOT VALID;

-- the denormalised size (what the user sees, even for de-duplicated blobs)
UPDATE files f SET size = h.size FROM file_hashes h WHERE h.id = f.hash_id AND f.size IS NULL;

-- users ------------------------------------------------------------------------------

-- manual bumps to the storage limit (PLAN.md "Limits"); NULL = the default
ALTER TABLE users ADD COLUMN storage_limit_override BIGINT;

-- chunked uploads ----------------------------------------------------------------------

CREATE TABLE upload_sessions (
    id BIGINT PRIMARY KEY,
    owner_user_id BIGINT REFERENCES users (id) ON DELETE CASCADE,
    owner_fingerprint BIGINT,
    owner_ip_hash BYTEA,
    filename TEXT NOT NULL,
    name TEXT NOT NULL,
    extension TEXT,
    mimetype_id TEXT NOT NULL REFERENCES mimetypes (id),
    size BIGINT NOT NULL CHECK (size > 0),
    chunk_size INTEGER NOT NULL CHECK (chunk_size > 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
    -- the file's own expiry (seconds after it is created), NULL = never
    expires_in INTEGER,
    visibility TEXT NOT NULL DEFAULT 'link' CHECK (visibility IN ('link', 'password', 'private')),
    password_hash TEXT,
    unlock_ttl INTEGER NOT NULL DEFAULT 3600,
    password_expires_at TIMESTAMPTZ,
    storage_key TEXT NOT NULL,
    b2_upload_id TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'complete', 'failed')),
    error TEXT,
    file_id BIGINT REFERENCES files (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (num_nonnulls(owner_user_id, owner_fingerprint) = 1)
);
CREATE INDEX upload_sessions_owner_user ON upload_sessions (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX upload_sessions_owner_fingerprint ON upload_sessions (owner_fingerprint)
    WHERE owner_fingerprint IS NOT NULL;
CREATE INDEX upload_sessions_owner_ip ON upload_sessions (owner_ip_hash) WHERE owner_ip_hash IS NOT NULL;
CREATE INDEX upload_sessions_expires ON upload_sessions (expires_at);

CREATE TABLE upload_parts (
    session_id BIGINT NOT NULL REFERENCES upload_sessions (id) ON DELETE CASCADE,
    index INTEGER NOT NULL CHECK (index >= 0),
    etag TEXT NOT NULL,
    size BIGINT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, index)
);

-- unlock rate limiting -------------------------------------------------------------------
-- Schema fix 3: the target is a real FK column, never type + id. Albums get their
-- own nullable album_id column (and the one-target CHECK) when albums exist (M3).

CREATE TABLE unlock_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id BIGINT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    -- 'unlock' (password attempts) or 'access' (token refresh and /view)
    scope TEXT NOT NULL CHECK (scope IN ('unlock', 'access')),
    ip_hash BYTEA NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (file_id, scope, ip_hash, window_start)
);
CREATE INDEX unlock_attempts_window ON unlock_attempts (window_start);
