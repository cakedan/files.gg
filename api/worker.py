"""Background worker: `python -m worker`.

Runs queued jobs and the scheduled tasks. Same image as the API, different
command; scale replicas independently. Stops cleanly on SIGTERM/SIGINT.

Deliberately synchronous (psycopg 3 sync): future jobs are CPU-bound (ffmpeg,
Pillow, scanning), so they don't belong on an event loop.
"""

import argparse
import logging
import os
import signal
import sys
import threading

import psycopg

log = logging.getLogger('worker')


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog='python -m worker')
    parser.add_argument(
        '--queues', default=os.getenv('WORKER_QUEUES', 'default'),
        help='comma-separated queues to claim jobs from (env WORKER_QUEUES; default: default)')
    return parser.parse_args(argv)


def main(argv=None):
    options = parse_args(argv)
    logging.basicConfig(
        level=os.getenv('LOG_LEVEL', 'INFO'),
        format='%(asctime)s %(name)s %(levelname)s %(message)s',
    )

    import db
    from jobs import Scheduler, make_worker_id, parse_queues, registered_kinds, run_next
    from jobs import tasks
    from utils.snowflake_nodes import start_process_lease, stop_process_lease

    queues = parse_queues(options.queues)
    # milestone-4 §3.1, §13: the scanner and rescanner refuse to start without a real matcher
    # (standin needs FILESGG_DEV_TOOLS=1) and the evidence settings
    if {'scan', 'rescan'} & set(queues):
        from safety.settings import check_scanner
        check_scanner()
    poll_interval = float(os.getenv('WORKER_POLL_INTERVAL', '1'))
    stop = threading.Event()

    def on_signal(signum, frame):
        log.info('received signal %s, stopping', signum)
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    start_process_lease()
    worker_id = make_worker_id()
    jobs_conn = db.connect()
    scheduler = tasks.register_scheduled(Scheduler(db.connect()))
    log.info('worker %s started; queues: %s; job kinds: %s; scheduled: %s',
             worker_id, ', '.join(queues), ', '.join(registered_kinds()), ', '.join(sorted(scheduler.tasks)))

    try:
        while not stop.is_set():
            try:
                if scheduler.conn.closed:
                    scheduler.conn = db.connect()
                    tasks.register_scheduled(scheduler)
                scheduler.tick()
                if jobs_conn.closed:
                    jobs_conn = db.connect()
                outcome = run_next(worker_id, queues=queues, conn=jobs_conn)
            except psycopg.OperationalError:
                log.exception('database error; reconnecting')
                for conn in (jobs_conn, scheduler.conn):
                    if not conn.closed:
                        conn.close()
                outcome = None
            except Exception:
                log.exception('error while claiming or running a job')
                outcome = None
            if outcome is None:
                stop.wait(poll_interval)
    finally:
        stop_process_lease()
        for conn in (jobs_conn, scheduler.conn):
            if not conn.closed:
                conn.close()
    log.info('worker %s stopped', worker_id)
    return 0


if __name__ == '__main__':
    sys.exit(main())
