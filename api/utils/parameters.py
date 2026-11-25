from utils.tokens import GuestToken


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
    if 254 < len(email):
        raise ValueError('Must be 254 characters or fewer in length')

    if 64 < len(alias):
        raise ValueError('Email alias must be under 64 characters')
    if 255 < len(domain):
        raise ValueError('Email domain must be under 255 characters')
    return email


def guest(token):
    """The guest id a `GuestToken` names, or None when it isn't one of ours."""
    try:
        return int(GuestToken.deconstruct(token))
    except:
        return None
