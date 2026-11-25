"""Every trust & safety setting (contract milestone-4 §13), read through one `safety_settings()`,
like `limits.defaults()`. Each is an environment variable of the same name; tests override
them with monkeypatch.
"""

import json
import os

from dataclasses import dataclass, field
from typing import Optional

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_STANDIN_MATCH_FILE = os.path.join(API_DIR, 'tests', 'fixtures', 'standin', 'match-list.txt')
DEFAULT_PHOTODNA_MATCH_URL = 'https://api.microsoftmoderator.com/photodna/v1.0/Match'
DEFAULT_REPORT_THRESHOLDS = {'violence': 2, 'malware': 2, 'adult_unmarked': 2, 'harassment': 3, 'spam': 3}
MATCHERS = ('photodna', 'standin')
DAY = 86400


def _int(name, default):
    value = os.getenv(name)
    return default if value in (None, '') else int(value)


def _float(name, default):
    value = os.getenv(name)
    return default if value in (None, '') else float(value)


def _str(name, default=None):
    value = os.getenv(name)
    return default if value in (None, '') else value


def truthy(value):
    return (value or '').strip().lower() in ('1', 'true', 'yes', 'on')


@dataclass(frozen=True)
class SafetySettings:
    csam_matcher: Optional[str]
    photodna_subscription_key: Optional[str]
    photodna_match_url: str
    photodna_timeout: float
    photodna_max_rps: float
    standin_match_file: str
    standin_mode: str
    pdq_match_distance: int
    nsfw_threshold: float
    nsfw_unmarked_warn: int
    scan_wall: int
    scan_cpu: int
    scan_address_space: int
    scan_stalled_after: int
    clamav_host: str
    clamav_port: int
    clamav_timeout: float
    clamav_max_bytes: int
    clamav_flag_only_prefixes: tuple
    archive_max_entries: int
    archive_max_depth: int
    archive_max_unpacked: int
    archive_max_ratio: int
    archive_max_matched_images: int
    archive_max_image_bytes: int
    web_risk_api_key: Optional[str]
    web_risk_standin_file: Optional[str]
    web_risk_max_urls: int
    report_thresholds: dict = field(default_factory=dict)
    report_rate_per_hour: int = 10
    report_message_rate_per_hour: int = 30
    report_reopen_days: int = 14
    report_close_after_days: int = 30
    report_retention_days: int = 365
    strikes_window_days: int = 90
    strikes_restrict: int = 3
    restrict_days: int = 30
    hold_days_default: int = 90
    hold_days_max: int = 365
    evidence_retention_days: int = 365
    s3_bucket_evidence: Optional[str] = None
    s3_evidence_access_key_id: Optional[str] = None
    s3_evidence_secret_access_key: Optional[str] = None
    evidence_public_key: Optional[str] = None
    abuse_hash_secret: Optional[str] = None
    abuse_ip_keep_days: int = 30
    staff_url_ttl: int = 600
    dev_tools: bool = False


