"""The sandboxed half of the `scan` job (contract milestone-4 §2.2, §2.3, §3.4, §4, §5):

    python -m media.process scan <input> <outdir> <hints json>

Everything that parses the upload runs here, under media/sandbox.py's limits (wall 120 s,
CPU 90 s, 2 GiB address space, no core files) with no secrets and no network: it sniffs the
type, decodes images and frames and writes the images to be matched as JPEG files into
<outdir> (fit 1024x1024, quality 90), computes PDQ, preprocesses the classifier's images into
<outdir>/nsfw.npy, lists archives, checks Office files and PDFs, looks for appended archives,
and extracts URLs. The job process (safety/scan.py) does everything that talks to a service,
and runs the NSFW model (loaded once per process) on nsfw.npy.

The type is decided by every type the bytes or the name say it is (the libmagic-sniffed
type, the declared mimetype and the extension's type), so a polyglot is checked as each
type it parses as (§5.5).
"""

import math
import os
import re
import struct
import tempfile
import zipfile

import media as media_rules
from media import sandbox
from utils import filetypes

MATCH_BOX = 1024
JPEG_QUALITY = 90
ANIMATED_FRAMES = 8
VIDEO_MIN_FRAMES = 8
VIDEO_MAX_FRAMES = 32
VIDEO_FRAME_EVERY = 10.0
NSFW_FRAMES = 8
PDF_PAGES = 3
TEXT_URL_BYTES = 1024 * 1024
HEAD_BYTES = filetypes.SNIFF_BYTES
NESTED_MAX_BYTES = 100 * 1024 * 1024
URL_LIMIT = 100
# entries of these extensions are blocked inside archives on top of filetypes.BLOCKED_EXTENSIONS (§5.3)
ARCHIVE_EXTRA_BLOCKED = frozenset(('dex',))

ARCHIVE_TYPES = frozenset((
    'application/zip', 'application/x-zip-compressed', 'application/x-zip', 'application/x-7z-compressed',
    'application/vnd.rar', 'application/x-rar', 'application/x-rar-compressed', 'application/x-tar',
    'application/x-gtar', 'application/gzip', 'application/x-gzip', 'application/x-bzip2', 'application/x-bzip',
    'application/x-xz', 'application/zstd', 'application/x-zstd', 'application/x-compressed-tar',
    'application/x-bzip2-compressed-tar', 'application/x-xz-compressed-tar', 'application/x-zstd-compressed-tar',
))
ARCHIVE_EXTENSIONS = frozenset(('zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst',
                                'tzst'))
OFFICE_TYPES = frozenset((
    'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint', 'application/vnd.ms-office',
    'application/x-ole-storage', 'application/cdfv2', 'application/vnd.ms-outlook', 'application/rtf', 'text/rtf',
))
OFFICE_EXTENSIONS = frozenset(('doc', 'dot', 'docx', 'dotx', 'xls', 'xlt', 'xlsx', 'xltx', 'xlsb', 'ppt', 'pot',
                               'pps', 'pptx', 'potx', 'ppsx', 'rtf'))
OLE_MAGIC = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'
ZIP_MAGIC = b'PK\x03\x04'
SEVEN_ZIP_MAGIC = b'7z\xbc\xaf\x27\x1c'
RAR_MAGIC = b'Rar!\x1a\x07'
ARCHIVE_SIGNATURES = ((b'PK\x03\x04', 'zip'), (b'PK\x05\x06', 'zip'), (SEVEN_ZIP_MAGIC, '7z'), (RAR_MAGIC, 'rar'))
IMAGE_EXTENSIONS = frozenset(('png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic',
                              'heif', 'avif', 'psd', 'apng', 'ico'))


class ScanError(Exception):
    """A required check couldn't run: the job retries (the hash stays pending)."""


# --- types -------------------------------------------------------------------------------------------------

def sniff(path):
    """libmagic's type of the bytes (python-magic), lowercase without parameters."""
    import magic
    try:
        sniffed = (magic.from_file(path, mime=True) or '').split(';', 1)[0].strip().lower() or None
    except Exception as error:
        raise ScanError('libmagic failed: {}'.format(error))
    return filetypes.trusted_sniff(sniffed, read_head(path, 2))


def read_head(path, size=HEAD_BYTES):
    with open(path, 'rb') as handle:
        return handle.read(size)


def extension_of(name):
    if not name or '.' not in name:
        return None
    return name.rsplit('.', 1)[-1].strip().lower() or None


