from flask import Blueprint

from utils.responses import ApiResponse
from utils.wrappers import authenticate

me = Blueprint('me', __name__, url_prefix='/users/@me')


@me.route('', methods=['GET'])
@authenticate()
def fetch_me(user):
    return ApiResponse(user.to_dict(me=True))
