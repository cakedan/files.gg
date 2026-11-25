"""`probe`, `derive` and `album_collage` (contract §2), on the `media` queue.

Per content, not per file: probe and derive take {"hash_id"} and work on the blob,
streamed from B2 to a temp file. The parsing itself runs in `python -m media.process`
under media/sandbox.py's limits; this side only moves bytes and rows:

- probe: stores `file_hashes.media`, sets `probed` (or `skipped` for types with nothing
  to read) and queues derive;
- derive: uploads every preview to `derived/<hash_id>/<kind>.<ext>`, then in one transaction
  replaces the hash's `file_hash_assets` rows and sets `done` + `derived_at`;
- album_collage: the 1200x630 og:image of an album from its first visual items.

A file the tools can't read is marked `failed` at once. Any other error is retried by
the queue (3 attempts), and the last failed attempt marks the hash `failed`. Nothing
partial is recorded: rows change only after every asset is stored.
"""

import io
import json
import logging
import os
import shutil
import sys
import tempfile
import time

import db
from jobs.queue import register
from media import PREVIEW_KINDS, preview_content_type, preview_filename, sandbox
from utils import storage as storage_module

log = logging.getLogger(__name__)

QUEUE = 'media'
MAX_ATTEMPTS = 3
COLLAGE_DELAY = 5
COLLAGE_SIZE = (1200, 630)
API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP_DIR = os.getenv('MEDIA_TMP_DIR') or None

_s3 = None


def s3():
    global _s3
    if _s3 is None:
        _s3 = storage_module.sync_client()
    return _s3


def bucket():
    return storage_module.S3Settings.from_env().bucket


def derived_key(hash_id, kind):
    """derived/<hash_id>/<kind>.<ext> (contract §1)."""
    return 'derived/{}/{}'.format(hash_id, preview_filename(kind))


def collage_key(album_id, version):
    return 'derived/albums/{}/collage-{}.webp'.format(album_id, version)


# --- queueing ---------------------------------------------------------------------------------

ENQUEUE_SQL = ('INSERT INTO jobs (kind, payload, run_at, max_attempts, queue) '
               "VALUES (%s, %s::jsonb, now() + make_interval(secs => %s::float8), %s, 'media') RETURNING id")
# album_collage is deduplicated: one waiting job per album is enough
ENQUEUE_COLLAGE_SQL = (
    "INSERT INTO jobs (kind, payload, run_at, max_attempts, queue) "
    "SELECT 'album_collage', %s::jsonb, now() + make_interval(secs => %s::float8), %s, 'media' "
    "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'album_collage' AND payload->>'album_id' = %s "
    "AND done_at IS NULL AND failed_at IS NULL AND locked_by IS NULL) RETURNING id")


def _hash_params(kind, hash_id, delay=0):
    return (kind, json.dumps({'hash_id': str(hash_id)}), delay, MAX_ATTEMPTS)


def _collage_params(album_id, delay=COLLAGE_DELAY):
    return (json.dumps({'album_id': str(album_id)}), delay, MAX_ATTEMPTS, str(album_id))


def queue_probe(conn, hash_id):
    conn.execute(ENQUEUE_SQL, _hash_params('probe', hash_id))


async def queue_probe_async(conn, hash_id):
    await conn.execute(ENQUEUE_SQL, _hash_params('probe', hash_id))


def queue_collage(conn, album_id, delay=COLLAGE_DELAY):
    conn.execute(ENQUEUE_COLLAGE_SQL, _collage_params(album_id, delay))


async def queue_collage_async(conn, album_id, delay=COLLAGE_DELAY):
    await conn.execute(ENQUEUE_COLLAGE_SQL, _collage_params(album_id, delay))


# --- the sandboxed child ---------------------------------------------------------------------------

class Unusable(Exception):
    pass


def run_child(op, path, outdir, hints, wall, cpu):
    hints = dict(hints, budget=wall - 1)
    cmd = [sys.executable, '-s', '-m', 'media.process', op, path, outdir, json.dumps(hints)]
    try:
        out = sandbox.run(cmd, timeout=wall, cpu_seconds=cpu, cwd=API_DIR,
                          env=sandbox.clean_env(PYTHONPATH=API_DIR, TMPDIR=outdir, HOME=outdir))
    except sandbox.Failed as error:
        if error.returncode == 3:
            raise Unusable(_last_json(error.stdout).get('error') or 'unusable')
        raise
    result = _last_json(out)
    if 'error' in result:
        raise Unusable(result['error'])
    return result


def _last_json(out, default=b'{}'):
    lines = [line for line in (out or default).splitlines() if line.strip()]
    try:
        return json.loads(lines[-1]) if lines else {}
    except ValueError:
        return {}


