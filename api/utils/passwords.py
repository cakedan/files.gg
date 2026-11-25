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
