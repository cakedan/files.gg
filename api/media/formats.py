"""The conversion format matrix (contract milestone-5 §1) as data: source kinds, targets, their options, the
default targets, option validation and normalising, recipes and their hashes (§6), and the
`GET /conversions/formats` document (§10.1).

Pure: no database, no I/O. The API validates and normalises with it; the converter imports `CONVERTER_VERSION`,
`TARGETS` and the helpers (`target_video_kbps`, `page_numbers`) so both sides read one table.
"""

import hashlib
import json
import math
import re

from dataclasses import dataclass
from typing import Optional

from utils import errors

# §6: bumped whenever any target's output would change; it's part of every recipe, so the cache is invalidated
# without a migration (decision 13)
CONVERTER_VERSION = 2

# decimal, as the web app and the limits use it: "10 MB" is 10,000,000 bytes (and fits Discord whichever unit it means)
MB = 1000 * 1000

# --- source kinds (§1.1) -------------------------------------------------------------------------------------------

PDF_MIMETYPE = 'application/pdf'
IMAGE_MIMETYPES = frozenset((
    'image/png', 'image/x-png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/webp', 'image/avif', 'image/heic',
    'image/heif', 'image/tiff', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/vnd.adobe.photoshop',
    'image/svg+xml', 'image/gif', 'image/apng',
))
# one frame: `image`; more (the probe's `framecount`): `animated`
ANIMATABLE_MIMETYPES = frozenset(('image/gif', 'image/webp', 'image/apng'))
# docx, doc, xlsx, xls, pptx, ppt, odt, ods, odp, rtf (the seed's types; macro-enabled ones are blocked at upload)
DOCUMENT_MIMETYPES = frozenset((
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/rtf',
))
# several images (or an album's) -> PDF: the recipe's kind for multi-source conversions
IMAGES = 'images'
KINDS = ('image', 'animated', 'video', 'audio', 'document', 'pdf', IMAGES)
# kinds whose conversions read the probe's duration
TIMED_KINDS = ('animated', 'video', 'audio')


class ProbePending(Exception):
    """The kind (or a limit) needs the probe, which hasn't finished yet."""


def source_kind(mimetype, media, processing_state):
    """The kind of one source file (§1.1), or None when it has no targets (a failed probe, or no kind). Raises
    ProbePending when telling needs the probe and it's still running."""
    mimetype = (mimetype or '').lower()
    if processing_state == 'failed':
        return None
    probed = media is not None
    waiting = processing_state in ('pending', 'probed') and not probed
    if mimetype == PDF_MIMETYPE:
        return 'pdf'
    if mimetype in DOCUMENT_MIMETYPES:
        return 'document'
    if mimetype in ANIMATABLE_MIMETYPES:
        if not probed:
            if waiting:
                raise ProbePending()
            return None
        return 'animated' if (media.get('framecount') or 1) > 1 else 'image'
    if mimetype in IMAGE_MIMETYPES:
        return 'image'
    major = mimetype.split('/', 1)[0]
    if major in ('video', 'audio'):
        if not probed:
            if waiting:
                raise ProbePending()
            return None
        if major == 'video' and media.get('width'):
            return 'video'
        return 'audio' if media.get('duration') else None
    return None


# --- targets (§1.2) -----------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Target:
    extension: str
    mimetype: str
    label: str


TARGETS = {
    'png': Target('png', 'image/png', 'PNG'),
    'jpg': Target('jpg', 'image/jpeg', 'JPG'),
    'webp': Target('webp', 'image/webp', 'WebP'),
    'avif': Target('avif', 'image/avif', 'AVIF'),
    'gif': Target('gif', 'image/gif', 'GIF'),
    'ico': Target('ico', 'image/vnd.microsoft.icon', 'ICO'),
    'mp4': Target('mp4', 'video/mp4', 'MP4'),
    'webm': Target('webm', 'video/webm', 'WebM'),
    'mp3': Target('mp3', 'audio/mpeg', 'MP3'),
    'm4a': Target('m4a', 'audio/mp4', 'M4A'),
    'ogg': Target('ogg', 'audio/ogg', 'Ogg (Opus)'),
    'flac': Target('flac', 'audio/flac', 'FLAC'),
    'wav': Target('wav', 'audio/wav', 'WAV'),
    'pdf': Target('pdf', 'application/pdf', 'PDF'),
}
# PDF -> images for anonymous callers is one ZIP of the pages (§4.6)
ZIP_MIMETYPE = 'application/zip'
ZIP_EXTENSION = 'zip'
# `"target": "same"` (§10.1): the source's own format, for image sources
SAME = 'same'
SAME_TARGETS = {
    'image/png': 'png', 'image/x-png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
    'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
}

