"""IP hashing for unique-view counting (PLAN.md schema fix 1).

ip_hash = HMAC-SHA256(daily_key, normalize(ip)), with
daily_key = HMAC-SHA256(VIEW_HASH_SECRET, "filesgg-view-day:" + UTC date).

normalize() is safety/ip.py's: an IPv6 client is its /64 (IPv4-mapped addresses are the IPv4
address), so rotating addresses inside one /64 doesn't mint new views, unlock attempts or
anonymous storage. The same goes for the purpose hashes below.

Every API worker derives the same key from the shared secret and the date; the
key is never stored, so once a day has passed its hashes can't be tied back to
an IP (and file_view_seen rows are deleted after 2 days anyway).
"""

import hashlib
import hmac

from datetime import datetime, timezone
from functools import lru_cache

from safety.ip import normalize


def utc_today():
    return datetime.now(timezone.utc).date()


@lru_cache(maxsize=4)
def daily_key(secret, day):
    return hmac.new(secret.encode('utf-8'), b'filesgg-view-day:' + day.isoformat().encode('ascii'),
                    hashlib.sha256).digest()


def normalize_ip(ip):
    """The address per-IP counting and limits key on (an IPv6 /64); anything that isn't an IP
    is used as it is."""
    try:
        return normalize(ip)
    except ValueError:
        return str(ip)


def ip_hash(secret, day, ip):
    return hmac.new(daily_key(secret, day), normalize_ip(ip).encode('utf-8'), hashlib.sha256).digest()


@lru_cache(maxsize=16)
def purpose_key(secret, purpose, day):
    """A daily key for another purpose (e.g. 'upload-ip', 'unlock'), so hashes
    made for different features can't be matched against each other."""
    return hmac.new(secret.encode('utf-8'), 'filesgg-{}-day:{}'.format(purpose, day.isoformat()).encode('ascii'),
                    hashlib.sha256).digest()


def purpose_hash(secret, purpose, day, ip):
    return hmac.new(purpose_key(secret, purpose, day), normalize_ip(ip).encode('utf-8'), hashlib.sha256).digest()


def recent_hashes(secret, purpose, ip, days=2):
    """This IP's hashes under today's and the previous days' keys (a rolling
    24 h window can span two UTC days)."""
    from datetime import timedelta
    today = utc_today()
    return [purpose_hash(secret, purpose, today - timedelta(days=n), ip) for n in range(days)]
