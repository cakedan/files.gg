from utils.tokens import FingerprintToken, UserToken


MIN_SNOWFLAKE = 0
MAX_SNOWFLAKE = 9223372036854775807
def snowflake(snowflake_id):
    try:
        snowflake_id = int(snowflake_id)
    except:
        raise ValueError('{} is not a valid Snowflake'.format(snowflake_id))
    if snowflake_id < MIN_SNOWFLAKE or MAX_SNOWFLAKE < snowflake_id:
        raise ValueError('Snowflake value should be {} <= snowflake <= {}'.format(MIN_SNOWFLAKE, MAX_SNOWFLAKE))
    return snowflake_id


def email(email):
    email = str(email)
    parts = email.split('@')
    if len(parts) != 2:
        raise ValueError('Not a well formed email address')
    alias, domain = parts
    if not len(alias) or len(domain) < 3 or '.' not in domain:
        raise ValueError('Not a well formed email address')
    if 128 < len(email):
        raise ValueError('Must be 128 characters or fewer in length')

    if 64 < len(alias):
        raise ValueError('Email alias must be under 64 characters')
    if 255 < len(domain):
        raise ValueError('Email domain must be under 255 characters')
    return email


def username(username):
    username = str(username)
    if len(username) < 3:
        raise ValueError('Must be 3 characters or longer in length')
    if 32 < len(username):
        raise ValueError('Must be 32 characters or fewer in length')
    return username


MIN_DISCRIMINATOR = 1
MAX_DISCRIMINATOR = 9999
def discriminator(discriminator):
    try:
        discriminator = int(discriminator)
    except:
        raise ValueError('Must be an integer')
    if discriminator < MIN_DISCRIMINATOR or MAX_DISCRIMINATOR < discriminator:
        raise ValueError('Discriminator value should be {} <= discriminator <= {}'.format(MIN_DISCRIMINATOR, MAX_DISCRIMINATOR))
    return discriminator


def password(password):
    password = str(password)
    if len(password) < 6:
        raise ValueError('Must be at 6 characters or longer in length')
    return password


def fingerprint(fingerprint):
    try:
        return int(FingerprintToken.deconstruct(fingerprint))
    except:
        return None


def token_email(serializer, max_age=259200):
    # max_age = 3 days
    def parameter(token):
        try:
            # max_age = 3 days
            payload = serializer.deconstruct(token, max_age=max_age)
        except Exception as error:
            raise ValueError('Invalid Token')
        if not isinstance(payload, dict):
            raise ValueError('Invalid Token')
        if 'user_id' not in payload or 'email' not in payload:
            raise ValueError('Invalid Token')
        return payload
    return parameter


def token_authorization(token):
    parts = str(token).split(' ')
    if len(parts) == 1:
        auth_type = 'user'
    elif len(parts) == 2:
        auth_type = parts.pop(0).lower()
    else:
        raise ValueError('Invalid Token')

    token = parts.pop(0)
    try:
        if auth_type == 'user':
            user_id = UserToken.deconstruct(token)
        elif auth_type == 'bot':
            user_id = UserToken.deconstruct(token)
    except:
        raise ValueError('Invalid Token')

    return auth_type, user_id, token
