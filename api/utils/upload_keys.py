"""Upload keys (contract milestone-6 §7): `fgg_` keys for ShareX, scripts and apps. They authenticate only
the upload endpoints, as `Authorization: Key fgg_…`, and are stored as SHA-256."""

import json

from utils import accounts, credentials, errors
from utils.account_settings import account_settings

SCOPES = ('files:upload', 'albums:append')
EXPIRIES = (30 * 86400, 90 * 86400, 365 * 86400)
KEY_COLUMNS = ('id', 'user_id', 'name', 'prefix', 'scopes', 'domain_id', 'created_at', 'expires_at', 'last_used_at',
               'revoked_at', 'revoked_reason')
# revoked and expired keys stay listed this long
LISTED_DAYS = 30
SHAREX_VERSION = '17.0.0'


class UploadKey:
    def __init__(self, row):
        for name, value in zip(KEY_COLUMNS, row):
            setattr(self, name, value)

    def allows(self, scope):
        return scope in (self.scopes or ())


def select(alias='k'):
    return ', '.join('{}.{}'.format(alias, c) for c in KEY_COLUMNS)


async def authenticate(conn, raw):
    """(key, owner) for a usable key, else 401 UPLOAD_KEY_INVALID. The checksum is checked first, so typos
    never reach the database. An owner with a pending deletion gets 403 ACCOUNT_PENDING_DELETION (the key
    works again if the deletion is cancelled)."""
    if not credentials.well_formed(raw, credentials.KEY_PREFIX):
        raise errors.upload_key_invalid()
    cursor = await conn.execute(
        'SELECT {} FROM upload_keys k WHERE k.key_hash = %s AND k.revoked_at IS NULL AND '
        '(k.expires_at IS NULL OR k.expires_at > now())'.format(select()), (credentials.token_hash(raw),))
    row = await cursor.fetchone()
    if row is None:
        raise errors.upload_key_invalid()
    key = UploadKey(row)
    user = await accounts.load_user(conn, key.user_id)
    if user is None:
        raise errors.upload_key_invalid()
    if user.state == 'pending_deletion':
        from db.models import epoch
        raise errors.account_pending_deletion(epoch(user.deletion_scheduled_for))
    # "last used" at most once a minute
    await conn.execute("UPDATE upload_keys SET last_used_at = now() WHERE id = %s AND (last_used_at IS NULL OR "
                       "last_used_at < now() - interval '1 minute')", (key.id,))
    return key, user


async def count_upload(request, key):
    """600 uploads an hour per key (§7.6, UPLOAD_KEY_RATE_PER_HOUR): POST /files and POST /uploads each count one.
    On Redis, open (milestone-5 §18.3): 429 TOO_MANY_UPLOADS { limit, retry_after }."""
    from utils.ratelimit import limiter
    await limiter.hit(request, 'upload_key', 'key:{:x}'.format(key.id))


def state_of(key, now=None):
    from datetime import datetime, timezone
    now = now or datetime.now(timezone.utc)
    if key.revoked_at is not None and key.revoked_reason != 'expired':
        return 'revoked'
    if key.revoked_reason == 'expired' or (key.expires_at is not None and key.expires_at <= now):
        return 'expired'
    return 'active'


def key_dict(key, domain=None):
    from db.models import epoch
    return {
        'id': str(key.id),
        'name': key.name,
        'prefix': key.prefix,
        'scopes': list(key.scopes),
        'domain': {'id': str(domain[0]), 'hostname': domain[1]} if domain else None,
        'created_at': epoch(key.created_at),
        'expires_at': epoch(key.expires_at),
        'last_used_at': epoch(key.last_used_at),
        'revoked_at': epoch(key.revoked_at),
        'state': state_of(key),
    }


# --- the .sxcu and the curl snippet (§7.7) ------------------------------------------------------------------------

SHAREX_ARGUMENTS = ('expires_in', 'visibility', 'generate_password', 'nsfw', 'album', 'view_limit', 'view_limit_action')


def sharex_arguments(options, scopes):
    """Only what the person picked in the create dialog, as strings."""
    options = options if isinstance(options, dict) else {}
    out = {}
    expires_in = options.get('expires_in')
    if expires_in not in (None, ''):
        out['expires_in'] = str(int(expires_in))
    if options.get('visibility') in ('link', 'password', 'private'):
        out['visibility'] = options['visibility']
    if options.get('generate_password') is True:
        out['generate_password'] = 'true'
    if options.get('nsfw') is True:
        out['nsfw'] = 'true'
    if options.get('album') and 'albums:append' in scopes:
        out['album'] = str(options['album'])
    # milestone-6 §19.3: a view limit (1-1000) and its action, as every upload can carry them
    from utils import view_limits
    try:
        limit = view_limits.limit_value(options['view_limit']) if options.get('view_limit') is not None else None
    except ValueError:
        limit = None
    if limit is not None:
        out['view_limit'] = str(limit)
        if options.get('view_limit_action') in view_limits.ACTIONS:
            out['view_limit_action'] = options['view_limit_action']
    return out


def sharex(name, secret, arguments, settings=None):
    settings = settings or account_settings()
    config = {
        'Version': SHAREX_VERSION,
        'Name': 'files.gg ({})'.format(name),
        'DestinationType': 'ImageUploader, TextUploader, FileUploader',
        'RequestMethod': 'POST',
        'RequestURL': settings.api_public_url + '/files',
        'Headers': {'Authorization': 'Key ' + secret},
        'Body': 'MultipartFormData',
    }
    if arguments:
        config['Arguments'] = dict(arguments)
    config['FileFormName'] = 'file'
    # key uploads always answer `url_with_password` (the plain link when no password was generated), so a generated
    # password reaches the copied link whether the tool asked for one or the owner's defaults did (milestone-5 §21)
    config['URL'] = '{json:url_with_password}'
    config['ErrorMessage'] = '{json:message}'
    return config


def curl(secret, arguments, settings=None):
    settings = settings or account_settings()
    fields = ' '.join('-F {}'.format(json.dumps('{}={}'.format(k, v))) for k, v in arguments.items())
    lines = ['curl -H {} \\'.format(json.dumps('Authorization: Key ' + secret)),
             '     -F "file=@photo.png"{} \\'.format(' ' + fields if fields else ''),
             '     {}/files'.format(settings.api_public_url)]
    return '\n'.join(lines)
