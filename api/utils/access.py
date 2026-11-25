"""Who may see a file: visibility, owners, unlock tokens and their rate limits
(contract §1 and §5, PLAN.md "Private and password-protected files")."""

import time

from db import queries
from db.models import epoch
from utils import access_token, errors, view_hash
from utils.helpers import client_ip, get_user

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
    """The signed-in caller, or None (a bad token is treated as signed out)."""
    authorization = request.headers.get('authorization')
    if not authorization:
        return None
    try:
        return await get_user(conn, authorization)
    except Exception:
        return None


def is_owner(fobj, user=None, fingerprint=None):
    if user is not None and fobj.user_id == user.id:
        return True
    return fobj.user_id is None and fingerprint is not None and fobj.fingerprint == fingerprint


def password_has_expired(fobj, at=None):
    return fobj.password_expires_at is not None and epoch(fobj.password_expires_at) <= (at or now())


def token_claims(request, fobj, token, scopes=access_token.SCOPES):
    """Claims of a token valid for this file right now, else None."""
    claims = access_token.decode(token, request.app.ctx.cdn_token_secret)
    if not access_token.valid_for(claims, 'file', fobj.id, fobj.access_version, scopes=scopes):
        return None
    return claims


def unlock_expiry(fobj, unlocked_at):
    """e = min(u + unlock_ttl, password_expires_at)."""
    expiry = unlocked_at + fobj.unlock_ttl
    if fobj.password_expires_at is not None:
        expiry = min(expiry, epoch(fobj.password_expires_at))
    return expiry


def mint(request, fobj, scope, unlocked_at, expires_at):
    claims = access_token.claims_for('file', fobj.id, scope, fobj.access_version, unlocked_at, expires_at)
    return access_token.mint(claims, request.app.ctx.cdn_token_secret)


async def rate_limit(conn, request, fobj, scope, limit):
    ip_hash = view_hash.purpose_hash(request.app.ctx.view_hash_secret, RATE_PURPOSE, view_hash.utc_today(),
                                     client_ip(request))
    count, retry_after = await queries.count_attempt(conn, fobj.id, scope, ip_hash)
    if count > limit:
        raise errors.too_many_attempts(retry_after)