class Types:
    """Every type the file says or seems to be."""

    def __init__(self, mimetypes, extensions, head):
        self.mimetypes = {m for m in mimetypes if m}
        self.extensions = {e for e in extensions if e}
        self.head = head

    def image(self):
        return any(media_rules.base_kind(m) == 'image' or media_rules.is_other_image(m) for m in self.mimetypes) \
            or bool(self.extensions & IMAGE_EXTENSIONS)

    def video(self):
        return any(m.startswith('video/') for m in self.mimetypes)

    def audio(self):
        return any(m.startswith('audio/') for m in self.mimetypes)

    def pdf(self):
        return 'application/pdf' in self.mimetypes or 'pdf' in self.extensions or self.head.startswith(b'%PDF')

    def ooxml(self):
        return any(m.startswith('application/vnd.openxmlformats-officedocument.') or
                   m.startswith('application/vnd.ms-word') or m.startswith('application/vnd.ms-excel') or
                   m.startswith('application/vnd.ms-powerpoint') for m in self.mimetypes)

    def office(self):
        return bool(self.mimetypes & OFFICE_TYPES) or self.ooxml() or bool(self.extensions & OFFICE_EXTENSIONS) \
            or self.head.startswith(OLE_MAGIC)

    def archive(self):
        if self.mimetypes & ARCHIVE_TYPES or self.extensions & ARCHIVE_EXTENSIONS:
            return True
        head = self.head
        return head.startswith((SEVEN_ZIP_MAGIC, RAR_MAGIC, b'\x1f\x8b', b'BZh', b'\xfd7zXZ\x00',
                                b'\x28\xb5\x2f\xfd')) or (len(head) > 262 and head[257:262] == b'ustar') \
            or (head.startswith(ZIP_MAGIC) and not self.office() and not self.ooxml_container())

    def ooxml_container(self):
        return any(m.startswith('application/vnd.oasis.opendocument') or m == 'application/epub+zip'
                   for m in self.mimetypes)

    def text(self):
        return any(media_rules.base_kind(m) == 'text' or m == 'text/html' or m.startswith('text/')
                   for m in self.mimetypes)

    def blocked(self):
        return sorted(m for m in self.mimetypes if filetypes.blocked_mimetype(m))


def primary_kind(types, animated):
    if types.video():
        return 'video'
    if types.audio():
        return 'audio'
    if types.image():
        return 'animated' if animated else 'image'
    if types.pdf():
        return 'pdf'
    if types.office():
        return 'office'
    if types.archive():
        return 'archive'
    if types.text():
        return 'text'
    return 'other'


# --- images to match (§2.3) ----------------------------------------------------------------------------------

class Images:
    """The matched images, written as m-NNN.jpg, with their PDQ."""

    def __init__(self, outdir):
        self.outdir = outdir
        self.items = []
        self.pdq = []
        self.pil = []  # (frame, source, PIL image) kept for the classifier

    def add(self, image, source, at_ms=None, keep=False):
        from PIL import Image
        frame = len(self.items)
        image = image.convert('RGB')
        image.thumbnail((MATCH_BOX, MATCH_BOX), Image.Resampling.LANCZOS)
        name = 'm-{:03d}.jpg'.format(frame)
        image.save(os.path.join(self.outdir, name), 'JPEG', quality=JPEG_QUALITY)
        self.items.append({'file': name, 'frame': frame, 'source': source, 'at_ms': at_ms,
                           'width': image.width, 'height': image.height})
        hash_hex, quality = pdq_of(image)
        self.pdq.append({'frame': frame, 'hash': hash_hex, 'quality': quality})
        if keep:
            self.pil.append((frame, source, image))
        return frame


def pdq_of(image):
    """Meta's PDQ of an RGB PIL image. pdqhash 0.2.8 needs a C-contiguous uint8 array: it
    returns wrong hashes for non-contiguous ones (an open upstream report, §3.4)."""
    import numpy as np
    import pdqhash
    array = np.ascontiguousarray(np.asarray(image.convert('RGB'), dtype=np.uint8))
    vector, quality = pdqhash.compute(array)
    bits = ''.join('1' if bit else '0' for bit in vector)
    return '{:064x}'.format(int(bits, 2)), int(quality)


def resource_error(error):
    """Out of memory, out of time, or a tool killed by a signal: the scan couldn't check the file, which
    is never the same as "not decodable" (§2.6). These propagate, so the child fails and the scan job
    retries (then, if it keeps failing, the sweeper holds the hash for staff)."""
    if isinstance(error, (MemoryError, RecursionError, sandbox.Timeout)):
        return True
    return isinstance(error, sandbox.Failed) and (error.returncode or 0) < 0


def reraise_resource(error):
    if resource_error(error):
        raise error


def pillow():
    from PIL import Image
    import pillow_heif
    pillow_heif.register_heif_opener()
    return Image


