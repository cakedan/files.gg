"""Shared upload rules: names and mimetypes, access options, quotas, hashing,
and streaming request bodies to a temp file (PLAN.md "Limits", "Expiry",
"Private and password-protected files")."""

import hashlib
import os
import re
import tempfile
import time

from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs

from sanic.request.parameters import RequestParameters

from db import queries
from utils import limits as limits_module
from utils import passwords, view_hash
from utils import errors
from utils.generators import EPOCH
from utils.responses import ApiError
from utils.vanity import generate_vanity

UPLOAD_TMP_DIR = os.getenv('UPLOAD_TMP_DIR') or None
FILENAME_REGEX = r'([\\\/?%*:|"<>])'
UNLOCK_TTLS = (600, 3600, 86400, 604800, 2592000)
VISIBILITIES = ('link', 'password', 'private')
# form fields (not files) in a multipart body: per field and in total
MAX_FIELD_BYTES = 64 * 1024
MAX_FIELDS_BYTES = 256 * 1024
# multipart framing on top of the file itself, allowed in the Content-Length pre-check
MULTIPART_SLACK = 1024 * 1024
ROLLING_WINDOW = 24 * 3600
IP_PURPOSE = 'upload-ip'


def utcnow():
    return datetime.now(timezone.utc)


def from_epoch(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc)


def mimetype_of(content_type):
    """Werkzeug's `.mimetype`: lowercased, without parameters."""
    return (content_type or '').split(';', 1)[0].strip().lower()


def boolean(value):
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ('1', 'true', 'yes', 'on'):
        return True
    if text in ('0', 'false', 'no', 'off', ''):
        return False
    raise ValueError('Must be true or false')


def positive_int(value):
    number = int(value)
    if number <= 0:
        raise ValueError('Must be a positive number')
    return number


def unlock_ttl(value):
    number = int(value)
    if number not in UNLOCK_TTLS:
        raise ValueError('Must be one of {}'.format(', '.join(str(x) for x in UNLOCK_TTLS)))
    return number


class Hasher:
    def __init__(self):
        self.blake2b = hashlib.blake2b()
        self.md5 = hashlib.md5()
        self.sha1 = hashlib.sha1()
        self.size = 0

    def update(self, data):
        self.blake2b.update(data)
        self.md5.update(data)
        self.sha1.update(data)
        self.size += len(data)

    def digests(self):
        return self.blake2b.hexdigest(), self.md5.hexdigest(), self.sha1.hexdigest()


# --- names and mimetypes -------------------------------------------------------------

async def resolve_name(conn, filename, fextension, mimetype):
    """(name, extension, mimetype) as `POST /files` always resolved them.
    Raises INVALID_MIMETYPE for types files.gg doesn't accept."""
    if filename is None:
        fname = [generate_vanity()]
    else:
        fname = filename.split('.')

    if 1 < len(fname):
        if fextension is None:
            fextension = fname.pop(-1)
        elif fextension.lower() == fname[-1].lower():
            fextension = fname.pop(-1)

    mime = await queries.get_mimetype(conn, mimetype)
    if mime is None:
        if fextension is None:
            raise errors.invalid_mimetype()
        mextension = await queries.get_extension(conn, fextension.lower())
        if mextension is None:
            raise errors.invalid_mimetype()
        mimetype = mextension.mimetype_id
    else:
        if mime.id == 'application/octet-stream':
            if fextension is not None:
                mextension = await queries.get_extension(conn, fextension.lower())
                if mextension is not None:
                    mimetype = mextension.mimetype_id

    if fextension is not None:
        mextension = await queries.get_extension(conn, fextension.lower(), mimetype_id=mimetype)
        if mextension is None:
            fname.append(fextension)
            fextension = None
        else:
            fextension = mextension.extension

    if fextension is None:
        mextension = await queries.get_top_extension(conn, mimetype)
        if mextension:
            fextension = mextension.extension
        else:
            if mimetype.endswith('+json'):
                fextension = 'json'
            elif mimetype.endswith('+xml'):
                fextension = 'xml'

    fname = '.'.join(fname)[:256]
    while '{random}' in fname:
        fname = fname.replace('{random}', generate_vanity(), 1)
    fname = re.sub(FILENAME_REGEX, '_', fname[:128])
    return fname, fextension, mimetype


# --- access options ------------------------------------------------------------------

