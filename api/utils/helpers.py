from models import User
from utils.generators import TimestampToken
from utils.responses import ApiError

import utils.parameters as parameters


def get_user(token, allow_user=True, allow_bot=False):
    try:
        parsed = parameters.token_authorization(token)
    except:
        raise ApiError(status=401)

    auth_type, user_id, token = parsed
    if auth_type == 'user':
        if not allow_user:
            raise ApiError('Users cannot use this endpoint.', status=401)
        user = User.get_or_none(id=user_id, bot=False)

        min_timestamp = user.last_password_reset.timestamp() - TimestampToken.epoch
        if not TimestampToken.validate(token, min_timestamp):
            raise ApiError(status=401)
    elif auth_type == 'bot':
        if not allow_bot:
            raise ApiError('Bots cannot use this endpoint.', status=401)
        raise ApiError('Bots are not supported currently.', status=401)
    else:
        raise ApiError(status=401)
    return user
