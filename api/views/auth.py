from typing import Annotated, Any, Optional

from sanic import Blueprint
from werkzeug.security import check_password_hash

import db
from db import queries
from utils.generators import Snowflake
from utils import email_templates
from utils.email import Email
from utils.email_domain import domain_accepts_mail
from utils.params import Arg, Args
from utils.turnstile import Turnstile
from utils.urls import public_url
from utils.responses import ApiError, ApiResponse
from utils.tokens import FingerprintToken, EmailForgotToken, EmailVerifyToken, UserToken
from utils.wrappers import authenticate, parse_args, route

import utils.helpers as helpers
import utils.parameters as parameters

auth = Blueprint('auth', url_prefix='/auth')

Fingerprint = Annotated[Optional[int], Arg('x-fingerprint', location='headers', type=parameters.fingerprint)]


# Turnstile (contract §8) replaced reCAPTCHA. These endpoints predate Milestone 2,
# so they keep their error shape: the token arrives as `turnstile_token` (or the
# legacy `captcha` field) and failures are reported under `captcha`.
Captcha = Annotated[Optional[str], Arg('captcha', aliases=('turnstile_token',))]


async def verify_captcha(request, token, action):
    if not await Turnstile.verify(token, action, helpers.client_ip(request)):
        raise ApiError(metadata={'errors': {'captcha': 'Invalid Captcha'}})


class FingerprintArgs(Args):
    fingerprint: Fingerprint = None


@route(auth, '/fingerprint', ['GET'])
@parse_args(FingerprintArgs)
async def auth_fingerprint(request, args):
    fingerprint = args.fingerprint
    if fingerprint is not None:
        async with db.connection() as conn:
            if await queries.get_user(conn, fingerprint) is not None:
                fingerprint = None

    if fingerprint is None:
        fingerprint = Snowflake.generate()

    return ApiResponse({
        'fingerprint': FingerprintToken.generate(fingerprint),
    })


class LoginArgs(Args):
    email: Annotated[Optional[str], Arg(type=parameters.email)]
    password: Annotated[Optional[str], Arg(type=parameters.password)]
    captcha: Captcha
    fingerprint: Fingerprint = None


@route(auth, '/login', ['POST'])
@parse_args(LoginArgs)
async def auth_login(request, args):
    await verify_captcha(request, args.captcha, 'login')

    async with db.connection() as conn:
        user = await queries.get_user_by_email(conn, args.email)
        if user is None:
            raise ApiError('Invalid Email or Password')

        if not user.password or not check_password_hash(user.password, args.password):
            raise ApiError('Invalid Email or Password')

        if args.fingerprint is not None:
            await queries.claim_fingerprint_files(conn, user.id, args.fingerprint)

    return ApiResponse({
        'token': UserToken.generate(user.id),
    })


@route(auth, '/logout', ['POST'])
@authenticate()
async def auth_logout(request, user):
    return ApiResponse(status=204)


class RegisterArgs(Args):
    email: Annotated[Optional[str], Arg(type=parameters.email)]
    username: Annotated[Optional[str], Arg(type=parameters.username)]
    password: Annotated[Optional[str], Arg(type=parameters.password)]
    captcha: Captcha
    fingerprint: Fingerprint = None


async def send_verify_email(email, username, token):
    subject, html, text = email_templates.verify_email(
        username=username, url=public_url('/auth/verify/{}'.format(token)))
    await Email.send(to=email, to_name=username, subject=subject, html=html, text=text,
                     tag='auth-verify')