def private_requires_account():
    return ApiError('Private files need an account', 400, code='PRIVATE_REQUIRES_ACCOUNT')


async def resolve_access(user, visibility=None, password=None, generate_password=False, unlock_ttl=None,
                         password_expires_in=None):
    """Access columns for a new file. Returns (columns, generated password or None)."""
    if password is not None or generate_password:
        visibility = visibility or 'password'
    visibility = visibility or 'link'
    if visibility == 'private' and user is None:
        raise private_requires_account()
    columns = {'visibility': visibility, 'password_hash': None, 'unlock_ttl': unlock_ttl or 3600,
               'password_expires_at': None}
    generated = None
    if visibility == 'password':
        if generate_password:
            password = generated = passwords.generate_passphrase()
        if password is None:
            raise errors.password_required()
        columns['password_hash'] = await passwords.hash(password)
        if password_expires_in is not None:
            columns['password_expires_at'] = utcnow() + timedelta(seconds=password_expires_in)
    return columns, generated


# --- quotas ------------------------------------------------------------------------------

def snowflake_since(seconds):
    """The smallest Snowflake id minted `seconds` ago (ids sort by time)."""
    return max(0, int(time.time() * 1000) - EPOCH - seconds * 1000) << 22


class Owner:
    """Who an upload counts against: a user, or a fingerprint and IP."""

    def __init__(self, user, fingerprint, ip, secret):
        self.user = user
        self.fingerprint = None if user is not None else fingerprint
        self.limits = limits_module.get_limits(user)
        self.ip_hashes = [] if user is not None else view_hash.recent_hashes(secret, IP_PURPOSE, ip)

    @property
    def ip_hash(self):
        return self.ip_hashes[0] if self.ip_hashes else None

    def lock_keys(self):
        if self.user is not None:
            return ['user:{}'.format(self.user.id)]
        keys = ['ip:' + self.ip_hash.hex()]
        if self.fingerprint is not None:
            keys.append('fingerprint:{}'.format(self.fingerprint))
        return keys

    async def usage(self, conn):
        if self.user is not None:
            return await queries.user_usage(conn, self.user.id)
        by_fingerprint, by_ip = await queries.anonymous_usage(
            conn, self.fingerprint, self.ip_hashes, snowflake_since(ROLLING_WINDOW))
        return max(by_fingerprint, by_ip)

    async def check(self, conn, adding, lock=False):
        """Raise STORAGE_LIMIT_REACHED if `adding` more bytes would exceed the
        storage limit (signed in) or the rolling 24 h cap (anonymous). With
        `lock`, hold the owner's quota lock until the transaction ends."""
        if lock:
            await queries.lock_quota(conn, *self.lock_keys())
        limit = self.limits.daily_bytes if self.user is None else self.limits.storage_bytes
        used = await self.usage(conn)
        if limit is not None and used + adding > limit:
            raise limits_module.storage_limit_reached(limit, used)
        return used


# --- request bodies ------------------------------------------------------------------------

class TooLarge(Exception):
    pass


def _new_tempfile():
    return tempfile.NamedTemporaryFile(prefix='upload-', dir=UPLOAD_TMP_DIR, delete=False)


class Spooled:
    """A request body (or one multipart file) on disk, with its hashes."""

    def __init__(self):
        self.handle = _new_tempfile()
        self.path = self.handle.name
        self.hasher = Hasher()
        self.filename = None
        self.content_type = None

    def write(self, data, limit):
        if self.hasher.size + len(data) > limit:
            raise TooLarge()
        self.hasher.update(data)
        self.handle.write(data)

    def close(self):
        if not self.handle.closed:
            self.handle.close()

    def discard(self):
        self.close()
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass

    @property
    def size(self):
        return self.hasher.size


async def spool_body(request, limit):
    """Stream the raw body to a temp file while hashing. Raises TooLarge."""
    spooled = Spooled()
    try:
        while True:
            chunk = await request.stream.read()
            if chunk is None:
                break
            if chunk:
                spooled.write(chunk, limit)
        spooled.close()
    except BaseException:
        spooled.discard()
        raise
    return spooled


async def read_capped(request, limit):
    body = bytearray()
    while True:
        chunk = await request.stream.read()
        if chunk is None:
            break
        body += chunk
        if len(body) > limit:
            raise TooLarge()
    return bytes(body)


