import re

from typing import Annotated, Optional

from sanic import Blueprint
from sanic.exceptions import NotFound

from utils.parameters import snowflake
from utils.params import Arg, Args
from utils.responses import ApiResponse
from utils.wrappers import parse_args, route
from views.me import fetch_me

users = Blueprint('users', url_prefix='/users')

DIGITS = re.compile(r'\d+')


class FetchUserArgs(Args):
    user_id: Annotated[Optional[int], Arg(location='view_args', type=snowflake)] = None


async def fetch_user(request, user_id):
    if user_id == '@me':
        return await fetch_me(request)
    # Flask's <int:user_id>: unsigned digits only, anything else is a 404
    if not DIGITS.fullmatch(user_id):
        raise NotFound('Not Found')
    return await _fetch_user(request, user_id=user_id)


fetch_user.__params_model__ = FetchUserArgs
route(users, '/<user_id:str>', ['GET'])(fetch_user)


@parse_args(FetchUserArgs)
async def _fetch_user(request, args):
    return ApiResponse({'id': args.user_id})
