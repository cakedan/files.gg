"""Milestone 3 media processing (contract milestone-3 §2-§5): probe and derive on real
media made with ffmpeg and Pillow, the sandbox, failures, and blob garbage collection."""

import json
import os
import socket
import subprocess
import threading
import time
import uuid

import pytest

from tests.conftest import assert_unsigned, s3_keys, s3_object, hash_of
from tests.m3 import (  # noqa: F401  (fixtures)
    ORIGIN, anonymous, appdb, gif, heic, hevc_mkv, image_size, jpeg_rotated, lookup, media_db, mp3, mp4, new_user,
    pdf, png, process, send, state_of,
)


def owner_view(client, headers, created):
    """The owner file (with media.snippet and albums) from the library list."""
    items = client.get('/users/@me/files?limit=100', headers=headers).json()['items']
    return next(item for item in items if item['id'] == created['id'])


PREVIEW_EXTENSIONS = {'peaks': 'json', 'hover': 'mp4'}


def assert_asset_urls(created, body, hash_row):
    version = int(hash_row[0].timestamp())
    for kind, entry in body['assets'].items():
        extension = PREVIEW_EXTENSIONS.get(kind, 'webp')
        # /previews/<kind>/<vanity>.<ext>?v=<derived_at>: by vanity, never by id; plain for a link file
        assert entry['url'] == 'https://cdn.files.gg/previews/{}/{}.{}?v={}'.format(
            kind, created['vanity'], extension, version)
        assert_unsigned(entry['url'])


def derived_at(db, hash_id):
    return db.fetchone('SELECT derived_at FROM file_hashes WHERE id = %s', (hash_id,))


# --- images ----------------------------------------------------------------------------------------

def test_png_gets_thumbs_and_media(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, png(800, 600), 'big.png', 'image/png')
    hash_id = int(hash_of(media_db, created))
    # queued for the new hash, on the media queue, with 3 attempts
    jobs_rows = media_db.fetchall("SELECT kind, queue, max_attempts FROM jobs WHERE kind = 'probe' "
                                  "AND payload->>'hash_id' = %s", (str(hash_id),))
    assert jobs_rows == [('probe', 'media', 3)]
    before = lookup(client, created)['file']
    assert before['processing'] is True and before['assets'] == {} and 'thumbnail' not in before
    assert before['nsfw'] is False

    process(media_db, created)
    assert state_of(media_db, hash_id) == 'done'
    body = lookup(client, created)
    item = body['file']
    assert item['processing'] is False and item['kind'] == 'image'
    assert item['media'] == {'width': 800, 'height': 600, 'has_alpha': True, 'container': 'png'}
    assert (item['width'], item['height']) == (800, 600)
    assert item['assets']['thumb']['width'] == 320 and item['assets']['thumb']['height'] == 240
    assert (item['assets']['thumb-2x']['width'], item['assets']['thumb-2x']['height']) == (640, 480)
    assert set(item['assets']) == {'thumb', 'thumb-2x'}
    assert item['thumbnail'] == dict(item['assets']['thumb'], type='thumb')
    assert 'hover_url' not in item
    assert_asset_urls(created, item, derived_at(media_db, hash_id))
    # the internal lookup lists the keys by kind, and the objects are real webp
    assert body['previews_version'] == int(derived_at(media_db, hash_id)[0].timestamp())
    assert set(body['previews']) == {'thumb', 'thumb-2x'}
    assert body['previews']['thumb']['key'] == 'derived/{}/thumb.webp'.format(hash_id)
    assert body['previews']['thumb-2x']['key'] == 'derived/{}/thumb-2x.webp'.format(hash_id)
    assert body['previews']['thumb']['content_type'] == 'image/webp'
    data = s3_object('derived/{}/thumb.webp'.format(hash_id))
    assert len(data) == body['previews']['thumb']['size']
    assert image_size(data)[:2] == ((320, 240), 'WEBP')
    rows = media_db.fetchall('SELECT kind, storage_key, width, height FROM file_hash_assets WHERE hash_id = %s',
                             (hash_id,))
    assert sorted(rows) == [('thumb', 'derived/{}/thumb.webp'.format(hash_id), 320, 240),
                            ('thumb-2x', 'derived/{}/thumb-2x.webp'.format(hash_id), 640, 480)]


