"""Custom domains on Cloudflare for SaaS (contract milestone-6 §10): which hostnames, the records, the
statuses and their checks, serving, domain-only mode, and the owner's API. Synchronous psycopg 3: the API
runs these in a thread (safety/run.py), the worker calls them directly.
"""

import base64
import ipaddress
import logging
import re
import secrets

from datetime import timedelta
from functools import lru_cache
from urllib.parse import urlsplit

from db.models import epoch
from utils import cloudflare, errors, mail
from utils.account_settings import account_settings
from utils.generators import Snowflake
from utils.urls import cdn_url, public_url

log = logging.getLogger(__name__)

STATUSES = ('pending_dns', 'pending_cert', 'active', 'failing', 'failed', 'paused', 'disabled')
SERVED = ('active', 'failing')
POLLED = ('pending_dns', 'pending_cert', 'active', 'failing')
PENDING = ('pending_dns', 'pending_cert')
# Cloudflare's values (§10.3)
CF_ACTIVE = ('active', 'active_redeploying')
CF_PENDING = ('pending', 'pending_provisioned', 'provisioned')
SSL_ACTIVE = ('active',)
SSL_PENDING = ('initializing', 'pending_validation', 'pending_issuance', 'pending_deployment', 'staging_deployment',
               'staging_active', 'holding_deployment')
