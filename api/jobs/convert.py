"""The RQ job functions of conversions and document previews (contract milestone-5 §3.3, §4, §9), enqueued by the
API by dotted path (utils/convert_queue.py) and run by `ConvertWorker` (convert_worker.py), each in its own forked
work horse:

- `run(conversion_id)`: reads the `conversions` row, skips one that's `cancelled` (or anything but `queued`), marks
  it `running`, downloads the source(s) into the job's directory, converts in sandboxed children
  (`python -m media.convert`, media/sandbox.py) or through the network-less `office` service (media/office.py),
  checks the output (§4.3) and stores it as a normal file (utils/conversion_outputs.py, §4.4). The stage goes
  `downloading` -> `converting` -> `storing`, and `progress` is written at most once a second (§8).
- `preview(hash_id)`: a document hash's preview PDF through the same office path (§9.1), stored as its `document`
  asset with its page count, plus `thumb` / `thumb-2x` from page 1 when the hash has none.

Refusals raise ApiError (§12); the worker class saves them as the conversion's error, and finishes in the parent
what a killed horse couldn't (§3.3). Each horse opens its own Postgres connection (sync psycopg) when it first
needs one and closes it when the job ends. Tool output never reaches the conversion (§0).
"""

import contextlib
import json
import logging
import os
import resource
import shutil
import sys
import tempfile
import threading
import time

from datetime import timezone

import db
from jobs import media as media_jobs
from media import formats, office, preview_content_type, sandbox
from media import convert as converter
from utils import conversion_outputs, conversions, errors, filetypes, storage as storage_module

log = logging.getLogger(__name__)

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP_DIR = os.getenv('CONVERT_TMP_DIR') or None
PROGRESS_EVERY = 1.0
# §3.3: the horse's tools stop this long before rq's time limit, so the usual timeout is a clean one
MARGIN = 5
# the next tier, for a CONVERSION_TIMEOUT's `tier` (who'd give more time, §7.1)
NEXT_TIER = {'convert_anonymous': 'member', 'convert_member': 'premium'}
# §9.1
PREVIEW_MAX_INPUT = 50 * 1000 * 1000
PREVIEW_MAX_PAGES = 300
PREVIEW_TIMEOUT = 120
PUBLISHED = ('passed', 'flagged')
SNIFF_BYTES = filetypes.SNIFF_BYTES

_conn = None
# the job's directory, made by the worker before it forks the horse (convert_worker.py); set only inside a work horse.
# A direct call (a script, the tests) makes its own directory and doesn't limit its own process's CPU
_directory = None


class Stop(Exception):
    """The conversion isn't `running` any more (cancelled meanwhile): the horse stops quietly."""


# --- the horse's connection and directory (§3.3) -----------------------------------------------------------------------

def connection():
    global _conn
    if _conn is None or _conn.closed:
        _conn = db.connect()
    return _conn


def close_connection():
    global _conn
    if _conn is not None and not _conn.closed:
        try:
            _conn.close()
        except Exception:
            log.exception("could not close the job's database connection")
    _conn = None


@contextlib.contextmanager
def job_directory(path):
    """The horse works in `path` (notsobot's `track_temp_directories`); it's deleted when the job ends, however
    the job ended (the worker deletes it too, after a killed horse)."""
    global _directory
    _directory = path
    try:
        yield path
    finally:
        _directory = None
        if path:
            shutil.rmtree(path, ignore_errors=True)


@contextlib.contextmanager
def workspace():
    if _directory is not None:
        yield _directory
        return
    path = tempfile.mkdtemp(prefix='convert-', dir=TMP_DIR)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


# --- errors (§12) --------------------------------------------------------------------------------------------------------

