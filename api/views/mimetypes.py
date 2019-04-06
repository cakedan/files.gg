from flask import Blueprint, request
from flask_restful import reqparse
from peewee import prefetch

from models import Mimetype, MimetypeExtension, MimetypeType
from utils.responses import ApiError, ApiResponse
from utils.wrappers import authenticate, parse_args

mimetypes = Blueprint('mimetypes', __name__, url_prefix='/mimetypes')



@mimetypes.route('', methods=['GET'])
def fetch_mimetypes():
    mimetypes = Mimetype.select()
    extensions = MimetypeExtension.select()
    group = prefetch(mimetypes, extensions)
    return ApiResponse([x.to_dict() for x in group])

@mimetypes.route('/<mtype>', methods=['GET'])
def fetch_mimetype_types(mtype):
    mtype = MimetypeType.get_or_none(id=mtype)
    if mtype is None:
        raise ApiError('Unknown Type', status=404)

    mimetypes = Mimetype.select().where(Mimetype.type == mtype)
    extensions = MimetypeExtension.select()
    group = prefetch(mimetypes, extensions)
    return ApiResponse([x.to_dict() for x in group])

@mimetypes.route('/<mtype>/<subtype>', methods=['GET'])
def fetch_mimetype(mtype, subtype):
    mimetype = Mimetype.get_or_none(id='{}/{}'.format(mtype, subtype))
    if mimetype is None:
        raise ApiError('Unknown Mimetype', status=404)
    return ApiResponse(mimetype.to_dict())



@mimetypes.route('/<mtype>', methods=['PUT'])
@authenticate()
def put_type(mtype, user):
    raise ApiError(status=403)

    mtype = MimetypeType.get_or_create(id=mtype.lower())
    return ApiResponse(status=204)


parser_create_mimetype = reqparse.RequestParser(trim=True)
parser_create_mimetype.add_argument('extension')
parser_create_mimetype.add_argument('flags', type=int)
parser_create_mimetype.add_argument('priority', type=int)

@mimetypes.route('/<mtype>/<subtype>', methods=['PUT'])
@parse_args(parser_create_mimetype)
@authenticate()
def put_mimetype(args, mtype, subtype, user):
    raise ApiError(status=403)

    mtype = mtype.lower()
    subtype = subtype.lower()

    if MimetypeType.get_or_none(id=mtype) is None:
        raise ApiError('Unknown Type', status=404)

    defaults = {'type': mtype}
    if args.flags is not None:
        defaults['flags'] = args.flags

    mimetype = Mimetype.get_or_none(id='{}/{}'.format(mtype, subtype))
    if mimetype is None:
        mimetype = Mimetype.create(
            id='{}/{}'.format(mtype, subtype),
            flags=args.flags or 0,
            type=mtype,
        )
    else:
        if args.flags is not None:
            mimetype.flags = args.flags
            mimetype.save()

    if args.extension is not None:
        extension = MimetypeExtension.get_or_none(mimetype=mimetype, extension=args.extension)
        if extension is None:
            extension = MimetypeExtension.create(
                mimetype=mimetype,
                extension=args.extension,
                priority=args.priority or 0,
            )
        else:
            if args.priority is not None:
                extension.priority = args.priority
                extension.save()

    return ApiResponse(status=204)