KIND_TARGETS = {
    'image': ('png', 'jpg', 'webp', 'avif', 'gif', 'ico'),
    'animated': ('mp4', 'webm', 'webp', 'gif'),
    'video': ('mp4', 'webm', 'gif', 'mp3', 'm4a', 'ogg', 'wav'),
    'audio': ('mp3', 'm4a', 'ogg', 'flac', 'wav'),
    'document': ('pdf',),
    'pdf': ('png', 'jpg'),
    IMAGES: ('pdf',),
}
# when `target` is left out (decision 14)
DEFAULT_TARGETS = {'image': 'png', 'animated': 'mp4', 'video': 'mp4', 'audio': 'mp3', 'document': 'pdf', 'pdf': 'png',
                   IMAGES: 'pdf'}
# §7.1: what anonymous callers can't do
ANONYMOUS_REFUSED = frozenset((('document', 'pdf'),))
# multi-output (PDF -> pages) and multi-source (images -> PDF) recipes aren't cached in v1 (§2.2)
UNCACHED_KINDS = ('pdf', IMAGES)


def group_of(target):
    """The format chip's group: image, video, audio or document."""
    major = TARGETS[target].mimetype.split('/', 1)[0]
    return major if major in ('image', 'video', 'audio') else 'document'


def resolve_target(kind, target, mimetype=None):
    """The target for a kind: the default when it's left out, the source's own format for `same`.
    UNSUPPORTED_CONVERSION when the kind has no such target."""
    if target is None or target == '':
        target = DEFAULT_TARGETS.get(kind)
    elif isinstance(target, str):
        target = target.strip().lower()
        if target == SAME and kind == 'image':
            target = SAME_TARGETS.get((mimetype or '').lower())
    if kind is None or target not in KIND_TARGETS.get(kind, ()):
        raise errors.unsupported_conversion(kind, target if isinstance(target, str) else None)
    return target


# --- options (§1.2) -------------------------------------------------------------------------------------------------

BITRATES = (64, 96, 128, 160, 192, 256, 320)
MAX_HEIGHTS = (1080, 720, 480)
PAGE_SIZES = ('fit', 'a4', 'letter')
DISCORD = 'discord'
DISCORD_MB = 10
# the audio a `target_size` video keeps: AAC / Opus at this bitrate (unless `mute`)
TARGET_SIZE_AUDIO_KBPS = 128
MIN_VIDEO_KBPS = 100
COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')
PAGES = re.compile(r'^\d+(-\d+)?(,\d+(-\d+)?)*$')


@dataclass(frozen=True)
class Option:
    name: str
    # int, number, bool, enum, color, pages, size (§10.1)
    type: str
    label: str
    default: object = None
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    values: tuple = ()
    # the targets it applies to; empty for all of the kind's
    targets: tuple = ()

    def applies(self, target):
        return not self.targets or target in self.targets

    def document(self):
        data = {'name': self.name, 'type': self.type, 'label': self.label, 'default': self.default}
        if self.values:
            data['values'] = list(self.values)
        if self.minimum is not None:
            data['min'] = self.minimum
        if self.maximum is not None:
            data['max'] = self.maximum
        if self.type == 'size':
            # the named sizes, in MB
            data['presets'] = {DISCORD: DISCORD_MB}
        return data


def _trim():
    return (Option('trim_start', 'number', 'Start at (seconds)', minimum=0),
            Option('trim_end', 'number', 'End at (seconds)', minimum=0))


