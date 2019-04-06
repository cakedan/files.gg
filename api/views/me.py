from flask import Blueprint
from flask_restful import reqparse
from peewee import JOIN, prefetch

from models import File, Mimetype, MimetypeExtension, MimetypeType
from utils.responses import ApiError, ApiResponse
from utils.wrappers import authenticate, parse_args

import utils.helpers as helpers
import utils.parameters as parameters


me = Blueprint('me', __name__, url_prefix='/users/@me')


@me.route('', methods=['GET'])
@authenticate()
def fetch_me(user):
    return ApiResponse(user.to_dict(me=True))


@me.route('/mimetypes', methods=['GET'])
@authenticate()
def fetch_me_mimetypes(user):
    mimetypes = (Mimetype
                .select(Mimetype)
                .join(File, JOIN.RIGHT_OUTER)
                .where(File.user == user))
    extensions = MimetypeExtension.select()
    group = prefetch(mimetypes, extensions)
    return ApiResponse([x.to_dict() for x in group])


parser_get_file_count = reqparse.RequestParser(trim=True)
parser_get_file_count.add_argument('authorization', location='headers')
parser_get_file_count.add_argument('x-fingerprint', location='headers', dest='fingerprint', type=parameters.fingerprint)
parser_get_file_count.add_argument('mimetype', location='args')
parser_get_file_count.add_argument('type', location='args')

@me.route('/file-count', methods=['GET'])
@parse_args(parser_get_file_count)
def fetch_me_file_count(args):
    if args.authorization is None and args.fingerprint is None:
        raise ApiError(status=401)

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

    if args.authorization is not None:
        user = helpers.get_user(args.authorization)
        query = File.select().where(File.user == user)
    else:
        query = File.select().where(File.fingerprint == args.fingerprint)

    if mtype is not None:
        query = (query
                .join(Mimetype, JOIN.RIGHT_OUTER, on=(Mimetype.id == File.mimetype))
                .join(MimetypeType, JOIN.RIGHT_OUTER, on=(MimetypeType.id == Mimetype.type))
                .where(MimetypeType.id == mtype)
                .switch(File))

    if mimetype is not None:
        query = query.where(File.mimetype == mimetype)

    return ApiResponse({'count': query.count()})