def test_small_image_needs_no_thumb(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, png(100, 80), 'small.png', 'image/png')
    hash_id = process(media_db, created)
    item = lookup(client, created)['file']
    assert state_of(media_db, hash_id) == 'done'
    assert item['assets'] == {} and 'thumbnail' not in item and item['processing'] is False
    assert (item['width'], item['height']) == (100, 80)


def test_exif_orientation_swaps_dimensions(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, jpeg_rotated(400, 200), 'photo.jpg', 'image/jpeg')
    process(media_db, created)
    item = lookup(client, created)['file']
    assert (item['media']['width'], item['media']['height']) == (200, 400)
    # the thumb is upright too
    assert (item['assets']['thumb']['width'], item['assets']['thumb']['height']) == (160, 320)


def test_heic_gets_a_display_preview_and_becomes_an_image(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, heic(1000, 500), 'photo.heic', 'image/heic')
    assert lookup(client, created)['file']['kind'] == 'file'  # no display preview yet
    process(media_db, created)
    item = lookup(client, created)['file']
    assert item['kind'] == 'image'
    assert item['media']['width'] == 1000 and item['media']['height'] == 500
    assert set(item['assets']) == {'display', 'thumb', 'thumb-2x'}
    assert (item['assets']['display']['width'], item['assets']['display']['height']) == (1000, 500)
    assert item['assets']['display']['url'].startswith(
        'https://cdn.files.gg/previews/display/{}.webp?v='.format(created['vanity']))
    assert item['thumbnail']['type'] == 'thumb'
    # the original is still what's downloaded
    assert item['cdn_url'].endswith('.heic')


def test_animated_gif_gets_first_frame_thumbs_and_a_hover_clip(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, gif(frames=3, duration=100), 'anim.gif', 'image/gif')
    hash_id = process(media_db, created)
    item = lookup(client, created)['file']
    assert item['media']['framecount'] == 3 and item['media']['duration'] == 300 and item['media']['loop'] == 0
    assert item['framecount'] == 3 and item['duration'] == 300
    assert set(item['assets']) == {'thumb', 'thumb-2x', 'hover'}
    assert item['hover_url'] == item['assets']['hover']['url'] and 'width' not in item['assets']['hover']
    clip = s3_object('derived/{}/hover.mp4'.format(hash_id))
    info = ffprobe_bytes(clip)
    stream = info['streams'][0]
    assert stream['codec_name'] == 'h264' and stream['pix_fmt'] == 'yuv420p'
    assert stream['width'] <= 480 and stream['height'] <= 480 and len(info['streams']) == 1  # muted
    assert float(info['format']['duration']) <= 3.05


def ffprobe_bytes(data):
    import tempfile
    with tempfile.NamedTemporaryFile(suffix='.mp4') as handle:
        handle.write(data)
        handle.flush()
        out = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
                              handle.name], capture_output=True, check=True).stdout
    return json.loads(out)


# --- video and audio --------------------------------------------------------------------------------------

def test_h264_mp4(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, mp4(seconds=2), 'clip.mp4', 'video/mp4')
    hash_id = process(media_db, created)
    item = lookup(client, created)['file']
    media = item['media']
    assert (media['width'], media['height']) == (640, 360)
    assert abs(media['duration'] - 2000) < 150 and media['fps'] == 25
    assert media['codecs'] == ['h264', 'aac'] and media['container'] == 'mp4'
    assert media['playable'] is True and media['has_audio'] is True
    assert media['sample_rate'] == 44100 and media['channels'] == 1 and media['bitrate'] > 0
    assert item['duration'] == media['duration'] and item['kind'] == 'video'
    assert set(item['assets']) == {'poster', 'thumb', 'thumb-2x', 'hover'}
    assert (item['assets']['poster']['width'], item['assets']['poster']['height']) == (640, 360)
    assert item['thumbnail'] == dict(item['assets']['poster'], type='poster')
    assert item['hover_url'] == 'https://cdn.files.gg/previews/hover/{}.mp4?v={}'.format(
        created['vanity'], int(derived_at(media_db, hash_id)[0].timestamp()))
    clip = ffprobe_bytes(s3_object('derived/{}/hover.mp4'.format(hash_id)))
    assert [s['codec_type'] for s in clip['streams']] == ['video']
    assert clip['streams'][0]['width'] == 480 and clip['streams'][0]['height'] == 270


