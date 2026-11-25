-- migrate:no-transaction
-- Milestone 4 hardening: scans that keep failing are held for staff (safety/scan.py `sweep`), and
-- indexes for the jobs queue's per-target lookups. Runs statement by statement so the indexes can
-- be built CONCURRENTLY on a live jobs table; every statement can be run again.

-- how many times the sweeper found the hash's scan job failed (or lost); at SCAN_MAX_FAILURES the
-- hash stays pending and is held for staff (`scan_stuck_at`, a `scan_failing` flag on its case)
ALTER TABLE file_hashes ADD COLUMN IF NOT EXISTS scan_failures integer NOT NULL DEFAULT 0;
ALTER TABLE file_hashes ADD COLUMN IF NOT EXISTS scan_stuck_at timestamptz;

-- one runnable job per target: `scan`, `rescan`, `probe`, `derive`, `delete_blob`, `csam_handle` (hash_id),
-- `album_collage`, `album_text_scan` (album_id) and `pdq_sweep` (blocked_hash_id) look these up
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_runnable_hash ON jobs (kind, (payload->>'hash_id'))
    WHERE done_at IS NULL AND failed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_runnable_album ON jobs (kind, (payload->>'album_id'))
    WHERE done_at IS NULL AND failed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_runnable_blocked_hash ON jobs (kind, (payload->>'blocked_hash_id'))
    WHERE done_at IS NULL AND failed_at IS NULL;
-- the purge of old done jobs (jobs/tasks.py)
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_done ON jobs (done_at) WHERE done_at IS NOT NULL;
-- the sweeper: pending hashes not yet held for staff
CREATE INDEX CONCURRENTLY IF NOT EXISTS file_hashes_pending_unstuck ON file_hashes (id)
    WHERE scan_state = 'pending' AND scan_stuck_at IS NULL;

-- a PDF with a user password is handled like an encrypted archive (contract §5.3): anonymous uploads
-- are rejected with ENCRYPTED_PDF_REQUIRES_ACCOUNT. NOT VALID, then VALIDATE, so the files table isn't
-- locked against writes while every row is checked.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_deleted_reason_check;
ALTER TABLE files ADD CONSTRAINT files_deleted_reason_check CHECK (deleted_reason IN ('moderator', 'FILE_BLOCKED',
    'MALWARE_DETECTED', 'FILE_TYPE_NOT_ALLOWED', 'NSFW_REQUIRES_ACCOUNT', 'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT',
    'ENCRYPTED_PDF_REQUIRES_ACCOUNT')) NOT VALID;
ALTER TABLE files VALIDATE CONSTRAINT files_deleted_reason_check;
