import hashlib
import os
import random
import re
import string
import tempfile

from typing import Annotated, Optional

from sanic import Blueprint

import db
from db import queries
from utils.errors import InvalidMimetype, UnknownFile
from utils.generators import Snowflake
from utils.params import Arg, Args
from utils.responses import ApiError, ApiResponse
from utils.wrappers import authenticate, parse_args, route
from utils import view_hash

import utils.helpers as helpers
import utils.parameters as parameters

files = Blueprint('files', url_prefix='/files')

UPLOAD_TMP_DIR = os.getenv('UPLOAD_TMP_DIR') or None
FORM_TYPES = ('multipart/form-data', 'application/x-www-form-urlencoded')

Authorization = Annotated[Optional[str], Arg('authorization', location='headers')]
Fingerprint = Annotated[Optional[int], Arg('x-fingerprint', location='headers', type=parameters.fingerprint)]


class FetchFilesArgs(Args):
    authorization: Authorization = None
    fingerprint: Fingerprint = None
    limit: Annotated[Optional[int], Arg(type=int, choices=range(1, 101),
                                        help='Must be at least or in between 1 and 100')] = 100
    after: Annotated[Optional[int], Arg(location='args', type=parameters.snowflake)] = None
    before: Annotated[Optional[int], Arg(location='args', type=parameters.snowflake)] = None
    mimetype: Annotated[Optional[str], Arg(location='args')] = None
    type: Annotated[Optional[str], Arg(location='args')] = None


@route(files, '', ['GET'])
@parse_args(FetchFilesArgs)
async def fetch_files(request, args):
    if args.authorization is None and args.fingerprint is None:
        raise ApiError(status=401)

    if args.after is not None and args.before is not None:
        raise ApiError('Choose between before or after, not both')

    if args.mimetype is not None and args.type is not None:
        raise ApiError('Choose Mimetype or Type, not both')

    async with db.connection() as conn:
        if args.type is not None:
            if not await queries.mimetype_type_exists(conn, args.type):
                raise ApiError(metadata={'errors': {'type': 'Invalid Type'}})

        if args.mimetype is not None:
            if await queries.get_mimetype(conn, args.mimetype) is None:
                raise ApiError(metadata={'errors': {'mimetype': 'Invalid Mimetype'}})

        user_id = fingerprint = None
        if args.authorization is not None:
            user = await helpers.get_user(conn, args.authorization)
            user_id = user.id
        else:
            fingerprint = args.fingerprint

        total, items = await queries.list_files(
            conn, user_id=user_id, fingerprint=fingerprint, type_id=args.type,
            mimetype_id=args.mimetype, after=args.after, before=args.before, limit=args.limit,
        )

    return ApiResponse({
        'total': total,
        'files': [x.to_dict() for x in items],
    })


FILENAME_REGEX = r'([\\\/?%*:|"<>])'
MIN_VANITY_LENGTH = 3
MAX_VANITY_LENGTH = 128
MIN_RANDOM_LENGTH = 3
MAX_RANDOM_LENGTH = 16
VANITY_CHOICES_ASCII = string.ascii_lowercase + string.digits
VANITY_PART = r'^(?:\(?((\d+)|\d+\-?\d+)\)?)$'

blacklisted_ids = (
    'assets',
    'auth',
    'dashboard',
    'details',
    'legal',
    'options',
)

def generate_id(length):
    fid = ''.join(random.choice(VANITY_CHOICES_ASCII) for _ in range(length))
    if fid in blacklisted_ids:
        return generate_id(length)
    return fid

def generate_vanity(vanity=''):
    vparts = []
    for part in vanity.split('/'):
        minv, maxv = parse_vanity_part(part)
        vparts.append(generate_id(random.randint(minv, maxv)))
    return '/'.join(vparts)

def parse_vanity_part(part):
    match = re.match(VANITY_PART, part)
    if match is None:
        return (MIN_RANDOM_LENGTH, MAX_RANDOM_LENGTH)
    else:
        parts = match.group(1).split('-')
        if len(parts) == 2:
            minv = int(parts.pop(0))
            maxv = int(parts.pop(0))
            if maxv < minv:
                return (maxv, minv)
            else:
                return (minv, maxv)
        else:
            vlength = int(parts.pop(0))
            return (vlength, vlength)


class CreateFileArgs(Args):
    filename: Annotated[Optional[str], Arg(location='values')] = None
    vanity: Annotated[Optional[str], Arg(location='values')] = ''
    type: Annotated[Optional[str], Arg(location='values', choices=('multipart', 'raw'),
                                       help='Invalid Upload Type')] = 'multipart'
    authorization: Authorization = None
    fingerprint: Fingerprint = None


def mimetype_of(content_type):
    """Werkzeug's `.mimetype`: lowercased, without parameters."""
    return (content_type or '').split(';', 1)[0].strip().lower()


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


async def stream_to_tempfile(request):
    """Write the raw request body to a temp file while hashing it, without
    holding it in memory. Returns (path, Hasher)."""
    hasher = Hasher()
    handle = tempfile.NamedTemporaryFile(prefix='upload-', dir=UPLOAD_TMP_DIR, delete=False)
    try:
        with handle:
            while True:
                chunk = await request.stream.read()
                if chunk is None:
                    break
                if chunk:
                    hasher.update(chunk)
                    handle.write(chunk)
    except BaseException:
        os.unlink(handle.name)
        raise
    return handle.name, hasher


# Streamed so raw uploads go to disk while hashing; form bodies (multipart)
# and JSON bodies are read whole, as before.
async def create_file(request):
    content_mimetype = mimetype_of(request.content_type)
    buffered = content_mimetype in FORM_TYPES or content_mimetype == 'application/json' or (
        content_mimetype.startswith('application/') and content_mimetype.endswith('+json'))
    if buffered:
        await request.receive_body()
    return await _create_file(request, buffered)


