"""Scheduled trust & safety tasks (contract milestone-4 §13), registered by jobs/tasks.py:

- scan_sweeper (5 min): re-queue pending hashes without a runnable scan (§2.6);
- rescan_scheduler (10 min): queue due rescans, at most 1,000 a run (§2.7);
- report_closer (1 h): close reports 30 days after they were resolved or dismissed (§7.6);
- safety_retention (daily): IP hashes and sealed IPs past 30 days, contact emails 90 days after
  a report closed, closed reports past REPORT_RETENTION_DAYS (except child-safety cases), and
  expired evidence holds in the files bucket;
- safety_rate_limits_cleanup (1 h): rate-limit windows older than an hour (a day for `domain_add`, whose
  window is a day, milestone-6 §10.13).
"""

import logging

from safety import scan as safety_scan
from safety.settings import safety_settings
from utils.uploading import snowflake_since

log = logging.getLogger(__name__)

SCAN_SWEEPER_INTERVAL = 5 * 60
RESCAN_SCHEDULER_INTERVAL = 10 * 60
REPORT_CLOSER_INTERVAL = 60 * 60
RETENTION_INTERVAL = 24 * 60 * 60
RATE_LIMITS_INTERVAL = 60 * 60
CONTACT_EMAIL_DAYS = 90


def register(scheduler):
    conn = scheduler.conn

    @scheduler.register('scan_sweeper', SCAN_SWEEPER_INTERVAL)
    def scan_sweeper():
        log.info('scan sweeper re-queued %d pending hash(es)', safety_scan.sweep(conn))

    @scheduler.register('rescan_scheduler', RESCAN_SCHEDULER_INTERVAL)
    def rescan_scheduler():
        log.info('rescan scheduler queued %d rescan(s)', safety_scan.schedule_rescans(conn))

    @scheduler.register('report_closer', REPORT_CLOSER_INTERVAL)
    def report_closer():
        log.info('report closer closed %d report(s)', close_reports(conn))

    @scheduler.register('safety_retention', RETENTION_INTERVAL)
    def safety_retention():
        log.info('safety retention: %r', retention(conn))

    @scheduler.register('safety_rate_limits_cleanup', RATE_LIMITS_INTERVAL)
    def safety_rate_limits_cleanup():
        deleted = conn.execute("DELETE FROM safety_rate_limits WHERE window_start < now() - CASE WHEN scope = "
                               "'domain_add' THEN interval '1 day' ELSE interval '1 hour' END").rowcount
        log.info('safety_rate_limits cleanup removed %d row(s)', deleted)

    return scheduler


def close_reports(conn, settings=None):
    settings = settings or safety_settings()
    return conn.execute(
        "UPDATE reports SET closed_at = now() WHERE closed_at IS NULL AND status IN ('resolved', 'dismissed') "
        "AND resolved_at <= now() - make_interval(days => %s)", (settings.report_close_after_days,)).rowcount


def retention(conn, settings=None):
    from jobs.gc import ENQUEUE_DELETE_SQL, _delete_params
    settings = settings or safety_settings()
    days = settings.abuse_ip_keep_days
    out = {}
    out['file_ips'] = conn.execute(
        'UPDATE files SET uploader_abuse_ip_hash = NULL, uploader_ip_sealed = NULL WHERE id < %s AND '
        '(uploader_abuse_ip_hash IS NOT NULL OR uploader_ip_sealed IS NOT NULL)',
        (snowflake_since(days * 86400),)).rowcount
    out['report_ips'] = conn.execute(
        'UPDATE reports SET reporter_abuse_ip_hash = NULL WHERE reporter_abuse_ip_hash IS NOT NULL AND '
        'created_at < now() - make_interval(days => %s)', (days,)).rowcount
    out['contact_emails'] = conn.execute(
        'UPDATE reports SET contact_email = NULL WHERE contact_email IS NOT NULL AND closed_at < now() - '
        'make_interval(days => %s)', (CONTACT_EMAIL_DAYS,)).rowcount
    out['reports'] = conn.execute(
        'DELETE FROM reports r WHERE closed_at < now() - make_interval(days => %s) AND NOT EXISTS ('
        'SELECT 1 FROM moderation_cases c WHERE c.id = r.case_id AND c.child_safety)',
        (settings.report_retention_days,)).rowcount
    with conn.transaction():
        released = conn.execute(
            "UPDATE evidence_holds SET released_at = now() WHERE bucket = 'files' AND released_at IS NULL "
            'AND retain_until <= now() RETURNING hash_id').fetchall()
        for (hash_id,) in released:
            if hash_id is not None and conn.execute('SELECT 1 FROM files WHERE hash_id = %s AND deleted_at IS NULL',
                                                    (hash_id,)).fetchone() is None:
                conn.execute(ENQUEUE_DELETE_SQL, _delete_params(hash_id))
    out['holds_released'] = len(released)
    return out
