"""The sandboxed half of conversions (contract milestone-5 §4.2, §4.3):

    python -m media.convert <op> <outdir> <params json>

Started by jobs/convert.py through media/sandbox.py, in the work horse's process group: the
conversion's CPU budget as RLIMIT_CPU, 3 GiB of address space, the caller's max file size as
RLIMIT_FSIZE, a wall clock a little shorter than the job's time limit, a scrubbed environment,
and `die_with_parent` (a killed horse takes this process and its tools with it). It reads only
the local files it is given, writes into <outdir>, and prints JSON lines on stdout: any number
of `{"progress": 0.42}` (§8), then one result:

    image, animated, av, pdf_pages, images_pdf:  {"outputs": ["<file in outdir>", ...]}
    pdf_info:       {"pages": n}            (an office PDF's page count, and that it reads as one)
    document_info:  {"encrypted": bool}     (a password-protected document isn't previewed, §9.1)

Exit status 3 with {"error": "<reason>"} means the conversion can't be done: a reason of §12
(`unreadable_source`, `too_many_pages`), or `timeout` / `cpu` when a tool ran out of time or of
the CPU budget, or `target_size_too_small` with `minimum_mb`. Tool output never leaves this
process except as a fixed reason (§0).

| Ops            | Tools |
|----------------|-------|
| image          | Pillow (pillow-heif registered); resvg first for SVG; ffmpeg palettegen/paletteuse for GIF |
| animated       | Pillow decodes the frames, piped raw to ffmpeg (which never parses the upload) |
| av             | ffmpeg on the upload (demuxer whitelist), `-progress pipe:1`, two-pass `target_size` and `loudnorm`, audio copied when it fits (decision 15) |
| pdf_pages      | pdftoppm, one page at a time |
| images_pdf     | img2pdf (lossless; alpha flattened on white first) |
"""

import json
import math
import os
import re
import resource
import sys
import time
import zipfile

from media import formats, sandbox
from media import process as media_process

UNUSABLE = 3

# §4.3: what libmagic may call each target's output (its `formats.TARGETS` type, or names libmagic uses for it)
MAGIC_TYPES = {
    'png': ('image/png',),
    'jpg': ('image/jpeg',),
    'webp': ('image/webp',),
    'avif': ('image/avif',),
    'gif': ('image/gif',),
    'ico': ('image/vnd.microsoft.icon', 'image/x-icon'),
    'mp4': ('video/mp4',),
    'webm': ('video/webm',),
    'mp3': ('audio/mpeg',),
    'm4a': ('audio/x-m4a', 'audio/mp4', 'video/mp4'),
    'ogg': ('audio/ogg', 'application/ogg'),
    'flac': ('audio/flac', 'audio/x-flac'),
    'wav': ('audio/x-wav', 'audio/wav', 'audio/vnd.wave'),
    'pdf': ('application/pdf',),
    'zip': ('application/zip',),
}

# §1.2: SVG renders at its own size, capped by max_width / max_height, else this on the longer side
SVG_DEFAULT_MAX = 2048
# resvg's size for an SVG without width, height or viewBox
SVG_FALLBACK_SIZE = 100
SVG_UNITS = {'': 1.0, 'px': 1.0, 'pt': 4 / 3, 'pc': 16.0, 'mm': 96 / 25.4, 'cm': 96 / 2.54, 'in': 96.0,
             'em': 16.0, 'ex': 8.0}
SVG_LENGTH = re.compile(r'^\s*([0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*([a-z%]*)\s*$')
ICO_MAX = 256
# animated sources: frame rate and width caps (§1.2)
MAX_FPS = 60
MAX_ANIMATED_WIDTH = 1920
# what video encodes use without target_size
X264 = ['-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p']
X264_CRF = '23'
VP9 = ['-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4']
VP9_CRF = '32'
VIDEO_AUDIO_KBPS = 128
GIF_PALETTE = 'split[a][b];[a]palettegen=stats_mode=diff{}[p];[b][p]paletteuse=dither=sierra2_4a{}'
LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11'
LOUDNORM_JSON = re.compile(r'\{[^{}]*"input_i"[^{}]*\}', re.S)
# decision 15: audio codecs each audio container takes as they are
AUDIO_COPY = {'mp4': ('aac',), 'm4a': ('aac',), 'webm': ('opus',), 'ogg': ('opus',), 'mp3': ('mp3',),
              'flac': ('flac',), 'wav': ('pcm_s16le',)}
