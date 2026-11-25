-- Milestone 6: accounts (docs/redesign/contracts/milestone-6.md §1).
--
-- Fresh launch: like Milestone 4's migration this assumes the `users` table is empty (no accounts,
-- sessions or tokens exist to keep working, contract §0). A development database with users must be
-- recreated. One transaction.

-- users (§1.1) ------------------------------------------------------------------------------------------
-- Gone: the discriminator, bot and flags, the Werkzeug password hash and the token-version times
-- (sessions are rows now, §3.4). An account's state is derived: `deleted` when deleted_at is set, else
-- `pending_deletion` when deletion_requested_at is set, else `active`.

DROP INDEX users_username_discriminator;
DROP INDEX users_username;
DROP INDEX users_email;
ALTER TABLE users
    DROP COLUMN discriminator,
    DROP COLUMN bot,
    DROP COLUMN flags,
    DROP COLUMN password,
    DROP COLUMN verified,
    DROP COLUMN last_email_reset_at,
    DROP COLUMN last_password_reset_at,
    DROP CONSTRAINT users_email_check,
    DROP CONSTRAINT users_username_check;
ALTER TABLE users
    -- NULL for Discord-only accounts; stored as typed, unique case-insensitively
    ALTER COLUMN email DROP NOT NULL,
    ADD CONSTRAINT users_email_check CHECK (char_length(email) <= 254),
    -- §2.2: lowercase [a-z0-9_.], 2-32, no leading, trailing or doubled dots; `deleted-<id>` is written only by
    -- the permanent deletion (§8.8)
    ADD CONSTRAINT users_username_check CHECK (
        username ~ '^([a-z0-9_][a-z0-9_.]{0,30}[a-z0-9_]|deleted-[0-9]+)$' AND username !~ '\.\.'),
    ADD COLUMN display_name text CHECK (char_length(display_name) BETWEEN 1 AND 32),
    ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
    -- an email change waiting for its link (§8.4); checked for uniqueness when it's confirmed
    ADD COLUMN pending_email text CHECK (char_length(pending_email) <= 254),
    -- argon2id (§2.6); NULL = no password
    ADD COLUMN password_hash text CHECK (password_hash LIKE '$argon2id$%'),
    -- set by a staff reset_username (§11.4)
    ADD COLUMN needs_username boolean NOT NULL DEFAULT false,
    -- the last self-service rename (the 30-day cooldown); NULL = never renamed
    ADD COLUMN username_changed_at timestamptz,
    ADD COLUMN show_name_on_albums boolean NOT NULL DEFAULT false,
    -- domain-only mode as the owner set it (§10.6), and when it last paused by itself
    ADD COLUMN domain_only boolean NOT NULL DEFAULT false,
    ADD COLUMN domain_only_paused_at timestamptz,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    -- the 14-day deletion grace period (§8.8), and the permanent deletion (a scrubbed tombstone)
    ADD COLUMN deletion_requested_at timestamptz,
    ADD COLUMN deletion_scheduled_for timestamptz,
    ADD COLUMN deleted_at timestamptz,
    ADD CONSTRAINT users_deletion_check CHECK ((deletion_requested_at IS NULL) = (deletion_scheduled_for IS NULL));
CREATE UNIQUE INDEX users_username ON users (username);
CREATE UNIQUE INDEX users_email ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_deletion_scheduled ON users (deletion_scheduled_for) WHERE deletion_scheduled_for IS NOT NULL;

-- a released username (rename or permanent deletion), held 30 days for its previous owner (§2.2)
CREATE TABLE username_holds (
    username text PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    released_at timestamptz NOT NULL DEFAULT now(),
    held_until timestamptz NOT NULL
);
CREATE INDEX username_holds_until ON username_holds (held_until);


-- login methods and sessions (§3, §5) -------------------------------------------------------------------------

CREATE TABLE user_identities (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('discord')),
    provider_user_id text NOT NULL,
    -- cached for Settings only: nothing syncs from the provider after creation
    username text,
    display_name text,
    avatar text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    UNIQUE (provider, provider_user_id),
    UNIQUE (user_id, provider)
);