def evenly(count, total):
    """`count` indices spread evenly over range(total) (all of them when total <= count)."""
    if total <= count:
        return list(range(total))
    return sorted({round(i * (total - 1) / (count - 1)) for i in range(count)})


def image_frames(path, images):
    """An image, or 8 frames of an animation. Returns (decodable, animated)."""
    from PIL import ImageOps
    Image = pillow()
    try:
        im = Image.open(path)
        frames = getattr(im, 'n_frames', 1) or 1
        if frames > 1:
            for index in evenly(ANIMATED_FRAMES, frames):
                im.seek(index)
                images.add(im.convert('RGBA').convert('RGB'), 'frame', keep=True)
            return True, True
        im.load()
        images.add(ImageOps.exif_transpose(im), 'image', keep=True)
        return True, False
    except Exception as error:
        # corrupt or unsupported data (decompression bombs included): not decodable, download only
        # (decision 15); memory and time aren't the file's fault
        reraise_resource(error)
        return False, False


def video_frames(path, outdir, images):
    """1 frame per 10 s (at least 8, at most 32), evenly spaced, through ffmpeg seeks."""
    Image = pillow()
    try:
        info = sandbox_tool(sandbox.ffprobe_cmd(path))
    except Exception as error:
        reraise_resource(error)
        return False
    import json
    info = json.loads(info or b'{}')
    streams = [s for s in info.get('streams') or () if s.get('codec_type') == 'video'
               and not (s.get('disposition') or {}).get('attached_pic')]
    if not streams:
        return False
    try:
        duration = float((info.get('format') or {}).get('duration') or streams[0].get('duration') or 0)
    except ValueError:
        duration = 0.0
    count = int(min(VIDEO_MAX_FRAMES, max(VIDEO_MIN_FRAMES, math.floor(duration / VIDEO_FRAME_EVERY))))
    times = [duration * (i + 0.5) / count for i in range(count)] if duration > 0 else [0.0]
    out = os.path.join(outdir, 'frame.png')
    got = []
    for at in times:
        if os.path.exists(out):
            os.unlink(out)
        cmd = sandbox.ffmpeg_cmd('-map', '0:{}'.format(streams[0]['index']), '-frames:v', '1', '-c:v', 'png',
                                 '-f', 'image2', out, input_path=path, input_args=['-ss', '{:.3f}'.format(at)])
        try:
            sandbox_tool(cmd)
        except Exception as error:
            reraise_resource(error)
            continue
        if os.path.exists(out) and os.path.getsize(out):
            with Image.open(out) as im:
                im.load()
                got.append((at, im.convert('RGB')))
    if os.path.exists(out):
        os.unlink(out)
    keep = set(evenly(NSFW_FRAMES, len(got)))
    for index, (at, image) in enumerate(got):
        images.add(image, 'frame', at_ms=int(at * 1000), keep=index in keep)
    return bool(got)


def cover_art(path, outdir, images):
    Image = pillow()
    try:
        import json
        info = json.loads(sandbox_tool(sandbox.ffprobe_cmd(path)) or b'{}')
    except Exception as error:
        reraise_resource(error)
        return
    pictures = [s for s in info.get('streams') or () if s.get('codec_type') == 'video'
                and (s.get('disposition') or {}).get('attached_pic')]
    if not pictures:
        return
    out = os.path.join(outdir, 'cover.png')
    try:
        sandbox_tool(sandbox.ffmpeg_cmd('-map', '0:{}'.format(pictures[0]['index']), '-frames:v', '1', '-c:v', 'png',
                                        '-f', 'image2', out, input_path=path))
        with Image.open(out) as im:
            im.load()
            images.add(im.convert('RGB'), 'cover', keep=True)
    except Exception as error:
        reraise_resource(error)
    finally:
        if os.path.exists(out):
            os.unlink(out)


def pdf_pages(path, outdir, images):
    Image = pillow()
    prefix = os.path.join(outdir, 'page')
    try:
        sandbox_tool(['pdftoppm', '-f', '1', '-l', str(PDF_PAGES), '-png', '-scale-to', str(MATCH_BOX), path, prefix])
    except Exception as error:
        reraise_resource(error)
        return False
    pages = sorted((name for name in os.listdir(outdir) if name.startswith('page-') and name.endswith('.png')),
                   key=lambda n: int(re.sub(r'\D', '', n) or 0))
    for name in pages[:PDF_PAGES]:
        full = os.path.join(outdir, name)
        with Image.open(full) as im:
            im.load()
            images.add(im.convert('RGB'), 'pdf_page', keep=True)
        os.unlink(full)
    return bool(pages)


# --- archives (§5.3) -------------------------------------------------------------------------------------