@route(auth, '/register', ['POST'])
@parse_args(RegisterArgs)
async def auth_register(request, args):
    # set up discriminator generator later
    discriminator = 1
    async with db.connection() as conn:
        if await queries.user_exists(conn, args.username, discriminator):
            raise ApiError(metadata={'errors': {'username': 'Already taken'}})

    await verify_captcha(request, args.captcha, 'register')

    # Postmark has no mailbox check: reject domains that can't receive mail (keeps bounces low);
    # the verification email is the real proof the mailbox exists
    if not await domain_accepts_mail(args.email):
        raise ApiError(metadata={'errors': {'email': 'Invalid Email'}})

    fingerprint = args.fingerprint
    async with db.connection() as conn:
        if await queries.get_user_by_email(conn, args.email):
            raise ApiError(metadata={'errors': {'email': 'Already Taken'}})

        if fingerprint is not None:
            if await queries.get_user(conn, fingerprint) is not None:
                fingerprint = None

        uid = fingerprint if fingerprint is not None else Snowflake.generate()

        async with conn.transaction():
            await queries.create_user(
                conn,
                id=uid,
                email=args.email,
                username=args.username,
                discriminator=discriminator,
                password=helpers.hash_password(args.password, salt_length=10),
            )
            if fingerprint is not None:
                await queries.claim_fingerprint_files(conn, uid, fingerprint)

    token = EmailVerifyToken.generate({'user_id': uid, 'email': args.email})
    await send_verify_email(args.email, args.username, token)

    return ApiResponse({
        'token': UserToken.generate(uid)
    })


class VerifyArgs(Args):
    token: Annotated[Optional[str], Arg()]
    payload: Annotated[Optional[Any], Arg('token', type=parameters.token_email(EmailVerifyToken))]


@route(auth, '/verify', ['POST'])
@parse_args(VerifyArgs)
async def auth_verify(request, args):
    async with db.connection() as conn:
        try:
            user = await queries.get_user(conn, args.payload['user_id'])
            if not user:
                raise ValueError('Invalid Token')
            min_timestamp = helpers.epoch_seconds(user.last_email_reset_at) - EmailVerifyToken.epoch
            if not EmailVerifyToken.validate(args.token, min_timestamp=min_timestamp):
                raise ValueError('Invalid Token')
        except Exception as error:
            raise ApiError(metadata={'errors': {'token': str(error)}})

        await queries.mark_email_verified(conn, user.id, args.payload['email'])
    return ApiResponse(status=204)


@route(auth, '/verify/resend', ['POST'])
@authenticate()
async def auth_verify_resend(request, user):
    token = EmailVerifyToken.generate({'user_id': user.id, 'email': user.email})
    await send_verify_email(user.email, user.username, token)
    return ApiResponse(status=204)


class ForgotArgs(Args):
    email: Annotated[Optional[str], Arg(type=parameters.email)]
    # optional here so an unknown email still answers as before; checked before any email is sent
    captcha: Annotated[Optional[str], Arg('captcha', aliases=('turnstile_token',))] = None


@route(auth, '/forgot', ['POST'])
@parse_args(ForgotArgs)
async def auth_forgot(request, args):
    async with db.connection() as conn:
        user = await queries.get_user_by_email(conn, args.email)
    if user is None:
        raise ApiError(metadata={'errors': {'email': 'Email not in use'}})
    await verify_captcha(request, args.captcha, 'forgot')

    token = EmailForgotToken.generate({'user_id': user.id, 'email': user.email})
    subject, html, text = email_templates.reset_password(
        username=user.username, url=public_url('/auth/forgot/{}'.format(token)))
    await Email.send(to=user.email, to_name=user.username, subject=subject, html=html, text=text,
                     tag='auth-forgot')
    return ApiResponse(status=204)


class ForgotResetArgs(Args):
    token: Annotated[Optional[str], Arg()]
    payload: Annotated[Optional[Any], Arg('token', type=parameters.token_email(EmailForgotToken))]
    password: Annotated[Optional[str], Arg(type=parameters.password)]


@route(auth, '/forgot/reset', ['POST'])
@parse_args(ForgotResetArgs)
async def auth_forgot_reset(request, args):
    async with db.connection() as conn:
        try:
            user = await queries.get_user(conn, args.payload['user_id'])
            if not user:
                raise ValueError('Invalid Token')
            min_timestamp = helpers.epoch_seconds(user.last_password_reset_at) - EmailForgotToken.epoch
            if not EmailForgotToken.validate(args.token, min_timestamp=min_timestamp):
                raise ValueError('Invalid Token')
        except Exception as error:
            raise ApiError(metadata={'errors': {'token': str(error)}})

        if check_password_hash(user.password, args.password):
            raise ApiError(metadata={'errors': {'password': 'Cannot use the same password again'}})

        await queries.set_password(conn, user.id, helpers.hash_password(args.password))
    return ApiResponse(status=204)
