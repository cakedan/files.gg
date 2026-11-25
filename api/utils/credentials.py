"""Credential formats (contract milestone-6 §2.5, §4.7, §5.4, §7.1).

- Session tokens (`fgs_`) and upload keys (`fgg_`): prefix + 30 random base62 characters + a 6-character
  base62 CRC32 checksum, 40 characters. Stored as SHA-256 of the whole token. The checksum is checked
  before any database lookup, so typos and scanner false positives never reach it.
- Email links: 32 random bytes, base64url without padding (43 characters), stored as SHA-256.
- The OAuth `state` and the Discord sign-up token: signed, stateless claims, built like the unlock tokens
  (utils/access_token.py) with a label so one can never be used as the other.
- The email rate-limit key: a keyed hash, so `safety_rate_limits` holds no addresses.
"""

import base64
import hashlib
import hmac
import json
import secrets
import time
import zlib

BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
SESSION_PREFIX = 'fgs_'
KEY_PREFIX = 'fgg_'
RANDOM_LENGTH = 30
CHECKSUM_LENGTH = 6
TOKEN_LENGTH = len(SESSION_PREFIX) + RANDOM_LENGTH + CHECKSUM_LENGTH
# what upload key lists show: `fgg_` plus 8
KEY_DISPLAY_PREFIX = 12
STATE_LABEL = 'filesgg-oauth-state-1'
SIGNUP_LABEL = 'filesgg-discord-signup-1'
EMAIL_KEY_LABEL = 'filesgg-auth-email-1'
_BASE62_SET = frozenset(BASE62)


def base62(number, width=CHECKSUM_LENGTH):
    out = ''
    while number:
        number, digit = divmod(number, 62)
        out = BASE62[digit] + out
    return out.rjust(width, '0')


def checksum(body):
    """base62(CRC32(ASCII(prefix + random))), left-padded with 0 to 6 characters."""
    return base62(zlib.crc32(body.encode('ascii')) & 0xFFFFFFFF)


def crc32(token):
    return zlib.crc32(token[:-CHECKSUM_LENGTH].encode('ascii')) & 0xFFFFFFFF


def generate(prefix):
    body = prefix + ''.join(secrets.choice(BASE62) for _ in range(RANDOM_LENGTH))
    return body + checksum(body)


def well_formed(token, prefix):
    """The length, the prefix, the alphabet and the checksum: no database lookup."""
    if not isinstance(token, str) or len(token) != TOKEN_LENGTH or not token.startswith(prefix):
        return False
    rest = token[len(prefix):]
    if not all(ch in _BASE62_SET for ch in rest):
        return False
    return hmac.compare_digest(checksum(token[:-CHECKSUM_LENGTH]), token[-CHECKSUM_LENGTH:])


def token_hash(token):
    """SHA-256 of the whole token string (UTF-8): `sessions.token_hash`, `upload_keys.key_hash`."""
    return hashlib.sha256(token.encode('utf-8')).digest()


def display_prefix(key):
    return key[:KEY_DISPLAY_PREFIX]


# --- email links ---------------------------------------------------------------------------------------------

def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def b64url_decode(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def email_token():
    return b64url(secrets.token_bytes(32))


def email_token_hash(token):
    if not isinstance(token, str) or not 20 <= len(token) <= 100:
        return None
    return hashlib.sha256(token.encode('utf-8')).digest()


# --- PKCE (§5.2) --------------------------------------------------------------------------------------------------

def code_challenge(verifier):
    """S256: base64url_nopad(SHA-256(verifier))."""
    return b64url(hashlib.sha256(verifier.encode('ascii')).digest())


def valid_challenge(value):
    return isinstance(value, str) and len(value) == 43 and all(c.isalnum() or c in '-_' for c in value)


def valid_verifier(value):
    # RFC 7636: 43 to 128 characters of [A-Za-z0-9-._~]
    return isinstance(value, str) and 43 <= len(value) <= 128 and all(c.isalnum() or c in '-._~' for c in value)


# --- signed claims (§5.4) ----------------------------------------------------------------------------------------

def sign(claims, label, secret):
    """body + "." + base64url_nopad(HMAC-SHA256(secret, label + "\\n" + body))."""
    body = b64url(json.dumps(claims, separators=(',', ':'), sort_keys=True).encode('utf-8'))
    mac = hmac.new(secret.encode('utf-8'), (label + '\n' + body).encode('ascii'), hashlib.sha256).digest()
    return body + '.' + b64url(mac)


def unsign(token, label, secret, now=None):
    """The claims of a valid, unexpired token signed with this label, else None."""
    if not isinstance(token, str) or len(token) > 4096 or token.count('.') != 1:
        return None
    body, signature = token.split('.')
    expected = b64url(hmac.new(secret.encode('utf-8'), (label + '\n' + body).encode('ascii'),
                               hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        claims = json.loads(b64url_decode(body))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(claims, dict) or not isinstance(claims.get('e'), int):
        return None
    if claims['e'] <= (time.time() if now is None else now):
        return None
    return claims


def nonce():
    return b64url(secrets.token_bytes(16))


# --- the email rate-limit key (§4.7) ---------------------------------------------------------------------------

def email_key(secret, email):
    """acct:hex(HMAC-SHA256(ABUSE_HASH_SECRET, "filesgg-auth-email-1\\n" + lower(trim(email))))."""
    normalized = (email or '').strip().lower()
    digest = hmac.new(secret.encode('utf-8'), (EMAIL_KEY_LABEL + '\n' + normalized).encode('utf-8'),
                      hashlib.sha256).hexdigest()
    return 'acct:' + digest
