"""Job handlers and scheduled tasks registered by the worker.

Milestone 1 registers a no-op `ping` job, the snowflake_nodes lease cleanup
and the file_view_seen cleanup; the media jobs (`finalize_upload`, `probe`, `derive`, `scan`,
`delete_blob`) arrive with their features.
"""

import logging

from datetime import timedelta

from jobs.queue import register
from utils import snowflake_nodes
from utils.view_hash import utc_today

log = logging.getLogger(__name__)

SNOWFLAKE_CLEANUP_INTERVAL = 15 * 60
VIEW_SEEN_CLEANUP_INTERVAL = 60 * 60
VIEW_SEEN_KEEP_DAYS = 2


@register('ping')
def ping(payload, job):
    log.info('ping %r', payload)


def register_scheduled(scheduler):
    conn = scheduler.conn

    @scheduler.register('snowflake_nodes_cleanup', SNOWFLAKE_CLEANUP_INTERVAL)
    def snowflake_nodes_cleanup():
        deleted = snowflake_nodes.cleanup_expired(conn)
        log.info('snowflake_nodes cleanup removed %d expired lease(s)', deleted)

    @scheduler.register('file_view_seen_cleanup', VIEW_SEEN_CLEANUP_INTERVAL)
    def file_view_seen_cleanup():
        deleted = cleanup_view_seen(conn)
        log.info('file_view_seen cleanup removed %d row(s)', deleted)

    return scheduler


def cleanup_view_seen(conn, today=None):
    """Delete unique-view hashes older than VIEW_SEEN_KEEP_DAYS (UTC days)."""
    cutoff = (today or utc_today()) - timedelta(days=VIEW_SEEN_KEEP_DAYS)
    return conn.execute('DELETE FROM file_view_seen WHERE day < %s', (cutoff,)).rowcount