def _fetch_hints(conn, hash_id):
    """The hash and the type of its earliest file (processing is per content; a blob's
    files share their bytes, the first one's type decides how it is read)."""
    row = conn.execute(
        'SELECT h.processing_state, h.media, f.mimetype_id, f.extension FROM file_hashes h '
        'LEFT JOIN LATERAL (SELECT mimetype_id, extension FROM files WHERE hash_id = h.id ORDER BY id LIMIT 1) f '
        'ON true WHERE h.id = %s', (hash_id,)).fetchone()
    if row is None:
        return None
    state, media, mimetype, extension = row
    return {'state': state, 'media': media, 'mimetype': mimetype, 'extension': extension}


def _set_failed(hash_id, reason):
    log.warning('media processing failed for hash %s: %s', hash_id, reason)
    with db.connect() as conn:
        conn.execute("UPDATE file_hashes SET processing_state = 'failed' WHERE id = %s", (hash_id,))


class Workspace:
    """A private temp dir holding the blob, removed afterwards."""

    def __init__(self, hash_id):
        self.dir = tempfile.mkdtemp(prefix='media-{}-'.format(hash_id), dir=TMP_DIR)
        self.input = os.path.join(self.dir, 'input')
        self.out = os.path.join(self.dir, 'out')
        os.mkdir(self.out, 0o700)

    def download(self, client, hash_id):
        client.download_file(bucket(), storage_module.blob_key(hash_id), self.input)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.dir, ignore_errors=True)
        return False


def _guarded(hash_id, job, func):
    """Run a media step: unusable files fail at once; other errors fail on the last attempt."""
    try:
        return func()
    except Unusable as error:
        _set_failed(hash_id, error)
        return None
    except Exception as error:
        if job is None or job.attempts >= job.max_attempts:
            _set_failed(hash_id, error)
        raise


# --- probe -------------------------------------------------------------------------------------------

def probe(hash_id, job=None, client=None):
    client = client or s3()
    with db.connect() as conn:
        hints = _fetch_hints(conn, hash_id)
    if hints is None or hints['state'] not in ('pending', 'failed'):
        return None  # gone, or already probed (a duplicate job)

    def work():
        with Workspace(hash_id) as space:
            space.download(client, hash_id)
            result = run_child('probe', space.input, space.out,
                               {'mimetype': hints['mimetype'], 'extension': hints['extension']},
                               sandbox.PROBE_WALL, sandbox.PROBE_CPU)
        state = result.get('state')
        media = result.get('media')
        with db.connect() as conn:
            with conn.transaction():
                updated = conn.execute(
                    "UPDATE file_hashes SET media = %s::jsonb, processing_state = %s, probed_at = now() "
                    "WHERE id = %s AND processing_state IN ('pending', 'failed') RETURNING id",
                    (json.dumps(media) if media is not None else None, state, hash_id)).fetchone()
                if updated is not None and state == 'probed':
                    conn.execute(ENQUEUE_SQL, _hash_params('derive', hash_id))
        return state

    return _guarded(hash_id, job, work)


@register('probe')
def probe_job(payload, job):
    probe(int(payload['hash_id']), job)


# --- derive ------------------------------------------------------------------------------------------

def derive(hash_id, job=None, client=None):
    client = client or s3()
    with db.connect() as conn:
        hints = _fetch_hints(conn, hash_id)
    if hints is None or hints['state'] != 'probed':
        return None

    def work():
        with Workspace(hash_id) as space:
            space.download(client, hash_id)
            result = run_child('derive', space.input, space.out,
                               {'mimetype': hints['mimetype'], 'extension': hints['extension'],
                                'media': hints['media']},
                               sandbox.DERIVE_WALL, sandbox.DERIVE_CPU)
            assets = []
            for item in result.get('assets') or ():
                kind = item.get('kind')
                if kind not in PREVIEW_KINDS or item.get('file') != preview_filename(kind):
                    raise RuntimeError('unexpected preview {!r}'.format(kind))
                path = os.path.join(space.out, item['file'])
                size = os.path.getsize(path)
                key = derived_key(hash_id, kind)
                content_type = preview_content_type(kind)
                with open(path, 'rb') as handle:
                    client.put_object(Bucket=bucket(), Key=key, Body=handle, ContentType=content_type,
                                      ContentLength=size)
                assets.append((kind, key, content_type, size, item.get('width'), item.get('height')))
        with db.connect() as conn:
            with conn.transaction():
                state = conn.execute('SELECT processing_state FROM file_hashes WHERE id = %s FOR UPDATE',
                                     (hash_id,)).fetchone()
                if state is None or state[0] != 'probed':
                    return None
                old = {r[0] for r in conn.execute('SELECT kind FROM file_hash_assets WHERE hash_id = %s',
                                                  (hash_id,)).fetchall()}
                conn.execute('DELETE FROM file_hash_assets WHERE hash_id = %s', (hash_id,))
                for kind, key, content_type, size, width, height in assets:
                    conn.execute(
                        'INSERT INTO file_hash_assets (hash_id, kind, storage_key, content_type, size, width, height) '
                        'VALUES (%s, %s, %s, %s, %s, %s, %s)', (hash_id, kind, key, content_type, size, width, height))
                # whole seconds: derived_at is also the ?v= asset version
                conn.execute("UPDATE file_hashes SET processing_state = 'done', "
                             "derived_at = date_trunc('second', now()) WHERE id = %s", (hash_id,))
                # albums holding these bytes may now get (or improve) their collage
                for (album_id,) in conn.execute(
                        'SELECT DISTINCT af.album_id FROM album_files af JOIN files f ON f.id = af.file_id '
                        'JOIN albums a ON a.id = af.album_id WHERE f.hash_id = %s AND a.deleted_at IS NULL',
                        (hash_id,)).fetchall():
                    queue_collage(conn, album_id)
        for kind in old - {a[0] for a in assets}:
            if kind in PREVIEW_KINDS:
                _delete_quietly(client, derived_key(hash_id, kind))
        return [a[0] for a in assets]

    return _guarded(hash_id, job, work)


