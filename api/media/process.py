"""The sandboxed half of media processing:

    python -m media.process probe  <input> <outdir> <hints json>
    python -m media.process derive <input> <outdir> <hints json>
    python -m media.process scan   <input> <outdir> <hints json>   (milestone-4, media/scanning.py)

Started by jobs/media.py through media/sandbox.py (rlimits, wall-clock timeout, no
secrets in the environment). It reads only the local temp file it is given, writes
assets into <outdir>, and prints one JSON object on stdout:

    probe:  {"state": "probed" | "skipped", "media": {...}}
    derive: {"assets": [{"kind", "file", "width"?, "height"?}]}   (kind: a preview kind, contract §3)

Exit status 3 with {"error": "..."} means the file itself is unusable (corrupt, not
what its type says): the job marks the hash `failed` without retrying.
"""

import array
import json
import math
import os
import sys
import time

import media as media_rules
from media import sandbox

UNUSABLE = 3
SNIPPET_LINES = 12
SNIPPET_BYTES = 1024
TAG_LENGTH = 200
THUMB = 320
THUMB_2X = 640
PREVIEW = 4096
POSTER = 1280
COVER = 1200
HOVER = 480
HOVER_MS = 3000
HOVER_FPS = 25
WAVEFORM_SIZE = (1600, 240)
WAVEFORM_COLOR = (0x3D, 0xEB, 0x7E, 255)
PEAKS = 1000
PEAKS_RATE = 4000
MAX_ANIMATION_FRAMES = 5000
TEXT_READ = 1024 * 1024

# the deadline this process works under (the parent kills it at its wall-clock timeout);
# every tool it starts gets what is left
_deadline = None


class Unusable(Exception):
    """The file can't be processed as what it claims to be."""


def remaining():
    return max(1.0, _deadline - time.monotonic()) if _deadline else 60.0


def tool(cmd, cpu, input=None, stdout=None):
    """A tool inside this sandbox: same limits, killed with us (same process group).
    Returns its stdout."""
    return sandbox.run(cmd, timeout=remaining(), cpu_seconds=cpu, input=input, new_session=False,
                       env=sandbox.clean_env())


def pillow():
    from PIL import Image
    import pillow_heif
    pillow_heif.register_heif_opener()
    # the decompression-bomb limit stays on (Image.MAX_IMAGE_PIXELS, an error at 2x)
    return Image


# --- probe ------------------------------------------------------------------------------------

def clean_tag(value):
    if value is None:
        return None
    text = ' '.join(str(value).split()).strip()[:TAG_LENGTH]
    return text or None


def probe_image(path):
    Image = pillow()
    try:
        im = Image.open(path)
        width, height = im.size
        exif = im.getexif()
        orientation = exif.get(0x0112) if exif else None
    except Exception as error:
        raise Unusable('not a readable image: {}'.format(type(error).__name__))
    if orientation in (5, 6, 7, 8):
        width, height = height, width
    data = {
        'width': width,
        'height': height,
        'has_alpha': im.mode in ('RGBA', 'LA', 'PA', 'RGBa', 'La') or 'transparency' in im.info,
        'container': (im.format or '').lower() or None,
    }
    frames = getattr(im, 'n_frames', 1) or 1
    if frames > 1:
        if frames > MAX_ANIMATION_FRAMES:
            raise Unusable('too many frames')
        duration = 0
        for index in range(frames):
            im.seek(index)
            duration += frame_duration(im)
        data['framecount'] = frames
        data['duration'] = duration
        if duration:
            data['fps'] = round(frames * 1000 / duration, 2)
        loop = im.info.get('loop')
        if loop is not None:
            data['loop'] = int(loop)
    return {k: v for k, v in data.items() if v is not None}


def frame_duration(im):
    """A frame's duration in ms, as browsers play it (0 or tiny delays become 100 ms)."""
    try:
        value = int(im.info.get('duration') or 0)
    except (TypeError, ValueError):
        value = 0
    return 100 if value <= 10 else value