AUDIO_ENCODERS = {'mp3': 'libmp3lame', 'm4a': 'aac', 'ogg': 'libopus', 'flac': 'flac', 'wav': 'pcm_s16le'}
AUDIO_MUXERS = {'mp3': 'mp3', 'm4a': 'ipod', 'ogg': 'ogg', 'flac': 'flac', 'wav': 'wav'}
LOSSLESS_AUDIO = ('flac', 'wav')
# cover art survives in these containers (keep_tags)
COVER_TARGETS = ('mp3', 'm4a', 'flac')
DEFAULT_BITRATE = 192
PROGRESS_EVERY = 0.5

# set by main(): the wall clock this process works under (the horse kills it at that) and its CPU budget, of which
# every tool gets what's left (§7.3); the caller's max file size (§3.1 MAX_OUTPUT_FILE)
_deadline = None
_cpu = 60.0
_max_file = sandbox.MAX_OUTPUT_FILE


class Refused(Exception):
    """The conversion can't be done: `reason` is what the horse turns into the conversion's error."""

    def __init__(self, reason, **details):
        super().__init__(reason)
        self.reason = reason
        self.details = details


# --- running tools ---------------------------------------------------------------------------------------------------

def remaining():
    return max(1.0, _deadline - time.monotonic()) if _deadline else 60.0


def cpu_used():
    own = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime


def cpu_left():
    """What's left of the budget for the next tool (§7.3: tools inherit what's left)."""
    left = _cpu - cpu_used()
    if left < 1:
        raise Refused('cpu')
    return left


def tool(cmd, input=None, on_line=None, return_stderr=False):
    """A tool inside this sandbox: same limits, killed with us. Returns its stdout (and stderr, kept in this
    process). Running out of the CPU budget is `cpu`, of time `timeout`."""
    try:
        return sandbox.run(cmd, timeout=remaining(), cpu_seconds=cpu_left(), input=input, new_session=False,
                           env=sandbox.convert_env(), address_space=sandbox.CONVERT_ADDRESS_SPACE, max_file=_max_file,
                           die_with_parent=True, on_line=on_line, return_stderr=return_stderr)
    except sandbox.Timeout as error:
        raise Refused('cpu' if error.cpu and cpu_used() >= _cpu - 2 else 'timeout')


def ffmpeg(*args, input_path=None, input_args=(), input=None, duration=None, span=(0.0, 1.0), loglevel='error'):
    """ffmpeg with the thread budget and `-progress pipe:1`; progress is reported over `span` of the whole when
    the output's `duration` (seconds) is known."""
    reporter = Progress(span) if duration else None

    def on_line(line):
        if reporter is None:
            return
        key, _, value = line.decode('ascii', 'replace').strip().partition('=')
        if key == 'out_time_us' and value.lstrip('-').isdigit():
            reporter.report(int(value) / 1e6 / duration)

    cmd = sandbox.ffmpeg_cmd('-progress', 'pipe:1', '-nostats', *args, input_path=input_path,
                             input_args=input_args, threads=sandbox.convert_threads(), loglevel=loglevel)
    return tool(cmd, input=input, on_line=on_line)


class Progress:
    """`{"progress": x}` lines on stdout, at most every PROGRESS_EVERY seconds (the horse writes at most once a
    second, §8). `span` maps this step's 0-1 onto part of the whole (two-pass encodes)."""

    def __init__(self, span=(0.0, 1.0)):
        self.low, self.high = span
        self.last = 0.0

    def report(self, fraction):
        now = time.monotonic()
        if now - self.last < PROGRESS_EVERY:
            return
        self.last = now
        value = self.low + (self.high - self.low) * min(1.0, max(0.0, fraction))
        emit({'progress': round(value, 4)})


def emit(data):
    sys.stdout.write(json.dumps(data) + '\n')
    sys.stdout.flush()


def out_path(outdir, name):
    return os.path.join(outdir, name)


# --- images (§1.2 image row) ---------------------------------------------------------------------------------------

def svg_length(value):
    match = SVG_LENGTH.match(value or '')
    if not match or match.group(2) == '%' or match.group(2) not in SVG_UNITS:
        return None
    number = float(match.group(1)) * SVG_UNITS[match.group(2)]
    return number if number > 0 and math.isfinite(number) else None


def svg_root(path):
    """The root element, read with expat (no external entities; billion-laughs protection)."""
    import xml.etree.ElementTree as ElementTree
    try:
        for _, element in ElementTree.iterparse(path, events=('start',)):
            return element
    except ElementTree.ParseError:
        pass
    raise Refused('unreadable_source')