LOSSY_AUDIO = ('mp3', 'm4a', 'ogg')
OPTIONS = {
    'image': (
        Option('quality', 'int', 'Quality', 85, 1, 100, targets=('jpg', 'webp', 'avif')),
        Option('max_width', 'int', 'Max width', None, 1, 8192),
        Option('max_height', 'int', 'Max height', None, 1, 8192),
        Option('background', 'color', 'Background', '#ffffff', targets=('jpg', 'gif', 'ico')),
        Option('strip_metadata', 'bool', 'Remove metadata (location included)', True),
    ),
    'animated': (
        Option('fps', 'int', 'Frame rate', None, 1, 60),
        Option('width', 'int', 'Width', None, 16, 1920),
        *_trim(),
        Option('loop', 'bool', 'Loop', True, targets=('webp', 'gif')),
    ),
    'video': (
        Option('max_height', 'enum', 'Max height', None, values=MAX_HEIGHTS, targets=('mp4', 'webm')),
        *_trim(),
        Option('mute', 'bool', 'Remove audio', False, targets=('mp4', 'webm')),
        Option('target_size', 'size', 'Target size', None, 1, 500, targets=('mp4', 'webm')),
        Option('fps', 'int', 'Frame rate', 12, 1, 30, targets=('gif',)),
        Option('width', 'int', 'Width', 480, 16, 960, targets=('gif',)),
        Option('bitrate', 'enum', 'Bitrate (kbps)', 192, values=BITRATES, targets=LOSSY_AUDIO),
    ),
    'audio': (
        Option('bitrate', 'enum', 'Bitrate (kbps)', 192, values=BITRATES, targets=LOSSY_AUDIO),
        *_trim(),
        Option('normalize', 'bool', 'Normalize loudness', False),
        Option('keep_tags', 'bool', 'Keep tags and cover art', True),
    ),
    'document': (),
    'pdf': (
        Option('dpi', 'int', 'Resolution (DPI)', 150, 72, 300),
        Option('pages', 'pages', 'Pages', None),
        Option('quality', 'int', 'Quality', 85, 1, 100, targets=('jpg',)),
    ),
    IMAGES: (
        Option('page_size', 'enum', 'Page size', 'fit', values=PAGE_SIZES),
        Option('margin_mm', 'int', 'Margin (mm)', 0, 0, 50),
    ),
}


def options_for(kind, target):
    return [option for option in OPTIONS[kind] if option.applies(target)]


def _invalid(name, reason):
    return errors.invalid_option(name, reason)


def _integer(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value


def _check(option, value):
    """The option's normalised value; INVALID_OPTION otherwise."""
    name = option.name
    if option.type == 'bool':
        if not isinstance(value, bool):
            raise _invalid(name, 'type')
        return value
    if option.type == 'int':
        number = _integer(value)
        if number is None:
            raise _invalid(name, 'type')
        if not option.minimum <= number <= option.maximum:
            raise _invalid(name, 'range')
        return number
    if option.type == 'number':
        number = _number(value)
        if number is None:
            raise _invalid(name, 'type')
        if number < option.minimum:
            raise _invalid(name, 'range')
        # §6: trims are rounded to milliseconds
        return round(float(number), 3)
    if option.type == 'enum':
        candidate = value.strip().lower() if isinstance(value, str) else _integer(value)
        if candidate not in option.values:
            raise _invalid(name, 'value')
        return candidate
    if option.type == 'color':
        if not isinstance(value, str) or not COLOR.match(value.strip()):
            raise _invalid(name, 'type')
        return value.strip().lower()
    if option.type == 'pages':
        return normalise_pages(value)
    if option.type == 'size':
        if isinstance(value, str) and value.strip().lower() == DISCORD:
            return DISCORD
        number = _number(value)
        if number is None:
            raise _invalid(name, 'type')
        if not option.minimum <= number <= option.maximum:
            raise _invalid(name, 'range')
        return int(number) if float(number).is_integer() else round(float(number), 3)
    raise _invalid(name, 'type')


def normalise_pages(value):
    """`1-3,7`: page numbers from 1, ranges low to high; sorted and merged, so the same pages are one recipe."""
    if not isinstance(value, str) or not PAGES.match(value.replace(' ', '')):
        raise _invalid('pages', 'type')
    ranges = []
    for part in value.replace(' ', '').split(','):
        low, _, high = part.partition('-')
        low, high = int(low), int(high or low)
        if low < 1 or high < low:
            raise _invalid('pages', 'range')
        ranges.append([low, high])
    ranges.sort()
    merged = [ranges[0]]
    for low, high in ranges[1:]:
        if low <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], high)
        else:
            merged.append([low, high])
    return ','.join(str(low) if low == high else '{}-{}'.format(low, high) for low, high in merged)


def page_numbers(pages, page_count):
    """The pages a `pages` option picks (all for None), within the document's `page_count`, in order."""
    if pages is None:
        return list(range(1, page_count + 1))
    out = []
    for part in pages.split(','):
        low, _, high = part.partition('-')
        out += range(int(low), min(int(high or low), page_count) + 1)
    return out


def normalise(kind, target, options, duration=None):
    """§1.2 and §6: every default filled in, "none" values dropped, trims rounded to milliseconds and clamped to the
    duration, enums and colours lowercased. An unknown option, a value out of range or one that doesn't apply to the
    target is INVALID_OPTION { option, reason }: never dropped silently."""
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise _invalid('options', 'type')
    known = {option.name: option for option in OPTIONS[kind]}
    out = {}
    for name, value in options.items():
        option = known.get(name)
        if option is None:
            raise _invalid(name, 'unknown')
        if not option.applies(target):
            raise _invalid(name, 'not_applicable')
        if value is None:
            continue
        out[name] = _check(option, value)
    for option in options_for(kind, target):
        if option.name not in out and option.default is not None:
            out[option.name] = option.default
    _trim_rules(out, duration)
    if kind == IMAGES and out.get('page_size') == 'fit':
        # the margin is ignored for `fit`, so it isn't part of the recipe
        out.pop('margin_mm', None)
    return dict(sorted(out.items()))


