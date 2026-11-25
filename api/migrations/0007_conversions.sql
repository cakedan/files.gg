-- Milestone 5 (docs/redesign/contracts/milestone-5.md §2): conversions, the conversion cache, provenance on files,
-- document previews, conversion usage, the account's upload defaults (§21), and the Postgres rate-limit tables gone
-- (§18.5). One transaction.
--
-- Conversions run on RQ + Redis (§3), so `jobs` doesn't change (§2.4): the `conversions` row is the record of
-- every conversion, and Redis only holds the queue.

-- conversions (§2.1) ----------------------------------------------------------------------------------------

CREATE TABLE conversions (
    id bigint PRIMARY KEY,
    -- the caller: their user, or their guest (§5.2, §20)
    owner_user_id bigint REFERENCES users (id) ON DELETE CASCADE,
    owner_guest_id bigint,
    -- the milestone-4 abuse IP hash, anonymous only, for the per-IP limits (§7.1); cleared with the other IP hashes
    owner_ip_hash bytea,
    -- groups a batch (§10.6)
    batch_id bigint,
    source_file_id bigint REFERENCES files (id) ON DELETE SET NULL,
    source_album_id bigint REFERENCES albums (id) ON DELETE SET NULL,
    -- the bytes converted (the cache and the cascade); for images -> PDF, the first image's
    source_hash_id bigint REFERENCES file_hashes (id) ON DELETE SET NULL,
    -- §1.1, and `images` for several images -> PDF
    source_kind text NOT NULL CHECK (source_kind IN ('image', 'animated', 'video', 'audio', 'document', 'pdf',
                                                     'images')),
    target text NOT NULL CHECK (target ~ '^[a-z0-9]{2,8}$'),
    -- normalised: defaults filled in, "none" values dropped (§6)
    options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'),
    recipe_hash bytea NOT NULL CHECK (octet_length(recipe_hash) = 32),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    progress real NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
    output_file_id bigint REFERENCES files (id) ON DELETE SET NULL,
    -- PDF -> images, signed in (§4.6)
    output_album_id bigint REFERENCES albums (id) ON DELETE SET NULL,
    -- served from the cache (§4.5)
    cached boolean NOT NULL DEFAULT false,
    -- the RQ queue it went on (§3.1)
    queue text NOT NULL CHECK (queue IN ('convert_premium', 'convert_member', 'convert_anonymous')),
    -- its RQ job id, `conversion-<id>` (rq allows no `:`; none for cache hits)
    job_id text,
    -- when it went on its RQ queue; NULL while a batch item waits for a free concurrent slot (§10.6)
    queued_at timestamptz,
    stage text CHECK (stage IN ('downloading', 'converting', 'storing')),
    -- seconds the work horse gets (§7.1)
    time_limit integer NOT NULL CHECK (time_limit > 0),
    -- { code, message, metadata }: what the API returns (§12), never tool output
    error jsonb,
    -- staff and metrics only (§3.3)
    failure_reason text,
    cpu_ms bigint NOT NULL DEFAULT 0 CHECK (cpu_ms >= 0),
    input_size bigint CHECK (input_size >= 0),
    output_size bigint CHECK (output_size >= 0),
    -- how the output file is made, fixed when the conversion is created (§1.3, §5.3, §5.5): its name, extension and
    -- mimetype, visibility, password hash, unlock_ttl, expiry, view limit, and the anonymous caller's daily IP hashes
    -- and sealed IP for the upload caps and evidence (as on uploads). The IP fields are dropped with the other IP
    -- hashes (jobs/tasks.py, safety/tasks.py).
    output_settings jsonb NOT NULL CHECK (jsonb_typeof(output_settings) = 'object'),
    -- DELETE /conversions/<id> on a finished conversion (§10.4): gone from history, kept for provenance and the
    -- moderation cascade (§5.4)
    hidden_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    CHECK (num_nonnulls(owner_user_id, owner_guest_id) = 1),
    CHECK (owner_user_id IS NULL OR owner_ip_hash IS NULL),
    CHECK (num_nonnulls(output_file_id, output_album_id) <= 1)
);
-- history (§10.5), newest first
CREATE INDEX conversions_owner_user ON conversions (owner_user_id, id DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX conversions_owner_guest_id ON conversions (owner_guest_id, id DESC)
    WHERE owner_guest_id IS NOT NULL;
-- concurrency (§7.2) and the sweeper (§3.3)
CREATE INDEX conversions_active ON conversions (status) WHERE status IN ('queued', 'running');
CREATE INDEX conversions_source_hash ON conversions (source_hash_id);
CREATE INDEX conversions_batch ON conversions (batch_id) WHERE batch_id IS NOT NULL;
-- the anonymous per-IP concurrency (§7.1)
CREATE INDEX conversions_owner_ip ON conversions (owner_ip_hash) WHERE owner_ip_hash IS NOT NULL;

-- the ordered sources of images -> PDF; single-source conversions don't use it
CREATE TABLE conversion_sources (
    conversion_id bigint NOT NULL REFERENCES conversions (id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 0),
    file_id bigint REFERENCES files (id) ON DELETE SET NULL,
    hash_id bigint REFERENCES file_hashes (id) ON DELETE SET NULL,
    PRIMARY KEY (conversion_id, position)
);
-- the moderation cascade walks it from a source file (§5.4)
CREATE INDEX conversion_sources_file ON conversion_sources (file_id) WHERE file_id IS NOT NULL;


-- the conversion cache (§2.2) ---------------------------------------------------------------------------------
-- Single-source, single-output recipes only. Rows go with their output hash (blob GC deletes file_hashes).

CREATE TABLE conversion_cache (
    source_hash_id bigint NOT NULL REFERENCES file_hashes (id) ON DELETE CASCADE,
    recipe_hash bytea NOT NULL CHECK (octet_length(recipe_hash) = 32),
    output_hash_id bigint NOT NULL REFERENCES file_hashes (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_hash_id, recipe_hash)
);
CREATE INDEX conversion_cache_output ON conversion_cache (output_hash_id);


-- provenance on files (§2.3) ------------------------------------------------------------------------------------

ALTER TABLE files
    -- the source (for several sources, the first), for the moderation cascade (§5.4)
    ADD COLUMN derived_from_file_id bigint REFERENCES files (id) ON DELETE SET NULL,
    ADD COLUMN conversion_id bigint REFERENCES conversions (id) ON DELETE SET NULL;
CREATE INDEX files_derived_from ON files (derived_from_file_id) WHERE derived_from_file_id IS NOT NULL;
CREATE INDEX files_conversion ON files (conversion_id) WHERE conversion_id IS NOT NULL;


-- assets and usage (§2.5) -----------------------------------------------------------------------------------------

-- the document preview: the PDF LibreOffice made (§9), with its page count
ALTER TABLE file_hash_assets DROP CONSTRAINT file_hash_assets_kind_check;
ALTER TABLE file_hash_assets
    ADD CONSTRAINT file_hash_assets_kind_check CHECK (kind IN ('thumb', 'thumb-2x', 'display', 'poster', 'cover',
                                                               'waveform', 'peaks', 'hover', 'document')),
    ADD COLUMN pages integer CHECK (pages > 0),
    ADD CONSTRAINT file_hash_assets_document_pages CHECK ((kind = 'document') = (pages IS NOT NULL));

ALTER TABLE file_hashes
    ADD COLUMN preview_state text NOT NULL DEFAULT 'none'
        CHECK (preview_state IN ('none', 'queued', 'done', 'failed', 'skipped'));
-- the sweeper re-enqueues a queued preview whose RQ job is missing (§9.1)
CREATE INDEX file_hashes_preview_queued ON file_hashes (id) WHERE preview_state = 'queued';

-- daily CPU time and count per subject (§7): `u:<user id>`, `g:<guest id>` or `i:<hex abuse IP hash>`, UTC days.
-- Rows older than 2 days are deleted by the hourly cleanup.
CREATE TABLE conversion_usage (
    subject text NOT NULL CHECK (subject ~ '^(u:[0-9]+|g:-?[0-9]+|i:[0-9a-f]{64})$'),
    day date NOT NULL,
    cpu_ms bigint NOT NULL DEFAULT 0 CHECK (cpu_ms >= 0),
    count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (subject, day)
);

-- upload defaults (§21) --------------------------------------------------------------------------------------------
-- `{ "expires_in": <seconds> | null, "visibility": "link" | "private" | "password", "nsfw": <bool> }`, the account's
-- choice for key uploads and conversions that don't say; `{}` is the plain default (link, the limits' expiry, not
-- adult). Validated by the API when it's set (utils/upload_defaults.py) and re-checked against the limits when used.
ALTER TABLE users
    ADD COLUMN upload_defaults jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(upload_defaults) = 'object');


-- rate limits moved to Redis (§18.5) ------------------------------------------------------------------------------

DROP TABLE safety_rate_limits, unlock_attempts;