def timeout_error(job, conversion=None):
    """CONVERSION_TIMEOUT with `{ seconds, ran_seconds, queued_seconds, max_seconds, tier }` (notsobot's
    `job_timeout_error`): queue time doesn't count, and the message says how long it ran after how long it waited."""
    seconds = job.timeout if job is not None else None
    queue = (conversion or {}).get('queue') or (job.origin if job is not None else None)
    metadata = {'seconds': seconds, 'max_seconds': seconds, 'tier': NEXT_TIER.get(queue)}
    started, enqueued = timestamp(job and job.started_at), timestamp(job and job.enqueued_at)
    if started is not None:
        metadata['ran_seconds'] = round(max(0.0, time.time() - started), 1)
        if enqueued is not None:
            metadata['queued_seconds'] = round(max(0.0, started - enqueued), 1)
    error = errors.conversion_timeout(**metadata)
    if 'ran_seconds' in metadata:
        error.message = '{}: it ran for {:g}s{}'.format(
            error.message, metadata['ran_seconds'],
            ' after {:g}s in line'.format(metadata['queued_seconds']) if 'queued_seconds' in metadata else '')
        error.data['message'] = error.message
    return error


def timestamp(value):
    """An rq job datetime (UTC, sometimes without a timezone) as epoch seconds."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def save_failure(job, error):
    """The horse's error handler (convert_worker.store_job_error): the conversion is `failed` with `error`, or a
    preview's hash `failed`. Its own connection: the job's may be mid-statement."""
    target = job_target(job)
    if target is None:
        return
    kind, ident = target
    with db.connect() as conn:
        if kind == 'conversion':
            conn.execute(
                "UPDATE conversions SET status = 'failed', error = %s::jsonb, stage = NULL, finished_at = now() "
                "WHERE id = %s AND status IN ('queued', 'running')",
                (json.dumps(errors.conversion_error(error)), ident))
        else:
            conn.execute("UPDATE file_hashes SET preview_state = 'failed' WHERE id = %s AND preview_state = 'queued'",
                         (ident,))


def job_target(job):
    """('conversion', id) or ('preview', hash id) for one of this module's jobs, else None."""
    try:
        name, args = job.func_name, job.args
    except Exception:
        return None
    if not args:
        return None
    if name == __name__ + '.run':
        return 'conversion', int(args[0])
    if name == __name__ + '.preview':
        return 'preview', int(args[0])
    return None


def _current_job():
    from rq import get_current_job
    return get_current_job()


# --- running a sandboxed step ---------------------------------------------------------------------------------------------

class Budget:
    """The horse's time and CPU (§7.3): RLIMIT_CPU on the horse itself is the smaller of the time limit and the
    caller's budget left today (at least 5 s), and each child gets what's left of it. Its wall clock ends MARGIN
    seconds before rq's time limit."""

    def __init__(self, time_limit, cpu_seconds):
        self.time_limit = time_limit
        self.deadline = time.monotonic() + max(1, time_limit - MARGIN)
        self.cpu = max(sandbox.CONVERT_MIN_CPU, min(time_limit, cpu_seconds))
        # the caller's budget, not the time limit, is what would run out
        self.cpu_bound = cpu_seconds < time_limit
        self.started = self.used()

    @staticmethod
    def used():
        """This process's CPU time and its reaped children's (a forked horse starts from 0)."""
        own = resource.getrusage(resource.RUSAGE_SELF)
        children = resource.getrusage(resource.RUSAGE_CHILDREN)
        return own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime

    def apply(self):
        cpu = int(self.cpu)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))

    def wall(self):
        return max(1.0, self.deadline - time.monotonic())

    def cpu_left(self):
        return self.cpu - (self.used() - self.started)


