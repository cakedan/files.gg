"""Transactional email through Postmark (docs/redesign/PLAN.md §4 item 19).

Postmark is configured once per process with `Email.configure(...)` from app.py:

    POSTMARK_SERVER_TOKEN  the server's API token (a secret; required to send)
    EMAIL_FROM             the From header, e.g. `files.gg <noreply@mail.files.gg>`
    POSTMARK_MESSAGE_STREAM  defaults to Postmark's transactional stream, `outbound`

Messages are rendered in code (utils/email_templates.py), not stored in Postmark, so
they are versioned with the API and switching providers only touches this file.
"""

import logging

from utils.http import get_client
from utils.responses import ApiError

log = logging.getLogger(__name__)

POSTMARK_URL = 'https://api.postmarkapp.com/email'
DEFAULT_FROM = 'files.gg <noreply@mail.files.gg>'
DEFAULT_STREAM = 'outbound'


class EmailUnavailable(ApiError):
    status = 503
    code = 'EMAIL_UNAVAILABLE'
    message = "Email isn't available right now. Try again in a few minutes"


def _header_value(value):
    """Strip characters that could break or inject into an email header."""
    return ''.join(ch for ch in str(value) if ch not in '\r\n"<>').strip()


def format_address(email, name=None):
    email = _header_value(email)
    name = _header_value(name) if name else ''
    return '"{}" <{}>'.format(name, email) if name else email


class Email:
    token = None
    sender = DEFAULT_FROM
    stream = DEFAULT_STREAM

    @classmethod
    def configure(cls, token=None, sender=None, stream=None):
        cls.token = token or None
        cls.sender = sender or DEFAULT_FROM
        cls.stream = stream or DEFAULT_STREAM
        if not cls.token:
            log.warning('POSTMARK_SERVER_TOKEN is not set: account emails will fail with 503')

    @classmethod
    def _request(cls, to, subject, html, text, tag, to_name):
        payload = {
            'From': cls.sender,
            'To': format_address(to, to_name),
            'Subject': subject,
            'HtmlBody': html,
            'TextBody': text,
            'Tag': tag,
            'MessageStream': cls.stream,
            'TrackOpens': False,
            'TrackLinks': 'None',
        }
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json',
                   'X-Postmark-Server-Token': cls.token}
        return payload, headers

    @classmethod
    def send_sync(cls, *, to, subject, html, text, tag, to_name=None):
        """The same message from synchronous code (`python -m worker`'s account and domain tasks). Raises
        EmailUnavailable like `send`."""
        import httpx
        if not cls.token:
            raise EmailUnavailable()
        payload, headers = cls._request(to, subject, html, text, tag, to_name)
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.post(POSTMARK_URL, json=payload, headers=headers)
        except Exception:
            log.exception('postmark request failed (tag=%s)', tag)
            raise EmailUnavailable()
        if response.status_code != 200:
            log.error('postmark refused message (tag=%s, status=%s)', tag, response.status_code)
            raise EmailUnavailable()
        return response.json()

    @classmethod
    async def send(cls, *, to, subject, html, text, tag, to_name=None):
        """Send one message. Raises EmailUnavailable if Postmark isn't configured or refuses it;
        the reason is logged, never returned to the client."""
        if not cls.token:
            raise EmailUnavailable()
        payload = {
            'From': cls.sender,
            'To': format_address(to, to_name),
            'Subject': subject,
            'HtmlBody': html,
            'TextBody': text,
            'Tag': tag,
            'MessageStream': cls.stream,
            # account emails carry one-time links: don't let tracking rewrite them
            'TrackOpens': False,
            'TrackLinks': 'None',
        }
        headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Postmark-Server-Token': cls.token,
        }
        try:
            response = await get_client().post(POSTMARK_URL, json=payload, headers=headers)
        except Exception:
            log.exception('postmark request failed (tag=%s)', tag)
            raise EmailUnavailable()

        if response.status_code != 200:
            # Postmark's body has ErrorCode and Message; log them for staff, keep the client response generic
            try:
                body = response.json()
            except ValueError:
                body = {'Message': response.text[:200]}
            log.error('postmark refused message (tag=%s, status=%s, code=%s): %s', tag,
                      response.status_code, body.get('ErrorCode'), body.get('Message'))
            raise EmailUnavailable()
        return response.json()
