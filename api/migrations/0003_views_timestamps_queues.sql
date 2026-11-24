-- PLAN.md Phase 1, "Schema fixes from the database review", fixes 1, 2 and 4.
-- Safe on production data: new columns are nullable or have constant defaults
-- (metadata-only on PG 11+), and each backfill is a single statement.
-- The legacy columns and file_views are dropped one release later by
-- pending/0004_drop_legacy.sql.

-- Unix timestamps written by Peewee's TimestampField are SECONDS (resolution 1;
-- e.g. 1795544992 for 2026-11-24). Values above 1e11 would be milliseconds
-- (seconds that large are year 5138+), so they are divided by 1000 defensively.
CREATE FUNCTION pg_temp.unix_to_timestamptz(value bigint) RETURNS timestamptz
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT CASE WHEN value > 100000000000 THEN to_timestamp(value / 1000.0)
                      ELSE to_timestamp(value) END $$;


-- 1. Daily view counts instead of one row (and one raw IP) per view ---------------

CREATE TABLE file_view_days (
    file_id BIGINT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    day DATE NOT NULL,
    views BIGINT NOT NULL DEFAULT 0,
    unique_views BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (file_id, day)
);

-- ip_hash = HMAC-SHA256(daily key, ip); the key rotates every UTC day and is
-- never stored. Rows older than 2 days are deleted by the scheduler.
CREATE TABLE file_view_seen (
    file_id BIGINT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    day DATE NOT NULL,
    ip_hash BYTEA NOT NULL,
    PRIMARY KEY (file_id, day, ip_hash)
);
CREATE INDEX file_view_seen_day ON file_view_seen (day);

-- The old code stored one file_views row per (file, IP) ever, so per day
-- views = unique_views here. No IPs are copied.
INSERT INTO file_view_days (file_id, day, views, unique_views)
SELECT file_id,
       (pg_temp.unix_to_timestamptz("timestamp") AT TIME ZONE 'UTC')::date AS day,
       count(*),
       count(DISTINCT ip)
FROM file_views
GROUP BY 1, 2;


-- 2. timestamptz twins for the users' unix-seconds columns -------------------------

ALTER TABLE users
    ADD COLUMN last_email_reset_at TIMESTAMPTZ,
    ADD COLUMN last_password_reset_at TIMESTAMPTZ;

UPDATE users
SET last_email_reset_at = pg_temp.unix_to_timestamptz(last_email_reset),
    last_password_reset_at = pg_temp.unix_to_timestamptz(last_password_reset);

-- Rolling deploy: new code reads only the *_at columns and writes both. Servers
-- still on the old code write only the old columns; this trigger carries those
-- writes into the *_at columns, so a password reset done by an old server still
-- invalidates older tokens on new servers. Dropped with the old columns in 0004.
CREATE FUNCTION users_sync_legacy_timestamps() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.last_email_reset_at IS NULL AND NEW.last_email_reset IS NOT NULL THEN
            NEW.last_email_reset_at := CASE WHEN NEW.last_email_reset > 100000000000
                THEN to_timestamp(NEW.last_email_reset / 1000.0) ELSE to_timestamp(NEW.last_email_reset) END;
        END IF;
        IF NEW.last_password_reset_at IS NULL AND NEW.last_password_reset IS NOT NULL THEN
            NEW.last_password_reset_at := CASE WHEN NEW.last_password_reset > 100000000000
                THEN to_timestamp(NEW.last_password_reset / 1000.0) ELSE to_timestamp(NEW.last_password_reset) END;
        END IF;
    ELSE
        IF NEW.last_email_reset IS DISTINCT FROM OLD.last_email_reset
           AND NEW.last_email_reset_at IS NOT DISTINCT FROM OLD.last_email_reset_at THEN
            NEW.last_email_reset_at := CASE WHEN NEW.last_email_reset > 100000000000
                THEN to_timestamp(NEW.last_email_reset / 1000.0) ELSE to_timestamp(NEW.last_email_reset) END;
        END IF;
        IF NEW.last_password_reset IS DISTINCT FROM OLD.last_password_reset
           AND NEW.last_password_reset_at IS NOT DISTINCT FROM OLD.last_password_reset_at THEN
            NEW.last_password_reset_at := CASE WHEN NEW.last_password_reset > 100000000000
                THEN to_timestamp(NEW.last_password_reset / 1000.0) ELSE to_timestamp(NEW.last_password_reset) END;
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER users_sync_legacy_timestamps
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION users_sync_legacy_timestamps();


-- 4. Job queues ----------------------------------------------------------------------

ALTER TABLE jobs ADD COLUMN queue TEXT NOT NULL DEFAULT 'default';

-- scheduler marker rows live on a queue no worker claims from
UPDATE jobs SET queue = 'scheduler' WHERE kind LIKE 'scheduled:%';

DROP INDEX IF EXISTS jobs_runnable;
CREATE INDEX jobs_runnable ON jobs (queue, run_at, id)
    WHERE done_at IS NULL AND failed_at IS NULL;

DROP FUNCTION pg_temp.unix_to_timestamptz(bigint);
