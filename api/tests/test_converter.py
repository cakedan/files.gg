"""The converter (contract milestone-5 §1.2, §4, §15 "Converter"): one conversion per target from the small fixtures
in tests/fixtures/convert, with the real tools of the test image (it's the converter's environment), offline.

`python -m media.convert` runs as a work horse runs it (jobs.convert.run_child); the last tests run
`jobs.convert.run` itself on `conversions` rows, storing the output through the normal path (§4.4)."""

import os
import signal
import subprocess
import sys
import time

import pytest

from PIL import Image

from tests import m5convert
from tests.m5convert import Refusal, child, fixture, mime, pdf_pages, probe


def run_image(tmp_path, source, target, mimetype, **options):
    result = child('image', str(tmp_path / 'out'), {'input': fixture(source), 'mimetype': mimetype,
                                                    'target': target, 'options': options})
    return str(tmp_path / 'out' / result['outputs'][0])


# --- images -------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize('target,expected', [
    ('png', 'image/png'), ('jpg', 'image/jpeg'), ('webp', 'image/webp'), ('avif', 'image/avif'),
    ('gif', 'image/gif'), ('ico', 'image/vnd.microsoft.icon'),
])
def test_image_targets(tmp_path, target, expected):
    from jobs.convert import check_output
    out = run_image(tmp_path, 'sample.png', target, 'image/png', quality=80, background='#000000')
    assert mime(out) == expected
    check_output(out, target)
    with Image.open(out) as image:
        assert image.size == (64, 48)


def test_jpg_metadata_stripped_by_default(tmp_path):
    with Image.open(fixture('gps.jpg')) as source:
        assert 0x8825 in source.getexif()  # the fixture really has a GPS position
    out = run_image(tmp_path, 'gps.jpg', 'jpg', 'image/jpeg', strip_metadata=True)
    with Image.open(out) as image:
        exif = image.getexif()
        assert 0x8825 not in exif and 0x010F not in exif
        assert b'FilesggTestCamera' not in open(out, 'rb').read()


def test_jpg_metadata_kept_when_asked(tmp_path):
    out = run_image(tmp_path, 'gps.jpg', 'webp', 'image/jpeg', strip_metadata=False)
    with Image.open(out) as image:
        exif = image.getexif()
        assert exif.get(0x010F) == 'FilesggTestCamera'
        assert exif.get_ifd(0x8825).get(1) == 'N'


def test_resize_keeps_aspect_and_never_upscales(tmp_path):
    out = run_image(tmp_path, 'sample.png', 'png', 'image/png', max_width=32)
    with Image.open(out) as image:
        assert image.size == (32, 24)
    out = run_image(tmp_path, 'sample.png', 'png', 'image/png', max_width=4000, max_height=4000)
    with Image.open(out) as image:
        assert image.size == (64, 48)


def test_jpg_background(tmp_path):
    out = run_image(tmp_path, 'sample.png', 'jpg', 'image/png', background='#00ff00')
    with Image.open(out) as image:
        assert image.mode == 'RGB'


def test_heic_and_psd(tmp_path):
    out = run_image(tmp_path / 'heic', 'sample.heic', 'png', 'image/heic')
    with Image.open(out) as image:
        assert image.size == (64, 48)
    out = run_image(tmp_path / 'psd', 'sample.psd', 'png', 'image/vnd.adobe.photoshop')
    with Image.open(out) as image:
        assert image.size == (40, 30)
        # the composite: the white square of the fixture
        assert image.convert('RGB').getpixel((15, 10)) == (255, 255, 255)


def test_svg_external_references_and_scripts(tmp_path):
    """resvg renders the SVG at its own size; the absolute-path image (solid red) and the URL aren't loaded, and the
    script does nothing."""
    out = run_image(tmp_path, 'external.svg', 'png', 'image/svg+xml')
    with Image.open(out) as image:
        image = image.convert('RGB')
        assert image.size == (80, 60)
        assert image.getpixel((10, 30)) == (0x20, 0x50, 0xc0)
        assert image.getpixel((60, 30)) == (0x20, 0x50, 0xc0)
    out = run_image(tmp_path / 'capped', 'external.svg', 'png', 'image/svg+xml', max_width=40)
    with Image.open(out) as image:
        assert image.size == (40, 30)


