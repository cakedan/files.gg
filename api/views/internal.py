"""Worker <-> API lookups (contract §2), only for requests carrying the
Worker's ORIGIN_SHARED_SECRET. Without it the answer is the same 404 as an
unknown vanity, so the endpoint can't be probed."""

from sanic import Blueprint

import db
from db import queries
from utils import errors, payloads, storage as storage_module
from utils.responses import ApiResponse
from utils.wrappers import route

internal = Blueprint('internal', url_prefix='/internal')


@route(internal, '/files/<vanity:path>', ['GET'])
async def lookup_file(request, vanity):
    if not request.ctx.from_worker:
        raise errors.unknown_file()
    async with db.connection() as conn:
        fobj = await queries.get_file_by_vanity(conn, vanity.split('.').pop(0))
    if fobj is None:
        raise errors.unknown_file()
    return ApiResponse({
        'file': payloads.public_file(fobj),
        'access': payloads.access_dict(fobj),
        'owner_user_id': str(fobj.user_id) if fobj.user_id is not None else None,
        # albums the file is a visible item of, as [{"id", "access_version"}]: the
        # Worker accepts an album token for this file only through this list.
        # Albums arrive in Milestone 3.
        'albums': [],
        'storage': {'backend': fobj.hash.storage_backend, 'key': storage_module.blob_key(fobj.hash_id)},
    })


@route(internal, '/albums/<vanity:path>', ['GET'])
async def lookup_album(request, vanity):
    # albums arrive in Milestone 3: every album is unknown, with or without the secret
    raise errors.unknown_album()
