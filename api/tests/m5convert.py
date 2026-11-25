"""Helpers for the converter tests (contract milestone-5 §15): the fixtures, running `python -m media.convert` the
way a work horse does, uploading a source and writing a `conversions` row for it (as POST /conversions would, so
the converter's side is tested on its own), and reading outputs back."""

import json
import os
import subprocess
import sys
import uuid

import magic

from tests.conftest import APP_DATABASE, hash_of, s3_object
from tests.m3 import send
from utils.generators import Snowflake

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'convert')
API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIMETYPES = {
    'sample.png': 'image/png', 'gps.jpg': 'image/jpeg', 'sample.heic': 'image/heic', 'external.svg': 'image/svg+xml',
    'sample.psd': 'image/vnd.adobe.photoshop', 'animated.gif': 'image/gif', 'clip.mp4': 'video/mp4',
    'tone.wav': 'audio/wav', 'three-pages.pdf': 'application/pdf',
    'document.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'remote-image.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'webservice.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'slides.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}


def fixture(name):
    return os.path.join(FIXTURES, name)


def read(name):
    with open(fixture(name), 'rb') as handle:
        return handle.read()


class Refusal(Exception):
    def __init__(self, reason, details):
        super().__init__(reason)
        self.reason = reason
        self.details = details


def child(op, outdir, params, wall=60, cpu=60, progress=None):
    """`python -m media.convert` as jobs.convert runs it; a refusal raises Refusal(reason)."""
    from jobs import convert as convert_jobs
    from media import sandbox
    os.makedirs(outdir, exist_ok=True)
    params = dict(params, budget=wall - 1, cpu=cpu, max_file=sandbox.MAX_OUTPUT_FILE)
    cmd = [sys.executable, '-s', '-m', 'media.convert', op, outdir, json.dumps(params)]

    def on_line(line):
        data = json.loads(line)
        if progress is not None and 'progress' in data:
            progress.append(data['progress'])

    def refused(reason, details):
        return Refusal(reason, details)

    return convert_jobs.run_child(cmd, wall, cpu, outdir, sandbox.MAX_OUTPUT_FILE, on_line, refused)


def mime(path):
    with open(path, 'rb') as handle:
        return magic.from_buffer(handle.read(65536), mime=True)


def mime_bytes(data):
    return magic.from_buffer(data[:65536], mime=True)


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
                         check=True, capture_output=True).stdout
    return json.loads(out)


def pdf_pages(path):
    out = subprocess.run(['pdfinfo', path], check=True, capture_output=True).stdout.decode()
    return int(next(line.split()[-1] for line in out.splitlines() if line.startswith('Pages:')))


# --- sources and conversion rows -----------------------------------------------------------------------------------

def upload(client, headers, name, unique=False):
    """Upload a fixture; returns (file id, hash id). `unique` appends random bytes, so the blob is this upload's
    own (the fixture's hash is shared by every test that uploads it)."""
    from tests.conftest import TempDatabase
    content = read(name) + (uuid.uuid4().bytes if unique else b'')
    created = send(client, headers, content, name, MIMETYPES[name])
    db = TempDatabase(APP_DATABASE)
    try:
        return int(created['id']), int(hash_of(db, created))
    finally:
        db.close()


def probe_source(hash_id):
    """probe the source's hash, as the media worker would, so its `media` is there."""
    from jobs import media as media_jobs
    media_jobs.probe(hash_id)


def insert_conversion(db, kind, target, options=None, file_id=None, hash_id=None, user_id=None, guest_id=None,
                      queue='convert_member', time_limit=120, name='converted', sources=None, status='queued'):
    """A `conversions` row as POST /conversions commits it (§2.1): queued, with its output settings."""
    from media import formats
    conversion_id = Snowflake.generate()
    settings = {'name': name, 'extension': formats.TARGETS[target].extension,
                'mimetype': formats.TARGETS[target].mimetype, 'visibility': 'link'}
    if kind == 'pdf':
        settings['title'] = name
    if user_id is None and guest_id is None:
        guest_id = Snowflake.generate()
    options = options or {}
    db.execute(
        'INSERT INTO conversions (id, owner_user_id, owner_guest_id, source_file_id, source_hash_id, source_kind, '
        'target, options, recipe_hash, status, queue, job_id, queued_at, time_limit, output_settings) VALUES '
        "(%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, now(), %s, %s::jsonb)",
        (conversion_id, user_id, guest_id, file_id, hash_id, kind, target, json.dumps(options),
         formats.recipe_hash(kind, target, options), status, queue, 'conversion:{}'.format(conversion_id),
         time_limit, json.dumps(settings)))
    for position, (source_file, source_hash) in enumerate(sources or ()):
        db.execute('INSERT INTO conversion_sources (conversion_id, position, file_id, hash_id) VALUES (%s, %s, %s, %s)',
                   (conversion_id, position, source_file, source_hash))
    return conversion_id


def conversion(db, conversion_id):
    from utils import conversions
    return conversions.row_dict(db.fetchone(conversions.SELECT + ' WHERE c.id = %s', (conversion_id,)))


def output_bytes(db, conversion_id):
    """The output file's blob."""
    row = db.fetchone('SELECT f.hash_id FROM conversions c JOIN files f ON f.id = c.output_file_id WHERE c.id = %s',
                      (conversion_id,))
    assert row is not None, 'no output file'
    from utils import storage
    return s3_object(storage.blob_key(row[0]))
