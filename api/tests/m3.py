"""Helpers for the Milestone 3 tests: real media made with ffmpeg and Pillow, uploads
with their mimetypes, and running probe / derive the way the worker does."""

import io
import os
import subprocess
import tempfile
import uuid

import pytest

from tests.conftest import TempDatabase, APP_DATABASE, hash_of
from tests.test_milestone2 import ORIGIN, anonymous, new_user  # noqa: F401  (re-exported)

@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


@pytest.fixture
def media_db(appdb):
    """The app's database; every mimetype the media tests upload comes from the migrations' seed."""
    return appdb


def send(client, headers, content, name, mimetype, status=200, **fields):
    data = {k: str(v) for k, v in fields.items()}
    response = client.post('/files', headers=headers, files={'file': (name, content, mimetype)}, data=data)
    assert response.status_code == status, response.text
    return response.json()


def process(db, created):
    """probe then derive the file's hash, as the media worker would. Returns the hash id."""
    from jobs import media as media_jobs
    hash_id = int(hash_of(db, created))
    media_jobs.probe(hash_id)
    media_jobs.derive(hash_id)
    return hash_id


def state_of(db, hash_id):
    return db.fetchone('SELECT processing_state FROM file_hashes WHERE id = %s', (hash_id,))[0]


def lookup(client, created):
    response = client.get('/internal/files/' + created['vanity'], headers=ORIGIN)
    assert response.status_code == 200, response.text
    return response.json()


# --- media ------------------------------------------------------------------------------------------

def ffmpeg(*args):
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, 'out.' + args[-1])
        subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', *args[:-1], out],
                       check=True, timeout=60)
        with open(out, 'rb') as handle:
            return handle.read()


def unique_tone():
    """A sine frequency per call, so generated media never de-duplicates across tests."""
    return 200 + uuid.uuid4().int % 2000


def png(width, height, mode='RGBA', color=None):
    from PIL import Image, ImageDraw
    color = color or tuple(uuid.uuid4().bytes[:3]) + ((128,) if mode == 'RGBA' else ())
    image = Image.new(mode, (width, height), color)
    ImageDraw.Draw(image).rectangle([width // 4, height // 4, width // 2, height // 2], fill=(255, 0, 0, 255)[:len(mode)])
    out = io.BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


def jpeg_rotated(width, height, orientation=6):
    from PIL import Image
    image = Image.new('RGB', (width, height), tuple(uuid.uuid4().bytes[:3]))
    exif = Image.Exif()
    exif[0x0112] = orientation
    out = io.BytesIO()
    image.save(out, 'JPEG', exif=exif.tobytes())
    return out.getvalue()


def heic(width, height):
    from PIL import Image
    import pillow_heif
    pillow_heif.register_heif_opener()
    image = Image.new('RGB', (width, height), tuple(uuid.uuid4().bytes[:3]))
    out = io.BytesIO()
    image.save(out, 'HEIF', quality=60)
    return out.getvalue()


def gif(frames=3, size=(200, 150), duration=100):
    from PIL import Image
    seed = uuid.uuid4().bytes
    images = [Image.new('RGB', size, (seed[i % 16], (i * 80) % 256, 50)) for i in range(frames)]
    out = io.BytesIO()
    images[0].save(out, 'GIF', save_all=True, append_images=images[1:], duration=duration, loop=0)
    return out.getvalue()


def mp4(seconds=2, size='640x360'):
    return ffmpeg('-f', 'lavfi', '-i', 'testsrc=size={}:rate=25'.format(size), '-f', 'lavfi', '-i',
                  'sine=frequency={}'.format(unique_tone()), '-t', str(seconds), '-c:v', 'libx264', '-pix_fmt',
                  'yuv420p', '-c:a', 'aac', '-shortest', 'mp4')


def hevc_mkv(seconds=1):
    return ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-f', 'lavfi', '-i',
                  'sine=frequency={}'.format(unique_tone()), '-t', str(seconds), '-c:v', 'libx265', '-preset',
                  'ultrafast', '-x265-params', 'log-level=error', '-c:a', 'libopus', '-shortest', 'mkv')


def mp3(seconds=2, art=False, title='Song', artist='Artist'):
    tone = ['-f', 'lavfi', '-i', 'sine=frequency={}:duration={}'.format(unique_tone(), seconds)]
    meta = ['-metadata', 'title=' + title, '-metadata', 'artist=' + artist, '-metadata', 'album=Record',
            '-metadata', 'track=3/10']
    if not art:
        return ffmpeg(*tone, '-c:a', 'libmp3lame', *meta, 'mp3')
    with tempfile.TemporaryDirectory() as tmp:
        cover = os.path.join(tmp, 'cover.png')
        with open(cover, 'wb') as handle:
            handle.write(png(500, 500, 'RGB'))
        return ffmpeg(*tone, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'png',
                      '-disposition:v', 'attached_pic', '-id3v2_version', '3', *meta, 'mp3')


def pdf(pages=2):
    from PIL import Image
    images = [Image.new('RGB', (612, 792), tuple(uuid.uuid4().bytes[:3])) for _ in range(pages)]
    out = io.BytesIO()
    images[0].save(out, 'PDF', save_all=True, append_images=images[1:], resolution=72)
    return out.getvalue()


def image_size(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        return image.size, image.format, image.mode