class Conversion:
    def __init__(self, conn, row, job=None):
        self.conn = conn
        self.row = row
        self.id = row['id']
        self.job = job
        self.options = row['options'] or {}
        self.settings = row['output_settings'] or {}
        self.budget = None
        self.limits = None
        self._last_progress = 0.0
        self._lock = threading.Lock()

    # --- the row -------------------------------------------------------------------------------------------------------

    def stage(self, stage):
        if self.conn.execute("UPDATE conversions SET stage = %s WHERE id = %s AND status = 'running' RETURNING id",
                             (stage, self.id)).fetchone() is None:
            raise Stop()

    def progress(self, value, force=False):
        """At most once a second (§8), from the child's progress lines."""
        now = time.monotonic()
        with self._lock:
            if not force and now - self._last_progress < PROGRESS_EVERY:
                return
            self._last_progress = now
            self.conn.execute("UPDATE conversions SET progress = %s WHERE id = %s AND status = 'running'",
                              (round(min(1.0, max(0.0, value)), 4), self.id))

    # --- limits ---------------------------------------------------------------------------------------------------------

    def prepare(self):
        user = conversions.load_owner(self.conn, self.row['owner_user_id']) \
            if self.row['owner_user_id'] is not None else None
        from utils import limits as limits_module
        self.limits = limits_module.get_limits(user)
        self.budget = Budget(self.row['time_limit'], conversions.cpu_seconds_left(self.conn, self.id))
        if _directory is not None:
            # in a work horse: RLIMIT_CPU on itself (§7.3)
            self.budget.apply()

    def limit_reached(self):
        return errors.conversion_limit_reached('cpu', conversions.seconds_to_midnight(),
                                               sign_in=self.row['owner_user_id'] is None)

    def refused(self, reason, details):
        """A child's refusal (media/convert.py) as the conversion's error."""
        if reason == 'timeout' or (reason == 'cpu' and not self.budget.cpu_bound):
            return timeout_error(self.job, self.row)
        if reason == 'cpu':
            return self.limit_reached()
        if reason == 'target_size_too_small':
            return errors.target_size_too_small(details.get('minimum_mb'))
        return errors.conversion_failed(reason)

    # --- steps ----------------------------------------------------------------------------------------------------------

    def child(self, op, outdir, params):
        """`python -m media.convert <op>` in the horse's process group, under the budget. Returns its result."""
        cpu = self.budget.cpu_left()
        if cpu < 1:
            raise self.refused('cpu', {})
        wall = self.budget.wall()
        params = dict(params, budget=max(1, wall - 1), cpu=cpu, max_file=self.limits.conversion_max_output)
        cmd = [sys.executable, '-s', '-m', 'media.convert', op, outdir, json.dumps(params)]

        def on_line(line):
            try:
                data = json.loads(line)
            except ValueError:
                return
            if isinstance(data, dict) and isinstance(data.get('progress'), (int, float)):
                self.progress(data['progress'])

        return run_child(cmd, wall, cpu, outdir, self.limits.conversion_max_output, on_line, self.refused)

    def download(self, hash_id, directory, name):
        path = os.path.join(directory, name)
        storage_module.download_sync(media_jobs.s3(), media_jobs.bucket(), storage_module.blob_key(hash_id), path)
        return path

    def source(self):
        """(hash id, mimetype, media, name without extension) of a single-source conversion."""
        row = self.conn.execute(
            'SELECT h.id, h.media, f.mimetype_id, f.filename FROM file_hashes h LEFT JOIN files f ON f.id = %s '
            'WHERE h.id = %s', (self.row['source_file_id'], self.row['source_hash_id'])).fetchone()
        if row is None:
            raise errors.conversion_failed('unreadable_source')
        hash_id, media, mimetype, filename = row
        if mimetype is None:
            hints = media_jobs._fetch_hints(self.conn, hash_id) or {}
            mimetype = hints.get('mimetype')
        return hash_id, mimetype, media or {}, filename

    def sources(self):
        """[(hash id, mimetype)] of images -> PDF, in order."""
        rows = self.conn.execute(
            'SELECT s.hash_id, f.mimetype_id FROM conversion_sources s LEFT JOIN files f ON f.id = s.file_id '
            'WHERE s.conversion_id = %s AND s.hash_id IS NOT NULL ORDER BY s.position', (self.id,)).fetchall()
        if not rows:
            raise errors.conversion_failed('unreadable_source')
        return rows

    def convert(self, directory):
        kind, target = self.row['source_kind'], self.row['target']
        outdir = os.path.join(directory, 'out')
        os.mkdir(outdir)
        if kind == formats.IMAGES:
            inputs = []
            for index, (hash_id, mimetype) in enumerate(self.sources()):
                inputs.append({'path': self.download(hash_id, directory, 'input-{}'.format(index)),
                               'mimetype': mimetype})
            self.stage('converting')
            result = self.child('images_pdf', outdir, {'inputs': inputs, 'options': self.options})
        else:
            hash_id, mimetype, media, _ = self.source()
            path = self.download(hash_id, directory, 'input')
            self.stage('converting')
            result = self.convert_one(kind, target, path, mimetype, media, outdir)
        paths = [os.path.join(outdir, name) for name in result['outputs']]
        self.stage('storing')
        for path in paths:
            check_output(path, target)
        if kind == 'pdf':
            conversion_outputs.store_pages(self.conn, self.id, paths)
        else:
            conversion_outputs.store_output(self.conn, self.id, paths[0], formats.TARGETS[target].mimetype,
                                            '{}.{}'.format(self.settings.get('name'), formats.TARGETS[target].extension))

    def convert_one(self, kind, target, path, mimetype, media, outdir):
        params = {'input': path, 'mimetype': mimetype, 'media': media, 'kind': kind, 'target': target,
                  'options': self.options, 'name': self.settings.get('name') or 'page'}
        if kind == 'image':
            return self.child('image', outdir, params)
        if kind == 'animated':
            return self.child('animated', outdir, params)
        if kind in ('video', 'audio'):
            params['max_height_cap'] = self.limits.conversion_max_height
            return self.child('av', outdir, params)
        if kind == 'pdf':
            return self.child('pdf_pages', outdir, params)
        if kind == 'document':
            return self.document(path, mimetype, outdir)
        raise errors.unsupported_conversion(kind, target)

    def document(self, path, mimetype, outdir):
        """document -> pdf through the office service (§3.2), then pdfinfo on its PDF in the sandbox."""
        extension = office.MIMETYPE_EXTENSIONS.get(mimetype)
        if extension is None:
            raise errors.unsupported_conversion('document', 'pdf')
        if self.child('document_info', outdir, {'input': path}).get('encrypted'):
            raise errors.conversion_failed('unreadable_source')
        out = os.path.join(outdir, 'output.pdf')
        timeout = int(min(office.TIMEOUT, max(1, self.budget.wall() - office.GRACE)))
        try:
            office.convert(path, extension, out, timeout=timeout, max_pages=self.limits.conversion_max_pdf_pages)
        except office.OfficeError as error:
            if error.reason == 'timeout':
                raise timeout_error(self.job, self.row)
            if error.reason == 'too_many_pages':
                raise errors.conversion_failed('too_many_pages')
            if error.reason == 'unavailable':
                raise errors.conversion_failed('internal')
            raise errors.conversion_failed('unreadable_source')
        self.progress(0.9, force=True)
        self.child('pdf_info', outdir, {'input': out})
        return {'outputs': ['output.pdf']}


