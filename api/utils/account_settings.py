"""Every Milestone 6 account setting (contract milestone-6 §15), read through one `account_settings()`,
like `safety_settings()`. Each is an environment variable of the same name, read on every call (tests
override them with monkeypatch)."""

import json
import os

from dataclasses import dataclass
from typing import Optional

from utils.urls import public_url

DEFAULT_AUTH_RATE_LIMITS = {
    'login_ip': 30, 'login_account': 10, 'register': 5, 'forgot_ip': 10, 'forgot_account': 3, 'verify_resend': 5,
    'discord': 30, 'reauth': 10, 'username_check': 60, 'domain_add': 10,
}
DEFAULT_DISCORD_API_BASE = 'https://discord.com/api'
DEFAULT_CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
DEFAULT_API_PUBLIC_URL = 'https://api.files.gg'
DEFAULT_CUSTOM_DOMAIN_TARGET = 'domains.files.gg'
SECURE_COOKIE_NAME = '__Host-filesgg_session'
INSECURE_COOKIE_NAME = 'filesgg_session'
MIB = 1024 * 1024


def _str(name, default=None):
    value = os.getenv(name)
    return default if value in (None, '') else value


def _int(name, default):
    value = os.getenv(name)
    return default if value in (None, '') else int(value)


def truthy(value):
    return (value or '').strip().lower() in ('1', 'true', 'yes', 'on')


@dataclass(frozen=True)
class AccountSettings:
    cookie_insecure: bool
    discord_client_id: Optional[str]
    discord_client_secret: Optional[str]
    discord_redirect_uri: str
    discord_api_base: str
    cloudflare_api_token: Optional[str]
    cloudflare_zone_id: Optional[str]
    cloudflare_api_base: str
    custom_domain_target: str
    custom_domains_global_max: int
    api_public_url: str
    premium_custom_domains: int
    proxy_body_limit: int
    auth_request_max_bytes: int
    json_request_max_bytes: int
    session_idle_days: int
    session_max_days: int
    sessions_max: int
    reauth_seconds: int
    deletion_grace_days: int
    username_cooldown_days: int
    username_hold_days: int
    verify_token_hours: int
    reset_token_minutes: int
    upload_keys_max: int
    upload_key_rate_per_hour: int
    rate_limits: dict
    domain_pending_hours: int
    domain_failing_days: int
    domain_paused_days: int
    domain_min_account_age_days: int
    export_keep_days: int

    @property
    def cookie_name(self):
        return INSECURE_COOKIE_NAME if self.cookie_insecure else SECURE_COOKIE_NAME

    @property
    def discord_enabled(self):
        return bool(self.discord_client_id and self.discord_client_secret)

    @property
    def domains_enabled(self):
        return bool(self.cloudflare_api_token and self.cloudflare_zone_id)

    def rate(self, scope):
        return self.rate_limits[scope]


def account_settings():
    limits = dict(DEFAULT_AUTH_RATE_LIMITS)
    raw = _str('AUTH_RATE_LIMITS')
    if raw:
        limits.update({str(k): int(v) for k, v in json.loads(raw).items()})
    return AccountSettings(
        cookie_insecure=truthy(os.getenv('SESSION_COOKIE_INSECURE')) and truthy(os.getenv('FILESGG_DEV_TOOLS')),
        discord_client_id=_str('DISCORD_CLIENT_ID'),
        discord_client_secret=_str('DISCORD_CLIENT_SECRET'),
        discord_redirect_uri=_str('DISCORD_REDIRECT_URI') or public_url('/app/auth/discord'),
        discord_api_base=_str('DISCORD_API_BASE', DEFAULT_DISCORD_API_BASE).rstrip('/'),
        cloudflare_api_token=_str('CLOUDFLARE_API_TOKEN'),
        cloudflare_zone_id=_str('CLOUDFLARE_ZONE_ID'),
        cloudflare_api_base=_str('CLOUDFLARE_API_BASE', DEFAULT_CLOUDFLARE_API_BASE).rstrip('/'),
        custom_domain_target=_str('CUSTOM_DOMAIN_TARGET', DEFAULT_CUSTOM_DOMAIN_TARGET).strip().rstrip('.').lower(),
        custom_domains_global_max=_int('CUSTOM_DOMAINS_GLOBAL_MAX', 1000),
        api_public_url=_str('API_PUBLIC_URL', DEFAULT_API_PUBLIC_URL).rstrip('/'),
        premium_custom_domains=_int('PREMIUM_CUSTOM_DOMAINS', 5),
        proxy_body_limit=_int('PROXY_BODY_LIMIT_BYTES', 100000000),
        auth_request_max_bytes=_int('AUTH_REQUEST_MAX_BYTES', 65536),
        json_request_max_bytes=_int('JSON_REQUEST_MAX_BYTES', MIB),
        session_idle_days=_int('SESSION_IDLE_DAYS', 30),
        session_max_days=_int('SESSION_MAX_DAYS', 180),
        sessions_max=_int('SESSIONS_MAX', 50),
        reauth_seconds=_int('REAUTH_SECONDS', 600),
        deletion_grace_days=_int('ACCOUNT_DELETION_GRACE_DAYS', 14),
        username_cooldown_days=_int('USERNAME_COOLDOWN_DAYS', 30),
        username_hold_days=_int('USERNAME_HOLD_DAYS', 30),
        verify_token_hours=_int('VERIFY_TOKEN_HOURS', 24),
        reset_token_minutes=_int('RESET_TOKEN_MINUTES', 60),
        upload_keys_max=_int('UPLOAD_KEYS_MAX', 20),
        upload_key_rate_per_hour=_int('UPLOAD_KEY_RATE_PER_HOUR', 600),
        rate_limits=limits,
        domain_pending_hours=_int('DOMAIN_PENDING_HOURS', 72),
        domain_failing_days=_int('DOMAIN_FAILING_DAYS', 3),
        domain_paused_days=_int('DOMAIN_PAUSED_DAYS', 30),
        domain_min_account_age_days=_int('DOMAIN_MIN_ACCOUNT_AGE_DAYS', 7),
        export_keep_days=_int('EXPORT_KEEP_DAYS', 7),
    )


def check_api(environ=os.environ):
    """Boot checks (§3.2, §15): SESSION_COOKIE_INSECURE only with FILESGG_DEV_TOOLS=1, Discord's id and
    secret both or neither, and the Cloudflare zone with the token."""
    if truthy(environ.get('SESSION_COOKIE_INSECURE')) and not truthy(environ.get('FILESGG_DEV_TOOLS')):
        raise RuntimeError('Refusing to start: SESSION_COOKIE_INSECURE needs FILESGG_DEV_TOOLS=1 (never in production)')
    if bool(environ.get('DISCORD_CLIENT_ID')) != bool(environ.get('DISCORD_CLIENT_SECRET')):
        raise RuntimeError('Refusing to start: set both DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, or neither')
    if environ.get('CLOUDFLARE_API_TOKEN') and not environ.get('CLOUDFLARE_ZONE_ID'):
        raise RuntimeError('Refusing to start: CLOUDFLARE_ZONE_ID is required with CLOUDFLARE_API_TOKEN')