def blocked_entry_name(name):
    """Any path segment with a blocked extension (`Foo.app/Contents/...` counts), or `.dex`."""
    for segment in re.split(r'[\\/]+', name or ''):
        ext = extension_of(segment)
        if ext and (ext in filetypes.BLOCKED_EXTENSIONS or ext in ARCHIVE_EXTRA_BLOCKED):
            return True
    return False


class ArchiveState:
    def __init__(self, limits, size):
        self.limits = limits
        self.size = max(1, size)
        self.entries = 0
        self.unpacked = 0
        self.partial = False
        self.encrypted = False
        self.depth = 1
        self.blocked = []
        self.errors = []
        self.images = 0
        # entries past max_entries whose names were still checked
        self.names_only = 0

    def result(self):
        bomb = self.unpacked > self.limits['max_unpacked'] or self.unpacked > self.limits['max_ratio'] * self.size
        return {'entries': self.entries, 'partial': self.partial, 'encrypted': self.encrypted, 'depth': self.depth,
                'unpacked': self.unpacked, 'bomb': bomb, 'blocked': self.blocked[:20],
                'unreadable': bool(self.errors) and self.entries == 0, 'errors': self.errors[:5]}


_is_encrypted = []


def _entry_encrypted(entry):
    """libarchive's archive_entry_is_encrypted (3.3+), which libarchive-c doesn't wrap. Declared
    with its real signature: without argtypes, ctypes would truncate the entry pointer."""
    import ctypes
    from libarchive import ffi
    if not _is_encrypted:
        function = ffi.libarchive.archive_entry_is_encrypted
        function.argtypes = [ctypes.c_void_p]
        function.restype = ctypes.c_int
        _is_encrypted.append(function)
    return bool(_is_encrypted[0](entry._entry_p))


def rar_headers_encrypted(head):
    """RAR5: an archive encryption header (type 4) right after the signature. RAR4: the main
    header's MHD_PASSWORD flag."""
    if head.startswith(b'Rar!\x1a\x07\x01\x00'):
        pos = 8 + 4  # header CRC32
        size, pos = _vint(head, pos)
        kind, _ = _vint(head, pos)
        return kind == 4
    if head.startswith(b'Rar!\x1a\x07\x00'):
        # marker block (7 bytes), then the main header: CRC (2), type 0x73 (1), flags (2)
        if len(head) >= 12 and head[9] == 0x73:
            (flags,) = struct.unpack_from('<H', head, 10)
            return bool(flags & 0x0080)
    return False


def _vint(data, pos):
    value, shift = 0, 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7f) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7
    return None, pos


# past ARCHIVE_MAX_ENTRIES, a non-zip archive's entry names are still checked, up to this many times the cap
NAME_CHECK_FACTOR = 10


def zip_declared(path, state):
    """Python's zipfile: the central directory's declared sizes, encryption flags and every name."""
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
    except Exception:
        return None
    total = sum(info.file_size for info in infos)
    encrypted = any(info.flag_bits & 0x1 for info in infos)
    return total, encrypted, [info.filename for info in infos if info.flag_bits & 0x1], \
        [info.filename for info in infos]


def check_names(state, names):
    """The blocked-name check for entries that weren't read (past the cap, or after an error)."""
    for name in names:
        if blocked_entry_name(name) and name not in state.blocked:
            state.blocked.append(name)


def inspect_archive(path, state, depth=1, images=None, workdir=None):
    """List `path` without extracting (libarchive, streamed), recursing into nested archives
    (<= 100 MiB) to ARCHIVE_MAX_DEPTH."""
    import libarchive
    limits = state.limits
    state.depth = max(state.depth, depth)
    head = read_head(path, 4096)
    if rar_headers_encrypted(head):
        state.encrypted = True
        return
    declared = zip_declared(path, state) if head.startswith(ZIP_MAGIC) or head.startswith(b'PK') else None
    if declared is not None:
        total, encrypted, _, names = declared
        state.unpacked += total
        state.encrypted = state.encrypted or encrypted
        # the central directory names every entry: all of them get the name check, read or not
        check_names(state, names)
        if state.unpacked > limits['max_unpacked'] or state.unpacked > limits['max_ratio'] * state.size:
            # a bomb by its own declaration: nothing more to read
            return
    read_here = 0
    try:
        with libarchive.file_reader(path) as archive:
            for entry in archive:
                if state.entries >= limits['max_entries']:
                    state.partial = True
                    if declared is not None or state.names_only >= limits['max_entries'] * NAME_CHECK_FACTOR:
                        break
                    # past the cap: the name check only (the entry's data is skipped, never read)
                    state.names_only += 1
                    check_names(state, [entry.pathname or ''])
                    continue
                state.entries += 1
                read_here += 1
                name = entry.pathname or ''
                if blocked_entry_name(name) and name not in state.blocked:
                    state.blocked.append(name)
                if declared is None and entry.size:
                    state.unpacked += int(entry.size)
                    if state.unpacked > limits['max_unpacked'] or state.unpacked > limits['max_ratio'] * state.size:
                        return
                if _entry_encrypted(entry):
                    state.encrypted = True
                    continue
                if not entry.isfile:
                    continue
                _inspect_entry(entry, name, state, depth, images, workdir)
    except libarchive.ArchiveError as error:
        message = str(error).lower()
        if any(word in message for word in ('encrypt', 'passphrase', 'password', 'decryption')):
            state.encrypted = True
        else:
            state.errors.append(str(error)[:200])
            if read_here:
                # it broke part-way: what's after the error wasn't checked (the zip central
                # directory's names were, above)
                state.partial = True


