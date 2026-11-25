"""Upload defaults (contract milestone-5 §21): the account's `{ expires_in, visibility, nsfw }`, stored in
`users.upload_defaults`. Upload-key uploads (`POST /files`, `POST /uploads` with `Authorization: Key`) and conversions
get them for the fields they don't send; website uploads with the session cookie never do (the Upload page sends what
it shows).

`visibility: "password"` always means a generated password per file: no password is stored. Each value is checked
against the account's limits when it's set and again when it's used, so one the limits no longer allow (an expiry
past a lowered `max_expiry`) falls back to the plain default: `link`, the limits' default expiry, not adult."""

from utils import errors, limits as limits_module, uploading

KEYS = ('expires_in', 'visibility', 'nsfw')
FIELD = 'settings.upload_defaults'


def plain(limits):
    return {'expires_in': limits.default_expiry, 'visibility': 'link', 'nsfw': False}


def expiry_problem(limits, value):
    """Why `value` (seconds, or None for never) isn't an expiry this account can use, else None."""
    if value is None:
        return None if limits.allow_no_expiry else 'Pick when files expire'
    if isinstance(value, bool) or not isinstance(value, int):
        return 'Must be a number of seconds, or null for never'
    if value < limits_module.MIN_EXPIRY:
        return 'Must be at least an hour'
    if limits.max_expiry is not None and value > limits.max_expiry:
        days = limits.max_expiry // limits_module.DAY
        return 'Must be at most {} day{}'.format(days, '' if days == 1 else 's')
    return None


def of(user, limits=None):
    """The defaults in effect for `user`: each stored value the limits still allow, else the plain default."""
    limits = limits or limits_module.get_limits(user)
    stored = user.upload_defaults or {}
    defaults = plain(limits)
    if 'expires_in' in stored and expiry_problem(limits, stored['expires_in']) is None:
        defaults['expires_in'] = stored['expires_in']
    if stored.get('visibility') in uploading.VISIBILITIES:
        defaults['visibility'] = stored['visibility']
    if isinstance(stored.get('nsfw'), bool):
        defaults['nsfw'] = stored['nsfw']
    return defaults


def update(user, value):
    """The object to store for `PATCH /users/@me { settings: { upload_defaults } }`: the fields given (any of them),
    over the defaults in effect. 400 INVALID_PARAMETERS names each bad field."""
    if not isinstance(value, dict):
        raise errors.invalid_parameters({FIELD: 'Must be an object'})
    limits = limits_module.get_limits(user)
    problems = {}
    for name in value:
        if name not in KEYS:
            problems['{}.{}'.format(FIELD, name)] = 'Unknown setting'
    if 'expires_in' in value:
        problem = expiry_problem(limits, value['expires_in'])
        if problem:
            problems[FIELD + '.expires_in'] = problem
    if 'visibility' in value and value['visibility'] not in uploading.VISIBILITIES:
        problems[FIELD + '.visibility'] = 'Must be one of {}'.format(', '.join(uploading.VISIBILITIES))
    if 'nsfw' in value and not isinstance(value['nsfw'], bool):
        problems[FIELD + '.nsfw'] = 'Must be true or false'
    if problems:
        raise errors.invalid_parameters(problems)
    return {**of(user, limits), **value}


def for_key_upload(args, user):
    """An upload key's request args with the owner's defaults for what it didn't send (§21). Sending `password` or
    `generate_password=true` says the visibility (`password`), as it does for every upload."""
    defaults = of(user)
    sent = args.model_fields_set
    changes = {}
    if 'expires_in' not in sent:
        changes['expires_in'] = defaults['expires_in']
    if 'visibility' not in sent and args.password is None and not args.generate_password:
        changes['visibility'] = defaults['visibility']
        changes['generate_password'] = defaults['visibility'] == 'password'
    if 'nsfw' not in sent:
        changes['nsfw'] = defaults['nsfw']
    return args.model_copy(update=changes)
