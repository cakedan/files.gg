"""Random vanities (the `files.gg/<vanity>` path) and the reserved names."""

import random
import re
import string

MIN_VANITY_LENGTH = 3
MAX_VANITY_LENGTH = 128
MIN_RANDOM_LENGTH = 3
MAX_RANDOM_LENGTH = 16
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
    # the API's /files/<vanity>/view and /unlock routes
    'view',
    'unlock',
)


def is_reserved(vanity):
    """True if any segment of `vanity` (before its extension) is reserved."""
    return any(part.lower() in blacklisted_ids for part in vanity.split('.', 1)[0].split('/'))


def generate_id(length):
    fid = ''.join(random.choice(VANITY_CHOICES_ASCII) for _ in range(length))
    if fid in blacklisted_ids:
        return generate_id(length)
    return fid


def generate_vanity(vanity=''):
    vparts = []
    for part in vanity.split('/'):
        minv, maxv = parse_vanity_part(part)
        vparts.append(generate_id(random.randint(minv, maxv)))
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
    min_vanity = max_vanity = vanity.count('/')
    for part in vanity.split('/'):
        minv, maxv = parse_vanity_part(part)
        min_vanity += minv
        max_vanity += maxv
    return MIN_VANITY_LENGTH <= min_vanity and max_vanity <= MAX_VANITY_LENGTH
