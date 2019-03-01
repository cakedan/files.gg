from flask import Blueprint, request
from flask_restful import reqparse
from peewee import prefetch

from models import Mimetypes, MimetypeExtensions
from utils.responses import ApiError, ApiResponse

mimetypes = Blueprint('mimetypes', __name__, url_prefix='/mimetypes')


@mimetypes.route('', methods=['GET'])
def fetch_mimetypes():
    mimetypes = Mimetypes.select()
    extensions = MimetypeExtensions.select()
    group = prefetch(mimetypes, extensions)
    return ApiResponse([x.to_dict() for x in group])


create_mimetype_parser = reqparse.RequestParser()
create_mimetype_parser.add_argument('mimetype', required=True)
create_mimetype_parser.add_argument('extension')
create_mimetype_parser.add_argument('flags', type=int, default=0)
create_mimetype_parser.add_argument('priority', type=int, default=0)

@mimetypes.route('', methods=['POST'])
def mimetype_create():
    raise ApiError(status=403)
    args = create_mimetype_parser.parse_args()

    args.mimetype = args.mimetype.lower()
    args.extension = args.extension and args.extension.lower()

    mimetype = Mimetypes.get_or_none(id=args.mimetype)
    if mimetype is None:
        mimetype = Mimetypes.create(id=args.mimetype, flags=args.flags)
    else:
        mimetype.flags = args.flags
        mimetype.save()

    if args.extension is not None:
        extension = MimetypeExtensions.get_or_none(mimetype=mimetype, extension=args.extension)
        if extension is None:
            extension = MimetypeExtensions.create(mimetype=mimetype, extension=args.extension, priority=args.priority)
        else:
            extension.priority = args.priority
            extension.save()

    print(args.mimetype, args.extension)
    return ApiResponse([args.mimetype, args.extension])
