"""Which client IP to believe (per-IP limits, view counting).

1. If ORIGIN_SHARED_SECRET is set and the request's X-Filesgg-Origin-Secret
   matches it (constant-time), the request came through our Cloudflare Worker:
   use X-Filesgg-Client-Ip (the worker copies it from CF-Connecting-IP).
2. Otherwise CF-Connecting-IP and X-Filesgg-Client-Ip are ignored: anyone who
   reaches the origin directly can set them. Use the last X-Forwarded-For hop
   if PROXIES_COUNT >= 1 (our nginx overwrites it with $remote_addr), else the
   socket peer.

The country Cloudflare derives from the client's IP (X-Filesgg-Client-Country, ISO 3166-1 alpha-2) is believed
the same way, only with the secret: utils/regions.py, `request.ctx.client_country` (milestone-7 §11.1).

The secret header is removed from the request once checked, so nothing later
in the request can log or echo it.
"""

import hmac
import ipaddress

CLIENT_IP_HEADER = 'x-filesgg-client-ip'
ORIGIN_SECRET_HEADER = 'x-filesgg-origin-secret'
# Sent only on the Worker's own /internal lookups; it strips it from every request it forwards.
INTERNAL_LOOKUP_HEADER = 'x-filesgg-internal-lookup'


def valid_ip(value):
    """The address in canonical form, or None if `value` is not an IP."""
    if not value:
        return None
    value = value.strip()
    if value.startswith('[') and value.endswith(']'):
        value = value[1:-1]
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


def from_trusted_worker(headers, secret):
    if not secret:
        return False
    given = headers.get(ORIGIN_SECRET_HEADER)
    if given is None:
        return False
    return hmac.compare_digest(given.encode('utf-8', 'surrogateescape'), secret.encode('utf-8'))


def internal_lookup(headers, secret):
    """The Worker's own /internal lookup: the shared secret and the lookup header together."""
    return headers.get(INTERNAL_LOOKUP_HEADER) == '1' and from_trusted_worker(headers, secret)


def forwarded_for(headers, proxies_count):
    if proxies_count < 1:
        return None
    hops = [hop.strip() for value in headers.getall('x-forwarded-for', []) for hop in value.split(',')]
    hops = [hop for hop in hops if hop]
    if len(hops) < proxies_count:
        return None
    return valid_ip(hops[-proxies_count])


def resolve(headers, peer, secret, proxies_count):
    if from_trusted_worker(headers, secret):
        ip = valid_ip(headers.get(CLIENT_IP_HEADER))
        if ip:
            return ip
    return forwarded_for(headers, proxies_count) or valid_ip(peer) or peer


def scrub(headers):
    """Drop the shared secret from the request headers."""
    while ORIGIN_SECRET_HEADER in headers:
        del headers[ORIGIN_SECRET_HEADER]