def _trim_rules(out, duration):
    if 'trim_start' not in out and 'trim_end' not in out:
        return
    if not duration:
        raise _invalid('trim_start' if 'trim_start' in out else 'trim_end', 'no_duration')
    start = out.get('trim_start', 0)
    if start >= duration:
        raise _invalid('trim_start', 'range')
    if 'trim_end' in out:
        if out['trim_end'] <= start:
            raise _invalid('trim_end', 'before_start')
        out['trim_end'] = round(min(out['trim_end'], float(duration)), 3)
    if out.get('trim_start') == 0:
        out.pop('trim_start')


def trimmed_duration(options, duration):
    """The seconds a conversion keeps of a `duration`-second source."""
    start = options.get('trim_start', 0)
    end = options.get('trim_end', duration)
    return max(0.0, float(end) - float(start))


def target_size_mb(options):
    value = options.get('target_size')
    return DISCORD_MB if value == DISCORD else value


def target_video_kbps(size_mb, duration, audio_kbps):
    """§1.2: (size × 8 × 0.97 − audio bitrate × duration) ÷ duration, in kbps."""
    bits = size_mb * MB * 8 * 0.97
    return (bits - audio_kbps * 1000 * duration) / duration / 1000


def check_target_size(options, duration):
    """TARGET_SIZE_TOO_SMALL { minimum_mb } when the size leaves the video under 100 kbps."""
    size = target_size_mb(options)
    if size is None or not duration:
        return
    audio = 0 if options.get('mute') else TARGET_SIZE_AUDIO_KBPS
    if target_video_kbps(size, duration, audio) < MIN_VIDEO_KBPS:
        minimum = (MIN_VIDEO_KBPS + audio) * 1000 * duration / 8 / 0.97 / MB
        raise errors.target_size_too_small(int(math.ceil(minimum)))


# --- recipes (§6) ---------------------------------------------------------------------------------------------------

# Kinds whose output the caller's tier can cap (§7.1: anonymous video output is at most 720p). The cap is part of
# the recipe, so a capped output is never served from the cache to a caller who'd get it uncapped, or back.
CAPPED_KINDS = frozenset(('video',))


def recipe(kind, target, options, max_height_cap=None):
    value = {'v': CONVERTER_VERSION, 'kind': kind, 'target': target, 'options': options}
    if max_height_cap is not None and kind in CAPPED_KINDS:
        value['cap'] = {'max_height': max_height_cap}
    return value


def canonical(value):
    """Canonical JSON: sorted keys, no spaces, numbers as given after normalising."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def recipe_hash(kind, target, options, max_height_cap=None):
    return hashlib.sha256(canonical(recipe(kind, target, options, max_height_cap)).encode('utf-8')).digest()


def cacheable(kind):
    return kind not in UNCACHED_KINDS


# --- GET /conversions/formats (§10.1) ------------------------------------------------------------------------------

PRESETS = (
    {'id': 'play_everywhere', 'label': 'Make it play everywhere', 'kinds': ['video'], 'target': 'mp4', 'options': {}},
    {'id': 'discord', 'label': 'Shrink for Discord', 'kinds': ['video'], 'target': 'mp4',
     'options': {'target_size': DISCORD}},
    {'id': 'extract_audio', 'label': 'Extract audio', 'kinds': ['video'], 'target': 'mp3', 'options': {}},
    {'id': 'gif_to_mp4', 'label': 'GIF → MP4', 'kinds': ['animated'], 'target': 'mp4', 'options': {}},
    {'id': 'remove_location', 'label': 'Remove photo location data', 'kinds': ['image'], 'target': SAME,
     'options': {'strip_metadata': True}},
)


def formats_document():
    kinds = {}
    for kind in KINDS:
        kinds[kind] = {
            'default': DEFAULT_TARGETS[kind],
            'targets': [{
                'target': target,
                'label': TARGETS[target].label,
                'group': group_of(target),
                'extension': TARGETS[target].extension,
                'anonymous': (kind, target) not in ANONYMOUS_REFUSED,
                'options': [option.document() for option in options_for(kind, target)],
            } for target in KIND_TARGETS[kind]],
        }
    return {'version': CONVERTER_VERSION, 'kinds': kinds, 'presets': [dict(p) for p in PRESETS]}