def ffprobe(path):
    try:
        out = tool(sandbox.ffprobe_cmd(path), sandbox.PROBE_CPU, stdout=True)
    except sandbox.Failed as error:
        raise Unusable('ffprobe could not read it: {}'.format((error.stderr or b'')[-300:].decode('utf-8', 'replace')))
    info = json.loads(out or b'{}')
    if not info.get('streams'):
        raise Unusable('no audio or video streams')
    return info


def _number(value, cast=float):
    try:
        number = cast(value)
    except (TypeError, ValueError):
        return None
    if isinstance(number, float) and (math.isnan(number) or math.isinf(number)):
        return None
    return number


def _rate(value):
    if not value or value in ('0/0',):
        return None
    if '/' in value:
        num, den = value.split('/', 1)
        num, den = _number(num), _number(den)
        if not num or not den:
            return None
        return num / den
    return _number(value)


def _rotation(stream):
    for item in stream.get('side_data_list') or ():
        if 'rotation' in item:
            return _number(item['rotation'], int) or 0
    return _number((stream.get('tags') or {}).get('rotate'), int) or 0


def container_of(info, extension, has_video):
    names = set((info.get('format', {}).get('format_name') or '').split(','))
    extension = (extension or '').lower()
    tags = {k.lower(): v for k, v in (info.get('format', {}).get('tags') or {}).items()}
    if 'mov' in names or 'mp4' in names:
        brand = (tags.get('major_brand') or '').strip().lower()
        if brand.startswith('qt') or extension == 'mov':
            return 'mov'
        if not has_video and (extension == 'm4a' or brand.startswith('m4a')):
            return 'm4a'
        return 'mp4'
    if 'matroska' in names or 'webm' in names:
        return 'webm' if extension == 'webm' else 'mkv'
    for name in ('ogg', 'mp3', 'wav', 'flac', 'aac', 'avi', 'flv', 'mpegts', 'asf', 'aiff', 'ape', 'caf', 'amr',
                 'wv', 'w64', 'opus'):
        if name in names:
            return 'wma' if name == 'asf' and not has_video and extension == 'wma' else name
    return sorted(names)[0] if names and names != {''} else None


VIDEO_CONTAINERS = ('mp4', 'mov', 'webm')
VIDEO_CODECS = ('h264', 'vp8', 'vp9', 'av1')
AUDIO_CODECS = ('aac', 'mp3', 'opus', 'vorbis', 'flac')


def playable(container, video_codecs, audio_codecs):
    """Contract §2: plays in current Chrome, Firefox and Safari."""
    if video_codecs:
        return (container in VIDEO_CONTAINERS and all(c in VIDEO_CODECS for c in video_codecs)
                and all(c in AUDIO_CODECS for c in audio_codecs))
    if len(audio_codecs) != 1:
        return False
    codec = audio_codecs[0]
    if container == 'mp3':
        return codec == 'mp3'
    if container in ('aac', 'm4a', 'mp4'):
        return codec == 'aac'
    if container == 'ogg':
        return codec in ('opus', 'vorbis')
    if container == 'wav':
        return codec.startswith('pcm_')
    if container == 'flac':
        return codec == 'flac'
    return False


