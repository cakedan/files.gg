"""Can this email address's domain receive mail? Replaces Mailgun's mailbox check at sign-up.

The email provider (Cloudflare Email Service) has no address-validation API. Sending to domains that can't receive mail produces
hard bounces, and a high bounce rate hurts deliverability for everyone, so registration
rejects addresses whose domain has no MX record (or, per RFC 5321, no A/AAAA fallback).
The verification email itself remains the real proof that the mailbox exists.
"""

import logging

import dns.asyncresolver
import dns.exception
import dns.resolver

log = logging.getLogger(__name__)

TIMEOUT = 4.0


async def _has_records(domain, rdtype):
    resolver = dns.asyncresolver.Resolver()
    resolver.lifetime = TIMEOUT
    try:
        answer = await resolver.resolve(domain, rdtype)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
        return False
    return len(answer) > 0


async def domain_accepts_mail(address):
    """True if the domain can receive mail, False if it clearly can't.

    A DNS timeout or other resolver failure returns True: an outage on our side must not block
    sign-ups, and the verification email still has to be clicked.
    """
    domain = address.rsplit('@', 1)[-1].strip().rstrip('.').lower()
    try:
        domain = domain.encode('idna').decode('ascii')
    except UnicodeError:
        return False
    try:
        if await _has_records(domain, 'MX'):
            # a "null MX" (RFC 7505, a single `0 .`) means the domain explicitly accepts no mail
            resolver = dns.asyncresolver.Resolver()
            resolver.lifetime = TIMEOUT
            answer = await resolver.resolve(domain, 'MX')
            return not all(str(record.exchange) == '.' for record in answer)
        return await _has_records(domain, 'A') or await _has_records(domain, 'AAAA')
    except (dns.exception.Timeout, dns.resolver.LifetimeTimeout):
        log.warning('mail domain check timed out for %s; allowing', domain)
        return True
    except Exception:
        log.exception('mail domain check failed for %s; allowing', domain)
        return True
