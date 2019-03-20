from datetime import datetime
from urllib.parse import quote
import time

from flask import Blueprint, request
from flask_restful import reqparse
from werkzeug.security import generate_password_hash, check_password_hash

from models import File, User
from utils.generators import Snowflake
from utils.mailgun import Mailgun
from utils.recaptcha import Recaptcha
from utils.responses import ApiError, ApiResponse
from utils.tokens import FingerprintToken, EmailForgotToken, EmailVerifyToken, UserToken

import utils.parameters as parameters
import utils.wrappers as wrappers

auth = Blueprint('auth', __name__, url_prefix='/auth')


parser_get_fingerprint = reqparse.RequestParser(trim=True)
parser_get_fingerprint.add_argument('x-fingerprint', location='headers', dest='fingerprint', type=parameters.fingerprint)

@auth.route('/fingerprint', methods=['GET'])
@wrappers.parse_args(parser_get_fingerprint)
def auth_fingerprint(args):
    fingerprint = args.fingerprint
    if fingerprint is not None:
        if User.get_or_none(id=fingerprint) is not None:
            fingerprint = None

    if fingerprint is None:
        fingerprint = Snowflake.generate()

    return ApiResponse({
        'fingerprint': FingerprintToken.generate(fingerprint),
    })


parser_login = reqparse.RequestParser(trim=True)
parser_login.add_argument('email', required=True, type=parameters.email)
parser_login.add_argument('password', required=True, type=parameters.password)
parser_login.add_argument('captcha', required=True)
parser_login.add_argument('x-fingerprint', location='headers', dest='fingerprint', type=parameters.fingerprint)

@auth.route('/login', methods=['POST'])
@wrappers.parse_args(parser_login)
def auth_login(args):
    response = Recaptcha.verify(args.captcha)
    if response.status_code != 200:
        raise ApiError(metadata={'errors': {'captcha': 'Error verifying Captcha'}})
    captcha = response.json()
    if not captcha['success']:
        raise ApiError(metadata={'errors': {'captcha': 'Invalid Captcha'}})

    user = User.get_or_none(email=args.email)
    if user is None:
        raise ApiError('Invalid Email or Password')

    if not check_password_hash(user.password, args.password):
        raise ApiError('Invalid Email or Password')

    if args.fingerprint is not None:
        query = File.update(user=user, fingerprint=None).where(File.fingerprint == args.fingerprint)
        query.execute()

    return ApiResponse({
        'token': UserToken.generate(user.id),
    })


@auth.route('/logout', methods=['POST'])
@wrappers.authenticate()
def auth_logout(user):
    return ApiResponse(status=204)


parser_create_account = reqparse.RequestParser(trim=True)
parser_create_account.add_argument('email', required=True, type=parameters.email)
parser_create_account.add_argument('username', required=True, type=parameters.username)
parser_create_account.add_argument('password', required=True, type=parameters.password)
parser_create_account.add_argument('captcha', required=True)
parser_create_account.add_argument('x-fingerprint', location='headers', dest='fingerprint', type=parameters.fingerprint)

@auth.route('/register', methods=['POST'])
@wrappers.parse_args(parser_create_account)
def auth_register(args):
    # set up discriminator generator later
    discriminator = 1
    if User.get_or_none(username=args.username, discriminator=discriminator):
        raise ApiError(metadata={'errors': {'username': 'Already taken'}})

    response = Recaptcha.verify(args.captcha)
    if response.status_code != 200:
        raise ApiError(metadata={'errors': {'captcha': 'Error verifying Captcha'}})
    captcha = response.json()
    if not captcha['success']:
        raise ApiError(metadata={'errors': {'captcha': 'Invalid Captcha'}})

    response = Mailgun.verify_email(args.email, True)
    if response.status_code != 200:
        raise ApiError(metadata={'errors': {'email': 'Error checking email'}})
    mail = response.json()
    if not mail['is_valid'] or mail['is_disposable_address'] or mail['mailbox_verification'] != 'true':
        raise ApiError(metadata={'errors': {'email': 'Invalid Email'}})

    if User.get_or_none(email=args.email):
        raise ApiError(metadata={'errors': {'email': 'Already Taken'}})

    if args.fingerprint is not None:
        if User.get_or_none(id=args.fingerprint) is not None:
            args.fingerprint = None

    uid = None
    if args.fingerprint is not None:
        uid = args.fingerprint
    else:
        uid = Snowflake.generate()

    user = User.create(
        id=uid,
        email=args.email,
        username=args.username,
        discriminator=discriminator,
        password=generate_password_hash(args.password, salt_length=10),
    )

    if args.fingerprint is not None:
        query = File.update(user=user, fingerprint=None).where(File.fingerprint == args.fingerprint)
        query.execute()

    token = EmailVerifyToken.generate({'user_id': uid, 'email': args.email})
    Mailgun.send_mail({
        'from': '"files.gg" <noreply@files.gg>',
        'to': '"{username}" <{email}>'.format(username=quote(args.username), email=args.email),
        'subject': 'Verify Email',
        'template': 'auth-verify',
    }, {
        'email': args.email,
        'username': args.username,
        'discriminator': '{:04d}'.format(discriminator),
        'url': 'https://files.gg/auth/verify/{}'.format(token),
    })

    return ApiResponse({
        'token': UserToken.generate(uid)
    })