def test_hevc_in_mkv_is_not_playable(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, hevc_mkv(), 'clip.mkv', 'video/x-matroska')
    process(media_db, created)
    media = lookup(client, created)['file']['media']
    assert media['playable'] is False and media['container'] == 'mkv'
    assert media['codecs'] == ['hevc', 'opus']


def test_mp3_with_cover_art(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, mp3(art=True, title='  A  Title ', artist='Someone'), 'song.mp3', 'audio/mpeg')
    hash_id = process(media_db, created)
    item = lookup(client, created)['file']
    media = item['media']
    assert media['tags'] == {'title': 'A Title', 'artist': 'Someone', 'album': 'Record', 'track': 3}
    assert media['playable'] is True and media['container'] == 'mp3' and media['codecs'] == ['mp3']
    assert 'width' not in media and abs(media['duration'] - 2000) < 200
    assert set(item['assets']) == {'cover', 'peaks'}
    assert (item['assets']['cover']['width'], item['assets']['cover']['height']) == (500, 500)
    assert item['thumbnail']['type'] == 'cover'
    peaks = json.loads(s3_object('derived/{}/peaks.json'.format(hash_id)))
    assert peaks['version'] == 1 and peaks['length'] == 1000 and len(peaks['peaks']) == 1000
    assert all(0 <= p <= 1 for p in peaks['peaks']) and max(peaks['peaks']) == 1
    assert all(round(p, 3) == p for p in peaks['peaks'])


def test_mp3_without_art_gets_a_waveform(client, media_db):
    from PIL import Image
    import io
    _, headers = new_user(media_db)
    created = send(client, headers, mp3(art=False), 'tone.mp3', 'audio/mpeg')
    hash_id = process(media_db, created)
    item = lookup(client, created)['file']
    assert set(item['assets']) == {'waveform', 'peaks'}
    assert item['thumbnail']['type'] == 'waveform'
    assert (item['assets']['waveform']['width'], item['assets']['waveform']['height']) == (1600, 240)
    with Image.open(io.BytesIO(s3_object('derived/{}/waveform.webp'.format(hash_id)))) as image:
        image = image.convert('RGBA')
        assert image.size == (1600, 240)
        assert image.getpixel((0, 0))[3] == 0  # transparent
        assert image.getpixel((800, 120)) == (0x3D, 0xEB, 0x7E, 255)  # brand green


def test_pdf(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, pdf(pages=2), 'doc.pdf', 'application/pdf')
    process(media_db, created)
    item = lookup(client, created)['file']
    assert item['media'] == {'pages': 2, 'page_width': 612, 'page_height': 792}
    assert set(item['assets']) == {'thumb', 'thumb-2x'}
    assert item['assets']['thumb-2x']['height'] == 640 and item['assets']['thumb']['height'] == 320


def test_text_has_lines_language_and_an_owner_only_snippet(client, media_db):
    _, headers = new_user(media_db)
    source = ''.join('line_{} = {}\n'.format(i, i) for i in range(40)) + 'tail = "é"'
    created = send(client, headers, source.encode(), 'script.py', 'text/x-python')
    hash_id = process(media_db, created)
    assert state_of(media_db, hash_id) == 'done'
    item = lookup(client, created)['file']
    assert item['media'] == {'lines': 41, 'language': 'python'} and item['assets'] == {}
    owner = owner_view(client, headers, created)
    snippet = owner['media']['snippet']
    assert snippet == ''.join('line_{} = {}\n'.format(i, i) for i in range(12)).rstrip('\n')
    assert len(snippet.encode()) <= 1024


