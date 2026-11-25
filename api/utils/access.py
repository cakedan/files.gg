"""Who may see a file: visibility, owners, unlock tokens and their rate limits
(contract §1 and §5, PLAN.md "Private and password-protected files")."""

import time

from db import queries
from db.models import epoch
from utils import access_token, errors, view_hash
from utils.helpers import client_ip

# X-Filesgg-Access carries an unlock/owner token to /view; the middleware moves it
# to request.ctx.access_token and removes the header, so it is never logged.
ACCESS_HEADER = 'x-filesgg-access'
UNLOCK_ATTEMPTS_PER_MINUTE = 5
# /unlock/refresh and /view (no Turnstile): generous, but bounded
ACCESS_REQUESTS_PER_MINUTE = 30
RATE_PURPOSE = 'unlock'


def now():
    return int(time.time())


async def optional_user(conn, request):
    """The signed-in caller (the session cookie), or None. A dead cookie is treated as signed out."""
    from utils.auth import auth_of
    current = auth_of(request)
    return current.user if current.kind == 'session' else None


def is_owner(fobj, user=None, fingerprint=None):
    if user is not None and fobj.user_id == user.id:
        return True
    return fobj.user_id is None and fingerprint is not None and fobj.fingerprint == fingerprint


def password_has_expired(fobj, at=None):
    return fobj.password_expires_at is not None and epoch(fobj.password_expires_at) <= (at or now())


def token_claims(request, fobj, token, scopes=access_token.SCOPES, kind='file'):
    """Claims of a token valid for this file (or, with kind='album', album) right now, else None."""
    claims = access_token.decode(token, request.app.ctx.access_secret)
    if not access_token.valid_for(claims, kind, fobj.id, fobj.access_version, scopes=scopes):
        return None
    return claims


async def file_or_album_claims(conn, request, fobj, token):
    """(claims, album) of a token that opens this file: its own (album None), or (milestone-2
    §1 rule 3) one for an album the file is a shown item of, at that album's current
    access_version. (None, None) otherwise."""
    claims = token_claims(request, fobj, token)
    if claims is not None:
        return claims, None
    claims = access_token.decode(token, request.app.ctx.access_secret)
    if claims is None or claims['k'] != 'album' or claims['e'] <= now():
        return None, None
    from db import albums as album_queries
    try:
        album_id = int(claims['t'])
    except ValueError:
        return None, None
    album = await album_queries.album_showing(conn, fobj.id, album_id, claims['v'])
    if album is not None:
        return claims, album
    return None, None


def grant_for(fobj, claims, album=None):
    """The CDN grant a valid token gives: the file's own, or the album's (item URLs then
    carry album=), both expiring with the token."""
    from utils.cdn_signing import Grant
    if album is not None:
        return Grant.for_album(album, claims['e'])
    return Grant.for_file(fobj, claims['e'])


def unlock_expiry(fobj, unlocked_at):
    """e = min(u + unlock_ttl, password_expires_at)."""
    expiry = unlocked_at + fobj.unlock_ttl
    if fobj.password_expires_at is not None:
        expiry = min(expiry, epoch(fobj.password_expires_at))
    return expiry


def mint(request, fobj, scope, unlocked_at, expires_at, kind='file'):
    claims = access_token.claims_for(kind, fobj.id, scope, fobj.access_version, unlocked_at, expires_at)
    return access_token.mint(claims, request.app.ctx.access_secret)


async def rate_limit(conn, request, fobj, scope, limit, kind='file'):
    ip_hash = view_hash.purpose_hash(request.app.ctx.view_hash_secret, RATE_PURPOSE, view_hash.utc_today(),
                                     client_ip(request))
    if kind == 'album':
        count, retry_after = await queries.count_attempt(conn, None, scope, ip_hash, album_id=fobj.id)
    else:
        count, retry_after = await queries.count_attempt(conn, fobj.id, scope, ip_hash)
    if count > limit:
        raise errors.too_many_attempts(retry_after)
