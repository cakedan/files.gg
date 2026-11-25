"""The API's unlock tokens (contract milestone-3 §3, milestone-2 §5): password unlocks and
owner passes. They're the visitor's proof for the API only (`X-Filesgg-Access` on /view,
the body of /unlock/refresh, `#t=` owner passes) and never appear in a CDN URL; the CDN
gets signed URLs instead (utils/cdn_signing.py).

    base64url(body_json) + "." + base64url(HMAC_SHA256(SECRET_KEY, base64url(body_json)))

body_json is json.dumps(claims, separators=(',', ':'), sort_keys=True); base64url
has no padding. Claims: k (file | album), t (target id), s (unlock | owner),
v (access_version), u (unlocked at), e (expires at).
"""

import base64
import hashlib
import hmac
import json
import time

KINDS = ('file', 'album')
SCOPES = ('unlock', 'owner')
OWNER_PASS_SECONDS = 3600
# refreshed owner passes live at most this long from minting (contract §5)
OWNER_PASS_MAX_SECONDS = 12 * 3600
REFRESH_SECONDS = 3600


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _unb64(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def _sign(secret, body):
    return _b64(hmac.new(secret.encode('utf-8'), body.encode('ascii'), hashlib.sha256).digest())


def mint(claims, secret):
    body = _b64(json.dumps(claims, separators=(',', ':'), sort_keys=True).encode('utf-8'))
    return '{}.{}'.format(body, _sign(secret, body))


def claims_for(kind, target_id, scope, access_version, unlocked_at, expires_at):
    return {'e': int(expires_at), 'k': kind, 's': scope, 't': str(target_id),
            'u': int(unlocked_at), 'v': int(access_version)}


def decode(token, secret):
    """The claims of a correctly signed, well-formed token, else None. Does not
    check expiry or the target (see `valid_for`)."""
    if not isinstance(token, str) or token.count('.') != 1 or not secret:
        return None
    body, signature = token.split('.')
    expected = _sign(secret, body)
    if not hmac.compare_digest(signature.encode('ascii', 'replace'), expected.encode('ascii')):
        return None
    try:
        claims = json.loads(_unb64(body))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(claims, dict) or set(claims) != {'e', 'k', 's', 't', 'u', 'v'}:
        return None
    if claims['k'] not in KINDS or claims['s'] not in SCOPES or not isinstance(claims['t'], str):
        return None
    if not all(isinstance(claims[k], int) and not isinstance(claims[k], bool) for k in ('e', 'u', 'v')):
        return None
    return claims


def valid_for(claims, kind, target_id, access_version, now=None, scopes=SCOPES):
    """Rules 2-4 of milestone-2 §1 for a direct target (album membership: utils/access.py)."""
    now = int(time.time()) if now is None else now
    return (claims is not None and claims['e'] > now and claims['k'] == kind
            and claims['t'] == str(target_id) and claims['v'] == int(access_version)
            and claims['s'] in scopes)