def test_other_types_are_skipped(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, uuid.uuid4().bytes * 10, 'data.zip', 'application/zip')
    hash_id = process(media_db, created)
    assert state_of(media_db, hash_id) == 'skipped'
    item = lookup(client, created)['file']
    assert item['processing'] is False and item['media'] == {} and item['assets'] == {}
    # derive was never queued
    assert media_db.fetchone("SELECT count(*) FROM jobs WHERE kind = 'derive' AND payload->>'hash_id' = %s",
                             (str(hash_id),))[0] == 0


# --- queueing --------------------------------------------------------------------------------------------

def test_probe_is_queued_once_per_hash(client, media_db):
    _, headers = new_user(media_db)
    content = png(400, 400)
    first = send(client, headers, content, 'a.png', 'image/png')
    hash_id = hash_of(media_db, first)
    process(media_db, first)
    second = send(client, headers, content, 'b.png', 'image/png')  # de-duplicated: nothing more queued
    assert hash_of(media_db, second) == hash_id
    assert media_db.fetchone("SELECT count(*) FROM jobs WHERE kind = 'probe' AND payload->>'hash_id' = %s",
                             (hash_id,))[0] == 1
    assert media_db.fetchone("SELECT count(*) FROM jobs WHERE kind = 'derive' AND payload->>'hash_id' = %s",
                             (hash_id,))[0] == 1
    # the duplicate shows the same processed assets, under its own id
    item = lookup(client, second)['file']
    assert item['assets']['thumb']['url'].startswith(
        'https://cdn.files.gg/previews/thumb/{}.webp?v='.format(second['vanity']))


def test_chunked_upload_queues_probe(client, media_db, monkeypatch):
    from jobs.finalize import finalize
    monkeypatch.setenv('UPLOAD_CHUNK_SIZE', str(5 * 1024 * 1024))
    _, headers = new_user(media_db)
    data = png(300, 300)
    session = client.post('/uploads', headers=headers, json={'filename': 'c.png', 'size': len(data),
                                                             'mimetype': 'image/png'}).json()
    client.request('PUT', '/uploads/{}/chunks/0'.format(session['upload_id']), headers=headers, content=data)
    client.post('/uploads/{}/complete'.format(session['upload_id']), headers=headers)
    file_id = finalize(int(session['upload_id']))
    hash_id = media_db.fetchone('SELECT hash_id FROM files WHERE id = %s', (file_id,))[0]
    assert media_db.fetchone("SELECT count(*) FROM jobs WHERE kind = 'probe' AND queue = 'media' "
                             "AND payload->>'hash_id' = %s", (str(hash_id),))[0] == 1


def test_the_worker_runs_media_jobs_from_the_media_queue(client, media_db):
    import jobs
    import jobs.tasks  # noqa: F401  registers the handlers
    _, headers = new_user(media_db)
    created = send(client, headers, png(500, 500), 'w.png', 'image/png')
    hash_id = hash_of(media_db, created)
    # only this hash's jobs, so other tests' queued jobs stay put
    media_db.execute("UPDATE jobs SET run_at = now() + interval '1 hour' WHERE queue = 'media' "
                     "AND done_at IS NULL AND payload->>'hash_id' IS DISTINCT FROM %s", (hash_id,))
    try:
        assert jobs.run_next('w', queues=['default'], kinds=['probe']) is None  # not on the default queue
        assert jobs.run_next('w', queues=['media'], kinds=['probe']) == 'done'
        assert jobs.run_next('w', queues=['media'], kinds=['derive']) == 'done'
    finally:
        media_db.execute("UPDATE jobs SET run_at = now() WHERE queue = 'media' AND done_at IS NULL")
    assert state_of(media_db, int(hash_id)) == 'done'


# --- failures and the sandbox ----------------------------------------------------------------------------

def test_corrupt_file_fails_and_still_serves(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, b'\x89PNG\r\n\x1a\n' + uuid.uuid4().bytes * 50, 'broken.png', 'image/png')
    hash_id = process(media_db, created)
    assert state_of(media_db, hash_id) == 'failed'
    body = lookup(client, created)
    assert body['file']['processing'] is False and body['file']['assets'] == {} and body['previews'] == {}
    assert body['previews_version'] is None
    assert body['file']['kind'] == 'image' and 'thumbnail' not in body['file']
    assert client.get('/files/' + created['vanity']).status_code == 200
    assert media_db.fetchone('SELECT media FROM file_hashes WHERE id = %s', (hash_id,))[0] is None