def svg_size(root):
    """An SVG's own size, as resvg reads it: width and height, else the viewBox, else 100x100."""
    width, height = svg_length(root.get('width')), svg_length(root.get('height'))
    box = None
    parts = re.split(r'[\s,]+', (root.get('viewBox') or '').strip())
    if len(parts) == 4:
        try:
            box = [float(p) for p in parts]
        except ValueError:
            box = None
    if box and box[2] > 0 and box[3] > 0:
        if width and not height:
            height = width * box[3] / box[2]
        elif height and not width:
            width = height * box[2] / box[3]
        elif not width and not height:
            width, height = box[2], box[3]
    return width or SVG_FALLBACK_SIZE, height or SVG_FALLBACK_SIZE


def sanitise_svg(path, out):
    """§1.2 "no external references": every href that isn't a fragment (#id) or a data: URL is removed before
    resvg reads it. resvg resolves file paths itself, absolute ones too, so an SVG could otherwise embed another
    file in this container (another conversion's input). resvg never runs scripts."""
    import xml.etree.ElementTree as ElementTree
    ElementTree.register_namespace('', 'http://www.w3.org/2000/svg')
    ElementTree.register_namespace('xlink', 'http://www.w3.org/1999/xlink')
    try:
        tree = ElementTree.parse(path)
    except ElementTree.ParseError:
        raise Refused('unreadable_source')
    for element in tree.iter():
        for name in list(element.attrib):
            if name.rsplit('}', 1)[-1] != 'href':
                continue
            value = element.attrib[name].strip()
            if not (value.startswith('#') or value[:5].lower() == 'data:'):
                del element.attrib[name]
    tree.write(out, encoding='utf-8', xml_declaration=True)


def rasterise_svg(path, outdir, max_width=None, max_height=None):
    """resvg at the SVG's own size, capped by max_width / max_height (default: SVG_DEFAULT_MAX on the longer side),
    never upscaled. Its resources directory is empty."""
    width, height = svg_size(svg_root(path))
    if max_width or max_height:
        scale = min(max_width / width if max_width else 1.0, max_height / height if max_height else 1.0)
    else:
        scale = SVG_DEFAULT_MAX / max(width, height)
    scale = min(1.0, scale)
    clean = out_path(outdir, 'source.svg')
    sanitise_svg(path, clean)
    resources = out_path(outdir, 'resources')
    os.makedirs(resources, exist_ok=True)
    png = out_path(outdir, 'source.png')
    try:
        tool(['resvg', '--resources-dir', resources, '-w', str(max(1, round(width * scale))), clean, png])
    except sandbox.Failed:
        raise Refused('unreadable_source')
    finally:
        os.unlink(clean)
    return png


def open_image(path, mimetype, outdir, options):
    """The source's first frame, upright (EXIF orientation applied), and its EXIF and ICC profile."""
    from PIL import ImageOps
    Image = media_process.pillow()
    if mimetype == 'image/svg+xml':
        path = rasterise_svg(path, outdir, options.get('max_width'), options.get('max_height'))
    try:
        source = Image.open(path)  # its first frame
        source.load()
        icc = source.info.get('icc_profile')
        image = ImageOps.exif_transpose(source)
        exif = image.getexif()
    except Refused:
        raise
    except Exception:
        raise Refused('unreadable_source')
    return image, exif, icc


def has_alpha(image):
    return image.mode in ('RGBA', 'LA', 'PA', 'RGBa', 'La') or (image.mode == 'P' and 'transparency' in image.info)


def color_of(value):
    value = (value or '#ffffff').lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def flatten(image, background):
    """Everything on the background colour (jpg)."""
    from PIL import Image
    if not has_alpha(image):
        return image.convert('RGB')
    rgba = image.convert('RGBA')
    canvas = Image.new('RGB', rgba.size, background)
    canvas.paste(rgba, mask=rgba.getchannel('A'))
    return canvas


def flatten_partial(image, background):
    """gif / ico (§1.2): semi-transparent pixels on the background colour, fully transparent ones stay so."""
    from PIL import Image
    if not has_alpha(image):
        return image.convert('RGB')
    rgba = image.convert('RGBA')
    alpha = rgba.getchannel('A')
    solid = flatten(rgba, background)
    out = solid.convert('RGBA')
    out.putalpha(alpha.point(lambda a: 0 if a == 0 else 255))
    return out if alpha.getextrema()[0] == 0 else Image.merge('RGB', out.split()[:3])


def fit(image, max_width, max_height):
    """Aspect kept, never upscaled (§1.2)."""
    from PIL import Image
    if not max_width and not max_height:
        return image
    width = min(image.width, max_width or image.width)
    height = min(image.height, max_height or image.height)
    if (width, height) == image.size:
        return image
    image = image.copy()
    image.thumbnail((width, height), Image.Resampling.LANCZOS)
    return image


