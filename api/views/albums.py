"""Album access endpoints from contract §5. Albums themselves are Milestone 3,
so until then every album is unknown."""

from sanic import Blueprint

from utils import errors
from utils.wrappers import route

albums = Blueprint('albums', url_prefix='/albums')


@route(albums, '/<vanity:path>/unlock', ['POST'])
async def unlock_album(request, vanity):
    raise errors.unknown_album()


@route(albums, '/<vanity:path>/unlock/refresh', ['POST'])
async def refresh_album_unlock(request, vanity):
    raise errors.unknown_album()


@route(albums, '/<vanity:path>/view', ['GET'])
async def view_album(request, vanity):
    raise errors.unknown_album()