def test_unreadable_image(tmp_path):
    bad = tmp_path / 'bad.png'
    bad.write_bytes(b'\x89PNG\r\n\x1a\nnot really')
    with pytest.raises(Refusal) as refused:
        child('image', str(tmp_path / 'out'), {'input': str(bad), 'mimetype': 'image/png', 'target': 'png',
                                               'options': {}})
    assert refused.value.reason == 'unreadable_source'


# --- animated -------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize('target,expected', [
    ('mp4', 'video/mp4'), ('webm', 'video/webm'), ('webp', 'image/webp'), ('gif', 'image/gif'),
])
def test_animated_targets(tmp_path, target, expected):
    result = child('animated', str(tmp_path), {'input': fixture('animated.gif'), 'target': target,
                                               'options': {'loop': True}, 'media': {'fps': 10}})
    out = str(tmp_path / result['outputs'][0])
    assert mime(out) == expected
    if target in ('mp4', 'webm'):
        stream = probe(out)['streams'][0]
        assert (stream['width'], stream['height']) == (64, 64)
        assert abs(float(probe(out)['format']['duration']) - 1.2) < 0.2
    if target == 'webp':
        with Image.open(out) as image:
            assert image.n_frames > 1


def test_gif_to_mp4_is_smaller(tmp_path):
    from tests import m3
    gif = tmp_path / 'big.gif'
    gif.write_bytes(m3.gif(frames=30, size=(200, 150)))
    result = child('animated', str(tmp_path / 'out'), {'input': str(gif), 'target': 'mp4', 'options': {},
                                                       'media': {}})
    out = tmp_path / 'out' / result['outputs'][0]
    assert out.stat().st_size < gif.stat().st_size


def test_animated_options(tmp_path):
    result = child('animated', str(tmp_path), {'input': fixture('animated.gif'), 'target': 'mp4',
                                               'options': {'fps': 5, 'width': 32, 'trim_start': 0.2, 'trim_end': 1.0},
                                               'media': {}})
    info = probe(str(tmp_path / result['outputs'][0]))
    stream = info['streams'][0]
    assert (stream['width'], stream['height']) == (32, 32)
    assert stream['r_frame_rate'] == '5/1'
    assert abs(float(info['format']['duration']) - 0.8) < 0.25


# --- video and audio ------------------------------------------------------------------------------------------------------

CLIP = {'duration': 3000, 'width': 160, 'height': 120, 'fps': 15}


def run_av(tmp_path, source, kind, target, media=CLIP, progress=None, **options):
    result = child('av', str(tmp_path), {'input': fixture(source), 'kind': kind, 'target': target,
                                         'options': options, 'media': media}, progress=progress)
    return str(tmp_path / result['outputs'][0])


def streams(path):
    info = probe(path)
    return {s['codec_type']: s for s in info['streams']}, info


@pytest.mark.parametrize('target,expected,codec', [
    ('mp4', 'video/mp4', 'h264'), ('webm', 'video/webm', 'vp9'), ('gif', 'image/gif', 'gif'),
    ('mp3', 'audio/mpeg', 'mp3'), ('m4a', 'audio/x-m4a', 'aac'), ('ogg', 'audio/ogg', 'opus'),
    ('wav', 'audio/x-wav', 'pcm_s16le'),
])
def test_video_targets(tmp_path, target, expected, codec):
    from jobs.convert import check_output
    options = {'bitrate': 192} if target in ('mp3', 'm4a', 'ogg') else {}
    out = run_av(tmp_path, 'clip.mp4', 'video', target, **options)
    check_output(out, target)
    assert mime(out) == expected
    found, _ = streams(out)
    first = found.get('video') or found.get('audio')
    assert first['codec_name'] == codec


def test_mp4_copies_aac_and_keeps_size(tmp_path):
    """Decision 15: the clip's AAC goes into the mp4 as it is (its 32 kbps, not a re-encode at 128)."""
    out = run_av(tmp_path, 'clip.mp4', 'video', 'mp4', max_height=1080)
    found, _ = streams(out)
    assert found['audio']['codec_name'] == 'aac'
    assert audio_packets(out) == audio_packets(fixture('clip.mp4'))
    assert (found['video']['width'], found['video']['height']) == (160, 120)  # never upscaled