def probe_av(path, extension):
    info = ffprobe(path)
    streams = info.get('streams') or []
    fmt = info.get('format') or {}
    video = [s for s in streams if s.get('codec_type') == 'video'
             and not (s.get('disposition') or {}).get('attached_pic')]
    audio = [s for s in streams if s.get('codec_type') == 'audio']
    if not video and not audio:
        raise Unusable('no audio or video streams')
    data = {}
    container = container_of(info, extension, bool(video))
    video_codecs = [s.get('codec_name') for s in video[:1] if s.get('codec_name')]
    audio_codecs = []
    for stream in audio:
        name = stream.get('codec_name')
        if name and name not in audio_codecs:
            audio_codecs.append(name)
    if video:
        stream = video[0]
        width, height = _number(stream.get('width'), int), _number(stream.get('height'), int)
        if width and height:
            if abs(_rotation(stream)) % 180 == 90:
                width, height = height, width
            data['width'], data['height'] = width, height
        fps = _rate(stream.get('avg_frame_rate')) or _rate(stream.get('r_frame_rate'))
        if fps and fps < 1000:
            data['fps'] = round(fps, 2)
        frames = _number(stream.get('nb_frames'), int)
        if frames:
            data['framecount'] = frames
        pix_fmt = stream.get('pix_fmt') or ''
        data['has_alpha'] = pix_fmt.startswith(('yuva', 'rgba', 'bgra', 'argb', 'abgr', 'gbrap', 'ya'))
    duration = _number(fmt.get('duration')) or next(
        (d for d in (_number(s.get('duration')) for s in video + audio) if d), None)
    if duration:
        data['duration'] = int(round(duration * 1000))
    data['has_audio'] = bool(audio)
    data['codecs'] = video_codecs + audio_codecs
    data['container'] = container
    data['playable'] = playable(container, video_codecs, audio_codecs)
    bitrate = _number(fmt.get('bit_rate'), int)
    if bitrate:
        data['bitrate'] = bitrate
    if audio:
        rate = _number(audio[0].get('sample_rate'), int)
        if rate:
            data['sample_rate'] = rate
        channels = _number(audio[0].get('channels'), int)
        if channels:
            data['channels'] = channels
    tags = {}
    raw = {k.lower(): v for k, v in (fmt.get('tags') or {}).items()}
    for stream in audio[:1]:
        for k, v in (stream.get('tags') or {}).items():  # ogg/opus keep their tags on the stream
            raw.setdefault(k.lower(), v)
    for key, sources in (('title', ('title',)), ('artist', ('artist', 'album_artist')), ('album', ('album',))):
        value = next((clean_tag(raw[s]) for s in sources if clean_tag(raw.get(s))), None)
        if value:
            tags[key] = value
    track = (raw.get('track') or raw.get('tracknumber') or '').split('/')[0].strip()
    if track.isdigit() and int(track) > 0:
        tags['track'] = int(track)
    if tags:
        data['tags'] = tags
    return {k: v for k, v in data.items() if v is not None}


def probe_pdf(path):
    try:
        out = tool(['pdfinfo', path], sandbox.PROBE_CPU, stdout=True)
    except sandbox.Failed:
        raise Unusable('pdfinfo could not read it')
    fields = {}
    for line in out.decode('utf-8', 'replace').splitlines():
        if ':' in line:
            key, value = line.split(':', 1)
            fields[key.strip().lower()] = value.strip()
    data = {}
    pages = _number(fields.get('pages'), int)
    if not pages:
        raise Unusable('no pages')
    data['pages'] = pages
    size = fields.get('page size', '').split()
    if len(size) >= 3 and size[1] == 'x':
        width, height = _number(size[0]), _number(size[2])
        if width and height:
            if (_number(fields.get('page rot'), int) or 0) % 180 == 90:
                width, height = height, width
            data['page_width'], data['page_height'] = int(round(width)), int(round(height))
    return data


def probe_text(path, extension):
    lines = 0
    last = b''
    head = bytearray()
    with open(path, 'rb') as handle:
        while True:
            chunk = handle.read(TEXT_READ)
            if not chunk:
                break
            lines += chunk.count(b'\n')
            last = chunk[-1:]
            if len(head) < 64 * 1024:
                head += chunk[:64 * 1024 - len(head)]
    if last and last != b'\n':
        lines += 1
    return {'lines': lines, 'language': media_rules.language_of(extension), 'snippet': snippet(bytes(head))}


def snippet(head):
    """The first SNIPPET_LINES lines, at most SNIPPET_BYTES of valid UTF-8."""
    text = head.decode('utf-8', 'replace').replace('\r\n', '\n')
    text = '\n'.join(text.split('\n')[:SNIPPET_LINES])
    encoded = text.encode('utf-8')[:SNIPPET_BYTES]
    return encoded.decode('utf-8', 'ignore')


