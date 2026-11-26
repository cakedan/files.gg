"""Regional rules (contract milestone-7 §11): adult content isn't uploaded or marked from a blocked country, and the
minimum age shown to visitors depends on where they are.

The country is the one Cloudflare derives from the visitor's IP: the Worker forwards it as X-Filesgg-Client-Country,
only with the origin secret, and the request middleware (app.py) puts it on `request.ctx.client_country` (`country`
below), or None when it's unknown. It's never stored or logged.

ADULT_BLOCKED_COUNTRIES is read on every call, like the other settings (tests override it with monkeypatch):
comma-separated country codes, spaces and case ignored; unset, empty or nothing valid means GB. An unknown country is never blocked."""

import os
import re

from utils import errors

COUNTRY_HEADER = 'x-filesgg-client-country'
DEFAULT_BLOCKED = frozenset(('GB',))
# Cloudflare's "unknown"; the Worker doesn't forward it (nor T1, Tor), and it would be unknown here anyway
UNKNOWN = frozenset(('XX',))
COUNTRY = re.compile(r'[A-Z]{2}')

# the EU and the EEA (§11.1): the minimum age is 16 there
EEA = frozenset((
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT',
    'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'IS', 'LI', 'NO',
))
MINIMUM_AGE = 13
MINIMUM_AGE_EEA = 16


def valid_country(value):
    """`value` if it's two letters A-Z (and not Cloudflare's unknown `XX`), else None."""
    if isinstance(value, str) and COUNTRY.fullmatch(value) and value not in UNKNOWN:
        return value
    return None


def from_headers(headers, trusted):
    """The visitor's country, believed only from the trusted Worker (`client_ip.from_trusted_worker`)."""
    return valid_country(headers.get(COUNTRY_HEADER)) if trusted else None


def blocked_countries():
    """ADULT_BLOCKED_COUNTRIES as a set of upper-case codes. Entries that aren't two letters are dropped, and with none
    left (unset, empty, only commas, or only malformed entries) it's GB: the same rule as the Worker's
    `adultBlockedCountries` (cf-worker/worker/utils/region.js), so the two enforcers never disagree.
    ops/check-env.sh refuses a malformed value before a deploy."""
    value = os.getenv('ADULT_BLOCKED_COUNTRIES') or ''
    codes = frozenset(code for code in (entry.strip().upper() for entry in value.split(','))
                      if COUNTRY.fullmatch(code))
    return codes or DEFAULT_BLOCKED


def adult_blocked(country):
    return country is not None and country in blocked_countries()


def minimum_age(country):
    """16 in the EU and EEA, and for an unknown country (the conservative statement); 13 elsewhere."""
    return MINIMUM_AGE_EEA if country is None or country in EEA else MINIMUM_AGE


def country_of(request):
    return getattr(request.ctx, 'client_country', None)


def request_blocked(request):
    return adult_blocked(country_of(request))


def refuse_adult(request):
    """451 ADULT_CONTENT_UNAVAILABLE when the request comes from a country where adult content is unavailable."""
    if request_blocked(request):
        raise errors.adult_content_unavailable()
