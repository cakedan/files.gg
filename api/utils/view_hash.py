"""IP hashing for unique-view counting (PLAN.md schema fix 1).

ip_hash = HMAC-SHA256(daily_key, ip), with
daily_key = HMAC-SHA256(VIEW_HASH_SECRET, "filesgg-view-day:" + UTC date).

Every API worker derives the same key from the shared secret and the date; the
key is never stored, so once a day has passed its hashes can't be tied back to
an IP (and file_view_seen rows are deleted after 2 days anyway).
"""

import hashlib
import hmac

from datetime import datetime, timezone
from functools import lru_cache


def utc_today():
    return datetime.now(timezone.utc).date()


@lru_cache(maxsize=4)
def daily_key(secret, day):
    return hmac.new(secret.encode('utf-8'), b'filesgg-view-day:' + day.isoformat().encode('ascii'),
                    hashlib.sha256).digest()


def ip_hash(secret, day, ip):
    return hmac.new(daily_key(secret, day), ip.encode('utf-8'), hashlib.sha256).digest()
