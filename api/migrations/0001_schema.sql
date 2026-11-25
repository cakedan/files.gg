-- The files.gg schema, written for a fresh database.
--
-- Nothing from the old site is migrated and nothing is kept for old code
-- (docs/redesign/contracts/milestone-3.md §0), so this is the whole schema in one
-- transaction: no legacy columns, no rollout triggers, and plain (valid) constraints and
-- indexes. The accepted mimetypes are seeded by 0002_mimetypes.sql.
--
-- Conventions: ids minted by utils/generators.py (Snowflake) are bigint, and so are sizes;
-- times are timestamptz; strings are text, with a CHECK where the code enforces a limit.
-- The db/models.py row types list each table's columns in this order.

-- the owner library's name search (files_filename_trgm)
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- mimetypes ---------------------------------------------------------------------------------
-- What uploads may be. utils/uploading.py resolve_name keeps the declared type if it's
-- listed here, else looks the file's extension up; neither found = INVALID_MIMETYPE.

-- the top-level types: application, audio, font, image, ...
CREATE TABLE mimetype_types (
    id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.+-]*$')
);

CREATE TABLE mimetypes (
    -- lowercase, without parameters (utils/uploading.py mimetype_of)
    id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+_-]*$'),
    -- not read by the code yet (GET /mimetypes returns it); PLAN.md "Accepted file types"
    -- adds a BLOCKED bit when uploads are sniffed
    flags integer NOT NULL DEFAULT 0,
    type_id text NOT NULL REFERENCES mimetype_types (id),
    CHECK (type_id = split_part(id, '/', 1))
);
CREATE INDEX mimetypes_type_id ON mimetypes (type_id);

CREATE TABLE mimetype_extensions (
    mimetype_id text NOT NULL REFERENCES mimetypes (id) ON DELETE CASCADE,
    -- lowercase, without the dot
    extension text NOT NULL CHECK (extension ~ '^[a-z0-9_+-]{1,12}$'),
    -- the highest is the type's preferred extension, given to files that have none
    priority integer NOT NULL DEFAULT 0,
    PRIMARY KEY (mimetype_id, extension)
);


-- users ---------------------------------------------------------------------------------------
-- Unchanged in design until accounts are redesigned (Milestone 6).

CREATE TABLE users (
    id bigint PRIMARY KEY,
    email text NOT NULL CHECK (char_length(email) <= 128),
    bot boolean NOT NULL,
    username text NOT NULL CHECK (char_length(username) <= 32),
    discriminator integer NOT NULL,
    -- a pbkdf2:sha256 hash (utils/helpers.py hash_password); NULL = no password
    password text CHECK (char_length(password) <= 128),
    flags integer NOT NULL,
    verified boolean NOT NULL,
    -- tokens issued before these (in whole seconds) are rejected; NULL = never reset
    last_email_reset_at timestamptz,
    last_password_reset_at timestamptz,
    -- a manual bump to the storage limit (PLAN.md "Limits"); NULL = the default
    storage_limit_override bigint
);
CREATE UNIQUE INDEX users_email ON users (email);
CREATE INDEX users_username ON users (username);
CREATE UNIQUE INDEX users_username_discriminator ON users (username, discriminator);


-- blobs -------------------------------------------------------------------------------------
-- One row per distinct content, stored in B2 at files/<id>. Files with the same bytes share
-- it. Blob garbage collection (jobs/gc.py) deletes the objects, then the files, then this row.

CREATE TABLE file_hashes (
    id bigint PRIMARY KEY,
    -- hex digests; the three together identify the content
    blake2b text NOT NULL,
    sha1 text NOT NULL,
    md5 text NOT NULL,
    size bigint NOT NULL CHECK (size >= 0),
    -- the probe output (contract milestone-3 §2); NULL until probed
    media jsonb,
    -- pending -> probed -> done, or failed / skipped
    processing_state text NOT NULL DEFAULT 'pending'
        CHECK (processing_state IN ('pending', 'probed', 'done', 'failed', 'skipped')),
    probed_at timestamptz,
    -- also the previews' version (?v= on preview URLs)
    derived_at timestamptz,
    UNIQUE (blake2b, sha1, md5)
);