def convert_image(params, outdir):
    target, options = params['target'], params['options']
    image, exif, icc = open_image(params['input'], params.get('mimetype'), outdir, options)
    image = fit(image, options.get('max_width'), options.get('max_height'))
    emit({'progress': 0.5})
    strip = options.get('strip_metadata', True)
    keep = {}
    if icc:
        keep['icc_profile'] = icc
    if not strip and len(exif):
        keep['exif'] = exif.tobytes()
    background = color_of(options.get('background'))
    name = 'output.' + formats.TARGETS[target].extension
    out = out_path(outdir, name)
    if target == 'jpg':
        flatten(image, background).save(out, 'JPEG', quality=options.get('quality', 85), optimize=True,
                                         progressive=True, **keep)
    elif target in ('png', 'webp', 'avif'):
        image = image.convert('RGBA') if has_alpha(image) else image.convert('RGB')
        if target == 'png':
            image.save(out, 'PNG', **keep)
        elif target == 'webp':
            image.save(out, 'WEBP', quality=options.get('quality', 85), method=4, **keep)
        else:
            image.save(out, 'AVIF', quality=options.get('quality', 85), speed=6, **keep)
    elif target == 'ico':
        image = fit(image, ICO_MAX, ICO_MAX)
        flatten_partial(image, background).save(out, 'ICO', sizes=[image.size])
    elif target == 'gif':
        still_gif(flatten_partial(image, background).convert('RGBA'), out)
    else:
        raise Refused('unreadable_source')
    return {'outputs': [name]}


def still_gif(image, out):
    """GIF output of anything goes through palettegen / paletteuse (§1.2), here from one raw RGBA frame."""
    ffmpeg('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '{}x{}'.format(*image.size), '-i', 'pipe:0',
           '-filter_complex', GIF_PALETTE.format(':reserve_transparent=1', ':alpha_threshold=128'),
           '-frames:v', '1', '-f', 'gif', out, input=image.tobytes())


# --- animated sources (§1.2 animated row) --------------------------------------------------------------------------

def animated_timeline(path, media, options):
    """(frames iterator, size, fps, duration): the source's frames, composited by Pillow, resampled to the output
    frame rate over the trimmed span."""
    Image = media_process.pillow()
    try:
        source = Image.open(path)
        count = getattr(source, 'n_frames', 1) or 1
    except Exception:
        raise Refused('unreadable_source')
    if count > media_process.MAX_ANIMATION_FRAMES:
        raise Refused('unreadable_source')
    durations = []
    try:
        for index in range(count):
            source.seek(index)
            durations.append(media_process.frame_duration(source))
    except Exception:
        raise Refused('unreadable_source')
    total = sum(durations) / 1000
    source_fps = media.get('fps') or (count / total if total else 10)
    fps = min(options.get('fps') or source_fps, MAX_FPS)
    fps = max(1.0, round(fps, 3))
    width = min(options.get('width') or source.width, MAX_ANIMATED_WIDTH, source.width)
    height = max(2, round(source.height * width / source.width))
    width, height = max(2, width // 2 * 2), max(2, height // 2 * 2)
    start = float(options.get('trim_start', 0))
    end = min(float(options.get('trim_end', total)), total)
    if end <= start:
        raise Refused('unreadable_source')
    frame_count = max(1, int(math.ceil((end - start) * fps)))
    starts = []
    position = 0.0
    for value in durations:
        starts.append(position)
        position += value / 1000

    def frames():
        index = 0
        current = None
        for n in range(frame_count):
            t = start + n / fps
            target = index
            while target + 1 < count and starts[target + 1] <= t:
                target += 1
            if current is None or target != index:
                index = target
                source.seek(index)
                current = source.convert('RGBA').resize((width, height), Image.Resampling.LANCZOS).tobytes()
            yield current

    return frames(), (width, height), fps, end - start


def convert_animated(params, outdir):
    target, options = params['target'], params['options']
    frames, size, fps, duration = animated_timeline(params['input'], params.get('media') or {}, options)
    raw = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '{}x{}'.format(*size), '-framerate', str(fps), '-i', 'pipe:0']
    name = 'output.' + formats.TARGETS[target].extension
    out = out_path(outdir, name)
    loop = options.get('loop', True)
    if target == 'mp4':
        # transparent pixels go on black, as the hover previews do
        args = [*raw, '-filter_complex', 'color=black:s={}x{}:r={}[bg];[bg][0:v]overlay=shortest=1,format=yuv420p'
                .format(size[0], size[1], fps), *X264, '-crf', X264_CRF, '-movflags', '+faststart', '-an', '-f', 'mp4',
                out]
    elif target == 'webm':
        args = [*raw, *VP9, '-crf', VP9_CRF, '-b:v', '0', '-pix_fmt', 'yuva420p', '-an', '-f', 'webm', out]
    elif target == 'gif':
        args = [*raw, '-filter_complex', GIF_PALETTE.format(':reserve_transparent=1', ':alpha_threshold=128'),
                '-loop', '0' if loop else '-1', '-f', 'gif', out]
    elif target == 'webp':
        args = [*raw, '-c:v', 'libwebp_anim', '-quality', '80', '-lossless', '0', '-pix_fmt', 'yuva420p',
                '-loop', '0' if loop else '1', '-f', 'webp', out]
    else:
        raise Refused('unreadable_source')
    try:
        ffmpeg(*args, input=frames, duration=duration)
    except sandbox.Failed:
        raise Refused('unreadable_source')
    return {'outputs': [name]}