create_file.__params_model__ = CreateFileArgs
route(files, '', ['POST'], stream=True)(create_file)


@parse_args(CreateFileArgs)
async def _create_file(request, args, buffered):
    fingerprint = user = None
    async with db.connection() as conn:
        if args.authorization is not None:
            try:
                user = await helpers.get_user(conn, args.authorization)
            except Exception:
                raise ApiError('Invalid Authentication')

    if args.fingerprint is not None and user is None:
        fingerprint = args.fingerprint

    vanity_arg = args.vanity
    min_vanity = max_vanity = vanity_arg.count('/')
    for part in vanity_arg.split('/'):
        minv, maxv = parse_vanity_part(part)
        min_vanity += minv
        max_vanity += maxv

    if min_vanity < MIN_VANITY_LENGTH or MAX_VANITY_LENGTH < max_vanity:
        raise ApiError('Vanity has to be at least or in between {} and {} characters long'.format(MIN_VANITY_LENGTH, MAX_VANITY_LENGTH))

    filename = args.filename
    fextension = None
    fdata = temp_path = None
    if args.type == 'multipart':
        uploads = request.files if buffered else None
        storage = None
        if uploads:
            storage = next(iter(uploads.values()), [None])[0]
        if storage is None:
            raise ApiError('A file must be uploaded')
        if filename is None:
            filename = storage.name
        else:
            # get original extension from uploaded file
            # just incase we generate filename in future
            if storage.name and '.' in storage.name:
                fextension = storage.name.split('.')[-1]
        mimetype = mimetype_of(storage.type)
        fdata = storage.body
        hasher = Hasher()
        hasher.update(fdata)
    elif args.type == 'raw':
        mimetype = mimetype_of(request.content_type)
        if buffered:
            fdata = request.body or b''
            hasher = Hasher()
            hasher.update(fdata)
        else:
            temp_path, hasher = await stream_to_tempfile(request)
    else:
        raise ApiError('Invalid Upload Type')

    try:
        return await _store(request, args, user, fingerprint, filename, fextension, mimetype, hasher, fdata, temp_path)
    finally:
        if temp_path is not None:
            os.unlink(temp_path)


async def _store(request, args, user, fingerprint, filename, fextension, mimetype, hasher, fdata, temp_path):
    async with db.connection() as conn:
        fname = None
        if filename is None:
            fname = [generate_vanity()]
        else:
            fname = filename.split('.')

        if 1 < len(fname):
            # do we want to use the original filename's extension all the time?
            if fextension is None:
                fextension = fname.pop(-1)
            elif fextension.lower() == fname[-1].lower():
                fextension = fname.pop(-1)

        mime = await queries.get_mimetype(conn, mimetype)
        if mime is None:
            if fextension is None:
                raise InvalidMimetype()
            mextension = await queries.get_extension(conn, fextension.lower())
            if mextension is None:
                raise InvalidMimetype()
            mimetype = mextension.mimetype_id
        else:
            # use extension to determine filetype
            if mime.id == 'application/octet-stream':
                if fextension is not None:
                    mextension = await queries.get_extension(conn, fextension.lower())
                    if mextension is not None:
                        mimetype = mextension.mimetype_id
        # check flags

        if fextension is not None:
            mextension = await queries.get_extension(conn, fextension.lower(), mimetype_id=mimetype)
            # keep extension incase its not found
            if mextension is None:
                fname.append(fextension)
                fextension = None
            else:
                # set it to the stored version, just this or fextension.lower()
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

        fname = '.'.join(fname)[:256] # just incase they send a huge text lol
        while '{random}' in fname:
            fname = fname.replace('{random}', generate_vanity(), 1)
        fname = re.sub(FILENAME_REGEX, '_', fname[:128])

        hblake2b, hmd5, hsha1 = hasher.digests()

        fid = Snowflake.generate()
        fhash = await queries.get_file_hash(conn, hblake2b, hmd5, hsha1)
        if fhash is None:
            fhash, created = await queries.create_file_hash(
                conn, Snowflake.generate(), hblake2b, hmd5, hsha1, hasher.size)
            if created:
                # upload it now
                storage = request.app.ctx.storage
                key = 'files/{}'.format(fhash.id)
                if temp_path is not None:
                    await storage.upload_file(key, temp_path)
                else:
                    await storage.upload_bytes(key, fdata)

        fobj = None
        while fobj is None:
            fvanity = generate_vanity(args.vanity)
            if await queries.vanity_exists(conn, fvanity):
                continue
            fobj = await queries.create_file(
                conn,
                id=fid,
                vanity=fvanity,
                mimetype_id=mimetype,
                extension=fextension,
                filename=fname,
                fhash=fhash,
                user=user,
                fingerprint=fingerprint,
            )
    return ApiResponse(fobj.to_dict())


class FileArgs(Args):
    vanity: Annotated[Optional[str], Arg(location='view_args')] = None


def view_ip(request):
    return helpers.client_ip(request)


@route(files, '/<vanity:path>', ['GET'])
@parse_args(FileArgs)
async def fetch_file(request, args):
    vanity = args.vanity.split('.').pop(0)
    async with db.connection() as conn:
        fobj = await queries.get_file_by_vanity(conn, vanity)
        if fobj is None:
            raise UnknownFile()
        day = view_hash.utc_today()
        await queries.record_view(conn, fobj, view_hash.ip_hash(request.app.ctx.view_hash_secret, day, view_ip(request)), day)

    return ApiResponse(fobj.to_dict())


@route(files, '/<vanity:path>', ['DELETE'])
@parse_args(FileArgs)
@authenticate()
async def delete_file(request, args, user):
    return ApiResponse(args.vanity)