parser_verify_account = reqparse.RequestParser(trim=True)
parser_verify_account.add_argument('token', required=True)
parser_verify_account.add_argument('token', required=True, dest='payload', type=parameters.token_email(EmailVerifyToken))

@auth.route('/verify', methods=['POST'])
@wrappers.parse_args(parser_verify_account)
def auth_verify(args):
    try:
        user = User.get_or_none(id=args.payload['user_id'])
        if not user:
            raise ValueError('Invalid Token')
        min_timestamp = user.last_email_reset.timestamp() - EmailVerifyToken.epoch
        if not EmailVerifyToken.validate(args.token, min_timestamp=min_timestamp):
            raise ValueError('Invalid Token')
    except Exception as error:
        raise ApiError(metadata={'errors': {'token': str(error)}})

    user.email = args.payload['email']
    user.last_email_reset = time.time()
    user.verified = True
    user.save()
    return ApiResponse(status=204)


@auth.route('/verify/resend', methods=['POST'])
@wrappers.authenticate()
def auth_verify_resend(user):
    token = EmailVerifyToken.generate({'user_id': user.id, 'email': user.email})
    Mailgun.send_mail({
        'from': '"files.gg" <noreply@files.gg>',
        'to': '"{username}" <{email}>'.format(username=quote(user.username), email=user.email),
        'subject': 'Verify Email',
        'template': 'auth-verify',
    }, {
        'email': user.email,
        'username': user.username,
        'discriminator': '{:04d}'.format(user.discriminator),
        'url': 'https://files.gg/auth/verify/{}'.format(token),
    })
    return ApiResponse(status=204)


parser_forgot = reqparse.RequestParser(trim=True)
parser_forgot.add_argument('email', required=True, type=parameters.email)

@auth.route('/forgot', methods=['POST'])
@wrappers.parse_args(parser_forgot)
def auth_forgot(args):
    user = User.get_or_none(email=args.email)
    if user is None:
        raise ApiError(metadata={'errors': {'email': 'Email not in use'}})

    token = EmailForgotToken.generate({'user_id': user.id, 'email': user.email})
    Mailgun.send_mail({
        'from': 'files.gg <noreply@files.gg>',
        'to': '{username} <{email}>'.format(username=user.username, email=user.email),
        'subject': 'Password Reset',
        'template': 'auth-forgot',
    }, {
        'email': user.email,
        'username': user.username,
        'discriminator': '{:04d}'.format(user.discriminator),
        'url': 'https://files.gg/auth/forgot/{}'.format(token),
    })
    return ApiResponse(status=204)


parser_forgot_reset = reqparse.RequestParser(trim=True)
parser_forgot_reset.add_argument('token', required=True)
parser_forgot_reset.add_argument('token', required=True, dest='payload', type=parameters.token_email(EmailForgotToken))
parser_forgot_reset.add_argument('password', required=True, type=parameters.password)

@auth.route('/forgot/reset', methods=['POST'])
@wrappers.parse_args(parser_forgot_reset)
def auth_forgot_reset(args):
    try:
        user = User.get_or_none(id=args.payload['user_id'])
        if not user:
            raise ValueError('Invalid Token')
        min_timestamp = user.last_password_reset.timestamp() - EmailForgotToken.epoch
        if not EmailForgotToken.validate(args.token, min_timestamp=min_timestamp):
            raise ValueError('Invalid Token')
    except Exception as error:
        raise ApiError(metadata={'errors': {'token': str(error)}})

    if check_password_hash(user.password, args.password):
        raise ApiError(metadata={'errors': {'password': 'Cannot use the same password again'}})

    user.password = generate_password_hash(args.password)
    user.last_password_reset = time.time()
    user.save()
    return ApiResponse(status=204)