# --- video and audio (§1.2 video and audio rows, §4.2) ---------------------------------------------------------------

class Streams:
    """What ffprobe says about the source (in this sandbox): its first video and audio streams, cover art."""

    def __init__(self, path):
        try:
            video, pictures, audio = media_process.video_streams(path)
        except media_process.Unusable:
            raise Refused('unreadable_source')
        self.video = video[0] if video else None
        self.picture = pictures[0] if pictures else None
        self.audio = audio[0] if audio else None

    @property
    def audio_codec(self):
        return (self.audio or {}).get('codec_name')

    @property
    def sample_rate(self):
        try:
            return int((self.audio or {}).get('sample_rate') or 0) or None
        except ValueError:
            return None


def audio_copies(streams, container, options, audio_only):
    """Decision 15 (notsobot's `copy_audio`): the source's audio codec fits the container and no option changes the
    audio. `bitrate` counts only when it isn't the default (the options arrive with every default filled in), and
    trims only for audio-only targets (a video keeps its audio in step by copying packets)."""
    if streams.audio_codec not in AUDIO_COPY.get(container, ()):
        return False
    if options.get('normalize') or options.get('target_size') is not None:
        return False
    if container not in LOSSLESS_AUDIO and options.get('bitrate', DEFAULT_BITRATE) != DEFAULT_BITRATE:
        return False
    return not (audio_only and ('trim_start' in options or 'trim_end' in options))


def trim_args(options, duration):
    """(input args, output args, output duration) for trim_start / trim_end."""
    start = float(options.get('trim_start', 0))
    end = float(options.get('trim_end', duration or 0)) if (duration or 'trim_end' in options) else None
    input_args = ['-ss', '{:.3f}'.format(start)] if start else []
    output_args = ['-t', '{:.3f}'.format(end - start)] if end is not None and 'trim_end' in options else []
    length = (end - start) if end is not None else None
    return input_args, output_args, length


def measure_loudness(path, input_args, output_args):
    """The first loudnorm pass: its measurements, from the JSON it prints on stderr (read here, never passed on)."""
    try:
        _, err = tool(sandbox.ffmpeg_cmd('-map', '0:a:0', '-af', LOUDNORM + ':print_format=json', *output_args,
                                         '-f', 'null', '-', input_path=path, input_args=input_args,
                                         threads=sandbox.convert_threads(), loglevel='info'), return_stderr=True)
    except sandbox.Failed:
        raise Refused('unreadable_source')
    match = LOUDNORM_JSON.search(err.decode('utf-8', 'replace'))
    if not match:
        raise Refused('unreadable_source')
    try:
        values = json.loads(match.group(0))
        return {key: float(values[key]) for key in ('input_i', 'input_tp', 'input_lra', 'input_thresh',
                                                     'target_offset')}
    except (ValueError, KeyError):
        raise Refused('unreadable_source')


def audio_encode_args(target, options, streams, copy, normalize_values=None):
    if copy:
        return ['-c:a', 'copy']
    args = []
    if normalize_values:
        v = normalize_values
        args += ['-af', '{}:measured_I={:.2f}:measured_TP={:.2f}:measured_LRA={:.2f}:measured_thresh={:.2f}:'
                        'offset={:.2f}:linear=true'.format(LOUDNORM, v['input_i'], v['input_tp'], v['input_lra'],
                                                           v['input_thresh'], v['target_offset'])]
        # loudnorm works at 192 kHz: back to the source's rate (Opus only takes 48 kHz)
        args += ['-ar', '48000' if target == 'ogg' else str(min(streams.sample_rate or 44100, 48000))]
    args += ['-c:a', AUDIO_ENCODERS[target]]
    if target not in LOSSLESS_AUDIO:
        args += ['-b:a', '{}k'.format(options.get('bitrate', DEFAULT_BITRATE))]
    return args


