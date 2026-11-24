from werkzeug.security import generate_password_hash

from db import queries
from utils.responses import ApiError
from utils.tokens import UserToken

import utils.parameters as parameters


async def get_user(conn, token, allow_user=True, allow_bot=False):
    try:
        parsed = parameters.token_authorization(token)
    except Exception:
        raise ApiError(status=401)

    auth_type, user_id, token = parsed
    if auth_type == 'user':
        if not allow_user:
            raise ApiError('Users cannot use this endpoint.', status=401)
        user = await queries.get_user(conn, user_id, bot=False)
        if user is None:
            raise ApiError('Unknown User', status=404)

        # tokens issued before the last password reset are rejected (whole seconds)
        min_timestamp = epoch_seconds(user.last_password_reset_at) - UserToken.epoch
        if not UserToken.validate(token, min_timestamp):
            raise ApiError(status=401)
    elif auth_type == 'bot':
        if not allow_bot:
            raise ApiError('Bots cannot use this endpoint.', status=401)
        raise ApiError('Bots are not supported currently.', status=401)
    else:
        raise ApiError(status=401)
    return user


def hash_password(password, **kwargs):
    # Werkzeug 3 defaults to scrypt, whose hashes (~160 chars) do not fit in
    # users.password VARCHAR(128). pbkdf2:sha256 hashes are ~102 chars, and
    # existing hashes keep verifying with check_password_hash.
    return generate_password_hash(password, method='pbkdf2:sha256', **kwargs)


def client_ip(request):
    """The client address resolved for this request (see utils/client_ip.py)."""
    ip = getattr(request.ctx, 'client_ip', None)
    if ip is None:
        from utils import client_ip as resolver
        ip = request.ctx.client_ip = resolver.resolve(
            request.headers, request.ip, request.app.ctx.origin_secret, request.app.ctx.proxies_count)
    return ip


def epoch_seconds(value):
    """Unix seconds of a timestamptz column (0 if unset)."""
    return int(value.timestamp()) if value is not None else 0
