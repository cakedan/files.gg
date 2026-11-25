-- Milestone 6 §19: view limits ("burn after N views"). One transaction.
--
-- A file can stop being viewable after N unique viewers. A viewer is the milestone-4 abuse IP hash (HMAC with
-- ABUSE_HASH_SECRET, IPv6 grouped by /64), so reopening never uses a second view; the owner and staff never
-- count. `views_used` always equals the number of `file_limit_viewers` rows of the file: both change in the
-- same transaction (views/files.py `count_view`).

ALTER TABLE files
    -- NULL = no limit
    ADD COLUMN view_limit integer CHECK (view_limit BETWEEN 1 AND 1000),
    -- what happens when the last view is used: the file expires, or becomes private
    ADD COLUMN view_limit_action text NOT NULL DEFAULT 'expire' CHECK (view_limit_action IN ('expire', 'private')),
    ADD COLUMN views_used integer NOT NULL DEFAULT 0 CHECK (views_used >= 0),
    -- a limit is never below what was already used (PATCH answers VIEW_LIMIT_TOO_LOW)
    ADD CONSTRAINT files_views_within_limit_check CHECK (view_limit IS NULL OR views_used <= view_limit);

-- a chunked upload carries the limit until it's finalized into a file
ALTER TABLE upload_sessions
    ADD COLUMN view_limit integer CHECK (view_limit BETWEEN 1 AND 1000),
    ADD COLUMN view_limit_action text NOT NULL DEFAULT 'expire' CHECK (view_limit_action IN ('expire', 'private'));

CREATE TABLE file_limit_viewers (
    file_id bigint NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    -- the abuse IP hash (32 bytes)
    viewer bytea NOT NULL,
    first_viewed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (file_id, viewer)
);