-- one row per preview in B2, at derived/<hash_id>/<kind>.<ext> (contract milestone-3 §1, §3)
CREATE TABLE file_hash_assets (
    hash_id bigint NOT NULL REFERENCES file_hashes (id) ON DELETE CASCADE,
    -- a preview kind (media.PREVIEW_KINDS); each has one extension: thumb, thumb-2x, display,
    -- poster, cover and waveform are webp, peaks is json, hover is mp4
    kind text NOT NULL CHECK (kind IN ('thumb', 'thumb-2x', 'display', 'poster', 'cover', 'waveform', 'peaks',
                                       'hover')),
    storage_key text NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL,
    -- NULL for non-images
    width integer,
    height integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (hash_id, kind)
);


-- files -------------------------------------------------------------------------------------
-- An upload: a name, an owner and access settings over a blob. Deleting one sets deleted_at
-- (a soft delete); the row itself goes with its blob (jobs/gc.py).

CREATE TABLE files (
    id bigint PRIMARY KEY,
    -- files.gg/<vanity> (utils/vanity.py)
    vanity text NOT NULL UNIQUE CHECK (char_length(vanity) <= 128),
    mimetype_id text NOT NULL REFERENCES mimetypes (id),
    -- one of the mimetype's extensions, NULL for none
    extension text CHECK (char_length(extension) <= 12),
    -- the name without the extension
    filename text NOT NULL CHECK (char_length(filename) <= 128),
    hash_id bigint NOT NULL REFERENCES file_hashes (id),
    -- the owner: a user, or an anonymous uploader's fingerprint (claimed on sign-in)
    user_id bigint REFERENCES users (id),
    fingerprint bigint,
    -- unique views per visitor per UTC day, summed (file_view_days)
    view_count bigint NOT NULL DEFAULT 0,
    -- the file's size, also for de-duplicated blobs (quotas and sorting)
    size bigint NOT NULL CHECK (size >= 0),
    expires_at timestamptz,
    deleted_at timestamptz,
    -- access (PLAN.md "Private and password-protected files")
    visibility text NOT NULL DEFAULT 'link' CHECK (visibility IN ('link', 'password', 'private')),
    -- argon2id
    password_hash text,
    -- bumped on every access change; signed URLs and unlock tokens carry it
    access_version integer NOT NULL DEFAULT 0,
    -- how long an unlock lasts, in seconds
    unlock_ttl integer NOT NULL DEFAULT 3600 CHECK (unlock_ttl > 0),
    password_expires_at timestamptz,
    show_name_when_locked boolean NOT NULL DEFAULT false,
    -- HMAC of the uploader's IP under that UTC day's key (utils/view_hash.py), for the anonymous
    -- rolling 24 h cap per IP. Unlinkable once the day's key is gone; cleared after 2 days.
    uploader_ip_hash bytea
);
-- blob garbage collection, and "does a live file still use this blob"
CREATE INDEX files_hash_id ON files (hash_id);
CREATE INDEX files_deleted_hash ON files (hash_id) WHERE deleted_at IS NULL;
-- the owner's library: newest first, type and size filters, name sorts and search
CREATE INDEX files_user_id_desc ON files (user_id, id DESC);
CREATE INDEX files_fingerprint_id_desc ON files (fingerprint, id DESC);
CREATE INDEX files_user_mimetype ON files (user_id, mimetype_id);
CREATE INDEX files_user_size ON files (user_id, size);
CREATE INDEX files_user_filename ON files (user_id, lower(filename));
CREATE INDEX files_filename_trgm ON files USING gin (lower(filename) gin_trgm_ops);
-- the expiry reaper
CREATE INDEX files_expires_at ON files (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
-- the anonymous rolling cap per IP
CREATE INDEX files_uploader_ip ON files (uploader_ip_hash, id) WHERE uploader_ip_hash IS NOT NULL;

-- views: one row per file per UTC day
CREATE TABLE file_view_days (
    file_id bigint NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    day date NOT NULL,
    views bigint NOT NULL DEFAULT 0,
    unique_views bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (file_id, day)
);

-- whether a view is that day's first from its visitor. ip_hash = HMAC-SHA256(daily key, ip);
-- the key rotates every UTC day and is never stored. The scheduler deletes rows after 2 days.
CREATE TABLE file_view_seen (
    file_id bigint NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    day date NOT NULL,
    ip_hash bytea NOT NULL,
    PRIMARY KEY (file_id, day, ip_hash)
);
CREATE INDEX file_view_seen_day ON file_view_seen (day);


-- albums ------------------------------------------------------------------------------------
-- PLAN.md "Albums", with the same access columns as files.

CREATE TABLE albums (
    id bigint PRIMARY KEY,
    vanity text NOT NULL UNIQUE,
    -- a user, or an anonymous fingerprint
    owner_user_id bigint REFERENCES users (id) ON DELETE CASCADE,
    owner_fingerprint bigint,
    title text CHECK (char_length(title) <= 100),
    description text CHECK (char_length(description) <= 2000),
    -- NULL = automatic; a deleted file stops being a cover (jobs/gc.py)
    cover_file_id bigint REFERENCES files (id) ON DELETE SET NULL,
    layout text NOT NULL DEFAULT 'auto' CHECK (layout IN ('auto', 'grid', 'list', 'tracklist')),
    -- derived from the items in Milestone 4; always false until then
    nsfw boolean NOT NULL DEFAULT false,
    -- anonymous albums: the latest expiry of their files
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    moderation_state text NOT NULL DEFAULT 'visible' CHECK (moderation_state IN ('visible', 'hidden', 'removed')),
    visibility text NOT NULL DEFAULT 'link' CHECK (visibility IN ('link', 'password', 'private')),
    password_hash text,
    access_version integer NOT NULL DEFAULT 0,
    unlock_ttl integer NOT NULL DEFAULT 3600 CHECK (unlock_ttl > 0),
    password_expires_at timestamptz,
    show_name_when_locked boolean NOT NULL DEFAULT false,
    -- derived/albums/<id>/collage-<version>.webp, made by the album_collage job
    collage_key text,
    -- epoch seconds
    collage_version bigint,
    -- set by the album reaper while the album has no live items; soft-deleted after 7 days
    empty_since timestamptz,
    CHECK (num_nonnulls(owner_user_id, owner_fingerprint) = 1)
);
CREATE INDEX albums_owner_user ON albums (owner_user_id, id DESC)
    WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX albums_owner_fingerprint ON albums (owner_fingerprint, id DESC)
    WHERE owner_fingerprint IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX albums_expires_at ON albums (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX albums_cover_file ON albums (cover_file_id) WHERE cover_file_id IS NOT NULL;

-- deleting a file (a soft delete) removes its rows here in the same transaction (jobs/gc.py);
-- the cascade covers the rows of files that blob garbage collection finally deletes
CREATE TABLE album_files (
    album_id bigint NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    file_id bigint NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    position integer NOT NULL,
    caption text CHECK (char_length(caption) <= 500),
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, file_id)
);
-- "which albums is this file in" (internal lookup, owner list, delete)
CREATE INDEX album_files_file_id ON album_files (file_id);
CREATE INDEX album_files_album_position ON album_files (album_id, position);


-- chunked uploads -------------------------------------------------------------------------------
-- POST /uploads (contract milestone-2). A session reserves its size against the owner's
-- quota while open or processing; the reaper deletes finished and abandoned ones.

CREATE TABLE upload_sessions (
    id bigint PRIMARY KEY,
    owner_user_id bigint REFERENCES users (id) ON DELETE CASCADE,
    owner_fingerprint bigint,
    owner_ip_hash bytea,
    -- the name as sent, then as resolved (utils/uploading.py resolve_name)
    filename text NOT NULL,
    name text NOT NULL,
    extension text,
    mimetype_id text NOT NULL REFERENCES mimetypes (id),
    size bigint NOT NULL CHECK (size > 0),
    chunk_size integer NOT NULL CHECK (chunk_size > 0),
    chunk_count integer NOT NULL CHECK (chunk_count > 0),
    -- the file's own expiry (seconds after it is created), NULL = never
    expires_in integer,
    visibility text NOT NULL DEFAULT 'link' CHECK (visibility IN ('link', 'password', 'private')),
    password_hash text,
    unlock_ttl integer NOT NULL DEFAULT 3600,
    password_expires_at timestamptz,
    -- the staging object and its B2 multipart upload
    storage_key text NOT NULL,
    b2_upload_id text,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'complete', 'failed')),
    error text,
    file_id bigint REFERENCES files (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    -- `album=<vanity>` on POST /uploads: the file joins it when finalized
    album_id bigint REFERENCES albums (id) ON DELETE SET NULL,
    CHECK (num_nonnulls(owner_user_id, owner_fingerprint) = 1)
);
CREATE INDEX upload_sessions_owner_user ON upload_sessions (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX upload_sessions_owner_fingerprint ON upload_sessions (owner_fingerprint)
    WHERE owner_fingerprint IS NOT NULL;
CREATE INDEX upload_sessions_owner_ip ON upload_sessions (owner_ip_hash) WHERE owner_ip_hash IS NOT NULL;
CREATE INDEX upload_sessions_expires ON upload_sessions (expires_at);

CREATE TABLE upload_parts (
    session_id bigint NOT NULL REFERENCES upload_sessions (id) ON DELETE CASCADE,
    index integer NOT NULL CHECK (index >= 0),
    etag text NOT NULL,
    size bigint NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, index)
);