def run_child(cmd, wall, cpu, outdir, max_file, on_line, refused):
    """A media.convert child in the horse's process group (a killed horse takes it and its tools with it), its
    refusals turned into errors by `refused(reason, details)`."""
    try:
        out = sandbox.run(cmd, timeout=wall, cpu_seconds=cpu, cwd=API_DIR, new_session=False,
                          env=sandbox.convert_env(PYTHONPATH=API_DIR, TMPDIR=outdir, HOME=outdir),
                          address_space=sandbox.CONVERT_ADDRESS_SPACE, max_file=max_file, die_with_parent=True,
                          on_line=on_line)
    except sandbox.Timeout as error:
        raise refused('cpu' if error.cpu else 'timeout', {})
    except sandbox.Failed as error:
        if error.returncode == converter.UNUSABLE:
            result = media_jobs._last_json(error.stdout)
            raise refused(result.get('error') or 'unreadable_source', result)
        # staff only (§0): the conversion gets a fixed reason
        log.error('media.convert %s exited with %s: %r', cmd[4], error.returncode, (error.stderr or b'')[-2000:])
        raise errors.conversion_failed('internal')
    result = media_jobs._last_json(out)
    if 'error' in result:
        raise refused(result['error'], result)
    return result


def check_output(path, target):
    """§4.3: sniffed like an upload (`sniff_executable` and the libmagic type), and of the target's type; an empty
    output is `empty_output`, anything else `bad_output`."""
    import magic
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise errors.conversion_failed('empty_output')
    with open(path, 'rb') as handle:
        head = handle.read(SNIFF_BYTES)
    if filetypes.sniff_executable(head):
        raise errors.conversion_failed('bad_output')
    found = filetypes.trusted_sniff(magic.from_buffer(head, mime=True), head)
    if found not in converter.MAGIC_TYPES[target]:
        raise errors.conversion_failed('bad_output')


