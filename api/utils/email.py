"""Transactional email through Cloudflare Email Service (docs/redesign/PLAN.md §4 item 14), over its REST API.

Configured once per process with `Email.configure(...)` from app.py, worker.py and tools:

    CLOUDFLARE_EMAIL_TOKEN  an API token with the account's "Email Sending: Edit" permission only (a secret;
                            required to send). Not CLOUDFLARE_API_TOKEN, which manages custom hostnames.
    CLOUDFLARE_ACCOUNT_ID   the account that owns the sending domain (mail.files.gg, onboarded in the dashboard)
    EMAIL_FROM              the sender, default `noreply@mail.files.gg`. Cloudflare documents a plain address for
                            the REST API; a `files.gg <noreply@mail.files.gg>` form is tried on staging
                            (docs/redesign/LAUNCH.md §4.4) and kept only if it's accepted.

Messages are rendered in code (utils/email_templates.py), not stored at the provider, so they're versioned with the
API and switching providers only touches this file. Cloudflare has no open or click tracking, so the one-time links in
these emails are never rewritten. Bounces and complaints go on Cloudflare's suppression list; a send to a suppressed
address is refused (400) and counted as failed.
"""

import logging
import os

from utils import metrics
from utils.http import get_client
from utils.responses import ApiError

log = logging.getLogger(__name__)

API_BASE = 'https://api.cloudflare.com/client/v4'
DEFAULT_FROM = 'noreply@mail.files.gg'
# which template a message is, for matching Cloudflare's logs to ours (any X- header is allowed)
TAG_HEADER = 'X-Filesgg-Email'


class EmailUnavailable(ApiError):
    status = 503
    code = 'EMAIL_UNAVAILABLE'
    message = "Email isn't available right now. Try again in a few minutes"


def _header_value(value):
    """Strip characters that could break or inject into an email header."""
    return ''.join(ch for ch in str(value) if ch not in '\r\n"<>').strip()


def count(tag, outcome):
    metrics.incr('filesgg_emails_total', {'tag': tag, 'outcome': outcome})


def send_url(account_id):
    return '{}/accounts/{}/email/sending/send'.format(API_BASE, account_id)


def _errors(response):
    """Cloudflare's `errors: [{code, message}]`, for the log only; never returned to the client."""
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    found = body.get('errors') if isinstance(body, dict) else None
    return [(e.get('code'), e.get('message')) for e in found if isinstance(e, dict)] if isinstance(found, list) \
        else str(body)[:200]


class Email:
    token = None
    account_id = None
    sender = DEFAULT_FROM

    @classmethod
    def configure(cls, token=None, account_id=None, sender=None):
        cls.token = token or None
        cls.account_id = account_id or None
        cls.sender = sender or DEFAULT_FROM
        if not cls.configured():
            log.warning('CLOUDFLARE_EMAIL_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set: account emails will fail with 503')

    @classmethod
    def configure_from_env(cls):
        """The API, the jobs worker and the CLI tools all send from the same settings."""
        cls.configure(token=os.getenv('CLOUDFLARE_EMAIL_TOKEN'), account_id=os.getenv('CLOUDFLARE_ACCOUNT_ID'),
                      sender=os.getenv('EMAIL_FROM'))

    @classmethod
    def configured(cls):
        return bool(cls.token and cls.account_id)

    @classmethod
    def _request(cls, to, subject, html, text, tag):
        payload = {
            'from': cls.sender,
            'to': [_header_value(to)],
            'subject': subject,
            'html': html,
            'text': text,
            'headers': {TAG_HEADER: _header_value(tag)},
        }
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json',
                   'Authorization': 'Bearer {}'.format(cls.token)}
        return send_url(cls.account_id), payload, headers

    @classmethod
    def _check(cls, response, tag):
        if response.status_code != 200:
            log.error('cloudflare email refused the message (tag=%s, status=%s): %s', tag, response.status_code,
                      _errors(response))
            count(tag, 'failed')
            raise EmailUnavailable()
        count(tag, 'sent')
        return response.json()

    @classmethod
    def send_sync(cls, *, to, subject, html, text, tag):
        """The same message from synchronous code (`python -m worker`'s account and domain tasks). Raises
        EmailUnavailable like `send`."""
        import httpx
        if not cls.configured():
            count(tag, 'unconfigured')
            raise EmailUnavailable()
        url, payload, headers = cls._request(to, subject, html, text, tag)
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.post(url, json=payload, headers=headers)
        except Exception:
            log.exception('cloudflare email request failed (tag=%s)', tag)
            count(tag, 'failed')
            raise EmailUnavailable()
        return cls._check(response, tag)

    @classmethod
    async def send(cls, *, to, subject, html, text, tag):
        """Send one message. Raises EmailUnavailable if sending isn't configured or Cloudflare refuses it; the reason
        is logged, never returned to the client."""
        if not cls.configured():
            count(tag, 'unconfigured')
            raise EmailUnavailable()
        url, payload, headers = cls._request(to, subject, html, text, tag)
        try:
            response = await get_client().post(url, json=payload, headers=headers)
        except Exception:
            log.exception('cloudflare email request failed (tag=%s)', tag)
            count(tag, 'failed')
            raise EmailUnavailable()
        return cls._check(response, tag)
