-- Milestone 3 (docs/redesign/contracts/milestone-3.md §1): media processing state and
-- derived assets per FileHash, and albums.
-- Safe on production data: every ALTER is metadata-only (nullable columns or constant
-- defaults; the CHECK is added NOT VALID and validated without blocking writes in 0007).
-- The new tables start empty. Their indexes (and the files ones) are built CONCURRENTLY
-- by 0007, outside a transaction.

-- media processing (probe / derive) ------------------------------------------------------

ALTER TABLE file_hashes
    -- the probe output (contract §2); NULL until probed
    ADD COLUMN media JSONB,
    -- pending -> probed -> done, or failed / skipped. Existing rows stay pending until the
    -- Milestone 7 backfill queues them.
    ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN probed_at TIMESTAMPTZ,
    -- also the previews' version (?v= on preview URLs)
    ADD COLUMN derived_at TIMESTAMPTZ;

ALTER TABLE file_hashes ADD CONSTRAINT file_hashes_processing_state_check
    CHECK (processing_state IN ('pending', 'probed', 'done', 'failed', 'skipped')) NOT VALID;

-- one row per preview in B2, at derived/<hash_id>/<kind>.<ext> (contract §1 and §3). Blob
-- garbage collection deletes the objects, then the hash row (these rows cascade).
CREATE TABLE file_hash_assets (
    hash_id BIGINT NOT NULL REFERENCES file_hashes (id) ON DELETE CASCADE,
    -- a preview kind; each has one extension (thumb, thumb-2x, display, poster, cover and
    -- waveform are webp, peaks is json, hover is mp4)
    kind TEXT NOT NULL CHECK (kind IN ('thumb', 'thumb-2x', 'display', 'poster', 'cover', 'waveform', 'peaks',
                                       'hover')),
    storage_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size BIGINT NOT NULL,
    -- NULL for non-images
    width INTEGER,
    height INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hash_id, kind)
);

-- albums (PLAN.md "Albums", plus the Milestone 2 access columns from files) ---------------

CREATE TABLE albums (
    id BIGINT PRIMARY KEY,
    vanity TEXT NOT NULL UNIQUE,
    owner_user_id BIGINT REFERENCES users (id) ON DELETE CASCADE,
    owner_fingerprint BIGINT,
    title TEXT CHECK (char_length(title) <= 100),
    description TEXT CHECK (char_length(description) <= 2000),
    -- NULL = automatic
    cover_file_id BIGINT REFERENCES files (id) ON DELETE SET NULL,
    layout TEXT NOT NULL DEFAULT 'auto' CHECK (layout IN ('auto', 'grid', 'list', 'tracklist')),
    -- derived from the items (Milestone 4); always false in Milestone 3
    nsfw BOOLEAN NOT NULL DEFAULT false,
    -- anonymous albums: the latest expiry of their files
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    moderation_state TEXT NOT NULL DEFAULT 'visible',
    visibility TEXT NOT NULL DEFAULT 'link' CHECK (visibility IN ('link', 'password', 'private')),
    password_hash TEXT,
    access_version INTEGER NOT NULL DEFAULT 0,
    unlock_ttl INTEGER NOT NULL DEFAULT 3600 CHECK (unlock_ttl > 0),
    password_expires_at TIMESTAMPTZ,
    show_name_when_locked BOOLEAN NOT NULL DEFAULT false,
    -- derived/albums/<id>/collage-<version>.webp, made by the album_collage job
    collage_key TEXT,
    collage_version BIGINT,
    -- set by the album reaper while the album has no live items; soft-deleted after 7 days
    empty_since TIMESTAMPTZ,
    CHECK (num_nonnulls(owner_user_id, owner_fingerprint) = 1)
);

-- deleting a file (soft delete) removes its rows here in the same statement batch; the
-- cascade covers the rows that blob garbage collection finally deletes
CREATE TABLE album_files (
    album_id BIGINT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    file_id BIGINT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    caption TEXT CHECK (char_length(caption) <= 500),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, file_id)
);

-- `album=<vanity>` on POST /uploads: finalize_upload appends the file to it
ALTER TABLE upload_sessions ADD COLUMN album_id BIGINT REFERENCES albums (id) ON DELETE SET NULL;

-- unlock rate limiting for albums: the album_id column and the one-target CHECK that
-- 0004 promised (schema fix 3: a real FK per target, never type + id)
ALTER TABLE unlock_attempts ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE unlock_attempts ADD COLUMN album_id BIGINT REFERENCES albums (id) ON DELETE CASCADE;
ALTER TABLE unlock_attempts ADD CONSTRAINT unlock_attempts_one_target
    CHECK (num_nonnulls(file_id, album_id) = 1) NOT VALID;
ALTER TABLE unlock_attempts ADD CONSTRAINT unlock_attempts_album_window
    UNIQUE (album_id, scope, ip_hash, window_start);