def test_corrupt_video_fails(client, media_db):
    _, headers = new_user(media_db)
    created = send(client, headers, uuid.uuid4().bytes * 300, 'junk.mp4', 'video/mp4')
    hash_id = process(media_db, created)
    assert state_of(media_db, hash_id) == 'failed'


def test_a_playlist_cannot_make_ffmpeg_fetch_anything(client, media_db):
    """An HLS playlist uploaded as a video points at a local listener: nothing may connect."""
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(5)
    listener.settimeout(0.2)
    port = listener.getsockname()[1]
    connections = []
    stop = threading.Event()

    def accept():
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
                connections.append(conn)
            except OSError:
                pass

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    try:
        playlist = ('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:{0}/a.ts\n'
                    '#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n# {1}\n').format(port, uuid.uuid4())
        _, headers = new_user(media_db)
        created = send(client, headers, playlist.encode(), 'stream.mp4', 'video/mp4')
        hash_id = process(media_db, created)
        time.sleep(0.5)
    finally:
        stop.set()
        thread.join()
        listener.close()
    assert connections == []
    assert state_of(media_db, hash_id) == 'failed'


def test_ffmpeg_refuses_network_protocols_and_playlists():
    import tempfile
    from media import sandbox
    with tempfile.TemporaryDirectory() as tmp:
        concat = os.path.join(tmp, 'list.txt')
        with open(concat, 'w') as handle:
            handle.write("ffconcat version 1.0\nfile '/etc/passwd'\n")
        with pytest.raises(sandbox.Failed) as error:
            sandbox.run(sandbox.ffprobe_cmd(concat), timeout=20, cpu_seconds=15)
        assert b'not on whitelist' in error.value.stderr or b'Invalid data' in error.value.stderr
        with pytest.raises(sandbox.Failed) as error:
            sandbox.run(['ffmpeg', '-nostdin', '-hide_banner', *sandbox.FFMPEG_SAFETY, '-i', 'http://127.0.0.1:9/x.mp4',
                         '-f', 'null', '-'], timeout=20, cpu_seconds=15)
        assert b'not on whitelist' in error.value.stderr


def test_sandbox_limits_and_environment(monkeypatch):
    import sys
    from media import sandbox
    monkeypatch.setenv('S3_SECRET_ACCESS_KEY', 'should-not-leak')
    script = ('import json, os, resource; print(json.dumps({"as": resource.getrlimit(resource.RLIMIT_AS)[0], '
              '"cpu": resource.getrlimit(resource.RLIMIT_CPU)[0], "core": resource.getrlimit(resource.RLIMIT_CORE)[0], '
              '"env": sorted(os.environ)}))')
    out = json.loads(sandbox.run([sys.executable, '-c', script], timeout=20, cpu_seconds=15))
    assert out['as'] == int(1.5 * 1024 ** 3) and out['cpu'] == 15 and out['core'] == 0
    assert not any('S3' in name or 'DATABASE' in name or 'SECRET' in name for name in out['env'])
    # the wall-clock timeout kills the whole process group
    start = time.monotonic()
    with pytest.raises(sandbox.Timeout):
        sandbox.run([sys.executable, '-c', 'import subprocess; subprocess.run(["sleep", "30"])'], timeout=1,
                    cpu_seconds=15)
    assert time.monotonic() - start < 10
    # the CPU limit
    with pytest.raises(sandbox.Timeout):
        sandbox.run([sys.executable, '-c', 'while True: pass'], timeout=20, cpu_seconds=1)


def test_decompression_bombs_fail(client, media_db):
    from PIL import Image
    import io
    image = Image.new('1', (20000, 20000))  # 400 MP: over Pillow's 2x bomb limit (~179 MP)
    out = io.BytesIO()
    image.save(out, 'PNG', optimize=True)
    _, headers = new_user(media_db)
    created = send(client, headers, out.getvalue(), 'bomb.png', 'image/png')
    hash_id = process(media_db, created)
    assert state_of(media_db, hash_id) == 'failed'