def _inspect_entry(entry, name, state, depth, images, workdir):
    limits = state.limits
    ext = extension_of(name.rsplit('/', 1)[-1])
    size = entry.size or 0
    wants_image = images is not None and depth == 1 and state.images < limits['max_images'] and \
        0 < size <= limits['max_image_bytes'] and ext in IMAGE_EXTENSIONS
    nested = depth < limits['max_depth'] and 0 < size <= NESTED_MAX_BYTES and (
        ext in ARCHIVE_EXTENSIONS or ext is None)
    keep_all = wants_image or nested
    head = bytearray()
    body = None
    if keep_all:
        body = tempfile.NamedTemporaryFile(dir=workdir, delete=False)
    try:
        for block in entry.get_blocks():
            if len(head) < HEAD_BYTES:
                head += block[:HEAD_BYTES - len(head)]
            if body is not None:
                body.write(block)
            elif len(head) >= HEAD_BYTES:
                break
        if filetypes.sniff_executable(bytes(head)):
            state.blocked.append(name)
        if body is None:
            return
        body.close()
        head = bytes(head)
        is_image = ext in IMAGE_EXTENSIONS or head.startswith((b'\x89PNG', b'\xff\xd8\xff', b'GIF8', b'RIFF'))
        if wants_image and is_image:
            Image = pillow()
            try:
                with Image.open(body.name) as im:
                    im.load()
                    images.add(im.convert('RGB'), 'archive_entry')
                    state.images += 1
            except Exception:
                pass
        if nested and _looks_like_archive(head, ext):
            inspect_archive(body.name, state, depth + 1, images=None, workdir=workdir)
    finally:
        if body is not None:
            body.close()
            os.unlink(body.name)


def _looks_like_archive(head, ext):
    if ext in ARCHIVE_EXTENSIONS:
        return True
    return head.startswith((ZIP_MAGIC, SEVEN_ZIP_MAGIC, RAR_MAGIC, b'\x1f\x8b', b'BZh', b'\xfd7zXZ\x00',
                            b'\x28\xb5\x2f\xfd')) or (len(head) > 262 and head[257:262] == b'ustar')


# --- Office (§5.4) ---------------------------------------------------------------------------------------

EXTERNAL_REL_TYPES = ('attachedtemplate', 'oleobject', 'frame', 'subdocument', 'externallinkpath',
                      'externallink', 'package')
EXTERNAL_TARGET = re.compile(r'^\s*(https?:|\\\\|//|file:)', re.IGNORECASE)
REL_PATTERN = re.compile(r'<Relationship\b[^>]*>', re.IGNORECASE)
ATTR_PATTERN = re.compile(r'(\w+)\s*=\s*"([^"]*)"')


def inspect_office(path):
    """VBA macros (OOXML vbaProject.bin, OLE VBA streams), XLM macros, DDE, and external
    template or OLE links over http(s) or UNC all block (`blocked_type`)."""
    result = {'vba': False, 'xlm': False, 'dde': False, 'external': []}
    if zipfile.is_zipfile(path):
        try:
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                lowered = [n.lower() for n in names]
                if any(n.endswith('vbaproject.bin') for n in lowered):
                    result['vba'] = True
                if any(n.startswith('xl/macrosheets/') or n.endswith('/xlm') for n in lowered):
                    result['xlm'] = True
                for name in names:
                    if not name.lower().endswith('.rels'):
                        continue
                    text = archive.read(name)[:4 * 1024 * 1024].decode('utf-8', 'replace')
                    for tag in REL_PATTERN.findall(text):
                        attrs = {k.lower(): v for k, v in ATTR_PATTERN.findall(tag)}
                        kind = attrs.get('type', '').rsplit('/', 1)[-1].lower()
                        if attrs.get('targetmode', '').lower() == 'external' and kind in EXTERNAL_REL_TYPES \
                                and EXTERNAL_TARGET.match(attrs.get('target', '')):
                            result['external'].append(attrs.get('target', '')[:200])
                content = archive.read('[Content_Types].xml').decode('utf-8', 'replace') \
                    if '[Content_Types].xml' in names else ''
                if 'macrosheet' in content.lower():
                    result['xlm'] = True
        except Exception as error:
            result['error'] = str(error)[:200]
    try:
        from oletools.olevba import VBA_Parser
        parser = VBA_Parser(path)
        try:
            if parser.detect_vba_macros():
                result['vba'] = True
            try:
                if parser.detect_xlm_macros():
                    result['xlm'] = True
            except Exception:
                pass
        finally:
            parser.close()
    except Exception as error:
        # not an Office file oletools understands (or a broken one): nothing to run in it
        result.setdefault('error', str(error)[:200])
    try:
        from oletools import msodde
        links = msodde.process_file(path) or ''
        if links.strip():
            result['dde'] = True
    except Exception:
        pass
    result['blocked'] = bool(result['vba'] or result['xlm'] or result['dde'] or result['external'])
    return result


