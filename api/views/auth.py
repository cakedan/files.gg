from flask import Blueprint, request
from flask_restful import reqparse
from werkzeug.security import generate_password_hash, check_password_hash

from models import User
from utils.generators import Snowflake, TimestampToken, Token
from utils.responses import ApiError, ApiResponse

auth = Blueprint('auth', __name__, url_prefix='/auth')


get_fingerprint_parser = reqparse.RequestParser(trim=True)
get_fingerprint_parser.add_argument('x-fingerprint', location='headers', dest='fingerprint')


@auth.route('/fingerprint', methods=['GET'])
def auth_fingerprint():
    args = get_fingerprint_parser.parse_args()

    fingerprint = None
    if args.fingerprint is not None:
        try:
            fingerprint = Token.deconstruct(args.fingerprint)
        except:
            pass

    if fingerprint is None:
        fingerprint = Snowflake.generate()

    return ApiResponse({'fingerprint': Token.generate(fingerprint)})


@auth.route('/login', methods=['POST'])
def auth_login():
    return 'login'


@auth.route('/logout', methods=['POST'])
def auth_logout():
    return 'logout'


create_account_parser = reqparse.RequestParser(trim=True)
create_account_parser.add_argument('email', required=True)
create_account_parser.add_argument('username', required=True)
create_account_parser.add_argument('password', required=True)
create_account_parser.add_argument('captcha', required=True)
create_account_parser.add_argument('x-fingerprint', location='headers', dest='fingerprint')

@auth.route('/register', methods=['POST'])
def auth_register():
    args = create_account_parser.parse_args()

    fingerprint = None
    if args.fingerprint is not None:
        try:
            fingerprint = Token.deconstruct(args.fingerprint)
            if User.get_or_none(id=fingerprint) is not None:
                fingerprint = None
        except:
            pass

    uid = None
    if fingerprint is None:
        uid = Snowflake.generate()
    else:
        uid = fingerprint

    # create user, transfer all files from fingerprint to user
    # store last_password_reset as timestamp (from TimestampToken.get_timestamp()), then do min_timestamp=last_password_reset
    return ApiResponse({
        'id': uid,
        'token': TimestampToken.generate('{}.test'.format(uid)),
        'password': generate_password_hash(args.password),
    })


verify_account_parser = reqparse.RequestParser(trim=True)
verify_account_parser.add_argument('token', required=True)

@auth.route('/verify', methods=['POST'])
def auth_verify():
    args = verify_account_parser.parse_args()

    try:
        # 604800 is 1 week in seconds
        payload = TimestampToken.deconstruct(args.token, max_age=604800)
        # user_id, email
        # set verified to true on user object
    except:
        raise ApiError(status=401)
    return ApiResponse(status=204)
