"""Every upload limit comes from `get_limits()` (PLAN.md "Limits").

Defaults (decided 2026-11-24): 10 GB storage, 1 GB chunked, 100 MB single
request; anonymous: 25 MB per file, 500 MB per rolling 24 h per fingerprint and
per IP, and files expire within 21 days. Plans plug in here later.
Each default can be overridden by an env var of the same name (tests use that).
"""

import os

from dataclasses import dataclass
from typing import Optional

from utils.responses import ApiError

GB = 1024 ** 3
MB = 1024 ** 2

HOUR = 3600
DAY = 24 * HOUR
MIN_EXPIRY = HOUR
ANONYMOUS_MAX_EXPIRY = 21 * DAY


def _env(name, default):
    return int(os.getenv(name, default))


def defaults():
    return {
        'storage': _env('LIMIT_STORAGE_BYTES', 10 * GB),
        'chunked': _env('LIMIT_CHUNKED_BYTES', GB),
        'single': _env('LIMIT_SINGLE_BYTES', 100 * MB),
        'anonymous_file': _env('LIMIT_ANONYMOUS_FILE_BYTES', 25 * MB),
        'anonymous_daily': _env('LIMIT_ANONYMOUS_DAILY_BYTES', 500 * MB),
        # Milestone 3: albums
        'album_files': _env('LIMIT_ALBUM_FILES', 500),
        'anonymous_album_files': _env('LIMIT_ANONYMOUS_ALBUM_FILES', 50),
        'albums': _env('LIMIT_ALBUMS', 1000),
    }


@dataclass(frozen=True)
class Limits:
    anonymous: bool
    storage_bytes: Optional[int]
    max_file_size_single: int
    max_file_size_chunked: int
    max_expiry: Optional[int]
    allow_no_expiry: bool
    # anonymous only: rolling 24 h bytes per fingerprint and per IP
    daily_bytes: Optional[int] = None
    # files per album, and albums per user (None: anonymous albums come from uploads only)
    album_max_files: int = 500
    albums_max: Optional[int] = 1000

    @property
    def default_expiry(self):
        return None if self.allow_no_expiry else self.max_expiry


def get_limits(user=None):
    values = defaults()
    if user is None:
        return Limits(
            anonymous=True,
            storage_bytes=None,
            max_file_size_single=values['anonymous_file'],
            max_file_size_chunked=values['anonymous_file'],
            max_expiry=ANONYMOUS_MAX_EXPIRY,
            allow_no_expiry=False,
            daily_bytes=values['anonymous_daily'],
            album_max_files=values['anonymous_album_files'],
            albums_max=None,
        )
    storage = getattr(user, 'storage_limit_override', None) or values['storage']
    return Limits(
        anonymous=False,
        storage_bytes=storage,
        max_file_size_single=values['single'],
        max_file_size_chunked=values['chunked'],
        max_expiry=None,
        allow_no_expiry=True,
        album_max_files=values['album_files'],
        albums_max=values['albums'],
    )


def expiry_not_allowed(limits):
    return ApiError('That expiry is not allowed', 400, code='EXPIRY_NOT_ALLOWED',
                    metadata={'max_expiry': limits.max_expiry, 'min_expiry': MIN_EXPIRY})


def resolve_expiry(limits, expires_in):
    """Seconds until the file expires (None = never) for a requested
    `expires_in` (None = not given). Raises EXPIRY_NOT_ALLOWED."""
    if expires_in is None:
        return limits.default_expiry
    if expires_in < MIN_EXPIRY:
        raise expiry_not_allowed(limits)
    if limits.max_expiry is not None and expires_in > limits.max_expiry:
        raise expiry_not_allowed(limits)
    return expires_in


def file_too_large(limit):
    return ApiError('File is too large', 413, code='FILE_TOO_LARGE', metadata={'limit': limit})


def storage_limit_reached(limit, used):
    return ApiError('Storage limit reached', 413, code='STORAGE_LIMIT_REACHED', metadata={'limit': limit, 'used': used})