def convert_audio_target(path, params, outdir, streams, media):
    """video or audio -> mp3, m4a, ogg, flac, wav."""
    target, options = params['target'], params['options']
    if streams.audio is None:
        raise Refused('unreadable_source')
    duration = (media.get('duration') or 0) / 1000 or None
    input_args, output_args, length = trim_args(options, duration)
    copy = audio_copies(streams, target, options, True)
    normalize_values = None
    if options.get('normalize'):
        normalize_values = measure_loudness(path, input_args, output_args)
    keep_tags = params['kind'] == 'audio' and options.get('keep_tags', True)
    maps = ['-map', '0:a:0']
    if keep_tags and target in COVER_TARGETS and streams.picture is not None:
        maps += ['-map', '0:{}'.format(streams.picture['index']), '-c:v', 'copy', '-disposition:v:0', 'attached_pic']
    else:
        maps += ['-vn']
    metadata = ['-map_metadata', '0' if keep_tags else '-1']
    if target == 'mp3':
        metadata += ['-id3v2_version', '3']
    name = 'output.' + formats.TARGETS[target].extension
    span = (0.5, 1.0) if normalize_values else (0.0, 1.0)
    try:
        ffmpeg(*maps, *audio_encode_args(target, options, streams, copy, normalize_values), *metadata, *output_args,
               '-f', AUDIO_MUXERS[target], out_path(outdir, name), input_path=path, input_args=input_args,
               duration=length, span=span)
    except sandbox.Failed:
        raise Refused('unreadable_source')
    return {'outputs': [name]}


def scale_filter(max_height, cap):
    """Never upscaled (§1.2); even dimensions for 4:2:0. `cap` is the caller's output cap (anonymous 720p, §7.1)."""
    limits = [h for h in (max_height, cap) if h]
    if limits:
        return "scale=-2:'min(ih,{})':flags=lanczos".format(min(limits))
    return 'scale=trunc(iw/2)*2:trunc(ih/2)*2'


def convert_video(path, params, outdir, streams, media):
    target, options = params['target'], params['options']
    if streams.video is None:
        raise Refused('unreadable_source')
    duration = (media.get('duration') or 0) / 1000 or None
    input_args, output_args, length = trim_args(options, duration)
    name = 'output.' + formats.TARGETS[target].extension
    out = out_path(outdir, name)
    video_map = ['-map', '0:{}'.format(streams.video['index'])]
    if target == 'gif':
        width = options.get('width', 480)
        graph = "fps={},scale='min({},iw)':-1:flags=lanczos,{}".format(
            options.get('fps', 12), width, GIF_PALETTE.format('', ''))
        args = [*video_map, '-vf', graph, '-an', '-loop', '0', *output_args, '-f', 'gif', out]
        try:
            ffmpeg(*args, input_path=path, input_args=input_args, duration=length)
        except sandbox.Failed:
            raise Refused('unreadable_source')
        return {'outputs': [name]}
    mute = options.get('mute', False) or streams.audio is None
    size_mb = formats.target_size_mb(options)
    copy = not mute and audio_copies(streams, target, options, False)
    audio = []
    if mute:
        audio = ['-an']
    else:
        audio = ['-map', '0:{}'.format(streams.audio['index'])]
        if copy:
            audio += ['-c:a', 'copy']
        else:
            kbps = formats.TARGET_SIZE_AUDIO_KBPS if size_mb is not None else VIDEO_AUDIO_KBPS
            audio += ['-c:a', 'aac' if target == 'mp4' else 'libopus', '-b:a', '{}k'.format(kbps)]
    vf = ['-vf', scale_filter(options.get('max_height'), params.get('max_height_cap'))]
    # video metadata (a phone's location tags) isn't carried over; the picture's rotation is applied
    common = [*video_map, *vf, '-map_metadata', '-1', '-sn', '-dn']
    if target == 'mp4':
        codec, muxer = X264 + ['-profile:v', 'high'], ['-movflags', '+faststart', '-f', 'mp4']
        quality = ['-crf', X264_CRF]
    else:
        codec, muxer = VP9 + ['-pix_fmt', 'yuv420p'], ['-f', 'webm']
        quality = ['-crf', VP9_CRF, '-b:v', '0']
    try:
        if size_mb is None:
            ffmpeg(*common, *codec, *quality, *audio, *output_args, *muxer, out, input_path=path,
                   input_args=input_args, duration=length)
            return {'outputs': [name]}
        if not length:
            raise Refused('unreadable_source')
        audio_kbps = 0 if mute else formats.TARGET_SIZE_AUDIO_KBPS
        kbps = formats.target_video_kbps(size_mb, length, audio_kbps)
        if kbps < formats.MIN_VIDEO_KBPS:
            minimum = (formats.MIN_VIDEO_KBPS + audio_kbps) * 1000 * length / 8 / 0.97 / formats.MB
            raise Refused('target_size_too_small', minimum_mb=int(math.ceil(minimum)))
        # Never bigger than the source: a target above what the video already uses ("Shrink for Discord" on a 6.8 MB
        # clip) re-encodes at about the source's own bitrate instead of inflating it to the target.
        source_kbps = source_video_kbps(path, duration, audio_kbps)
        if source_kbps is not None:
            kbps = max(formats.MIN_VIDEO_KBPS, min(kbps, source_kbps))
        limit = int(size_mb * formats.MB)
        passlog = ['-passlogfile', out_path(outdir, 'pass')]
        ffmpeg(*common, *codec, '-b:v', '{}k'.format(int(kbps)), '-pass', '1', *passlog, '-an', *output_args,
               '-f', 'null', '-', input_path=path, input_args=input_args, duration=length, span=(0.0, 0.5))

        def second_pass(rate, span):
            ffmpeg(*common, *codec, '-b:v', '{}k'.format(int(rate)), '-pass', '2', *passlog, *audio, *output_args,
                   *muxer, out, input_path=path, input_args=input_args, duration=length, span=span)

        second_pass(kbps, (0.5, 0.85))
        # The size is a promise ("Shrink for Discord" must fit): rate control and the audio can overshoot it, so an
        # output over the limit is encoded once more at a bitrate scaled down by the overshoot, and refused if it's
        # still over.
        size = os.path.getsize(out)
        if size > limit:
            second_pass(max(formats.MIN_VIDEO_KBPS, kbps * limit / size * 0.95), (0.85, 1.0))
            if os.path.getsize(out) > limit:
                raise Refused('target_size_missed')
    except sandbox.Failed:
        raise Refused('unreadable_source')
    return {'outputs': [name]}


