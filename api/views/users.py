from flask import Blueprint
from flask_restful import reqparse

from utils.parameters import snowflake
from utils.responses import ApiResponse
from utils.wrappers import authenticate, parse_args

users = Blueprint('users', __name__, url_prefix='/users')


parser_fetch_user = reqparse.RequestParser(trim=True)
parser_fetch_user.add_argument('user_id', location='view_args', type=snowflake)

@users.route('/<int:user_id>', methods=['GET'])
#@authenticate()
@parse_args(parser_fetch_user)
def fetch_user(args):
    return ApiResponse({'id': args.user_id})
