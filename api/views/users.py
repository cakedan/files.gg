"""`/users/<id>`: only `@me` exists (contract milestone-6 §8.1, decision 42: no public profiles).

    GET   /users/@me        the user object (§2.1)
    PATCH /users/@me        { display_name?, settings?: { show_name_on_albums? } }
    GET   /users/<id>       404
"""

from sanic import Blueprint
from sanic.exceptions import NotFound

import db
from utils import accounts, errors, params, usernames
from utils.auth import require_session
from utils.responses import ApiResponse
from utils.wrappers import route
from views.me import fetch_me

users = Blueprint('users', url_prefix='/users')


async def fetch_user(request, user_id):
    if user_id == '@me':
        return await fetch_me(request)
    raise NotFound('Not Found')


route(users, '/<user_id:str>', ['GET'])(fetch_user)


@route(users, '/<user_id:str>', ['PATCH'])
async def patch_user(request, user_id):
    if user_id != '@me':
        raise NotFound('Not Found')
    user, _ = require_session(request)
    body = params.request_json(request)
    body = body if isinstance(body, dict) else {}
    changes = {}
    if 'display_name' in body:
        if body['display_name'] is not None and not isinstance(body['display_name'], str):
            raise errors.display_name_invalid('length')
        name = usernames.clean_display_name(body['display_name'])
        reason = usernames.display_name_reason(name)
        if reason:
            raise errors.display_name_invalid(reason)
        changes['display_name'] = name
    settings = body.get('settings')
    if settings is not None:
        if not isinstance(settings, dict):
            raise errors.invalid_parameters({'settings': 'Must be an object'})
        if 'show_name_on_albums' in settings:
            if not isinstance(settings['show_name_on_albums'], bool):
                raise errors.invalid_parameters({'settings.show_name_on_albums': 'Must be true or false'})
            changes['show_name_on_albums'] = settings['show_name_on_albums']
    async with db.connection() as conn:
        if changes:
            await conn.execute('UPDATE users SET {} WHERE id = %s'.format(
                ', '.join('{} = %s'.format(k) for k in changes)), list(changes.values()) + [user.id])
        return ApiResponse(await accounts.user_object(conn, await accounts.load_user(conn, user.id)))