def audio_packets(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=size',
                          '-of', 'csv=p=0', path], check=True, capture_output=True).stdout.decode()
    return out.split()


def test_m4a_copy_and_reencode(tmp_path):
    """The default bitrate copies the AAC packet for packet; another bitrate re-encodes."""
    source = audio_packets(fixture('clip.mp4'))
    copied = run_av(tmp_path / 'copy', 'clip.mp4', 'video', 'm4a', bitrate=192)
    assert audio_packets(copied) == source
    encoded = run_av(tmp_path / 'encode', 'clip.mp4', 'video', 'm4a', bitrate=128)
    assert audio_packets(encoded) != source


def test_mute_and_height_cap(tmp_path):
    out = run_av(tmp_path, 'clip.mp4', 'video', 'webm', mute=True)
    assert 'audio' not in streams(out)[0]
    result = child('av', str(tmp_path / 'capped'), {'input': fixture('clip.mp4'), 'kind': 'video', 'target': 'mp4',
                                                    'options': {}, 'media': CLIP, 'max_height_cap': 60})
    assert streams(str(tmp_path / 'capped' / result['outputs'][0]))[0]['video']['height'] == 60


def test_trim(tmp_path):
    out = run_av(tmp_path, 'clip.mp4', 'video', 'mp4', trim_start=1.0, trim_end=2.5)
    assert abs(float(streams(out)[1]['format']['duration']) - 1.5) < 0.2


def test_progress_lines(tmp_path):
    progress = []
    run_av(tmp_path, 'clip.mp4', 'video', 'webm', progress=progress)
    assert all(0 <= value <= 1 for value in progress)


def test_target_size_is_never_over_and_close_to_it(tmp_path):
    """Two-pass to a size (§1.2): 2 MB from a noisy 8 s clip is never over it (what "Shrink for Discord" needs), and
    at least 85% of it. x264's two-pass lands about 7% under the bitrate it's given on this clip; the formula already
    aims at 97% of the size for the muxer's overhead. The clip has no audio, so the whole budget is video (a test tone
    would leave the 128 kbps audio reservation unused and measure the AAC encoder instead)."""
    source = tmp_path / 'noisy.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                    'testsrc2=size=480x270:rate=25:duration=8,noise=alls=60:allf=t',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', str(source)], check=True)
    result = child('av', str(tmp_path / 'out'), {'input': str(source), 'kind': 'video', 'target': 'mp4',
                                                 'options': {'target_size': 2},
                                                 'media': {'duration': 8000, 'width': 480, 'height': 270}},
                   wall=120, cpu=120)
    size = (tmp_path / 'out' / result['outputs'][0]).stat().st_size
    target = 2_000_000  # decimal MB (media.formats.MB)
    assert 0.85 * target <= size <= target, size


def _clip(tmp_path, name, noise, crf, seconds=8):
    """A test clip with audio (a tone), noisy or calm, at a given quality."""
    source = tmp_path / name
    video = 'testsrc2=size=480x270:rate=25:duration={}'.format(seconds) + (',noise=alls=60:allf=t' if noise else '')
    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i',
                    'sine=frequency=500:duration={}'.format(seconds), '-c:v', 'libx264', '-preset', 'ultrafast',
                    '-crf', str(crf), '-c:a', 'aac', '-shortest', str(source)], check=True)
    return source


def _to_size(tmp_path, source, size_mb, seconds=8):
    result = child('av', str(tmp_path / 'out'), {'input': str(source), 'kind': 'video', 'target': 'mp4',
                                                 'options': {'target_size': size_mb},
                                                 'media': {'duration': seconds * 1000, 'width': 480, 'height': 270}},
                   wall=180, cpu=180)
    return (tmp_path / 'out' / result['outputs'][0]).stat().st_size