# --- PDFs (§5.5) -----------------------------------------------------------------------------------------

PDF_NAME = re.compile(rb'/(?:[A-Za-z0-9_.+\-]|#[0-9A-Fa-f]{2})+')
# A JavaScript action always names its type (`/S /JavaScript`) and code (`/JS`), so these two find it however
# it's triggered. `/OpenAction` and `/AA` are only triggers: on their own they open the document at a page or a
# zoom (LibreOffice writes `/OpenAction [3 0 R /Fit]` into every PDF it exports), which is harmless. They're
# recorded (`triggers`), not flagged; what they trigger is what's judged (milestone-4 §5.5, revised 2026-11-25:
# every Office document converted to PDF was being flagged).
PDF_JAVASCRIPT = frozenset(('JavaScript', 'JS'))
PDF_TRIGGERS = frozenset(('OpenAction', 'AA'))
PDF_DANGEROUS = frozenset(('Launch', 'RichMedia'))
PDF_WATCH = PDF_JAVASCRIPT | PDF_TRIGGERS | PDF_DANGEROUS | {'EmbeddedFile', 'URI'}
URI_PATTERN = re.compile(rb'/URI\s*\(((?:\\.|[^\\)])*)\)')
CHUNK = 1024 * 1024
OVERLAP = 512


def pdf_names(path):
    """The watched PDF names (name escapes like /J#61vaScript normalised) in a file."""
    found = set()
    uris = []
    with open(path, 'rb') as handle:
        carry = b''
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            data = carry + chunk
            for token in PDF_NAME.findall(data):
                name = re.sub(rb'#([0-9A-Fa-f]{2})', lambda m: bytes([int(m.group(1), 16)]), token[1:])
                name = name.decode('latin-1')
                if name in PDF_WATCH:
                    found.add(name)
            for raw in URI_PATTERN.findall(data):
                if len(uris) < URL_LIMIT:
                    uris.append(raw.decode('latin-1').replace('\\)', ')').replace('\\(', '('))
            carry = data[-OVERLAP:]
    return found, uris


def inspect_pdf(path, workdir):
    from safety.webrisk import extract_urls
    names, uris = pdf_names(path)
    result = {'qpdf': False, 'encrypted': pdf_requires_password(path)}
    expanded = os.path.join(workdir, 'qdf.pdf')
    # a PDF with a user password can't be expanded (its streams can't be read): like an encrypted
    # archive (§5.3), anonymous uploads are rejected and signed-in ones get the `encrypted_pdf` warning
    try:
        if not result['encrypted']:
            sandbox_tool(['qpdf', '--qdf', '--object-streams=disable', '--decrypt', path, expanded], ok_codes=(0, 3))
        if os.path.exists(expanded):
            more, more_uris = pdf_names(expanded)
            names |= more
            uris += more_uris
            result['qpdf'] = True
    except Exception as error:
        # a qpdf crash, timeout or limit is a retry; a PDF qpdf can't parse is recorded
        reraise_resource(error)
        result['qpdf_error'] = str(error)[:200]
    finally:
        if os.path.exists(expanded):
            os.unlink(expanded)
    embedded = pdf_attachments(path, workdir) if 'EmbeddedFile' in names else []
    result['javascript'] = sorted(names & PDF_JAVASCRIPT)
    result['triggers'] = sorted(names & PDF_TRIGGERS)
    result['dangerous'] = sorted(names & PDF_DANGEROUS)
    result['embedded'] = embedded
    if any(item['blocked'] for item in embedded):
        result['dangerous'] = sorted(set(result['dangerous']) | {'EmbeddedFile'})
    text = ''
    try:
        text = sandbox_tool(['pdftotext', '-q', '-enc', 'UTF-8', path, '-'])[:TEXT_URL_BYTES].decode('utf-8', 'replace')
    except Exception:
        pass
    urls = extract_urls(' '.join(uris) + '\n' + text, URL_LIMIT)
    return result, urls


