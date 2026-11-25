"""Account emails as values (contract milestone-6 §2.7): code that runs in a transaction (often in a thread or
the worker) builds `Mail`s, and the caller sends them once the transaction has committed, with `send()`
(async API) or `send_sync()` (worker). Notices never fail the request: a Postmark failure is logged."""

import logging

from typing import NamedTuple, Optional

from utils import email_templates
from utils.email import Email
from utils.urls import public_url

log = logging.getLogger(__name__)


class Mail(NamedTuple):
    to: str
    to_name: Optional[str]
    subject: str
    html: str
    text: str
    tag: str


def build(to, to_name, rendered, tag):
    subject, html, text = rendered
    return Mail(to, to_name, subject, html, text, tag)


def verify_email(address, username, token):
    url = public_url('/app/verify#token=' + token)
    return build(address, username, email_templates.verify_email(username=username, url=url), 'auth-verify')


def reset_password(address, username, token):
    url = public_url('/app/reset#token=' + token)
    return build(address, username, email_templates.reset_password(username=username, url=url), 'auth-forgot')


def password_changed(address, username):
    return build(address, username, email_templates.password_changed(username=username), 'auth-password-changed')


def email_changed(address, username, new_email):
    return build(address, username, email_templates.email_changed(username=username, new_email=new_email),
                 'auth-email-changed')


def discord_linked(address, username, discord_username):
    return build(address, username, email_templates.discord_linked(username=username,
                                                                   discord_username=discord_username),
                 'auth-discord-linked')


def deletion_requested(address, username, date):
    return build(address, username, email_templates.account_deletion_requested(username=username, date=date),
                 'auth-deletion-requested')


def deletion_cancelled(address, username):
    return build(address, username, email_templates.account_deletion_cancelled(username=username),
                 'auth-deletion-cancelled')


def account_deleted(address, username):
    return build(address, username, email_templates.account_deleted(username=username), 'auth-account-deleted')


def domain_status(address, username, hostname, event):
    return build(address, username, email_templates.domain_status(username=username, hostname=hostname, event=event),
                 'domain-status')


def premium_changed(address, username, event, expires_at=None):
    return build(address, username, email_templates.premium_changed(username=username, event=event,
                                                                    expires_at=expires_at), 'premium-changed')


def date_text(value):
    """'9 December 2026' for an aware datetime."""
    return '{} {}'.format(value.day, value.strftime('%B %Y')) if value is not None else None


async def send(mails, raise_errors=False):
    for mail in mails or ():
        if mail is None:
            continue
        try:
            await Email.send(to=mail.to, to_name=mail.to_name, subject=mail.subject, html=mail.html, text=mail.text,
                             tag=mail.tag)
        except Exception:
            if raise_errors:
                raise
            log.warning('account email failed (tag=%s)', mail.tag)


def send_sync(mails):
    for mail in mails or ():
        if mail is None:
            continue
        try:
            Email.send_sync(to=mail.to, to_name=mail.to_name, subject=mail.subject, html=mail.html, text=mail.text,
                            tag=mail.tag)
        except Exception:
            log.warning('account email failed (tag=%s)', mail.tag)