def test_target_size_with_audio_is_never_over(tmp_path):
    """"Shrink for Discord" must fit: with audio (whose budget the formula only estimates) the output still never goes
    over the size, re-encoded smaller once when the first try overshoots."""
    source = _clip(tmp_path, 'noisy.mp4', noise=True, crf=18)
    assert _to_size(tmp_path, source, 2) <= 2_000_000


def test_target_size_never_grows_a_smaller_source(tmp_path):
    """A source already under the size isn't inflated to it ("Shrink for Discord" on a small clip): it stays about its
    own size."""
    source = _clip(tmp_path, 'calm.mp4', noise=False, crf=30)
    before = source.stat().st_size
    assert before < 10_000_000
    after = _to_size(tmp_path, source, 10)
    assert after <= before * 1.2, (before, after)


def test_target_size_too_small(tmp_path):
    with pytest.raises(Refusal) as refused:
        run_av(tmp_path, 'clip.mp4', 'video', 'mp4', media=dict(CLIP, duration=600000), target_size=1)
    assert refused.value.reason == 'target_size_too_small'
    assert refused.value.details['minimum_mb'] > 1


@pytest.mark.parametrize('target,expected', [
    ('mp3', 'audio/mpeg'), ('m4a', 'audio/x-m4a'), ('ogg', 'audio/ogg'), ('flac', 'audio/flac'),
    ('wav', 'audio/x-wav'),
])
def test_audio_targets(tmp_path, target, expected):
    options = {'keep_tags': True}
    if target in ('mp3', 'm4a', 'ogg'):
        options['bitrate'] = 128
    out = run_av(tmp_path, 'tone.wav', 'audio', target, media={'duration': 1000}, **options)
    assert mime(out) == expected
    # mp3 frames are 72 ms at 8 kHz, plus the encoder's delay
    assert abs(float(streams(out)[1]['format']['duration']) - 1.0) < (0.2 if target == 'mp3' else 0.1)