-- unlock rate limiting ------------------------------------------------------------------------
-- Counts per target, scope, IP hash and window. The target is a real foreign key, never
-- type + id (PLAN.md schema fix 3). The scheduler deletes windows older than an hour.

CREATE TABLE unlock_attempts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id bigint REFERENCES files (id) ON DELETE CASCADE,
    album_id bigint REFERENCES albums (id) ON DELETE CASCADE,
    -- 'unlock' (password attempts) or 'access' (token refresh and /view)
    scope text NOT NULL CHECK (scope IN ('unlock', 'access')),
    ip_hash bytea NOT NULL,
    window_start timestamptz NOT NULL,
    count integer NOT NULL DEFAULT 0,
    CHECK (num_nonnulls(file_id, album_id) = 1),
    UNIQUE (file_id, scope, ip_hash, window_start),
    UNIQUE (album_id, scope, ip_hash, window_start)
);
CREATE INDEX unlock_attempts_window ON unlock_attempts (window_start);


-- background jobs ---------------------------------------------------------------------------
-- The Postgres job queue (jobs/queue.py) and the Snowflake node-id leases
-- (utils/snowflake_nodes.py), PLAN.md §2.1.

CREATE TABLE jobs (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    -- workers claim from a list of queues; scheduler markers live on 'scheduler', which no
    -- worker claims from
    queue text NOT NULL DEFAULT 'default',
    kind text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    run_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,
    locked_by text,
    locked_at timestamptz,
    last_error text,
    done_at timestamptz,
    failed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- the claim query scans only runnable jobs
CREATE INDEX jobs_runnable ON jobs (queue, run_at, id) WHERE done_at IS NULL AND failed_at IS NULL;
CREATE INDEX jobs_kind ON jobs (kind);

CREATE TABLE snowflake_nodes (
    node_id smallint PRIMARY KEY CHECK (node_id BETWEEN 0 AND 1023),
    holder text NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT now()
);