-- web sessions: an opaque `fgs_` token in the HttpOnly cookie, stored as SHA-256. No IP addresses.
CREATE TABLE sessions (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    method text NOT NULL CHECK (method IN ('password', 'discord', 'register', 'reset')),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- the last password or Discord proof (re-authentication, §3.5)
    authenticated_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    -- idle expiry (slides), and the absolute one
    expires_at timestamptz NOT NULL,
    max_expires_at timestamptz NOT NULL,
    user_agent text CHECK (char_length(user_agent) <= 256),
    -- CF-IPCountry at sign-in, and at the last use
    country text CHECK (country ~ '^[A-Z]{2}$'),
    last_country text CHECK (last_country ~ '^[A-Z]{2}$'),
    revoked_at timestamptz,
    revoked_reason text CHECK (revoked_reason IN ('logout', 'user', 'everywhere', 'password_change', 'password_reset',
                                                  'limit', 'staff', 'deletion_requested', 'account_deleted')),
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_cleanup ON sessions (revoked_at, max_expires_at);

-- single-use email links (§2.5, §4.4), stored as SHA-256
CREATE TABLE account_tokens (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
    -- the address the link was sent to
    email text NOT NULL CHECK (char_length(email) <= 254),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
CREATE INDEX account_tokens_user ON account_tokens (user_id);


-- custom domains (§10) --------------------------------------------------------------------------------------------

CREATE TABLE custom_domains (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- lowercase punycode (§10.1)
    hostname text NOT NULL CHECK (char_length(hostname) <= 253 AND hostname = lower(hostname)),
    cf_hostname_id text,
    status text NOT NULL DEFAULT 'pending_dns' CHECK (status IN ('pending_dns', 'pending_cert', 'active', 'failing',
                                                                'failed', 'paused', 'disabled')),
    status_reason text,
    -- filesgg-verify=<verify_token> at _filesgg-verify.<hostname>
    verify_token text NOT NULL CHECK (verify_token ~ '^[a-z2-7]{26}$'),
    is_default boolean NOT NULL DEFAULT false,
    scope text NOT NULL DEFAULT 'own' CHECK (scope IN ('own', 'any')),
    -- Cloudflare's hostname `status` and `ssl.status`, and our DNS checks, as last seen
    cf_status text,
    cf_ssl_status text,
    dns_txt_ok boolean,
    dns_cname_ok boolean,
    verified_at timestamptz,
    last_checked_at timestamptz,
    next_check_at timestamptz,
    -- the start of the current 72 h pending window: creation, a retry, or premium coming back (§10.3)
    pending_since timestamptz NOT NULL DEFAULT now(),
    failing_since timestamptz,
    paused_at timestamptz,
    disabled_reason text,
    disabled_action_id bigint REFERENCES moderation_actions (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE UNIQUE INDEX custom_domains_hostname ON custom_domains (hostname) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX custom_domains_default ON custom_domains (user_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX custom_domains_next_check ON custom_domains (next_check_at) WHERE deleted_at IS NULL;
CREATE INDEX custom_domains_user ON custom_domains (user_id) WHERE deleted_at IS NULL;


-- upload keys (§7) -------------------------------------------------------------------------------------------------

CREATE TABLE upload_keys (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    -- `fgg_` plus 8, shown in lists
    prefix text NOT NULL CHECK (prefix ~ '^fgg_[0-9A-Za-z]{8}$'),
    key_hash bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
    scopes text[] NOT NULL CHECK (scopes <@ ARRAY['files:upload', 'albums:append'] AND 'files:upload' = ANY(scopes)),
    domain_id bigint REFERENCES custom_domains (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- NULL = never
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    revoked_reason text CHECK (revoked_reason IN ('owner', 'staff', 'account_deleted', 'expired')),
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX upload_keys_user ON upload_keys (user_id, id DESC);
CREATE INDEX upload_keys_prefix ON upload_keys (prefix);

ALTER TABLE files ADD COLUMN upload_key_id bigint REFERENCES upload_keys (id) ON DELETE SET NULL;
CREATE INDEX files_upload_key ON files (upload_key_id) WHERE upload_key_id IS NOT NULL;
ALTER TABLE upload_sessions ADD COLUMN upload_key_id bigint REFERENCES upload_keys (id) ON DELETE SET NULL;


-- premium (§9) ---------------------------------------------------------------------------------------------------

CREATE TABLE user_entitlements (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('premium')),
    granted_by bigint REFERENCES users (id) ON DELETE SET NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    -- NULL = until revoked
    expires_at timestamptz,
    revoked_at timestamptz,
    revoked_by bigint REFERENCES users (id) ON DELETE SET NULL,
    -- staff only
    note text CHECK (char_length(note) <= 2000),
    action_id bigint REFERENCES moderation_actions (id) ON DELETE SET NULL,
    -- the hourly entitlements_expiry task has recorded its lapse
    expired_at timestamptz
);
CREATE UNIQUE INDEX user_entitlements_active ON user_entitlements (user_id, kind) WHERE revoked_at IS NULL;


-- data exports (§8.7) ---------------------------------------------------------------------------------------------

CREATE TABLE data_exports (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
    -- exports/<user_id>/<id>.zip in the files bucket
    storage_key text,
    size bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    ready_at timestamptz,
    expires_at timestamptz
);
CREATE INDEX data_exports_user ON data_exports (user_id, id DESC);


-- soft-delete reasons (§1.3) ---------------------------------------------------------------------------------------

ALTER TABLE files DROP CONSTRAINT files_deleted_reason_check;
ALTER TABLE files ADD CONSTRAINT files_deleted_reason_check CHECK (deleted_reason IN ('moderator', 'FILE_BLOCKED',
    'MALWARE_DETECTED', 'FILE_TYPE_NOT_ALLOWED', 'NSFW_REQUIRES_ACCOUNT', 'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT',
    'ENCRYPTED_PDF_REQUIRES_ACCOUNT', 'account_deleted'));
ALTER TABLE albums DROP CONSTRAINT albums_deleted_reason_check;
ALTER TABLE albums ADD CONSTRAINT albums_deleted_reason_check CHECK (deleted_reason IN ('moderator', 'account_deleted'));


-- rate limits (§4.7, §7.6, §10.13) ----------------------------------------------------------------------------------

ALTER TABLE safety_rate_limits DROP CONSTRAINT safety_rate_limits_scope_check;
ALTER TABLE safety_rate_limits DROP CONSTRAINT safety_rate_limits_key_check;
ALTER TABLE safety_rate_limits
    ADD CONSTRAINT safety_rate_limits_scope_check CHECK (scope IN ('report', 'report_message', 'login_ip',
        'login_account', 'register', 'forgot_ip', 'forgot_account', 'verify_resend', 'discord', 'reauth',
        'username_check', 'upload_key', 'domain_add', 'domain_check', 'export')),
    -- acct:<email hash>, key:<upload key id>, domain:<domain id>, all hex
    ADD CONSTRAINT safety_rate_limits_key_check CHECK (key ~ '^(user|fp|ip|acct|key|domain):[0-9a-f]+$');


-- moderation: domains as targets (§10.12) ------------------------------------------------------------------------------

ALTER TABLE moderation_actions ADD COLUMN domain_id bigint REFERENCES custom_domains (id) ON DELETE SET NULL;
CREATE INDEX moderation_actions_domain ON moderation_actions (domain_id, id) WHERE domain_id IS NOT NULL;
ALTER TABLE custom_domains ADD CONSTRAINT custom_domains_disabled_check
    CHECK ((status = 'disabled') = (disabled_reason IS NOT NULL));

-- reports: a `domain` kind. Like Milestone 4's, the target checks are "at most one", because a target's
-- ON DELETE SET NULL can clear it (the unnamed checks are found by their definition)
ALTER TABLE reports ADD COLUMN domain_id bigint REFERENCES custom_domains (id) ON DELETE SET NULL;
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'reports'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%' LOOP
        EXECUTE format('ALTER TABLE reports DROP CONSTRAINT %I', c.conname);
    END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'moderation_cases'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%' LOOP
        EXECUTE format('ALTER TABLE moderation_cases DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;
ALTER TABLE reports DROP CONSTRAINT reports_kind_check;
ALTER TABLE reports
    ADD CONSTRAINT reports_kind_check CHECK (kind IN ('file', 'album', 'user', 'domain', 'bug')),
    ADD CONSTRAINT reports_bug_target_check CHECK (kind <> 'bug' OR num_nonnulls(file_id, album_id, user_id, domain_id) = 0),
    ADD CONSTRAINT reports_one_target_check CHECK (num_nonnulls(file_id, album_id, user_id, domain_id) <= 1),
    ADD CONSTRAINT reports_domain_target_check CHECK (kind = 'domain' OR domain_id IS NULL);
CREATE INDEX reports_domain ON reports (domain_id) WHERE domain_id IS NOT NULL;

ALTER TABLE moderation_cases ADD COLUMN domain_id bigint REFERENCES custom_domains (id) ON DELETE SET NULL;
ALTER TABLE moderation_cases DROP CONSTRAINT moderation_cases_kind_check;
ALTER TABLE moderation_cases
    ADD CONSTRAINT moderation_cases_kind_check CHECK (kind IN ('file', 'album', 'user', 'domain', 'hash', 'bug',
                                                              'appeal')),
    ADD CONSTRAINT moderation_cases_one_target_check
        CHECK (num_nonnulls(file_id, album_id, user_id, domain_id, hash_id, warning_id) <= 1);
CREATE UNIQUE INDEX moderation_cases_open_domain ON moderation_cases (domain_id)
    WHERE status = 'open' AND kind = 'domain';