def peak(path):
    out = subprocess.run(['ffmpeg', '-nostdin', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'],
                         capture_output=True).stderr.decode()
    return float(out.split('max_volume:')[1].split('dB')[0])


def test_normalize(tmp_path):
    """Two-pass loudnorm makes the quiet tone louder (to -16 LUFS)."""
    out = run_av(tmp_path, 'tone.wav', 'audio', 'flac', media={'duration': 1000}, normalize=True)
    assert peak(out) > peak(fixture('tone.wav')) + 3
    found, _ = streams(out)
    assert int(found['audio']['sample_rate']) == 8000


def test_audio_copy_rules():
    from media.convert import audio_copies

    class Streams:
        def __init__(self, codec):
            self.audio_codec = codec

    assert audio_copies(Streams('aac'), 'm4a', {'bitrate': 192}, True)
    assert audio_copies(Streams('opus'), 'ogg', {'bitrate': 192}, True)
    assert audio_copies(Streams('mp3'), 'mp3', {}, True)
    assert audio_copies(Streams('aac'), 'mp4', {'trim_start': 1}, False)
    assert not audio_copies(Streams('aac'), 'm4a', {'trim_start': 1}, True)
    assert not audio_copies(Streams('aac'), 'm4a', {'bitrate': 128}, True)
    assert not audio_copies(Streams('mp3'), 'mp3', {'normalize': True}, True)
    assert not audio_copies(Streams('vorbis'), 'ogg', {}, True)
    assert not audio_copies(Streams('aac'), 'mp4', {'target_size': 10}, False)


# --- PDF -> images, images -> PDF ------------------------------------------------------------------------------------------

def test_pdf_pages(tmp_path):
    progress = []
    result = child('pdf_pages', str(tmp_path), {'input': fixture('three-pages.pdf'), 'target': 'png',
                                                'options': {'dpi': 72}, 'name': 'report'}, progress=progress)
    assert result['outputs'] == ['report-p1.png', 'report-p2.png', 'report-p3.png']
    with Image.open(tmp_path / 'report-p2.png') as image:
        assert image.size == (200, 140)
    result = child('pdf_pages', str(tmp_path / 'jpg'), {'input': fixture('three-pages.pdf'), 'target': 'jpg',
                                                        'options': {'dpi': 144, 'pages': '2-3', 'quality': 50},
                                                        'name': 'report'})
    assert result['outputs'] == ['report-p2.jpg', 'report-p3.jpg']
    assert mime(str(tmp_path / 'jpg' / 'report-p3.jpg')) == 'image/jpeg'


def test_images_to_pdf(tmp_path):
    inputs = [{'path': fixture('sample.png'), 'mimetype': 'image/png'},
              {'path': fixture('gps.jpg'), 'mimetype': 'image/jpeg'},
              {'path': fixture('sample.heic'), 'mimetype': 'image/heic'},
              {'path': fixture('external.svg'), 'mimetype': 'image/svg+xml'}]
    result = child('images_pdf', str(tmp_path), {'inputs': inputs, 'options': {'page_size': 'fit'}})
    out = str(tmp_path / result['outputs'][0])
    assert mime(out) == 'application/pdf'
    assert pdf_pages(out) == 4
    result = child('images_pdf', str(tmp_path / 'a4'), {'inputs': inputs[:2],
                                                        'options': {'page_size': 'a4', 'margin_mm': 10}})
    info = subprocess.run(['pdfinfo', str(tmp_path / 'a4' / result['outputs'][0])], capture_output=True,
                          check=True).stdout.decode()
    # A4, turned to the landscape images (auto_orient)
    assert '(A4)' in info


def test_document_info(tmp_path):
    assert child('document_info', str(tmp_path), {'input': fixture('document.docx')}) == {'encrypted': False}
    encrypted = tmp_path / 'encrypted.odt'
    import zipfile
    with zipfile.ZipFile(encrypted, 'w') as archive:
        archive.writestr('mimetype', 'application/vnd.oasis.opendocument.text')
        archive.writestr('META-INF/manifest.xml', '<manifest:file-entry><manifest:encryption-data/>'
                                                  '</manifest:file-entry>')
    assert child('document_info', str(tmp_path), {'input': str(encrypted)}) == {'encrypted': True}


# --- output checks (§4.3) ------------------------------------------------------------------------------------------------

def test_output_checks(tmp_path):
    from jobs.convert import check_output
    from utils.responses import ApiError
    empty = tmp_path / 'empty.png'
    empty.write_bytes(b'')
    elf = tmp_path / 'elf.png'
    elf.write_bytes(b'\x7fELF' + b'\x00' * 200)
    for path, target, reason in ((empty, 'png', 'empty_output'), (tmp_path / 'missing', 'png', 'empty_output'),
                                 (elf, 'png', 'bad_output'), (fixture('sample.png'), 'jpg', 'bad_output'),
                                 (fixture('clip.mp4'), 'webm', 'bad_output')):
        with pytest.raises(ApiError) as error:
            check_output(str(path), target)
        assert error.value.code == 'CONVERSION_FAILED'
        assert error.value.data['reason'] == reason
    check_output(fixture('sample.png'), 'png')


# --- limits: cancel, timeout, CPU ---------------------------------------------------------------------------------------

def slow_gif(tmp_path):
    """Two 1000x1000 frames shown for a minute each: tiny to store, thousands of big frames to encode."""
    frames = [Image.new('RGB', (1000, 1000), colour) for colour in ((200, 30, 30), (30, 30, 200))]
    path = tmp_path / 'slow.gif'
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=60000, loop=0)
    return str(path)


def slow_params(tmp_path):
    return {'input': slow_gif(tmp_path), 'target': 'webm', 'options': {'fps': 60}, 'media': {}}


# a stand-in work horse: runs one media.convert child the way jobs.convert does (nothing from tests/ is imported:
# the test conftest sets up databases at import)
HORSE = '''
import json, os, sys
sys.path.insert(0, {api!r})
from jobs import convert
os.makedirs({out!r}, exist_ok=True)
params = dict({params!r}, budget=299, cpu=300, max_file=2 ** 30)
cmd = [sys.executable, '-s', '-m', 'media.convert', 'animated', {out!r}, json.dumps(params)]
convert.run_child(cmd, 300, 300, {out!r}, 2 ** 30, None, lambda reason, details: RuntimeError(reason))
'''