def pdf_requires_password(path):
    """qpdf --requires-password: exit 0 when a user password is needed to open the PDF, 2 when it
    isn't encrypted, 3 when it's encrypted with an owner password only (readable)."""
    try:
        sandbox_tool(['qpdf', '--requires-password', path])
    except Exception as error:
        reraise_resource(error)
        return False
    return True


def pdf_attachments(path, workdir):
    """[{name, blocked}] of the PDF's embedded files, by name and by sniffed content."""
    try:
        listing = sandbox_tool(['qpdf', '--list-attachments', path], ok_codes=(0, 3)).decode('utf-8', 'replace')
    except Exception:
        return [{'name': None, 'blocked': False, 'error': 'unlisted'}]
    out = []
    for line in listing.splitlines():
        match = re.match(r'^(\S.*?) -> ', line)
        if not match:
            continue
        key = match.group(1).strip()
        blocked = blocked_entry_name(key)
        try:
            data = sandbox_tool(['qpdf', '--show-attachment=' + key, path], ok_codes=(0, 3))[:HEAD_BYTES]
            if filetypes.sniff_executable(data):
                blocked = True
            else:
                import magic
                if filetypes.blocked_mimetype(filetypes.trusted_sniff(magic.from_buffer(data, mime=True), data)):
                    blocked = True
        except Exception:
            pass
        out.append({'name': key[:200], 'blocked': blocked})
        if len(out) >= 50:
            break
    return out


# --- polyglots (§5.5) --------------------------------------------------------------------------------------

def image_end(data):
    """Where the image or PDF format's own data ends in `data` (bytes or an mmap), and its name;
    (None, None) if unknown."""
    head = bytes(data[:16])
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        pos = 8
        while pos + 8 <= len(data):
            (length,) = struct.unpack_from('>I', data, pos)
            kind = data[pos + 4:pos + 8]
            pos += 12 + length
            if kind == b'IEND':
                return pos, 'png'
        return None, 'png'
    if head.startswith(b'\xff\xd8'):
        return _jpeg_end(data), 'jpeg'
    if head.startswith((b'GIF87a', b'GIF89a')):
        return _gif_end(data), 'gif'
    if head.startswith(b'RIFF') and head[8:12] == b'WEBP':
        (size,) = struct.unpack_from('<I', head, 4)
        return 8 + size + (size & 1), 'webp'
    if head.startswith(b'BM') and len(head) >= 6:
        (size,) = struct.unpack_from('<I', head, 2)
        return size, 'bmp'
    if head.startswith(b'%PDF'):
        end = data.rfind(b'%%EOF')
        return (end + 5 if end >= 0 else None), 'pdf'
    return None, None


def _jpeg_end(data):
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            return None
        marker = data[pos + 1]
        if marker == 0xD9:
            return pos + 2
        if marker in (0x01,) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        (length,) = struct.unpack_from('>H', data, pos + 2)
        pos += 2 + length
        if marker == 0xDA:
            # entropy-coded data: runs until a marker that isn't FF00 or a restart (found with
            # find(), not byte by byte: this can be hundreds of megabytes)
            while True:
                pos = data.find(b'\xff', pos)
                if pos < 0 or pos + 1 >= len(data):
                    return None
                following = data[pos + 1]
                if following != 0x00 and not 0xD0 <= following <= 0xD7:
                    break
                pos += 1
    return None


def _gif_end(data):
    if len(data) < 13:
        return None
    flags = data[10]
    pos = 13 + (3 * (2 ** ((flags & 7) + 1)) if flags & 0x80 else 0)
    while pos < len(data):
        block = data[pos]
        if block == 0x3B:
            return pos + 1
        if block == 0x21:
            pos += 2
        elif block == 0x2C:
            if pos + 10 > len(data):
                return None
            local = data[pos + 9]
            pos += 10 + (3 * (2 ** ((local & 7) + 1)) if local & 0x80 else 0) + 1
        else:
            return None
        while pos < len(data):
            size = data[pos]
            pos += 1 + size
            if size == 0:
                break
    return None


