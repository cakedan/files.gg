"""Random vanities (the `files.gg/<vanity>` path) and the reserved names."""

import re
import secrets
import string

MIN_VANITY_LENGTH = 3
MAX_VANITY_LENGTH = 128
MIN_RANDOM_LENGTH = 3
MAX_RANDOM_LENGTH = 16
# every `/`-separated part of a vanity pattern is at least this long: `0/0/0/0` would always
# generate '///', and every later upload with that pattern would never find a free vanity
MIN_PART_LENGTH = 1
# how many random vanities an upload or album tries before giving up with VANITY_EXHAUSTED
MAX_VANITY_ATTEMPTS = 10
VANITY_CHOICES_ASCII = string.ascii_lowercase + string.digits
VANITY_PART = r'^(?:\(?((\d+)|\d+\-?\d+)\)?)$'

# No vanity segment may be one of these: they are routes on files.gg (contract §9).
blacklisted_ids = (
    'assets',
    'auth',
    'dashboard',
    'details',
    'legal',
    'options',
    'app',
    'api',
    'a',
    'convert',
    'internal',
    'report',
    'uploads',
    'favicon',
    'apple-touch-icon',
    'og-image',
    # once the API's /files/<vanity>/view and /unlock routes; nothing comes after a vanity any more
    # (milestone-6 §20), so they stay reserved only as defence in depth
    'view',
    'unlock',
    # milestone-6 §6.3: the sign-in redirects, the custom-domain Turnstile frame, and the byte paths a custom
    # domain serves (/files, /previews, /albums)
    'login',
    'register',
    'signup',
    'challenge',
    'files',
    'previews',
    'albums',
)


def is_reserved(vanity):
    """True if any segment of `vanity` (before its extension) is reserved."""
    return any(part.lower() in blacklisted_ids for part in vanity.split('.', 1)[0].split('/'))


def generate_id(length):
    # vanities of `link` files and albums are capabilities: always the OS CSPRNG
    while True:
        fid = ''.join(secrets.choice(VANITY_CHOICES_ASCII) for _ in range(length))
        if fid not in blacklisted_ids:
            return fid


def generate_vanity(vanity=''):
    vparts = []
    for part in vanity.split('/'):
        minv, maxv = parse_vanity_part(part)
        vparts.append(generate_id(minv + secrets.randbelow(maxv - minv + 1)))
    return '/'.join(vparts)


def parse_vanity_part(part):
    match = re.match(VANITY_PART, part)
    if match is None:
        return (MIN_RANDOM_LENGTH, MAX_RANDOM_LENGTH)
    else:
        parts = match.group(1).split('-')
        if len(parts) == 2:
            minv = int(parts.pop(0))
            maxv = int(parts.pop(0))
            if maxv < minv:
                return (maxv, minv)
            else:
                return (minv, maxv)
        else:
            vlength = int(parts.pop(0))
            return (vlength, vlength)


def vanity_length_ok(vanity):
    """The pattern makes 3 to 128 character vanities, and no part can be shorter than
    MIN_PART_LENGTH."""
    min_vanity = max_vanity = vanity.count('/')
    for part in vanity.split('/'):
        minv, maxv = parse_vanity_part(part)
        if minv < MIN_PART_LENGTH:
            return False
        min_vanity += minv
        max_vanity += maxv
    return MIN_VANITY_LENGTH <= min_vanity and max_vanity <= MAX_VANITY_LENGTH