def _delete_quietly(client, key):
    try:
        client.delete_object(Bucket=bucket(), Key=key)
    except Exception:
        log.warning('could not delete %s', key)


@register('derive')
def derive_job(payload, job):
    derive(int(payload['hash_id']), job)


# --- album_collage -----------------------------------------------------------------------------------

# the best stored image per item for a collage tile, largest first
COLLAGE_SOURCES = ('poster', 'cover', 'thumb-2x', 'thumb')


def collage_sources(conn, album_id, limit=4):
    """Storage keys of the first `limit` shown items that have a thumb, poster or cover."""
    from utils import albums as album_rules
    rows = conn.execute(
        'SELECT f.id, a.storage_key, a.kind FROM album_files af JOIN files f ON f.id = af.file_id '
        'JOIN albums al ON al.id = af.album_id '
        'JOIN file_hash_assets a ON a.hash_id = f.hash_id AND a.kind = ANY(%s) '
        'WHERE af.album_id = %s AND ' + album_rules.SHOWN_SQL + ' ORDER BY af.position, af.file_id',
        (list(COLLAGE_SOURCES), album_id)).fetchall()
    best = {}
    order = []
    for file_id, key, name in rows:
        if file_id not in best:
            order.append(file_id)
            best[file_id] = (key, name)
        elif COLLAGE_SOURCES.index(name) < COLLAGE_SOURCES.index(best[file_id][1]):
            best[file_id] = (key, name)
    return [best[f][0] for f in order[:limit]]


def tiles(count):
    """(x, y, w, h) boxes: 1 fills, 2 side by side, 3 one big plus two stacked, 4 a 2x2 grid."""
    w, h = COLLAGE_SIZE
    half_w, half_h = w // 2, h // 2
    if count == 1:
        return [(0, 0, w, h)]
    if count == 2:
        return [(0, 0, half_w, h), (half_w, 0, w - half_w, h)]
    if count == 3:
        return [(0, 0, half_w, h), (half_w, 0, w - half_w, half_h), (half_w, half_h, w - half_w, h - half_h)]
    return [(0, 0, half_w, half_h), (half_w, 0, w - half_w, half_h), (0, half_h, half_w, h - half_h),
            (half_w, half_h, w - half_w, h - half_h)]


def render_collage(images):
    from PIL import Image, ImageOps
    canvas = Image.new('RGB', COLLAGE_SIZE, (17, 17, 17))
    for image, (x, y, w, h) in zip(images, tiles(len(images))):
        tile = ImageOps.fit(image.convert('RGB'), (w, h), Image.Resampling.LANCZOS)
        canvas.paste(tile, (x, y))
    out = io.BytesIO()
    canvas.save(out, 'WEBP', quality=82, method=4)
    return out.getvalue()


def album_collage(album_id, client=None):
    from PIL import Image
    client = client or s3()
    with db.connect() as conn:
        album = conn.execute('SELECT collage_key, collage_version FROM albums WHERE id = %s AND deleted_at IS NULL',
                             (album_id,)).fetchone()
        if album is None:
            return None
        keys = collage_sources(conn, album_id)
    old_key, old_version = album
    images = []
    for key in keys:
        body = client.get_object(Bucket=bucket(), Key=key)['Body'].read()
        image = Image.open(io.BytesIO(body))
        image.load()
        images.append(image)
    new_key = version = None
    if images:
        version = max(int(time.time()), (old_version or 0) + 1)
        new_key = collage_key(album_id, version)
        client.put_object(Bucket=bucket(), Key=new_key, Body=render_collage(images), ContentType='image/webp')
    with db.connect() as conn:
        conn.execute('UPDATE albums SET collage_key = %s, collage_version = %s WHERE id = %s',
                     (new_key, version, album_id))
    if old_key and old_key != new_key:
        _delete_quietly(client, old_key)
    return new_key


@register('album_collage')
def album_collage_job(payload, job):
    album_collage(int(payload['album_id']))