# --- the job functions ---------------------------------------------------------------------------------------------------

def run(conversion_id):
    """`jobs.convert.run(conversion_id)` (§4.1 step 4)."""
    conversion_id = int(conversion_id)
    conn = connection()
    try:
        row = conversions.row_dict(conn.execute(conversions.SELECT + ' WHERE c.id = %s', (conversion_id,)).fetchone())
        if row is None or row['status'] != 'queued':
            return None  # cancelled before it started (§3.3), or a duplicate
        if conn.execute("UPDATE conversions SET status = 'running', stage = 'downloading', progress = 0, "
                        "started_at = now() WHERE id = %s AND status = 'queued' RETURNING id",
                        (conversion_id,)).fetchone() is None:
            return None
        conversion = Conversion(conn, row, _current_job())
        conversion.prepare()
        with workspace() as directory:
            conversion.convert(directory)
        return conversion_id
    except Stop:
        return None
    finally:
        close_connection()


def preview(hash_id):
    """`jobs.convert.preview(hash_id)` (§9.1): `queued` -> `done`, `failed` or `skipped`."""
    hash_id = int(hash_id)
    conn = connection()
    try:
        row = conn.execute('SELECT preview_state, scan_state, size FROM file_hashes WHERE id = %s',
                           (hash_id,)).fetchone()
        if row is None or row[0] != 'queued':
            return None
        state, scan_state, size = row
        hints = media_jobs._fetch_hints(conn, hash_id) or {}
        extension = office.MIMETYPE_EXTENSIONS.get(hints.get('mimetype'))
        if scan_state not in PUBLISHED or extension is None or size > PREVIEW_MAX_INPUT:
            set_preview_state(conn, hash_id, 'skipped')
            return 'skipped'
        with workspace() as directory:
            return make_preview(conn, hash_id, extension, directory)
    finally:
        close_connection()


def set_preview_state(conn, hash_id, state):
    conn.execute("UPDATE file_hashes SET preview_state = %s WHERE id = %s AND preview_state = 'queued'",
                 (state, hash_id))


def preview_child(op, directory, params, wall=PREVIEW_TIMEOUT):
    def refused(reason, details):
        return errors.conversion_failed(reason if reason in errors.CONVERSION_FAILURE_REASONS else 'internal')
    params = dict(params, budget=wall - 1, cpu=wall)
    cmd = [sys.executable, '-s', '-m', 'media.convert', op, directory, json.dumps(params)]
    return run_child(cmd, wall, wall, directory, sandbox.MAX_OUTPUT_FILE, None, refused)