def safety_settings():
    thresholds = dict(DEFAULT_REPORT_THRESHOLDS)
    raw = _str('REPORT_THRESHOLDS')
    if raw:
        thresholds.update({str(k): int(v) for k, v in json.loads(raw).items()})
    return SafetySettings(
        csam_matcher=_str('CSAM_MATCHER'),
        photodna_subscription_key=_str('PHOTODNA_SUBSCRIPTION_KEY'),
        photodna_match_url=_str('PHOTODNA_MATCH_URL', DEFAULT_PHOTODNA_MATCH_URL),
        photodna_timeout=_float('PHOTODNA_TIMEOUT', 10.0),
        photodna_max_rps=_float('PHOTODNA_MAX_RPS', 5.0),
        standin_match_file=_str('STANDIN_MATCH_FILE', DEFAULT_STANDIN_MATCH_FILE),
        standin_mode=_str('STANDIN_MODE', 'list'),
        pdq_match_distance=_int('PDQ_MATCH_DISTANCE', 31),
        nsfw_threshold=_float('NSFW_THRESHOLD', 0.85),
        nsfw_unmarked_warn=_int('NSFW_UNMARKED_WARN', 3),
        scan_wall=_int('SCAN_WALL', 120),
        scan_cpu=_int('SCAN_CPU', 90),
        scan_address_space=_int('SCAN_ADDRESS_SPACE', 2147483648),
        scan_stalled_after=_int('SCAN_STALLED_AFTER', 600),
        clamav_host=_str('CLAMAV_HOST', 'clamav'),
        clamav_port=_int('CLAMAV_PORT', 3310),
        clamav_timeout=_float('CLAMAV_TIMEOUT', 120.0),
        clamav_max_bytes=_int('CLAMAV_MAX_BYTES', 536870912),
        clamav_flag_only_prefixes=tuple(p.strip() for p in _str('CLAMAV_FLAG_ONLY_PREFIXES', 'PUA.,Heuristics.')
                                        .split(',') if p.strip()),
        archive_max_entries=_int('ARCHIVE_MAX_ENTRIES', 10000),
        archive_max_depth=_int('ARCHIVE_MAX_DEPTH', 3),
        archive_max_unpacked=_int('ARCHIVE_MAX_UNPACKED', 21474836480),
        archive_max_ratio=_int('ARCHIVE_MAX_RATIO', 1000),
        archive_max_matched_images=_int('ARCHIVE_MAX_MATCHED_IMAGES', 100),
        archive_max_image_bytes=_int('ARCHIVE_MAX_IMAGE_BYTES', 20971520),
        web_risk_api_key=_str('WEB_RISK_API_KEY'),
        web_risk_standin_file=_str('WEB_RISK_STANDIN_FILE'),
        web_risk_max_urls=_int('WEB_RISK_MAX_URLS', 100),
        report_thresholds=thresholds,
        report_rate_per_hour=_int('REPORT_RATE_PER_HOUR', 10),
        report_message_rate_per_hour=_int('REPORT_MESSAGE_RATE_PER_HOUR', 30),
        report_reopen_days=_int('REPORT_REOPEN_DAYS', 14),
        report_close_after_days=_int('REPORT_CLOSE_AFTER_DAYS', 30),
        report_retention_days=_int('REPORT_RETENTION_DAYS', 365),
        strikes_window_days=_int('STRIKES_WINDOW_DAYS', 90),
        strikes_restrict=_int('STRIKES_RESTRICT', 3),
        restrict_days=_int('RESTRICT_DAYS', 30),
        hold_days_default=_int('HOLD_DAYS_DEFAULT', 90),
        hold_days_max=_int('HOLD_DAYS_MAX', 365),
        evidence_retention_days=_int('EVIDENCE_RETENTION_DAYS', 365),
        s3_bucket_evidence=_str('S3_BUCKET_EVIDENCE'),
        s3_evidence_access_key_id=_str('S3_EVIDENCE_ACCESS_KEY_ID'),
        s3_evidence_secret_access_key=_str('S3_EVIDENCE_SECRET_ACCESS_KEY'),
        evidence_public_key=_str('EVIDENCE_PUBLIC_KEY'),
        abuse_hash_secret=_str('ABUSE_HASH_SECRET'),
        abuse_ip_keep_days=_int('ABUSE_IP_KEEP_DAYS', 30),
        staff_url_ttl=min(600, _int('STAFF_URL_TTL', 600)),
        dev_tools=truthy(os.getenv('FILESGG_DEV_TOOLS')),
    )


class ConfigError(RuntimeError):
    pass


def check_matcher_name(settings=None):
    """`CSAM_MATCHER` is required; `standin` refuses to run without FILESGG_DEV_TOOLS=1, so
    production can't run without a real matcher by accident (§3.1)."""
    settings = settings or safety_settings()
    if settings.csam_matcher not in MATCHERS:
        raise ConfigError('Refusing to start: CSAM_MATCHER must be one of {} (got {!r})'.format(
            ', '.join(MATCHERS), settings.csam_matcher))
    if settings.csam_matcher == 'standin' and not settings.dev_tools:
        raise ConfigError('Refusing to start: CSAM_MATCHER=standin is for tests and local development only '
                          '(it needs FILESGG_DEV_TOOLS=1)')
    return settings


def check_matcher(settings=None):
    """The matcher choice, plus what the chosen matcher needs to run: PhotoDNA's key. Only the
    processes that call the matcher (the scanner and rescanner) need it."""
    settings = check_matcher_name(settings)
    if settings.csam_matcher == 'photodna' and not settings.photodna_subscription_key:
        raise ConfigError('Refusing to start: CSAM_MATCHER=photodna needs PHOTODNA_SUBSCRIPTION_KEY')
    return settings


def check_api(settings=None):
    """What the API validates at boot: the matcher choice (never the PhotoDNA key, which only
    the scanner and rescanner get), the abuse hash secret and the evidence key (the API seals
    IPs and hashes them)."""
    settings = check_matcher_name(settings)
    missing = [name for name, value in (('ABUSE_HASH_SECRET', settings.abuse_hash_secret),
                                        ('EVIDENCE_PUBLIC_KEY', settings.evidence_public_key)) if not value]
    if missing:
        raise ConfigError('Refusing to start: missing required secret(s) {}'.format(', '.join(missing)))
    from safety import ip
    ip.check_public_key(settings.evidence_public_key)
    return settings


def check_scanner(settings=None):
    """The scanner and rescanner also need the matcher's own settings (PhotoDNA's key), the
    evidence bucket and its key."""
    settings = check_matcher(check_api(settings))
    missing = [name for name, value in (
        ('S3_BUCKET_EVIDENCE', settings.s3_bucket_evidence),
        ('S3_EVIDENCE_ACCESS_KEY_ID', settings.s3_evidence_access_key_id),
        ('S3_EVIDENCE_SECRET_ACCESS_KEY', settings.s3_evidence_secret_access_key)) if not value]
    if missing:
        raise ConfigError('Refusing to start: missing required setting(s) {}'.format(', '.join(missing)))
    return settings
