from functools import wraps
from typing import Annotated, Optional

from sanic import Blueprint
from sanic.exceptions import NotFound

import db
from db import queries
from utils.params import Arg, Args
from utils.responses import ApiError, ApiResponse
from utils.wrappers import authenticate, parse_args, route

import utils.helpers as helpers
import utils.parameters as parameters


# Sanic URL-encodes static route segments ('@' -> '%40') but matches the raw
# request path, so '/users/@me' is routed as '/users/<me>' and anything other
# than '@me' is a 404. GET /users/@me itself is dispatched by views.users.
me = Blueprint('me', url_prefix='/users/<me:str>')


def only_me(func):
    @wraps(func)
    async def wrapper(request, *args, me, **kwargs):
        if me != '@me':
            raise NotFound('Not Found')
        return await func(request, *args, **kwargs)
    return wrapper


@authenticate()
async def fetch_me(request, user):
    return ApiResponse(user.to_dict(me=True))


@route(me, '/mimetypes', ['GET'])
@only_me
@authenticate()
async def fetch_me_mimetypes(request, user):
    async with db.connection() as conn:
        group = await queries.list_user_mimetypes(conn, user.id)
    return ApiResponse([x.to_dict() for x in group])


class FileCountArgs(Args):
    authorization: Annotated[Optional[str], Arg('authorization', location='headers')] = None
    fingerprint: Annotated[Optional[int], Arg('x-fingerprint', location='headers', type=parameters.fingerprint)] = None
    mimetype: Annotated[Optional[str], Arg(location='args')] = None
    type: Annotated[Optional[str], Arg(location='args')] = None


@route(me, '/file-count', ['GET'])
@only_me
@parse_args(FileCountArgs)
async def fetch_me_file_count(request, args):
    if args.authorization is None and args.fingerprint is None:
        raise ApiError(status=401)

    if args.mimetype is not None and args.type is not None:
        raise ApiError('Choose Mimetype or Type, not both')

    async with db.connection() as conn:
        if args.type is not None:
            if not await queries.mimetype_type_exists(conn, args.type):
                raise ApiError(metadata={'errors': {'type': 'Invalid Type'}})

        if args.mimetype is not None:
            if await queries.get_mimetype(conn, args.mimetype) is None:
                raise ApiError(metadata={'errors': {'mimetype': 'Invalid Mimetype'}})

        if args.authorization is not None:
            user = await helpers.get_user(conn, args.authorization)
            count = await queries.count_files(conn, user_id=user.id, type_id=args.type, mimetype_id=args.mimetype)
        else:
            count = await queries.count_files(conn, fingerprint=args.fingerprint, type_id=args.type,
                                              mimetype_id=args.mimetype)

    return ApiResponse({'count': count})