def processes_with(marker):
    found = []
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open('/proc/{}/cmdline'.format(pid), 'rb') as handle:
                cmdline = handle.read()
            with open('/proc/{}/stat'.format(pid)) as handle:
                state = handle.read().rsplit(')', 1)[1].split()[0]
        except OSError:
            continue
        if marker.encode() in cmdline and state != 'Z':
            found.append(int(pid))
    return found


def test_killed_horse_takes_its_tools(tmp_path):
    """A horse killed alone (the OOM killer, rq's kill) takes the child and its ffmpeg with it: `die_with_parent`."""
    out = str(tmp_path / 'killed-out')
    horse = subprocess.Popen([sys.executable, '-c', HORSE.format(api=m5convert.API_DIR, out=out,
                                                                 params=slow_params(tmp_path))],
                             cwd=m5convert.API_DIR, start_new_session=True)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not any('ffmpeg' in open('/proc/{}/cmdline'.format(p)).read()
                                                  for p in processes_with(out)):
        time.sleep(0.2)
    tools = processes_with(out)
    assert len(tools) >= 2, 'the child and ffmpeg should be running'
    os.kill(horse.pid, signal.SIGKILL)
    horse.wait()
    deadline = time.monotonic() + 10
    while processes_with(out) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert processes_with(out) == []


def test_timeout(tmp_path):
    started = time.monotonic()
    with pytest.raises(Refusal) as refused:
        child('animated', str(tmp_path / 'out'), slow_params(tmp_path), wall=4, cpu=300)
    assert refused.value.reason == 'timeout'
    assert time.monotonic() - started < 15
    assert processes_with(str(tmp_path / 'out')) == []


def test_cpu_budget_runs_out(tmp_path):
    with pytest.raises(Refusal) as refused:
        child('animated', str(tmp_path / 'out'), slow_params(tmp_path), wall=120, cpu=3)
    assert refused.value.reason == 'cpu'


def test_refusals_become_errors():
    """The horse's mapping: running out of the caller's CPU budget is CONVERSION_LIMIT_REACHED (cpu), of the time
    limit CONVERSION_TIMEOUT."""
    from jobs.convert import Budget, Conversion
    row = {'id': 1, 'options': {}, 'output_settings': {}, 'owner_user_id': None, 'queue': 'convert_anonymous'}
    conversion = Conversion(None, row)
    conversion.budget = Budget(120, 30)
    error = conversion.refused('cpu', {})
    assert error.code == 'CONVERSION_LIMIT_REACHED' and error.data['limit'] == 'cpu' and error.data['sign_in']
    conversion.budget = Budget(120, 1000)
    assert conversion.refused('cpu', {}).code == 'CONVERSION_TIMEOUT'
    timeout = conversion.refused('timeout', {})
    assert timeout.code == 'CONVERSION_TIMEOUT' and timeout.data['tier'] == 'member'
    assert conversion.refused('target_size_too_small', {'minimum_mb': 12}).data['minimum_mb'] == 12
    assert conversion.refused('unreadable_source', {}).data['reason'] == 'unreadable_source'
    assert Budget(600, 0).cpu == 5  # at least 5 s (§7.3)


def test_thread_budget(monkeypatch):
    from media import sandbox
    monkeypatch.setenv('CONVERT_THREADS', '3')
    assert sandbox.convert_threads() == 3
    assert sandbox.convert_env()['OMP_NUM_THREADS'] == '3'
    monkeypatch.delenv('CONVERT_THREADS')
    monkeypatch.setenv('CONVERT_PROCESSES', '1000')
    assert sandbox.convert_threads() == 1
    assert sandbox.ffmpeg_cmd('-i', 'x', threads=3)[sandbox.ffmpeg_cmd('-i', 'x', threads=3).index('-threads') + 1] \
        == '3'


# --- jobs.convert.run, end to end (§4.1 step 4, §4.4) ---------------------------------------------------------------------

@pytest.fixture
def stored(client, appdb):
    """Upload a fixture as a user's file, probed; returns (file id, hash id, user id)."""
    from tests.m3 import new_user

    def make(name, user=None):
        user_id, headers = user or new_user(appdb)
        file_id, hash_id = m5convert.upload(client, headers, name)
        m5convert.probe_source(hash_id)
        return file_id, hash_id, user_id
    return make