def find_appended(path, workdir, limit=512 * 1024 * 1024):
    """An archive appended after an image's or PDF's end: (finding, carved path) or (None, None).
    The file is memory-mapped, not read, and the carved tail is copied a piece at a time."""
    import mmap
    size = os.path.getsize(path)
    if size == 0 or size > limit:
        return None, None
    with open(path, 'rb') as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
        end, container = image_end(data)
        if end is None or end >= size:
            return None, None
        for signature, kind in ARCHIVE_SIGNATURES:
            offset = data.find(signature, end)
            if offset < 0:
                continue
            start = offset
            # a zip is carved from the image's end (its offsets may point before the first local
            # header); so is an end record without local headers here
            carve_from = end if kind == 'zip' else start
            if kind == 'zip' and signature == b'PK\x05\x06':
                start = end
            carved = os.path.join(workdir, 'appended.' + kind)
            with open(carved, 'wb') as out:
                for piece in range(carve_from, size, CHUNK):
                    out.write(data[piece:min(size, piece + CHUNK)])
            return {'container': container, 'offset': start, 'archive': kind}, carved
    return None, None


# --- running tools inside this sandbox -------------------------------------------------------------------

_deadline = [None]


def sandbox_tool(cmd, ok_codes=(0,)):
    import time
    remaining = max(1.0, _deadline[0] - time.monotonic()) if _deadline[0] else 60.0
    try:
        return sandbox.run(cmd, timeout=remaining, cpu_seconds=sandbox.SCAN_CPU, new_session=False,
                           env=sandbox.clean_env(), address_space=sandbox.SCAN_ADDRESS_SPACE)
    except sandbox.Failed as error:
        if error.returncode in ok_codes:
            return error.stdout or b''
        raise


# --- the scan --------------------------------------------------------------------------------------------

def scan(path, outdir, hints, deadline=None):
    import time
    _deadline[0] = deadline or (time.monotonic() + float(hints.get('budget') or 110))
    limits = {
        'max_entries': int(hints.get('archive_max_entries', 10000)),
        'max_depth': int(hints.get('archive_max_depth', 3)),
        'max_unpacked': int(hints.get('archive_max_unpacked', 21474836480)),
        'max_ratio': int(hints.get('archive_max_ratio', 1000)),
        'max_images': int(hints.get('archive_max_matched_images', 100)),
        'max_image_bytes': int(hints.get('archive_max_image_bytes', 20971520)),
    }
    size = os.path.getsize(path)
    head = read_head(path)
    sniffed = sniff(path)
    workdir = tempfile.mkdtemp(dir=outdir, prefix='work-')
    names = [hints.get('filename')] + [n for n in hints.get('filenames') or ()]
    types = Types([hints.get('mimetype'), sniffed] + list(hints.get('types') or ()),
                  [hints.get('extension')] + [extension_of(n) for n in names if n], head)
    images = Images(outdir)
    result = {'sniffed': sniffed, 'types': sorted(types.mimetypes), 'size': size, 'decodable': None,
              'archive': None, 'office': None, 'pdf': None, 'polyglot': [], 'urls': [], 'nsfw_batch': None,
              'blocked_types': types.blocked()}
    if filetypes.sniff_executable(head):
        result['blocked_types'].append('executable:' + filetypes.sniff_executable(head))

    animated = False
    if types.video():
        result['decodable'] = video_frames(path, workdir, images)
    elif types.audio():
        cover_art(path, workdir, images)
    elif types.image():
        result['decodable'], animated = image_frames(path, images)
    if types.pdf():
        pdf_pages(path, workdir, images)
        result['pdf'], urls = inspect_pdf(path, workdir)
        result['urls'] += urls
    if types.office():
        result['office'] = inspect_office(path)
    archive_state = None
    if types.archive():
        archive_state = ArchiveState(limits, size)
        inspect_archive(path, archive_state, images=images, workdir=workdir)
    if types.image() or types.pdf():
        finding, carved = find_appended(path, workdir)
        if finding is not None:
            result['polyglot'].append(finding)
            if archive_state is None:
                archive_state = ArchiveState(limits, size)
            inspect_archive(carved, archive_state, depth=1, images=None, workdir=workdir)
            os.unlink(carved)
    if archive_state is not None:
        result['archive'] = archive_state.result()
    if types.text() and not types.pdf():
        from safety.webrisk import extract_urls
        with open(path, 'rb') as handle:
            text = handle.read(TEXT_URL_BYTES).decode('utf-8', 'replace')
        result['urls'] += extract_urls(text, URL_LIMIT)
    result['urls'] = list(dict.fromkeys(result['urls']))[:URL_LIMIT]
    result['kind'] = primary_kind(types, animated)
    result['images'] = images.items
    result['pdq'] = images.pdq
    if hints.get('nsfw', True) and images.pil:
        # the scan job classifies them with its own, already loaded model (media/nsfw.py)
        from media import nsfw
        result['nsfw_batch'] = nsfw.write_batch([image for _, _, image in images.pil], outdir)
    return result