async def read_urlencoded(request):
    body = await read_capped(request, MAX_FIELDS_BYTES)
    return RequestParameters(parse_qs(body.decode('utf-8', 'replace'), keep_blank_values=True))


async def read_multipart(request, limit):
    """Stream a multipart body: the first file part goes to a temp file (hashed
    on the way), form fields are kept in memory (capped). Returns
    (RequestParameters of fields, Spooled or None). Raises TooLarge."""
    from python_multipart.multipart import MultipartParser, parse_options_header

    _, options = parse_options_header(request.content_type or '')
    boundary = options.get(b'boundary')
    if not boundary:
        raise errors.file_required()

    fields = {}
    state = {'headers': {}, 'field': None, 'value': None, 'kind': None, 'name': None,
             'header_field': b'', 'header_value': b'', 'fields_bytes': 0}
    upload = {'spooled': None}

    def on_part_begin():
        state.update(headers={}, kind=None, name=None, value=None, header_field=b'', header_value=b'')

    def on_header_field(data, start, end):
        state['header_field'] += data[start:end]

    def on_header_value(data, start, end):
        state['header_value'] += data[start:end]

    def on_header_end():
        state['headers'][state['header_field'].decode('latin-1').lower()] = state['header_value']
        state['header_field'] = state['header_value'] = b''

    def on_headers_finished():
        disposition, params = parse_options_header(state['headers'].get('content-disposition', b''))
        name = params.get(b'name', b'').decode('utf-8', 'replace')
        state['name'] = name
        if b'filename' in params:
            if upload['spooled'] is None:
                spooled = Spooled()
                spooled.filename = params[b'filename'].decode('utf-8', 'replace')
                spooled.content_type = state['headers'].get('content-type', b'').decode('latin-1')
                upload['spooled'] = spooled
                state['kind'] = 'file'
            else:
                state['kind'] = 'ignored'
        else:
            state['kind'] = 'field'
            state['value'] = bytearray()

    def on_part_data(data, start, end):
        if state['kind'] == 'file':
            upload['spooled'].write(data[start:end], limit)
        elif state['kind'] == 'field':
            state['value'] += data[start:end]
            state['fields_bytes'] += end - start
            if len(state['value']) > MAX_FIELD_BYTES or state['fields_bytes'] > MAX_FIELDS_BYTES:
                raise TooLarge()

    def on_part_end():
        if state['kind'] == 'field':
            fields.setdefault(state['name'], []).append(bytes(state['value']).decode('utf-8', 'replace'))
        elif state['kind'] == 'file':
            upload['spooled'].close()

    parser = MultipartParser(boundary, {
        'on_part_begin': on_part_begin,
        'on_header_field': on_header_field,
        'on_header_value': on_header_value,
        'on_header_end': on_header_end,
        'on_headers_finished': on_headers_finished,
        'on_part_data': on_part_data,
        'on_part_end': on_part_end,
    })
    try:
        while True:
            chunk = await request.stream.read()
            if chunk is None:
                break
            if chunk:
                parser.write(chunk)
        parser.finalize()
    except BaseException:
        if upload['spooled'] is not None:
            upload['spooled'].discard()
        raise
    if upload['spooled'] is not None:
        upload['spooled'].close()
    return RequestParameters(fields), upload['spooled']


# --- albums (Milestone 3: `album=<vanity>` on uploads) ------------------------------------------------

async def resolve_album(conn, user, vanity):
    """The id of the caller's own live album `vanity`, None when no album was asked for.
    Unknown, foreign or anonymous: INVALID_ALBUM, before anything is uploaded. A full
    album is ALBUM_FULL."""
    from db import albums as album_queries
    if vanity is None or vanity == '':
        return None
    if user is None:
        raise errors.invalid_album()
    album = await album_queries.get_album_by_vanity(conn, vanity.strip())
    if album is None or album.owner_user_id != user.id:
        raise errors.invalid_album()
    limit = limits_module.get_limits(user).album_max_files
    if await album_queries.item_count(conn, album.id) >= limit:
        raise errors.album_full(limit)
    return album.id


async def append_to_album(conn, album_id, file_id, limit):
    from db import albums as album_queries
    from jobs.media import queue_collage_async
    await album_queries.append_file(conn, album_id, file_id, limit)
    await queue_collage_async(conn, album_id)