def source_video_kbps(path, duration, audio_kbps):
    """The source's average video bitrate in kbps (its whole size over its whole duration, less the audio budget),
    or None when that can't be told."""
    if not duration:
        return None
    total = os.path.getsize(path) * 8 / 1000 / duration
    return max(0.0, total - audio_kbps) or None


def convert_av(params, outdir):
    path = params['input']
    streams = Streams(path)
    media = params.get('media') or {}
    if params['target'] in AUDIO_ENCODERS:
        return convert_audio_target(path, params, outdir, streams, media)
    return convert_video(path, params, outdir, streams, media)


# --- PDF -> images (§1.2 pdf row, §4.6) -----------------------------------------------------------------------------

def page_count(path):
    try:
        return media_process.probe_pdf(path)['pages']
    except media_process.Unusable:
        raise Refused('unreadable_source')


def convert_pdf_pages(params, outdir):
    """One pdftoppm run per page (progress: pages done / pages), named `<name>-p<page>.<ext>` with the page number
    zero-padded to the page count's width (§1.3)."""
    target, options, path = params['target'], params['options'], params['input']
    count = page_count(path)
    pages = formats.page_numbers(options.get('pages'), count)
    if not pages:
        raise Refused('unreadable_source')
    width = len(str(count))
    extension = formats.TARGETS[target].extension
    if target == 'jpg':
        kind = ['-jpeg', '-jpegopt', 'quality={}'.format(options.get('quality', 85))]
    else:
        kind = ['-png']
    names = []
    reporter = Progress()
    for done, page in enumerate(pages):
        prefix = out_path(outdir, 'page')
        try:
            tool(['pdftoppm', '-r', str(options.get('dpi', 150)), '-f', str(page), '-l', str(page), '-singlefile',
                  *kind, path, prefix])
        except sandbox.Failed:
            raise Refused('unreadable_source')
        name = '{}-p{}.{}'.format(params['name'], str(page).zfill(width), extension)
        os.replace('{}.{}'.format(prefix, 'jpg' if target == 'jpg' else 'png'), out_path(outdir, name))
        names.append(name)
        reporter.report((done + 1) / len(pages))
    return {'outputs': names}


# --- images -> PDF (§1.2 last row) ----------------------------------------------------------------------------------

PAGE_SIZES_MM = {'a4': (210, 297), 'letter': (215.9, 279.4)}


