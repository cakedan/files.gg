import hashlib
import random
import re
import string

from flask import current_app, Blueprint, request
from flask_restful import inputs, reqparse
from peewee import fn, JOIN

from models import File, FileHash, FileView, Mimetype, MimetypeExtension, MimetypeType
from utils.errors import InvalidMimetype, UnknownFile
from utils.generators import Snowflake
from utils.responses import ApiError, ApiResponse
from utils.wrappers import authenticate, parse_args

import utils.helpers as helpers
import utils.parameters as parameters

files = Blueprint('files', __name__, url_prefix='/files')


parser_get_files = reqparse.RequestParser(trim=True)
parser_get_files.add_argument('authorization', location='headers')
parser_get_files.add_argument('x-fingerprint', location='headers', dest='fingerprint', type=parameters.fingerprint)
parser_get_files.add_argument('limit', type=int, default=100, choices=range(1, 101), help='Must be at least or in between 1 and 100')
parser_get_files.add_argument('after', location='args', type=parameters.snowflake)
parser_get_files.add_argument('before', location='args', type=parameters.snowflake)
parser_get_files.add_argument('mimetype', location='args')
parser_get_files.add_argument('type', location='args')

@files.route('', methods=['GET'])
@parse_args(parser_get_files)
def fetch_files(args):
    if args.authorization is None and args.fingerprint is None:
        raise ApiError(status=401)

    if args.after is not None and args.before is not None:
        raise ApiError('Choose between before or after, not both')

    if args.mimetype is not None and args.type is not None:
        raise ApiError('Choose Mimetype or Type, not both')

    mtype = None
    if args.type is not None:
        mtype = MimetypeType.get_or_none(id=args.type)
        if mtype is None:
            raise ApiError(metadata={'errors': {'type': 'Invalid Type'}})

    mimetype = None
    if args.mimetype is not None:
        mimetype = Mimetype.get_or_none(id=args.mimetype)
        if mimetype is None:
            raise ApiError(metadata={'errors': {'mimetype': 'Invalid Mimetype'}})

    files = (File
            .select(File, FileHash)
            .join(FileHash)
            .switch(File)
            .order_by(File.id.desc())
            .limit(args.limit))
    total = File.select(fn.COUNT(File.id).alias('count'))

    if args.authorization is not None:
        user = helpers.get_user(args.authorization)
        files = files.where(File.user == user)
        total = total.where(File.user == user)
    else:
        files = files.where(File.fingerprint == args.fingerprint)
        total = total.where(File.fingerprint == args.fingerprint)

    if mtype is not None:
        files = (files
                .join(Mimetype, JOIN.RIGHT_OUTER, on=(Mimetype.id == File.mimetype))
                .join(MimetypeType, JOIN.RIGHT_OUTER, on=(MimetypeType.id == Mimetype.type))
                .where(MimetypeType.id == mtype)
                .switch(File))
        total = (total
                .join(Mimetype, JOIN.RIGHT_OUTER, on=(Mimetype.id == File.mimetype))
                .join(MimetypeType, JOIN.RIGHT_OUTER, on=(MimetypeType.id == Mimetype.type))
                .where(MimetypeType.id == mtype)
                .switch(File))

    if mimetype is not None:
        files = files.where(File.mimetype == mimetype)
        total = total.where(File.mimetype == mimetype)

    if args.after is not None:
        files = files.where(File.id > args.after)
    elif args.before is not None:
        files = files.where(File.id < args.before)

    return ApiResponse({
        'total': total.scalar(),
        'files': [x.to_dict() for x in files],
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

parser_create_files = reqparse.RequestParser(trim=True)
parser_create_files.add_argument('filename', location='values')
parser_create_files.add_argument('vanity', location='values', default='')
parser_create_files.add_argument('type', location='values', default='multipart', choices=('multipart', 'raw'), help='Invalid Upload Type')
parser_create_files.add_argument('authorization', location='headers')
parser_create_files.add_argument('x-fingerprint', location='headers', dest='fingerprint', type=parameters.fingerprint)

@files.route('', methods=['POST'])
@parse_args(parser_create_files)
def create_file(args):
    fingerprint = user = None
    if args.authorization is not None:
        try:
            user = helpers.get_user(args.authorization)
        except:
            raise ApiError('Invalid Authentication')

    if args.fingerprint is not None and user is None:
        fingerprint = args.fingerprint

    min_vanity = max_vanity = args.vanity.count('/')
    for part in args.vanity.split('/'):
        minv, maxv = parse_vanity_part(part)
        min_vanity += minv
        max_vanity += maxv

    if min_vanity < MIN_VANITY_LENGTH or MAX_VANITY_LENGTH < max_vanity:
        raise ApiError('Vanity has to be at least or in between {} and {} characters long'.format(MIN_VANITY_LENGTH, MAX_VANITY_LENGTH))

    fextension = None
    if args.type == 'multipart':
        storage = next(request.files.values(), None)
        if storage is None:
            raise ApiError('A file must be uploaded')
        if args.filename is None:
            args.filename = storage.filename
        else:
            # get original extension from uploaded file
            # just incase we generate filename in future
            if '.' in storage.filename:
                fextension = storage.filename.split('.')[-1]
        mimetype = storage.mimetype
        stream = storage.stream
        stream.seek(0, 2)
        fsize = stream.tell()
        stream.seek(0)
    elif args.type == 'raw':
        mimetype = request.mimetype
        stream = request.stream
        fsize = request.content_length
    else:
        raise ApiError('Invalid Upload Type')

    #check filesize

    fname = None
    if args.filename is None:
        fname = [generate_vanity()]
    else:
        fname = args.filename.split('.')

    if 1 < len(fname):
        # do we want to use the original filename's extension all the time?
        if fextension is None:
            fextension = fname.pop(-1)
        elif fextension.lower() == fname[-1].lower():
            fextension = fname.pop(-1)

    mime = Mimetype.get_or_none(id=mimetype)
    if mime is None:
        if fextension is None:
            raise InvalidMimetype()
        mextension = MimetypeExtension.get_or_none(extension=fextension.lower())
        if mextension is None:
            raise InvalidMimetype()
        # mime = mextension.mime
        mimetype = mextension.mimetype_id
    else:
        # use extension to determine filetype
        if mime.id == 'application/octet-stream':
            if fextension is not None:
                mextension = MimetypeExtension.get_or_none(extension=fextension.lower())
                if mextension is not None:
                    mimetype = mextension.mimetype_id
    # check flags

    if fextension is not None:
        mextension = MimetypeExtension.get_or_none(mimetype=mimetype, extension=fextension.lower())
        # keep extension incase its not found
        if mextension is None:
            fname.append(fextension)
            fextension = None
        else:
            # set it to the stored version, just this or fextension.lower()
            fextension = mextension.extension

    if fextension is None:
        mextension = (MimetypeExtension
                    .select()
                    .where(MimetypeExtension.mimetype == mimetype)
                    .order_by(MimetypeExtension.priority.desc())
                    .limit(1)
                    .execute())
        if mextension:
            fextension = mextension[0].extension
        else:
            if mimetype.endswith('+json'):
                fextension = 'json'
            elif mimetype.endswith('+xml'):
                fextension = 'xml'

    fname = '.'.join(fname)[:256] # just incase they send a huge text lol
    while '{random}' in fname:
        fname = fname.replace('{random}', generate_vanity(), 1)
    fname = re.sub(FILENAME_REGEX, '_', fname[:128])

    # we read the filedata now to get the hashes of it
    fdata = stream.read(fsize)

    hblake2b = hashlib.blake2b(fdata).hexdigest()
    hmd5 = hashlib.md5(fdata).hexdigest()
    hsha1 = hashlib.sha1(fdata).hexdigest()

    fid = Snowflake.generate()
    fhash = FileHash.get_or_none(blake2b=hblake2b, md5=hmd5, sha1=hsha1)
    if fhash is None:
        fhash = FileHash.create(
            id=Snowflake.generate(),
            blake2b=hblake2b,
            md5=hmd5,
            sha1=hsha1,
            size=fsize,
        )
        # upload it now
        bucket = current_app.gcs.get_bucket(current_app.config.storage_bucket)
        blob = bucket.blob('files/{}'.format(fhash.id))
        blob.upload_from_string(fdata, content_type='application/octet-stream', predefined_acl='publicRead')

    unique = False
    while not unique:
        fvanity = generate_vanity(args.vanity)
        unique = bool(File.get_or_none(vanity=fvanity) is None)

    fobj = File.create(
        id=fid,
        vanity=fvanity,
        mimetype=mimetype,
        extension=fextension,
        filename=fname,
        hash=fhash,
        user=user,
        fingerprint=fingerprint,
    )
    return ApiResponse(fobj.to_dict())


parser_fetch_file = reqparse.RequestParser(trim=True)
parser_fetch_file.add_argument('vanity', location='view_args')

@files.route('/<path:vanity>', methods=['GET'])
@parse_args(parser_fetch_file)
def fetch_file(args):
    vanity = args.vanity.split('.').pop(0)
    fobj = File.get_or_none(vanity=vanity)
    if fobj is None:
        raise UnknownFile()

    ip = request.remote_addr
    if FileView.get_or_none(file=fobj, ip=ip) is None:
        FileView.create(file=fobj, ip=ip)
        fobj.view_count += 1
        fobj.save()

    return ApiResponse(fobj.to_dict())


parser_delete_file = reqparse.RequestParser(trim=True)
parser_delete_file.add_argument('vanity', location='view_args')

@files.route('/<path:vanity>', methods=['DELETE'])
@parse_args(parser_delete_file)
@authenticate()
def delete_file(args, user):
    return args.vanity
