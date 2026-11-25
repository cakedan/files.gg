"""File and album passwords: argon2id hashes and generated passphrases.

argon2-cffi's defaults (time_cost 3, 64 MiB, parallelism 4) take about 50 ms,
the target in PLAN.md, so hashing and checking run in the default executor.
"""

import asyncio
import os
import secrets

from functools import lru_cache

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

MIN_LENGTH = 6
MAX_LENGTH = 128
PASSPHRASE_WORDS = 4
WORDLIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wordlists', 'eff_large_wordlist.txt')

_hasher = PasswordHasher()


@lru_cache(maxsize=1)
def words():
    with open(WORDLIST, encoding='utf-8') as handle:
        result = tuple(line.strip() for line in handle if line.strip())
    if len(result) != 7776:
        raise RuntimeError('unexpected wordlist size {}'.format(len(result)))
    return result


def generate_passphrase(count=PASSPHRASE_WORDS):
    """e.g. 'amber-tunnel-oxide-violet': 4 words of 7776, about 51.7 bits."""
    choices = words()
    return '-'.join(secrets.choice(choices) for _ in range(count))


def validate(password):
    if not isinstance(password, str) or not MIN_LENGTH <= len(password) <= MAX_LENGTH:
        raise ValueError('Must be between {} and {} characters'.format(MIN_LENGTH, MAX_LENGTH))
    return password


def hash_sync(password):
    return _hasher.hash(password)


def verify_sync(password_hash, password):
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


async def hash(password):
    return await asyncio.get_running_loop().run_in_executor(None, hash_sync, password)


async def verify(password_hash, password):
    if not password_hash or not isinstance(password, str):
        return False
    return await asyncio.get_running_loop().run_in_executor(None, verify_sync, password_hash, password)


# --- account passwords (contract milestone-6 §2.6) ---------------------------------------------------------------
# The same argon2id hasher (argon2-cffi's defaults, RFC 9106's second profile). At least 8 characters and no
# maximum: the endpoints that take a password cap the request at 64 KiB (§4.8), which is the only bound.

ACCOUNT_MIN_LENGTH = 8
_dummy_hash = None


def account_password_reason(password, username=None, email=None):
    """None when the password is acceptable, else `too_short`, `matches_username` or `matches_email`."""
    if not isinstance(password, str) or len(password) < ACCOUNT_MIN_LENGTH:
        return 'too_short'
    lowered = password.casefold()
    if username and lowered == username.casefold():
        return 'matches_username'
    if email and lowered == email.casefold():
        return 'matches_email'
    return None


def _dummy():
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_sync(secrets.token_urlsafe(32))
    return _dummy_hash


def verify_account_sync(password_hash, password):
    """Wrong, missing or malformed hashes are all "wrong password". Without a hash (an unknown email, or an
    account with no password) it still verifies against a fixed dummy hash, so the timing doesn't tell."""
    if not isinstance(password, str):
        password = ''
    if not password_hash:
        verify_sync(_dummy(), password)
        return False
    return verify_sync(password_hash, password)


async def verify_account(password_hash, password):
    return await asyncio.get_running_loop().run_in_executor(None, verify_account_sync, password_hash, password)


def needs_rehash(password_hash):
    try:
        return _hasher.check_needs_rehash(password_hash)
    except Exception:
        return False
