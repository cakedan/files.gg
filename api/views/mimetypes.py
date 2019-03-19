from flask import Blueprint, request
from flask_restful import reqparse
from peewee import prefetch

from models import Mimetype, MimetypeExtension
from utils.responses import ApiError, ApiResponse
from utils.wrappers import parse_args

mimetypes = Blueprint('mimetypes', __name__, url_prefix='/mimetypes')


@mimetypes.route('', methods=['GET'])
def fetch_mimetypes():
    mimetypes = Mimetype.select()
    extensions = MimetypeExtension.select()
    group = prefetch(mimetypes, extensions)
    return ApiResponse([x.to_dict() for x in group])


parser_create_mimetype = reqparse.RequestParser(trim=True)
parser_create_mimetype.add_argument('mimetype', required=True)
parser_create_mimetype.add_argument('extension')
parser_create_mimetype.add_argument('flags', type=int, default=0)
parser_create_mimetype.add_argument('priority', type=int, default=0)

@mimetypes.route('', methods=['POST'])
@parse_args(parser_create_mimetype)
def mimetype_create(args):
    raise ApiError(status=403)
    args.mimetype = args.mimetype.lower()
    args.extension = args.extension and args.extension.lower()

    mimetype = Mimetype.get_or_none(id=args.mimetype)
    if mimetype is None:
        mimetype = Mimetype.create(id=args.mimetype, flags=args.flags)
    else:
        mimetype.flags = args.flags
        mimetype.save()

    if args.extension is not None:
        extension = MimetypeExtension.get_or_none(mimetype=mimetype, extension=args.extension)
        if extension is None:
            extension = MimetypeExtension.create(mimetype=mimetype, extension=args.extension, priority=args.priority)
        else:
            extension.priority = args.priority
            extension.save()

    print(args.mimetype, args.extension)
    return ApiResponse([args.mimetype, args.extension])