def pdf_ready_image(index, item, outdir):
    """A file img2pdf embeds as it is: a JPEG stays (lossless embedding); anything else becomes a PNG, with alpha
    flattened on white."""
    path, mimetype = item['path'], item.get('mimetype')
    if mimetype == 'image/svg+xml':
        path = rasterise_svg(path, outdir)
        mimetype = 'image/png'
    Image = media_process.pillow()
    try:
        with Image.open(path) as source:
            source.load()
            if source.format == 'JPEG' and source.mode in ('RGB', 'L', 'CMYK'):
                return path
            from PIL import ImageOps
            image = ImageOps.exif_transpose(source)
            image = flatten(image, (255, 255, 255)) if has_alpha(image) or image.mode not in ('RGB', 'L') else image
            out = out_path(outdir, 'page-{}.png'.format(index))
            image.save(out, 'PNG')
            return out
    except Refused:
        raise
    except Exception:
        raise Refused('unreadable_source')


def convert_images_pdf(params, outdir):
    import img2pdf
    options = params['options']
    reporter = Progress((0.0, 0.9))
    inputs = params['inputs']
    paths = []
    for index, item in enumerate(inputs):
        paths.append(pdf_ready_image(index, item, outdir))
        reporter.report((index + 1) / len(inputs))
    page_size = options.get('page_size', 'fit')
    layout = img2pdf.default_layout_fun
    if page_size in PAGE_SIZES_MM:
        width, height = PAGE_SIZES_MM[page_size]
        margin = img2pdf.mm_to_pt(options.get('margin_mm', 0))
        layout = img2pdf.get_layout_fun(pagesize=(img2pdf.mm_to_pt(width), img2pdf.mm_to_pt(height)),
                                        border=(margin, margin), fit=img2pdf.FitMode.into, auto_orient=True)
    name = 'output.pdf'
    try:
        with open(out_path(outdir, name), 'wb') as handle:
            img2pdf.convert(paths, layout_fun=layout, rotation=img2pdf.Rotation.ifvalid, outputstream=handle)
    except Exception:
        raise Refused('unreadable_source')
    return {'outputs': [name]}


# --- documents (§3.2, §9.1) -------------------------------------------------------------------------------------------

ZIP_MAGIC = b'PK\x03\x04'
CFB_MAGIC = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'


def document_encrypted(path):
    """A password-protected document: OOXML encryption (an OLE file with an EncryptedPackage stream), the legacy
    formats' own encryption (msoffcrypto), or an encrypted OpenDocument (its manifest's encryption-data)."""
    with open(path, 'rb') as handle:
        head = handle.read(8)
    if head.startswith(ZIP_MAGIC):
        try:
            with zipfile.ZipFile(path) as archive:
                if 'META-INF/manifest.xml' not in archive.namelist():
                    return False
                manifest = archive.read('META-INF/manifest.xml')[:4 * 1024 * 1024]
                return b'encryption-data' in manifest
        except (zipfile.BadZipFile, OSError, RuntimeError):
            return False
    if head == CFB_MAGIC:
        try:
            import msoffcrypto
            with open(path, 'rb') as handle:
                return bool(msoffcrypto.OfficeFile(handle).is_encrypted())
        except Exception:
            return False
    return False


# --- main -------------------------------------------------------------------------------------------------------------

OPS = {
    'image': convert_image,
    'animated': convert_animated,
    'av': convert_av,
    'pdf_pages': convert_pdf_pages,
    'images_pdf': convert_images_pdf,
    'pdf_info': lambda params, outdir: {'pages': page_count(params['input'])},
    'document_info': lambda params, outdir: {'encrypted': document_encrypted(params['input'])},
}


def main(argv=None):
    global _deadline, _cpu, _max_file
    argv = sys.argv[1:] if argv is None else argv
    op, outdir, params = argv[0], argv[1], json.loads(argv[2])
    _deadline = time.monotonic() + float(params.get('budget') or 60)
    _cpu = float(params.get('cpu') or 60)
    _max_file = int(params.get('max_file') or sandbox.MAX_OUTPUT_FILE)
    if op not in OPS:
        raise SystemExit('unknown operation {!r}'.format(op))
    try:
        result = OPS[op](params, outdir)
    except Refused as refused:
        emit({'error': refused.reason, **refused.details})
        return UNUSABLE
    except Exception as error:
        # Pillow's own "this isn't an image" family, decompression bombs included
        from PIL import Image, UnidentifiedImageError
        if isinstance(error, (UnidentifiedImageError, Image.DecompressionBombError, SyntaxError, EOFError)):
            emit({'error': 'unreadable_source'})
            return UNUSABLE
        raise
    emit(result)
    return 0


if __name__ == '__main__':
    sys.exit(main())