def test_transient_errors_retry_and_fail_on_the_last_attempt(client, media_db, monkeypatch):
    from jobs import media as media_jobs
    from jobs.queue import Job
    _, headers = new_user(media_db)
    created = send(client, headers, png(400, 300), 'x.png', 'image/png')
    hash_id = int(hash_of(media_db, created))

    def broken(*args, **kwargs):
        raise RuntimeError('storage is down')

    monkeypatch.setattr(media_jobs.Workspace, 'download', broken)
    with pytest.raises(RuntimeError):
        media_jobs.probe(hash_id, Job(1, 'probe', {}, 1, 3, None))
    assert state_of(media_db, hash_id) == 'pending'  # retried later, nothing recorded
    with pytest.raises(RuntimeError):
        media_jobs.probe(hash_id, Job(1, 'probe', {}, 3, 3, None))
    assert state_of(media_db, hash_id) == 'failed'


# --- blob garbage collection -------------------------------------------------------------------------------

def test_delete_queues_gc_which_removes_blob_and_derived_media(client, media_db, monkeypatch):
    from jobs import gc
    _, headers = new_user(media_db)
    content = png(700, 700)
    created = send(client, headers, content, 'gc.png', 'image/png')
    other = send(client, headers, content, 'gc2.png', 'image/png')  # same blob
    hash_id = process(media_db, created)
    assert s3_keys('derived/{}/'.format(hash_id)) != []

    assert client.request('DELETE', '/users/@me/files/' + created['id'], headers=headers).status_code == 204
    # another live file still uses the blob: nothing queued
    assert media_db.fetchone("SELECT count(*) FROM jobs WHERE kind = 'delete_blob' AND payload->>'hash_id' = %s",
                             (str(hash_id),))[0] == 0
    assert client.request('DELETE', '/users/@me/files/' + other['id'], headers=headers).status_code == 204
    run_at = media_db.fetchone("SELECT extract(epoch FROM run_at - now()) FROM jobs WHERE kind = 'delete_blob' "
                               "AND payload->>'hash_id' = %s", (str(hash_id),))[0]
    assert 48 * 3600 - 60 < float(run_at) <= 48 * 3600  # BLOB_GC_GRACE

    assert gc.delete_blob(hash_id) == 'deleted'
    assert s3_object('files/{}'.format(hash_id)) is None
    assert s3_keys('derived/{}/'.format(hash_id)) == []
    assert media_db.fetchone('SELECT count(*) FROM file_hash_assets WHERE hash_id = %s', (hash_id,))[0] == 0
    assert media_db.fetchone('SELECT count(*) FROM file_hashes WHERE id = %s', (hash_id,))[0] == 0
    assert media_db.fetchone('SELECT count(*) FROM files WHERE hash_id = %s', (hash_id,))[0] == 0
    assert gc.delete_blob(hash_id) is None  # a duplicate job: nothing to do


def test_gc_keeps_a_blob_that_is_live_again(client, media_db):
    from jobs import gc
    _, headers = new_user(media_db)
    content = png(330, 330)
    created = send(client, headers, content, 'k.png', 'image/png')
    hash_id = int(hash_of(media_db, created))
    client.request('DELETE', '/users/@me/files/' + created['id'], headers=headers)
    send(client, headers, content, 'again.png', 'image/png')  # uploaded again before the grace period ends
    assert gc.delete_blob(hash_id) == 'kept'
    assert s3_object('files/{}'.format(hash_id)) == content


def test_expiry_reaper_queues_gc_for_expired_files(client, media_db):
    from jobs import tasks
    _, headers = new_user(media_db)
    created = send(client, headers, png(50, 50), 'e.png', 'image/png', expires_in=3600)
    hash_id = hash_of(media_db, created)
    media_db.execute("UPDATE files SET expires_at = now() - interval '1 second' WHERE id = %s", (int(created['id']),))
    tasks.reap_expired(media_db.conn)
    assert media_db.fetchone("SELECT count(*) FROM jobs WHERE kind = 'delete_blob' AND payload->>'hash_id' = %s",
                             (hash_id,))[0] == 1
