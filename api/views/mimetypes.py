from typing import Annotated, Optional

from sanic import Blueprint

import db
from db import queries
from utils.params import Arg, Args
from utils.responses import ApiError, ApiResponse
from utils.wrappers import authenticate, parse_args, route

mimetypes = Blueprint('mimetypes', url_prefix='/mimetypes')


@route(mimetypes, '', ['GET'])
async def fetch_mimetypes(request):
    async with db.connection() as conn:
        group = await queries.list_mimetypes(conn)
    return ApiResponse([x.to_dict() for x in group])


@route(mimetypes, '/<mtype:str>', ['GET'])
async def fetch_mimetype_types(request, mtype):
    async with db.connection() as conn:
        if not await queries.mimetype_type_exists(conn, mtype):
            raise ApiError('Unknown Type', status=404)
        group = await queries.list_mimetypes(conn, type_id=mtype)
    return ApiResponse([x.to_dict() for x in group])


@route(mimetypes, '/<mtype:str>/<subtype:str>', ['GET'])
async def fetch_mimetype(request, mtype, subtype):
    async with db.connection() as conn:
        mimetype = await queries.get_mimetype(conn, '{}/{}'.format(mtype, subtype), with_extensions=True)
    if mimetype is None:
        raise ApiError('Unknown Mimetype', status=404)
    return ApiResponse(mimetype.to_dict())


# Mimetype editing is disabled (always 403), as before.

@route(mimetypes, '/<mtype:str>', ['PUT'])
@authenticate()
async def put_type(request, mtype, user):
    raise ApiError(status=403)


class PutMimetypeArgs(Args):
    extension: Annotated[Optional[str], Arg()] = None
    flags: Annotated[Optional[int], Arg(type=int)] = None
    priority: Annotated[Optional[int], Arg(type=int)] = None


@route(mimetypes, '/<mtype:str>/<subtype:str>', ['PUT'])
@parse_args(PutMimetypeArgs)
@authenticate()
async def put_mimetype(request, args, mtype, subtype, user):
    raise ApiError(status=403)
