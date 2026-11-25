"""Every upload limit comes from `get_limits()` (PLAN.md "Limits", contract milestone-6 §9.2).

Defaults (decided 2026-11-24): 10 GB storage, 1 GB chunked, 100 MB single
request; anonymous: 25 MB per file, 500 MB per rolling 24 h per guest and
per IP, and files expire within 21 days. Premium (milestone-6, staff-granted):
100 GB storage, 5 GB chunked, 500 MB single request, 5 custom domains.
A single request is never larger than PROXY_BODY_LIMIT_BYTES - 1 MiB, for everyone
(Cloudflare's request-body limit, §9.5). Sizes are decimal (1 MB = 1,000,000 bytes), as the web app shows them, so
"100 MB" is 100,000,000 bytes everywhere. Cloudflare's limit is assumed to be 100 MiB, which leaves the 100 MB single
upload room for its multipart framing; check it on the real zone before launch (PLAN.md "Before the first deploy"). `storage_limit_override` wins over both
the signed-in and premium storage defaults.
Each default can be overridden by an env var of the same name (tests use that).

Milestone 5 (§7.1): the conversion limits, `conversion_*`, by tier (signed in, premium, anonymous), each overridable
by `CONVERSION_<KEY>`, `CONVERSION_PREMIUM_<KEY>` and `CONVERSION_ANONYMOUS_<KEY>`.
"""

import os

from dataclasses import dataclass
from typing import Optional

from utils.responses import ApiError

# decimal, as the web app displays sizes
GB = 1000 ** 3
MB = 1000 ** 2
# multipart framing headroom below the proxy's body limit
MIB = 1024 ** 2

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
        # Milestone 6 (§9.2)
        'premium_storage': _env('LIMIT_PREMIUM_STORAGE_BYTES', 100 * GB),
        'premium_chunked': _env('LIMIT_PREMIUM_CHUNKED_BYTES', 5 * GB),
        # 100 MB like everyone (owner, 2026-11-25): Cloudflare's Free/Pro body limit can't carry more. Premium's bigger
        # files go through the website's chunked uploads (5 GB); raise this with PROXY_BODY_LIMIT_BYTES on a bigger plan.
        'premium_single': _env('LIMIT_PREMIUM_SINGLE_BYTES', 100 * MB),
        'premium_domains': _env('PREMIUM_CUSTOM_DOMAINS', 5),
        'upload_keys': _env('UPLOAD_KEYS_MAX', 20),
        # Cloudflare's 100 MB request-body limit (Free and Pro), assumed binary: 100 MiB
        'proxy_body': _env('PROXY_BODY_LIMIT_BYTES', 100 * MIB),
    }


# milestone-5 §7.1, by tier: (signed in, premium, anonymous)
CONVERSION_DEFAULTS = {
    'MAX_INPUT': (500 * MB, 5 * GB, 50 * MB),
    'MAX_DURATION': (30 * 60, 2 * HOUR, 60),
    'MAX_PDF_PAGES': (200, 500, 20),
    'MAX_IMAGES_TO_PDF': (200, 500, 20),
    'CPU_SECONDS_PER_DAY': (1800, 7200, 180),
    'COUNT_PER_DAY': (200, 1000, 10),
    'CONCURRENT': (3, 5, 1),
    'TIME_LIMIT': (600, 1800, 120),
}
CONVERSION_TIERS = ('member', 'premium', 'anonymous')
CONVERSION_ENV_PREFIX = {'member': 'CONVERSION_', 'premium': 'CONVERSION_PREMIUM_', 'anonymous': 'CONVERSION_ANONYMOUS_'}
# §7.1: the RQ queue each tier's conversions go on (§3.1)
CONVERSION_QUEUES = {'member': 'convert_member', 'premium': 'convert_premium', 'anonymous': 'convert_anonymous'}
# anonymous outputs are capped at 720p (§7.1)
ANONYMOUS_MAX_HEIGHT = 720


def conversion_values(tier):
    index = CONVERSION_TIERS.index(tier)
    prefix = CONVERSION_ENV_PREFIX[tier]
    return {key: _env(prefix + key, values[index]) for key, values in CONVERSION_DEFAULTS.items()}