def probe(path, hints):
    mimetype, extension = hints.get('mimetype'), hints.get('extension')
    prober = media_rules.probe_kind(mimetype)
    if prober == 'image':
        return {'state': 'probed', 'media': probe_image(path)}
    if prober == 'av':
        return {'state': 'probed', 'media': probe_av(path, extension)}
    if prober == 'pdf':
        return {'state': 'probed', 'media': probe_pdf(path)}
    if prober == 'text':
        return {'state': 'probed', 'media': probe_text(path, extension)}
    return {'state': 'skipped', 'media': None}


# --- derive -----------------------------------------------------------------------------------

class Assets:
    def __init__(self, outdir):
        self.outdir = outdir
        self.items = []

    def path(self, name):
        return os.path.join(self.outdir, name)

    def file(self, kind):
        """The output path of a preview kind (thumb -> <outdir>/thumb.webp)."""
        return self.path(media_rules.preview_filename(kind))

    def add(self, kind, width=None, height=None):
        item = {'kind': kind, 'file': media_rules.preview_filename(kind)}
        if width is not None:
            item['width'], item['height'] = width, height
        self.items.append(item)

    def webp(self, kind, image, box):
        image = fitted(image, box)
        save_webp(image, self.file(kind))
        self.add(kind, *image.size)
        return image

    def thumbs(self, image):
        self.webp('thumb-2x', image, THUMB_2X)
        self.webp('thumb', image, THUMB)


def fitted(image, box):
    from PIL import Image
    image = image.copy()
    image.thumbnail((box, box), Image.Resampling.LANCZOS)
    return image


def flatten_mode(image):
    """RGB, or RGBA when the image has transparency."""
    if image.mode in ('RGBA', 'LA', 'PA') or (image.mode == 'P' and 'transparency' in image.info):
        return image.convert('RGBA')
    if image.mode != 'RGB':
        return image.convert('RGB')
    return image


def save_webp(image, path, lossless=False):
    image.save(path, 'WEBP', quality=80, method=4, lossless=lossless)


def open_first_frame(path):
    from PIL import ImageOps
    Image = pillow()
    try:
        im = Image.open(path)
        im.seek(0)
        im.load()
        return flatten_mode(ImageOps.exif_transpose(im)), im
    except Exception as error:
        raise Unusable('not a readable image: {}'.format(type(error).__name__))


def derive_image(path, assets, category, media):
    image, source = open_first_frame(path)
    width, height = image.size
    if category == 'image_other':
        # the browser can't show the original, so there are always thumbs, plus a display stand-in
        assets.webp('display', image, PREVIEW)
        assets.thumbs(image)
    elif category == 'animated':
        assets.thumbs(image)
        hover_from_frames(source, assets)
    elif width > THUMB or height > THUMB:
        assets.thumbs(image)