@pytest.fixture(scope='module')
def appdb():
    from tests.conftest import APP_DATABASE, TempDatabase
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


def run_conversion(appdb, *args, **kwargs):
    from jobs import convert as convert_jobs
    conversion_id = m5convert.insert_conversion(appdb, *args, **kwargs)
    convert_jobs.run(conversion_id)
    return m5convert.conversion(appdb, conversion_id)


def test_run_image(stored, appdb):
    file_id, hash_id, user_id = stored('gps.jpg')
    row = run_conversion(appdb, 'image', 'png', {'strip_metadata': True}, file_id=file_id, hash_id=hash_id,
                         user_id=user_id, name='gps')
    assert row['status'] == 'succeeded', row['error']
    assert row['progress'] == 1 and row['stage'] is None and row['started_at'] is not None
    output = m5convert.output_bytes(appdb, row['id'])
    assert output.startswith(b'\x89PNG')
    name, mimetype, derived = appdb.fetchone('SELECT filename, mimetype_id, derived_from_file_id FROM files '
                                             'WHERE id = %s', (row['output_file_id'],))
    assert (name, mimetype, derived) == ('gps', 'image/png', file_id)


def test_run_skips_cancelled(stored, appdb):
    file_id, hash_id, user_id = stored('sample.png')
    row = run_conversion(appdb, 'image', 'jpg', {}, file_id=file_id, hash_id=hash_id, user_id=user_id,
                         status='cancelled')
    assert row['status'] == 'cancelled' and row['started_at'] is None and row['output_file_id'] is None


def test_run_pdf_pages(stored, appdb):
    file_id, hash_id, user_id = stored('three-pages.pdf')
    row = run_conversion(appdb, 'pdf', 'png', {'dpi': 72}, file_id=file_id, hash_id=hash_id, user_id=user_id,
                         name='three-pages')
    assert row['status'] == 'succeeded', row['error']
    assert appdb.fetchone('SELECT count(*) FROM album_files WHERE album_id = %s', (row['output_album_id'],))[0] == 3


def test_run_images_to_pdf(stored, appdb):
    first = stored('sample.png')
    second = stored('gps.jpg', user=None)
    row = run_conversion(appdb, 'images', 'pdf', {'page_size': 'fit'}, file_id=None, hash_id=first[1],
                         user_id=first[2], sources=[first[:2], second[:2]], name='album')
    assert row['status'] == 'succeeded', row['error']
    assert m5convert.output_bytes(appdb, row['id']).startswith(b'%PDF')


def test_run_unreadable_source_fails(stored, appdb, client):
    from jobs import convert as convert_jobs
    from tests.m3 import new_user
    user_id, headers = new_user(appdb)
    file_id, hash_id = m5convert.upload(client, headers, 'sample.png')
    conversion_id = m5convert.insert_conversion(appdb, 'video', 'mp4', {}, file_id=file_id, hash_id=hash_id,
                                                user_id=user_id)
    from utils.responses import ApiError
    with pytest.raises(ApiError) as error:
        convert_jobs.run(conversion_id)
    assert error.value.code == 'CONVERSION_FAILED' and error.value.data['reason'] == 'unreadable_source'


def test_a_nested_sandbox_only_tightens_its_parents_limits(tmp_path):
    """A tool started inside a sandboxed child asks for the default limits (1 GiB files); under a parent with a
    smaller hard limit (a caller's decimal 1 GB) that must still run, capped at the parent's limit."""
    import subprocess
    import sys

    from media import sandbox
    script = (
        'import resource, subprocess, sys\n'
        'from media import sandbox\n'
        'out = sandbox.run([sys.executable, "-c", "import resource; print(resource.getrlimit(resource.RLIMIT_FSIZE)[1])"],'
        ' timeout=20, cpu_seconds=5)\n'
        'print(out.decode().strip())\n'
    )
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, timeout=30,
                            preexec_fn=sandbox.limiter(10, max_file=1_000_000_000))
    assert result.returncode == 0, result.stderr.decode()
    assert result.stdout.decode().strip() == '1000000000'