@dataclass(frozen=True)
class Limits:
    anonymous: bool
    storage_bytes: Optional[int]
    max_file_size_single: int
    max_file_size_chunked: int
    max_expiry: Optional[int]
    allow_no_expiry: bool
    # anonymous only: rolling 24 h bytes per guest and per IP
    daily_bytes: Optional[int] = None
    # files per album, and albums per user (None: anonymous albums come from uploads only)
    album_max_files: int = 500
    albums_max: Optional[int] = 1000
    # Milestone 6 (§9.2)
    premium: bool = False
    max_file_size_single_configured: Optional[int] = None
    custom_domains: int = 0
    domain_only_allowed: bool = False
    upload_keys_max: int = 0
    # Milestone 5 (§7.1): conversions
    conversion_tier: str = 'anonymous'
    # `all`, or `no_documents` (anonymous: every target but document -> pdf)
    conversion_targets: str = 'no_documents'
    conversion_max_input: int = 50 * MB
    conversion_max_duration: int = 60
    conversion_max_pdf_pages: int = 20
    conversion_max_images_to_pdf: int = 20
    conversion_cpu_seconds_per_day: int = 180
    conversion_count_per_day: int = 10
    conversion_concurrent: int = 1
    conversion_batch: bool = False
    conversion_turnstile: bool = True
    conversion_time_limit: int = 120
    conversion_queue: str = 'convert_anonymous'
    # the output's height cap (anonymous: 720p), None for none
    conversion_max_height: Optional[int] = ANONYMOUS_MAX_HEIGHT

    @property
    def default_expiry(self):
        return None if self.allow_no_expiry else self.max_expiry

    @property
    def conversion_max_output(self):
        """An output is never bigger than the caller's max file size (§3.1 `MAX_OUTPUT_FILE`)."""
        return self.max_file_size_chunked

    def conversion_allows(self, kind, target):
        return self.conversion_targets == 'all' or (kind, target) != ('document', 'pdf')


def proxy_single_cap(values=None):
    """The largest single request Cloudflare passes to the Worker, less 1 MiB of multipart framing."""
    values = values or defaults()
    return values['proxy_body'] - MIB


def conversion_limits(tier):
    """The `conversion_*` fields of a tier's Limits (§7.1)."""
    values = conversion_values(tier)
    anonymous = tier == 'anonymous'
    return {
        'conversion_tier': tier,
        'conversion_targets': 'no_documents' if anonymous else 'all',
        'conversion_max_input': values['MAX_INPUT'],
        'conversion_max_duration': values['MAX_DURATION'],
        'conversion_max_pdf_pages': values['MAX_PDF_PAGES'],
        'conversion_max_images_to_pdf': values['MAX_IMAGES_TO_PDF'],
        'conversion_cpu_seconds_per_day': values['CPU_SECONDS_PER_DAY'],
        'conversion_count_per_day': values['COUNT_PER_DAY'],
        'conversion_concurrent': values['CONCURRENT'],
        'conversion_batch': not anonymous,
        'conversion_turnstile': anonymous,
        'conversion_time_limit': values['TIME_LIMIT'],
        'conversion_queue': CONVERSION_QUEUES[tier],
        'conversion_max_height': ANONYMOUS_MAX_HEIGHT if anonymous else None,
    }


def get_limits(user=None):
    values = defaults()
    cap = proxy_single_cap(values)
    if user is None:
        return Limits(
            anonymous=True,
            storage_bytes=None,
            max_file_size_single=min(values['anonymous_file'], cap),
            max_file_size_chunked=values['anonymous_file'],
            max_expiry=ANONYMOUS_MAX_EXPIRY,
            allow_no_expiry=False,
            daily_bytes=values['anonymous_daily'],
            album_max_files=values['anonymous_album_files'],
            albums_max=None,
            max_file_size_single_configured=values['anonymous_file'],
            **conversion_limits('anonymous'),
        )
    premium = bool(getattr(user, 'premium', False))
    override = getattr(user, 'storage_limit_override', None)
    storage = override or (values['premium_storage'] if premium else values['storage'])
    single = values['premium_single'] if premium else values['single']
    return Limits(
        anonymous=False,
        storage_bytes=storage,
        max_file_size_single=min(single, cap),
        max_file_size_chunked=values['premium_chunked'] if premium else values['chunked'],
        max_expiry=None,
        allow_no_expiry=True,
        album_max_files=values['album_files'],
        albums_max=values['albums'],
        premium=premium,
        max_file_size_single_configured=single,
        custom_domains=values['premium_domains'] if premium else 0,
        domain_only_allowed=premium,
        upload_keys_max=values['upload_keys'],
        **conversion_limits('premium' if premium else 'member'),
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