def hover_from_frames(source, assets):
    """hover.mp4 from an animation Pillow decodes (gif, apng, animated webp): frames are
    sampled at 25 fps for up to 3 s and piped raw to ffmpeg, which never parses the upload."""
    from PIL import Image
    frames, starts, total = [], [], 0
    count = getattr(source, 'n_frames', 1)
    size = None
    for index in range(count):
        if total >= HOVER_MS:
            break
        source.seek(index)
        frame = source.convert('RGBA')
        if size is None:
            frame_fit = fitted(frame, HOVER)
            size = (max(2, frame_fit.width // 2 * 2), max(2, frame_fit.height // 2 * 2))
        canvas = Image.new('RGB', frame.size, (0, 0, 0))
        canvas.paste(frame, mask=frame.split()[3])
        frames.append(canvas.resize(size, Image.Resampling.LANCZOS).tobytes())
        starts.append(total)
        total += frame_duration(source)
    length = min(total, HOVER_MS)
    data = bytearray()
    step = 1000 / HOVER_FPS
    t, index = 0.0, 0
    while t < length or not data:
        while index + 1 < len(starts) and starts[index + 1] <= t:
            index += 1
        data += frames[index]
        t += step
    encode_hover(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '{}x{}'.format(*size), '-r', str(HOVER_FPS),
                  '-i', 'pipe:0'], assets, input=bytes(data))


HOVER_OUTPUT = ['-an', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', '-f', 'mp4']
HOVER_SCALE = 'scale=w={0}:h={0}:force_original_aspect_ratio=decrease:force_divisible_by=2'.format(HOVER)


def encode_hover(input_args, assets, input=None, input_path=None, video_map=None):
    out = assets.file('hover')
    if input_path is not None:
        cmd = sandbox.ffmpeg_cmd('-map', video_map or '0:v:0', '-vf', HOVER_SCALE, *HOVER_OUTPUT, out,
                                 input_path=input_path, input_args=input_args)
    else:
        cmd = sandbox.ffmpeg_cmd(*input_args, '-vf', HOVER_SCALE, *HOVER_OUTPUT, out)
    tool(cmd, sandbox.DERIVE_CPU, input=input)
    assets.add('hover')


def video_streams(path):
    info = ffprobe(path)
    streams = info.get('streams') or []
    video = [s for s in streams if s.get('codec_type') == 'video'
             and not (s.get('disposition') or {}).get('attached_pic')]
    pictures = [s for s in streams if s.get('codec_type') == 'video'
                and (s.get('disposition') or {}).get('attached_pic')]
    audio = [s for s in streams if s.get('codec_type') == 'audio']
    return video, pictures, audio


def still(path, out, input_args, map_spec, vf=None):
    args = ['-map', map_spec]
    if vf:
        args += ['-vf', vf]
    args += ['-frames:v', '1', '-c:v', 'png', '-f', 'image2', out]
    tool(sandbox.ffmpeg_cmd(*args, input_path=path, input_args=input_args), sandbox.DERIVE_CPU)
    return os.path.exists(out) and os.path.getsize(out) > 0


def derive_video(path, assets, media):
    Image = pillow()
    video, _, _ = video_streams(path)
    if not video:
        raise Unusable('no video stream')
    map_spec = '0:{}'.format(video[0]['index'])
    duration = (media.get('duration') or 10000) / 1000
    window = max(1.0, min(duration * 0.1, 30.0))
    fps = media.get('fps') or 25
    batch = int(max(1, min(100, fps * window)))
    poster_png = assets.path('poster.png')
    scale = "scale=w='min({0},iw)':h='min({0},ih)':force_original_aspect_ratio=decrease".format(POSTER)
    made = False
    try:
        made = still(path, poster_png, ['-t', '{:.3f}'.format(window)], map_spec,
                     '{},thumbnail=n={}'.format(scale, batch))
    except sandbox.Failed:
        made = False
    if not made:  # very short clips: the first frame
        made = still(path, poster_png, [], map_spec, scale)
    if not made:
        raise Unusable('no frame could be decoded')
    with Image.open(poster_png) as im:
        im.load()
        image = flatten_mode(im)
    os.unlink(poster_png)
    assets.webp('poster', image, POSTER)
    assets.thumbs(image)
    encode_hover(['-t', '{:.3f}'.format(HOVER_MS / 1000)], assets, input_path=path, video_map=map_spec)


def derive_audio(path, assets, media):
    Image = pillow()
    _, pictures, audio = video_streams(path)
    if not audio:
        raise Unusable('no audio stream')
    cover = False
    if pictures:
        cover_png = assets.path('cover.png')
        try:
            if still(path, cover_png, [], '0:{}'.format(pictures[0]['index'])):
                with Image.open(cover_png) as im:
                    im.load()
                    assets.webp('cover', flatten_mode(im), COVER)
                cover = True
        except Exception:
            cover = False  # unreadable art: fall back to the waveform
        if os.path.exists(cover_png):
            os.unlink(cover_png)
    pcm = tool(sandbox.ffmpeg_cmd('-map', '0:{}'.format(audio[0]['index']), '-ac', '1', '-ar', str(PEAKS_RATE),
                                  '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1', input_path=path),
               sandbox.DERIVE_CPU, stdout=True)
    samples = array.array('h')
    samples.frombytes(pcm[:len(pcm) - len(pcm) % 2])
    if sys.byteorder != 'little':
        samples.byteswap()
    peaks = buckets(samples, PEAKS)
    with open(assets.file('peaks'), 'w') as handle:
        json.dump({'version': 1, 'length': PEAKS, 'peaks': peaks}, handle, separators=(',', ':'))
    assets.add('peaks')
    if not cover:
        draw_waveform(buckets(samples, WAVEFORM_SIZE[0]), assets)


def buckets(samples, count):
    """`count` peak amplitudes in [0, 1] (normalised to the loudest), 3 decimals."""
    total = len(samples)
    values = []
    for i in range(count):
        start = i * total // count
        end = max(start + 1, (i + 1) * total // count) if total else 0
        part = samples[start:end]
        values.append(max(max(part), -min(part)) if len(part) else 0)
    loudest = max(values) if values else 0
    if not loudest:
        return [0] * count
    return [round(min(1.0, v / loudest), 3) for v in values]


def draw_waveform(values, assets):
    from PIL import Image, ImageDraw
    width, height = WAVEFORM_SIZE
    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    middle = height / 2
    for x, value in enumerate(values[:width]):
        half = max(0.5, value * (middle - 1))
        draw.line([(x, middle - half), (x, middle + half)], fill=WAVEFORM_COLOR)
    save_webp(image, assets.file('waveform'), lossless=True)
    assets.add('waveform', width, height)


def derive_pdf(path, assets):
    Image = pillow()
    prefix = assets.path('page')
    try:
        tool(['pdftoppm', '-f', '1', '-l', '1', '-singlefile', '-png', '-scale-to', str(THUMB_2X), path, prefix],
             sandbox.DERIVE_CPU)
    except sandbox.Failed:
        raise Unusable('pdftoppm could not render page 1')
    with Image.open(prefix + '.png') as im:
        im.load()
        image = flatten_mode(im)
    os.unlink(prefix + '.png')
    assets.thumbs(image)


def derive(path, outdir, hints):
    media = hints.get('media') or {}
    category = media_rules.category(hints.get('mimetype'), media)
    assets = Assets(outdir)
    if category in ('image', 'image_other', 'animated'):
        derive_image(path, assets, category, media)
    elif category == 'video':
        derive_video(path, assets, media)
    elif category == 'audio':
        derive_audio(path, assets, media)
    elif category == 'pdf':
        derive_pdf(path, assets)
    return {'assets': assets.items, 'category': category}


def main(argv=None):
    global _deadline
    argv = sys.argv[1:] if argv is None else argv
    op, path, outdir, hints = argv[0], argv[1], argv[2], json.loads(argv[3])
    _deadline = time.monotonic() + float(hints.get('budget') or 60)
    try:
        if op == 'probe':
            result = probe(path, hints)
        elif op == 'derive':
            result = derive(path, outdir, hints)
        elif op == 'scan':
            # contract milestone-4 §2.2: every failure here is a retry, never "unusable"
            from media import scanning
            print(json.dumps(scanning.scan(path, outdir, hints, deadline=_deadline)))
            return 0
        else:
            raise SystemExit('unknown operation {!r}'.format(op))
    except Unusable as error:
        print(json.dumps({'error': str(error)}))
        return UNUSABLE
    except Exception as error:
        # Pillow's own "this isn't an image" family, decompression bombs included
        from PIL import Image, UnidentifiedImageError
        if isinstance(error, (UnidentifiedImageError, Image.DecompressionBombError, SyntaxError, EOFError)):
            print(json.dumps({'error': '{}: {}'.format(type(error).__name__, error)[:500]}))
            return UNUSABLE
        raise
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