def make_preview(conn, hash_id, extension, directory):
    client = media_jobs.s3()
    path = os.path.join(directory, 'input')
    storage_module.download_sync(client, media_jobs.bucket(), storage_module.blob_key(hash_id), path)
    outdir = os.path.join(directory, 'out')
    os.mkdir(outdir)
    if preview_child('document_info', outdir, {'input': path}).get('encrypted'):
        set_preview_state(conn, hash_id, 'skipped')
        return 'skipped'
    pdf = os.path.join(directory, 'preview.pdf')
    try:
        office.convert(path, extension, pdf, timeout=PREVIEW_TIMEOUT, max_pages=PREVIEW_MAX_PAGES)
    except office.OfficeError as error:
        log.warning('document preview of hash %s failed: %s', hash_id, error.reason)
        set_preview_state(conn, hash_id, 'failed')
        return 'failed'
    pages = preview_child('pdf_info', outdir, {'input': pdf})['pages']
    check_output(pdf, 'pdf')
    has_thumbs = conn.execute("SELECT count(*) FROM file_hash_assets WHERE hash_id = %s AND kind IN ('thumb', "
                              "'thumb-2x')", (hash_id,)).fetchone()[0] == 2
    thumbs = []
    if not has_thumbs:
        derived = media_jobs.run_child('derive', pdf, outdir, {'mimetype': formats.PDF_MIMETYPE},
                                       sandbox.DERIVE_WALL, sandbox.DERIVE_CPU)
        thumbs = [item for item in derived.get('assets') or () if item.get('kind') in ('thumb', 'thumb-2x')]
    uploaded = []
    try:
        size = os.path.getsize(pdf)
        key = media_jobs.derived_key(hash_id, 'document')
        with open(pdf, 'rb') as handle:
            client.put_object(Bucket=media_jobs.bucket(), Key=key, Body=handle,
                              ContentType=preview_content_type('document'), ContentLength=size)
        uploaded.append(key)
        assets = [('document', key, size, None, None, pages)]
        for item in thumbs:
            thumb = os.path.join(outdir, item['file'])
            thumb_key = media_jobs.derived_key(hash_id, item['kind'])
            with open(thumb, 'rb') as handle:
                client.put_object(Bucket=media_jobs.bucket(), Key=thumb_key, Body=handle,
                                  ContentType=preview_content_type(item['kind']),
                                  ContentLength=os.path.getsize(thumb))
            uploaded.append(thumb_key)
            assets.append((item['kind'], thumb_key, os.path.getsize(thumb), item.get('width'), item.get('height'),
                           None))
        with conn.transaction():
            state = conn.execute('SELECT preview_state, scan_state FROM file_hashes WHERE id = %s FOR UPDATE',
                                 (hash_id,)).fetchone()
            if state is None or state[0] != 'queued' or state[1] not in PUBLISHED:
                raise Stop()
            for kind, asset_key, asset_size, width, height, asset_pages in assets:
                conn.execute(
                    'INSERT INTO file_hash_assets (hash_id, kind, storage_key, content_type, size, width, height, pages) '
                    'VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (hash_id, kind) DO UPDATE SET '
                    'storage_key = EXCLUDED.storage_key, content_type = EXCLUDED.content_type, size = EXCLUDED.size, '
                    'width = EXCLUDED.width, height = EXCLUDED.height, pages = EXCLUDED.pages, created_at = now()',
                    (hash_id, kind, asset_key, preview_content_type(kind), asset_size, width, height, asset_pages))
            # whole seconds: derived_at is also the ?v= asset version (§9.2)
            conn.execute("UPDATE file_hashes SET preview_state = 'done', derived_at = date_trunc('second', now()) "
                         'WHERE id = %s', (hash_id,))
    except Stop:
        # held, blocked or deleted meanwhile: what was just uploaded must not stay
        for asset_key in uploaded:
            media_jobs._delete_quietly(client, asset_key)
        return None
    return 'done'