# pending rows are checked 1, 2, 5, 10, 15 and 30 minutes into their window, then every 30 minutes
PENDING_SCHEDULE = (1, 2, 5, 10, 15, 30)
TXT_PREFIX = '_filesgg-verify.'
TXT_VALUE = 'filesgg-verify='
DNS_RESOLVERS = ('1.1.1.1', '8.8.8.8')
DNS_TIMEOUT = 3.0
LABEL = re.compile(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
BATCH = 50
COLUMNS = ('id', 'user_id', 'hostname', 'cf_hostname_id', 'status', 'status_reason', 'verify_token', 'is_default',
           'scope', 'cf_status', 'cf_ssl_status', 'dns_txt_ok', 'dns_cname_ok', 'verified_at', 'last_checked_at',
           'next_check_at', 'pending_since', 'failing_since', 'paused_at', 'disabled_reason', 'disabled_action_id',
           'created_at', 'deleted_at')
PREMIUM_SQL = ("EXISTS (SELECT 1 FROM user_entitlements e WHERE e.user_id = {u}.id AND e.kind = 'premium' AND "
               "e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now()))")
# a domain serves when it's active or failing, its owner is premium and the owner's account is active (§10.5)
SERVING_SQL = ("(d.deleted_at IS NULL AND d.status IN ('active', 'failing') AND u.deleted_at IS NULL AND "
               "u.deletion_requested_at IS NULL AND " + PREMIUM_SQL.format(u='u') + ')')
# domain-only is effective when the owner switched it on, is premium and has a serving domain (§10.6)
DOMAIN_ONLY_SQL = ('({u}.domain_only AND ' + PREMIUM_SQL + " AND EXISTS (SELECT 1 FROM custom_domains d JOIN users u "
                   "ON u.id = d.user_id WHERE d.user_id = {u}.id AND " + SERVING_SQL + '))')


def domain_only_sql(alias):
    return DOMAIN_ONLY_SQL.format(u=alias)


def select(alias='d'):
    return ', '.join('{}.{}'.format(alias, c) for c in COLUMNS)


class Domain:
    def __init__(self, row):
        for name, value in zip(COLUMNS, row):
            setattr(self, name, value)


# --- which hostnames (§10.1) --------------------------------------------------------------------------------------

@lru_cache(maxsize=1)
def public_suffixes():
    from publicsuffixlist import PublicSuffixList
    # the snapshot shipped in the package: never fetched at runtime
    return PublicSuffixList()


def _host(url):
    return (urlsplit(url).hostname or '').lower()


def reserved_hosts(settings=None):
    import os
    settings = settings or account_settings()
    hosts = {'files.gg', _host(public_url()), _host(cdn_url()), _host(settings.api_public_url)}
    for name in ('MAIN_HOST', 'CDN_HOST', 'API_HOST', 'PROXY_HOST'):
        if os.getenv(name):
            hosts.add(os.getenv(name).strip().lower())
    target = settings.custom_domain_target
    hosts.add(target)
    zone = public_suffixes().privatesuffix(target)
    if zone:
        hosts.add(zone)
    return {h for h in hosts if h}


def normalize(raw, settings=None):
    """The lowercase punycode hostname, or 400 INVALID_HOSTNAME { reason }."""
    if not isinstance(raw, str):
        raise errors.invalid_hostname('syntax')
    host = raw.strip()
    if host.endswith('.'):
        host = host[:-1]
    host = host.lower()
    if not host or len(host) > 1000:
        raise errors.invalid_hostname('syntax')
    if '*' in host:
        raise errors.invalid_hostname('wildcard')
    try:
        ipaddress.ip_address(host.strip('[]'))
        raise errors.invalid_hostname('ip')
    except ValueError:
        pass
    try:
        import idna
        host = idna.encode(host, uts46=True).decode('ascii').lower()
    except Exception:
        raise errors.invalid_hostname('syntax')
    labels = host.split('.')
    if len(host) > 253 or len(labels) < 2 or not all(LABEL.match(label) for label in labels):
        raise errors.invalid_hostname('syntax')
    if labels[-1].isdigit():
        raise errors.invalid_hostname('ip')
    for reserved in reserved_hosts(settings):
        if host == reserved or host.endswith('.' + reserved):
            raise errors.invalid_hostname('reserved')
    psl = public_suffixes()
    if psl.is_public(host):
        raise errors.invalid_hostname('public_suffix')
    registrable = psl.privatesuffix(host)
    if registrable is None:
        raise errors.invalid_hostname('public_suffix')
    if registrable == host:
        raise errors.invalid_hostname('apex')
    return host


def new_verify_token():
    """16 random bytes, base32 lowercase without padding (26 characters)."""
    return base64.b32encode(secrets.token_bytes(16)).decode('ascii').rstrip('=').lower()


def records(domain, settings=None):
    settings = settings or account_settings()
    return [
        {'type': 'CNAME', 'name': domain.hostname, 'value': settings.custom_domain_target,
         'ok': bool(domain.dns_cname_ok)},
        {'type': 'TXT', 'name': TXT_PREFIX + domain.hostname, 'value': TXT_VALUE + domain.verify_token,
         'ok': bool(domain.dns_txt_ok)},
    ]


# --- DNS checks (§10.4) ----------------------------------------------------------------------------------------------

def lookup(name, rdtype):
    """The record strings at `name` (TXT strings joined, CNAME targets without the dot); [] when there are
    none or the lookup fails. Tests replace this function: the suite never queries DNS."""
    import dns.exception
    import dns.resolver
    resolver = dns.resolver.Resolver(configure=False)
    resolver.nameservers = list(DNS_RESOLVERS)
    resolver.lifetime = DNS_TIMEOUT
    try:
        answer = resolver.resolve(name, rdtype)
    except (dns.exception.DNSException, OSError):
        return []
    out = []
    for record in answer:
        if rdtype == 'TXT':
            out.append(b''.join(record.strings).decode('utf-8', 'replace'))
        else:
            out.append(str(record.target).rstrip('.').lower())
    return out


def check_dns(domain, settings=None):
    """(txt_ok, cname_ok): our TXT matches exactly; the CNAME chain reaches CUSTOM_DOMAIN_TARGET."""
    settings = settings or account_settings()
    txt_ok = (TXT_VALUE + domain.verify_token) in lookup(TXT_PREFIX + domain.hostname, 'TXT')
    name, seen, cname_ok = domain.hostname, set(), False
    for _ in range(8):
        targets = lookup(name, 'CNAME')
        if not targets:
            break
        name = targets[0]
        if name == settings.custom_domain_target:
            cname_ok = True
            break
        if name in seen:
            break
        seen.add(name)
    return txt_ok, cname_ok


# --- statuses (§10.3) ------------------------------------------------------------------------------------------------

def _cf_ok(cf_status):
    return cf_status in CF_ACTIVE


def _ssl_ok(ssl_status):
    return ssl_status in SSL_ACTIVE


def next_check(status, pending_since, now):
    if status in PENDING:
        for minutes in PENDING_SCHEDULE:
            at = pending_since + timedelta(minutes=minutes)
            if at > now:
                return at
        return now + timedelta(minutes=30)
    if status == 'active':
        return now + timedelta(days=1)
    if status == 'failing':
        return now + timedelta(hours=1)
    return None


def evaluate(domain, txt_ok, cname_ok, cf_status, ssl_status, now, premium=True, settings=None):
    """The §10.3 transitions for one check: {status, status_reason, verified_at, failing_since, paused_at,
    delete_cf, event}. Pure, so §16.9 is a table test."""
    settings = settings or account_settings()
    out = {'status': domain.status, 'status_reason': domain.status_reason, 'verified_at': domain.verified_at,
           'failing_since': domain.failing_since, 'paused_at': domain.paused_at, 'delete_cf': False, 'event': None}
    if domain.status not in POLLED:
        return out
    if not premium:
        out.update(status='paused', status_reason='premium_ended', paused_at=now, failing_since=None, event='paused')
        return out
    records_ok = bool(txt_ok and cname_ok)
    serving_ok = records_ok and _cf_ok(cf_status) and _ssl_ok(ssl_status)
    if domain.status in PENDING:
        if domain.pending_since + timedelta(hours=settings.domain_pending_hours) <= now and not serving_ok:
            out.update(status='failed', status_reason='dns_timeout', delete_cf=True, event='failed')
            return out
        if records_ok and _cf_ok(cf_status):
            if _ssl_ok(ssl_status):
                out.update(status='active', status_reason=None, verified_at=domain.verified_at or now,
                           event='active' if domain.verified_at else None)
            else:
                out.update(status='pending_cert', status_reason=None)
        else:
            out.update(status='pending_dns', status_reason=None)
        return out
    if serving_ok:
        out.update(status='active', status_reason=None, failing_since=None,
                   event='active' if domain.status == 'failing' else None)
        return out
    since = domain.failing_since if domain.status == 'failing' and domain.failing_since else now
    if since + timedelta(days=settings.domain_failing_days) <= now:
        out.update(status='failed', status_reason='dns_changed', failing_since=since, delete_cf=True, event='failed')
    else:
        out.update(status='failing', status_reason='dns_changed' if not records_ok else 'certificate',
                   failing_since=since)
    return out


# --- loading -------------------------------------------------------------------------------------------------------

def one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()


def load(conn, domain_id, user_id=None, lock=False):
    sql = 'SELECT {} FROM custom_domains d WHERE d.id = %s AND d.deleted_at IS NULL'.format(select())
    params = [domain_id]
    if user_id is not None:
        sql += ' AND d.user_id = %s'
        params.append(user_id)
    row = one(conn, sql + (' FOR UPDATE' if lock else ''), params)
    return Domain(row) if row else None


def owner_flags(conn, user_id):
    """(premium, account active) of a domain's owner."""
    row = one(conn, 'SELECT {}, u.deleted_at IS NULL AND u.deletion_requested_at IS NULL FROM users u '
                    'WHERE u.id = %s'.format(PREMIUM_SQL.format(u='u')), (user_id,))
    return (bool(row[0]), bool(row[1])) if row else (False, False)


def serving(domain, premium, active):
    return domain.deleted_at is None and domain.status in SERVED and premium and active


def pending_until(domain, settings):
    if domain.status not in PENDING:
        return None
    return epoch(domain.pending_since + timedelta(hours=settings.domain_pending_hours))


def domain_dict(domain, premium, active, settings=None):
    settings = settings or account_settings()
    return {
        'id': str(domain.id),
        'hostname': domain.hostname,
        'status': domain.status,
        'status_reason': domain.status_reason,
        'serving': serving(domain, premium, active),
        'is_default': domain.is_default,
        'scope': domain.scope,
        'records': records(domain, settings),
        'cloudflare': {'status': domain.cf_status, 'ssl_status': domain.cf_ssl_status},
        'created_at': epoch(domain.created_at),
        'verified_at': epoch(domain.verified_at),
        'last_checked_at': epoch(domain.last_checked_at),
        'pending_until': pending_until(domain, settings),
        'failing_since': epoch(domain.failing_since),
        'disabled_reason': domain.disabled_reason,
    }


def user_row(conn, user_id):
    return one(conn, 'SELECT username, email, email_verified, domain_only, domain_only_paused_at FROM users '
                     'WHERE id = %s', (user_id,))


def _status_mail(conn, user_id, hostname, event):
    row = user_row(conn, user_id)
    if row is None or not row[1] or not row[2]:
        return None
    return mail.domain_status(row[1], row[0], hostname, event)


# --- checks (§10.4) ------------------------------------------------------------------------------------------------

def queue_cf_delete(conn, domain_id, cf_hostname_id):
    if not cf_hostname_id:
        return
    from jobs.queue import enqueue
    enqueue('domain_delete', {'domain_id': str(domain_id), 'cf_hostname_id': cf_hostname_id}, conn=conn)


def check(conn, domain_id, manual=False, settings=None):
    """One check of one domain (the checker, "Check now"): Cloudflare's hostname, our TXT and the CNAME,
    then §10.3. Runs its own short transactions; the network calls happen outside them. Returns the mails
    to send."""
    settings = settings or account_settings()
    domain = load(conn, domain_id)
    if domain is None or domain.status not in POLLED:
        return []
    premium, _ = owner_flags(conn, domain.user_id)
    cf_status, ssl_status = domain.cf_status, domain.cf_ssl_status
    if premium:
        if domain.cf_hostname_id:
            try:
                _, cf_status, ssl_status = cloudflare.get(domain.cf_hostname_id, settings)
                if manual and (cf_status not in CF_ACTIVE or ssl_status not in SSL_ACTIVE):
                    _, cf_status, ssl_status = cloudflare.recheck(domain.cf_hostname_id, settings)
            except cloudflare.CloudflareError:
                log.warning('cloudflare check failed for domain %s', domain.id)
        txt_ok, cname_ok = check_dns(domain, settings)
    else:
        txt_ok, cname_ok = domain.dns_txt_ok, domain.dns_cname_ok
    mails = []
    with conn.transaction():
        locked = load(conn, domain_id, lock=True)
        if locked is None or locked.status != domain.status:
            return []
        now = one(conn, 'SELECT now()')[0]
        result = evaluate(locked, txt_ok, cname_ok, cf_status, ssl_status, now, premium=premium, settings=settings)
        status = result['status']
        conn.execute(
            'UPDATE custom_domains SET status = %s, status_reason = %s, verified_at = %s, failing_since = %s, '
            'paused_at = %s, cf_status = %s, cf_ssl_status = %s, dns_txt_ok = %s, dns_cname_ok = %s, '
            'last_checked_at = now(), next_check_at = %s WHERE id = %s',
            (status, result['status_reason'], result['verified_at'], result['failing_since'], result['paused_at'],
             cf_status, ssl_status, txt_ok, cname_ok, next_check(status, locked.pending_since, now), domain_id))
        if result['delete_cf']:
            queue_cf_delete(conn, domain_id, locked.cf_hostname_id)
            conn.execute('UPDATE custom_domains SET cf_hostname_id = NULL WHERE id = %s', (domain_id,))
        if result['event'] in ('failed', 'paused', 'active') and status != locked.status:
            mails.append(_status_mail(conn, locked.user_id, locked.hostname, result['event']))
        mails += refresh_domain_only(conn, locked.user_id)
    return [m for m in mails if m is not None]


def run_checker(conn, settings=None, limit=BATCH):
    """The domain_checker task (every minute): rows due, 50 at a time. Also pauses domains whose owner lost
    premium, and gives up on domains paused for DOMAIN_PAUSED_DAYS."""
    settings = settings or account_settings()
    mails = pause_lapsed(conn, settings)
    rows = conn.execute(
        "SELECT id FROM custom_domains WHERE deleted_at IS NULL AND status IN ('pending_dns', 'pending_cert', "
        "'active', 'failing') AND next_check_at <= now() ORDER BY next_check_at LIMIT %s", (limit,)).fetchall()
    for (domain_id,) in rows:
        try:
            mails += check(conn, domain_id, settings=settings)
        except Exception:
            log.exception('domain check failed for %s', domain_id)
    return mails


def pause_lapsed(conn, settings):
    """Domains whose owner isn't premium any more are paused; domains paused for DOMAIN_PAUSED_DAYS fail and
    lose their Cloudflare hostname (§10.3)."""
    mails = []
    with conn.transaction():
        users = conn.execute(
            "SELECT DISTINCT d.user_id FROM custom_domains d JOIN users u ON u.id = d.user_id WHERE d.deleted_at IS "
            "NULL AND d.status IN ('pending_dns', 'pending_cert', 'active', 'failing') AND NOT "
            + PREMIUM_SQL.format(u='u')).fetchall()
        for (user_id,) in users:
            mails += pause_user_domains(conn, user_id)
        stale = conn.execute(
            "UPDATE custom_domains SET status = 'failed', status_reason = 'premium_ended', next_check_at = NULL, "
            "is_default = false WHERE deleted_at IS NULL AND status = 'paused' AND paused_at <= now() - "
            "make_interval(days => %s) RETURNING id, cf_hostname_id", (settings.domain_paused_days,)).fetchall()
        for domain_id, cf_id in stale:
            queue_cf_delete(conn, domain_id, cf_id)
        if stale:
            conn.execute('UPDATE custom_domains SET cf_hostname_id = NULL WHERE id = ANY(%s)',
                         ([r[0] for r in stale],))
    return mails


def pause_user_domains(conn, user_id):
    """Premium ended (§9.3): every live, polled domain goes to `paused`."""
    rows = conn.execute(
        "UPDATE custom_domains SET status = 'paused', status_reason = 'premium_ended', paused_at = now(), "
        "failing_since = NULL, next_check_at = NULL WHERE user_id = %s AND deleted_at IS NULL AND status IN "
        "('pending_dns', 'pending_cert', 'active', 'failing') RETURNING hostname", (user_id,)).fetchall()
    mails = [_status_mail(conn, user_id, hostname, 'paused') for (hostname,) in rows]
    mails += refresh_domain_only(conn, user_id)
    return [m for m in mails if m is not None]


def resume_user_domains(conn, user_id):
    """Premium came back: paused domains go to `pending_cert` with a new window, re-checked at once."""
    conn.execute("UPDATE custom_domains SET status = 'pending_cert', status_reason = NULL, paused_at = NULL, "
                 "pending_since = now(), next_check_at = now() WHERE user_id = %s AND deleted_at IS NULL AND "
                 "status = 'paused'", (user_id,))
    return refresh_domain_only(conn, user_id)


def domain_only_state(conn, user_id):
    """(enabled, effective, paused)."""
    row = one(conn, 'SELECT u.domain_only, {} FROM users u WHERE u.id = %s'.format(domain_only_sql('u')), (user_id,))
    if row is None:
        return False, False, False
    enabled, effective = bool(row[0]), bool(row[1])
    return enabled, effective, enabled and not effective


def refresh_domain_only(conn, user_id):
    """§10.6: one email when domain-only pauses by itself (tracked by domain_only_paused_at), and one when it
    resumes."""
    enabled, effective, paused = domain_only_state(conn, user_id)
    row = user_row(conn, user_id)
    if row is None:
        return []
    paused_at = row[4]
    event = None
    if paused and paused_at is None:
        conn.execute('UPDATE users SET domain_only_paused_at = now() WHERE id = %s', (user_id,))
        event = 'domain_only_paused'
    elif not paused and paused_at is not None:
        conn.execute('UPDATE users SET domain_only_paused_at = NULL WHERE id = %s', (user_id,))
        event = 'domain_only_resumed' if effective else None
    if event is None or not row[1] or not row[2]:
        return []
    return [mail.domain_status(row[1], row[0], '', event)]


# --- the owner's API (§10.5) ------------------------------------------------------------------------------------------

def owned(conn, user, domain_id, lock=False):
    try:
        domain_id = int(domain_id)
    except (TypeError, ValueError):
        raise errors.unknown_domain()
    domain = load(conn, domain_id, user.id, lock=lock)
    if domain is None:
        raise errors.unknown_domain()
    return domain


def listing(conn, user, settings=None):
    settings = settings or account_settings()
    premium, active = owner_flags(conn, user.id)
    rows = conn.execute('SELECT {} FROM custom_domains d WHERE d.user_id = %s AND d.deleted_at IS NULL '
                        'ORDER BY d.id'.format(select()), (user.id,)).fetchall()
    enabled, effective, paused = domain_only_state(conn, user.id)
    return {'items': [domain_dict(Domain(r), premium, active, settings) for r in rows],
            'limit': settings.premium_custom_domains if premium else 0,
            'domain_only': {'enabled': enabled, 'effective': effective, 'paused': paused}}


def detail(conn, user, domain, settings=None):
    premium, active = owner_flags(conn, user.id)
    return domain_dict(domain, premium, active, settings)


def check_requirements(conn, user, settings):
    """§10.13: premium, the limit, a verified email and a 7-day-old account."""
    premium, _ = owner_flags(conn, user.id)
    if not premium:
        raise errors.premium_required()
    row = one(conn, 'SELECT email IS NOT NULL AND email_verified, created_at FROM users WHERE id = %s', (user.id,))
    if not row[0]:
        raise errors.domain_requirements('email_not_verified')
    available = row[1] + timedelta(days=settings.domain_min_account_age_days)
    if available > one(conn, 'SELECT now()')[0]:
        raise errors.domain_requirements('account_too_new', epoch(available))


def check_global_cap(conn, settings):
    count = one(conn, 'SELECT count(*) FROM custom_domains WHERE cf_hostname_id IS NOT NULL')[0]
    if count >= settings.custom_domains_global_max:
        raise errors.domains_unavailable()


def _count_add(conn, user, settings):
    from utils.ratelimit_sync import hit
    count, retry_after = hit(conn, 'domain_add', 'user:{:x}'.format(user.id), 'day')
    if count > settings.rate('domain_add'):
        raise errors.too_many_attempts(retry_after)


def add(conn, user, hostname, settings=None):
    """POST /users/@me/domains. `conn` is in autocommit: the checks, then Cloudflare (outside any
    transaction), then the row. A Cloudflare failure stores nothing (503 DOMAINS_UNAVAILABLE)."""
    settings = settings or account_settings()
    if not settings.domains_enabled:
        raise errors.domains_unavailable()
    host = normalize(hostname, settings)
    with conn.transaction():
        check_requirements(conn, user, settings)
        used = one(conn, "SELECT count(*) FROM custom_domains WHERE user_id = %s AND deleted_at IS NULL AND "
                         "status <> 'disabled'", (user.id,))[0]
        if used >= settings.premium_custom_domains:
            raise errors.domain_limit_reached(settings.premium_custom_domains)
        if one(conn, 'SELECT 1 FROM custom_domains WHERE hostname = %s AND deleted_at IS NULL', (host,)):
            raise errors.domain_taken()
        check_global_cap(conn, settings)
        _count_add(conn, user, settings)
    try:
        cf_id, cf_status, ssl_status = cloudflare.create(host, settings)
    except cloudflare.CloudflareError:
        raise errors.domains_unavailable()
    domain_id = Snowflake.generate()
    try:
        with conn.transaction():
            now = one(conn, 'SELECT now()')[0]
            conn.execute(
                'INSERT INTO custom_domains (id, user_id, hostname, cf_hostname_id, status, verify_token, cf_status, '
                "cf_ssl_status, pending_since, next_check_at, created_at) VALUES (%s, %s, %s, %s, 'pending_dns', %s, "
                '%s, %s, %s, %s, %s)',
                (domain_id, user.id, host, cf_id, new_verify_token(), cf_status, ssl_status, now,
                 next_check('pending_dns', now, now), now))
    except Exception as error:
        # taken meanwhile (the unique index): give the hostname back to Cloudflare
        try:
            cloudflare.delete(cf_id, settings)
        except Exception:
            pass
        from psycopg import errors as pg_errors
        if isinstance(error, pg_errors.UniqueViolation):
            raise errors.domain_taken()
        raise
    return detail(conn, user, load(conn, domain_id), settings)


def verify_now(conn, user, domain_id, settings=None):
    """"Check now": once a minute per domain."""
    settings = settings or account_settings()
    domain = owned(conn, user, domain_id)
    from utils.ratelimit_sync import hit
    with conn.transaction():
        count, retry_after = hit(conn, 'domain_check', 'domain:{:x}'.format(domain.id), 'minute')
    if count > 1:
        raise errors.domain_check_rate_limited(retry_after)
    mails = check(conn, domain.id, manual=True, settings=settings)
    return detail(conn, user, load(conn, domain.id), settings), mails


def retry(conn, user, domain_id, settings=None):
    settings = settings or account_settings()
    domain = owned(conn, user, domain_id)
    if domain.status != 'failed':
        raise errors.domain_not_failed()
    with conn.transaction():
        check_requirements(conn, user, settings)
        check_global_cap(conn, settings)
        _count_add(conn, user, settings)
    try:
        cf_id, cf_status, ssl_status = cloudflare.create(domain.hostname, settings)
    except cloudflare.CloudflareError:
        raise errors.domains_unavailable()
    with conn.transaction():
        now = one(conn, 'SELECT now()')[0]
        conn.execute("UPDATE custom_domains SET status = 'pending_dns', status_reason = NULL, cf_hostname_id = %s, "
                     'cf_status = %s, cf_ssl_status = %s, pending_since = %s, failing_since = NULL, '
                     "next_check_at = %s WHERE id = %s AND status = 'failed'",
                     (cf_id, cf_status, ssl_status, now, next_check('pending_dns', now, now), domain.id))
    return detail(conn, user, load(conn, domain.id), settings)


def patch(conn, user, domain_id, body, settings=None):
    settings = settings or account_settings()
    with conn.transaction():
        domain = owned(conn, user, domain_id, lock=True)
        if 'default' in body:
            if not isinstance(body['default'], bool):
                raise errors.invalid_parameters({'default': 'Must be true or false'})
            if body['default']:
                if domain.status not in SERVED:
                    raise errors.domain_not_active()
                conn.execute('UPDATE custom_domains SET is_default = false WHERE user_id = %s AND id <> %s',
                             (user.id, domain.id))
            conn.execute('UPDATE custom_domains SET is_default = %s WHERE id = %s', (body['default'], domain.id))
        if 'scope' in body:
            if body['scope'] not in ('own', 'any'):
                raise errors.invalid_parameters({'scope': 'own or any'})
            if body['scope'] == 'any' and body.get('confirm') is not True:
                raise errors.invalid_parameters({'confirm': "Other people's files will be viewable on your domain. "
                                                            'Send confirm: true'})
            conn.execute('UPDATE custom_domains SET scope = %s WHERE id = %s', (body['scope'], domain.id))
    return detail(conn, user, load(conn, domain.id), settings)


def remove(conn, user, domain_id):
    """Soft delete, and the Cloudflare hostname through `domain_delete`. A staff-disabled domain stays, so
    nobody can re-add the hostname (§10.12)."""
    with conn.transaction():
        domain = owned(conn, user, domain_id, lock=True)
        if domain.status == 'disabled':
            raise errors.domain_disabled()
        conn.execute('UPDATE custom_domains SET deleted_at = now(), is_default = false WHERE id = %s', (domain.id,))
        conn.execute('UPDATE upload_keys SET domain_id = NULL WHERE domain_id = %s', (domain.id,))
        queue_cf_delete(conn, domain.id, domain.cf_hostname_id)
        mails = refresh_domain_only(conn, user.id)
    return mails


def affected(conn, user_id):
    """Live `link` and `password` files and albums that would stop showing on files.gg (§10.6)."""
    row = one(conn, (
        "SELECT (SELECT count(*) FROM files WHERE user_id = %s AND deleted_at IS NULL AND (expires_at IS NULL OR "
        "expires_at > now()) AND visibility IN ('link', 'password')), (SELECT count(*) FROM albums WHERE "
        "owner_user_id = %s AND deleted_at IS NULL AND visibility IN ('link', 'password'))"), (user_id, user_id))
    return {'affected_files': row[0], 'affected_albums': row[1]}


def set_domain_only(conn, user, body):
    enabled = body.get('enabled')
    if not isinstance(enabled, bool):
        raise errors.invalid_parameters({'enabled': 'Must be true or false'})
    with conn.transaction():
        if enabled:
            premium, _ = owner_flags(conn, user.id)
            if not premium:
                raise errors.premium_required()
            serving_now = one(conn, 'SELECT EXISTS (SELECT 1 FROM custom_domains d JOIN users u ON u.id = d.user_id '
                                    'WHERE d.user_id = %s AND ' + SERVING_SQL + ')', (user.id,))[0]
            if not serving_now:
                raise errors.domain_only_not_available()
            if body.get('confirm') is not True:
                raise errors.invalid_parameters({'confirm': 'Check the preview, then send confirm: true'})
        conn.execute('UPDATE users SET domain_only = %s, domain_only_paused_at = NULL WHERE id = %s',
                     (enabled, user.id))
        state = domain_only_state(conn, user.id)
        counts = affected(conn, user.id)
    return dict({'enabled': state[0], 'effective': state[1], 'paused': state[2]}, **counts)


# --- serving (for the Worker, the owner's links, and the lookups) ------------------------------------------------------

def lookup_hostname(conn, hostname):
    """The Worker's domain lookup (§10.7): None for unknown, deleted or malformed hostnames."""
    if not isinstance(hostname, str) or len(hostname) > 253 or not re.match(r'^[a-z0-9.-]+$', hostname):
        return None
    row = one(conn, 'SELECT d.id, d.hostname, d.user_id, d.scope, ' + SERVING_SQL + ' FROM custom_domains d '
                    'JOIN users u ON u.id = d.user_id WHERE d.hostname = %s AND d.deleted_at IS NULL', (hostname,))
    if row is None:
        return None
    return {'id': str(row[0]), 'hostname': row[1], 'user_id': str(row[2]), 'scope': row[3], 'serving': bool(row[4])}
