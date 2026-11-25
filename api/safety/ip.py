"""Stable keyed IP hashes and sealed IPs (contract milestone-4 §1 "IP hashes", §3.6).

    abuse_ip_hash = HMAC-SHA256(ABUSE_HASH_SECRET, "filesgg-abuse-ip-1" + "\\n" + normalize(ip))

    normalize(ip): IPv4-mapped IPv6 -> the IPv4 address; IPv4 -> dotted quad;
                   IPv6 -> its /64 network, compressed lowercase ("2001:db8::/64")

Unlike the daily view hashes (utils/view_hash.py) the key never rotates, so a hash can back a
ban, rate limits and distinct-reporter counting; it's kept 30 days (ABUSE_IP_KEEP_DAYS), and
in `bans` while the ban lasts. The raw uploader IP is only ever kept sealed to the offline
evidence key (a libsodium sealed box to EVIDENCE_PUBLIC_KEY): nothing on a server can open it.
"""

import base64
import hashlib
import hmac
import ipaddress

PREFIX = 'filesgg-abuse-ip-1'


def normalize(ip):
    address = ipaddress.ip_address(str(ip).strip().strip('[]'))
    if address.version == 6:
        if address.ipv4_mapped is not None:
            return str(address.ipv4_mapped)
        return str(ipaddress.ip_network('{}/64'.format(address), strict=False))
    return str(address)


def abuse_ip_hash(ip, secret):
    """The 32-byte hash, or None for something that isn't an IP."""
    if not ip or not secret:
        return None
    try:
        normalized = normalize(ip)
    except ValueError:
        return None
    message = '{}\n{}'.format(PREFIX, normalized).encode('utf-8')
    return hmac.new(secret.encode('utf-8'), message, hashlib.sha256).digest()


def check_public_key(value):
    """EVIDENCE_PUBLIC_KEY must be a base64 32-byte Curve25519 public key."""
    from safety.settings import ConfigError
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception:
        raw = b''
    if len(raw) != 32:
        raise ConfigError('Refusing to start: EVIDENCE_PUBLIC_KEY must be a base64 libsodium public key (32 bytes)')
    return raw


def seal_ip(ip, public_key_b64):
    """The raw IP sealed to the offline evidence key, or None."""
    if not ip or not public_key_b64:
        return None
    from nacl.public import PublicKey, SealedBox
    return SealedBox(PublicKey(base64.b64decode(public_key_b64))).encrypt(str(ip).encode('utf-8'))


def for_request(ip, settings):
    """(abuse_ip_hash, sealed ip) for an upload or report from `ip`."""
    return abuse_ip_hash(ip, settings.abuse_hash_secret), seal_ip(ip, settings.evidence_public_key)
