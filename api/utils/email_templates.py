"""Account email content, rendered in code (HTML and plain text).

Every user-supplied value is HTML-escaped. Copy follows the plan's content rules:
sentence case, no "please", no exclamation marks.
"""

from html import escape

BRAND_GREEN = '#3DEB7E'
INK = '#1E1F22'


def _layout(*, heading, intro, button_label, url, outro):
    """A minimal, email-client-safe layout: one table, inline styles, no images or tracking."""
    return f"""<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f4f6f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f5;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:{INK};">
      <tr><td style="font-size:20px;font-weight:700;padding-bottom:24px;">files<span style="color:#1FA86A;">.gg</span></td></tr>
      <tr><td style="font-size:18px;font-weight:600;padding-bottom:12px;">{heading}</td></tr>
      <tr><td style="font-size:15px;line-height:1.6;padding-bottom:24px;">{intro}</td></tr>
      <tr><td style="padding-bottom:24px;">
        <a href="{escape(url, quote=True)}" style="display:inline-block;background:{BRAND_GREEN};color:{INK};text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px;">{button_label}</a>
      </td></tr>
      <tr><td style="font-size:13px;line-height:1.6;color:#5f6368;padding-bottom:8px;">If the button doesn't work, copy this link into your browser:</td></tr>
      <tr><td style="font-size:13px;line-height:1.6;word-break:break-all;padding-bottom:24px;"><a href="{escape(url, quote=True)}" style="color:#1FA86A;">{escape(url)}</a></td></tr>
      <tr><td style="font-size:13px;line-height:1.6;color:#5f6368;">{outro}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""


def verify_email(*, username, url):
    name = escape(username)
    subject = 'Verify your email for files.gg'
    html = _layout(
        heading='Verify your email',
        intro=f'Hi {name}, confirm this is your email address to finish setting up your files.gg account.',
        button_label='Verify email',
        url=url,
        outro="If you didn't create a files.gg account, you can ignore this email.",
    )
    text = (
        f'Hi {username},\n\n'
        'Confirm this is your email address to finish setting up your files.gg account:\n\n'
        f'{url}\n\n'
        "If you didn't create a files.gg account, you can ignore this email.\n"
    )
    return subject, html, text


def reset_password(*, username, url):
    name = escape(username)
    subject = 'Reset your files.gg password'
    html = _layout(
        heading='Reset your password',
        intro=f'Hi {name}, someone asked to reset the password for your files.gg account. Use the button below to choose a new one.',
        button_label='Choose a new password',
        url=url,
        outro="If this wasn't you, you can ignore this email. Your password won't change.",
    )
    text = (
        f'Hi {username},\n\n'
        'Someone asked to reset the password for your files.gg account. Choose a new one here:\n\n'
        f'{url}\n\n'
        "If this wasn't you, you can ignore this email. Your password won't change.\n"
    )
    return subject, html, text


def report_update(*, status):
    """To an anonymous reporter who left an address (milestone-4 §7.6): once, when the report is
    resolved or dismissed. Neutral: no details of the action or of the uploader."""
    from utils.urls import public_url
    subject = 'Your report to files.gg was reviewed'
    if status == 'resolved':
        line = 'We reviewed the content you reported and took the action we found appropriate.'
    else:
        line = "We reviewed the content you reported and didn't find a reason to act on it."
    url = public_url('/report')
    html = _layout(
        heading='Your report was reviewed',
        intro=escape(line) + ' Thank you for helping keep files.gg safe.',
        button_label='Report something else',
        url=url,
        outro="We don't share what happens to other people's content. This address is deleted 90 days after "
              'the report closes.',
    )
    text = (
        f'{line} Thank you for helping keep files.gg safe.\n\n'
        f'Report something else: {url}\n\n'
        "We don't share what happens to other people's content. This address is deleted 90 days after the report "
        'closes.\n'
    )
    return subject, html, text


# --- Milestone 6 account notices (contract milestone-6 §2.7) ------------------------------------------------------

def _notice(*, subject, heading, lines, button_label=None, url=None):
    """A notice: a heading, escaped paragraphs and an optional button. Returns (subject, html, text)."""
    from utils.urls import public_url
    url = url or public_url('/app/settings/security')
    paragraphs = ''.join('<p style="margin:0 0 12px 0;">{}</p>'.format(escape(line)) for line in lines)
    html = _layout(heading=escape(heading), intro=paragraphs, button_label=escape(button_label or 'Open files.gg'),
                   url=url, outro="You're getting this because it's about your files.gg account.")
    text = '\n\n'.join(lines) + '\n\n{}: {}\n'.format(button_label or 'Open files.gg', url)
    return subject, html, text


def mask_email(address):
    """d***@example.com"""
    local, _, domain = (address or '').partition('@')
    return '{}***@{}'.format(local[:1], domain) if domain else '***'


def password_changed(*, username):
    from utils.urls import public_url
    return _notice(
        subject='Your files.gg password was changed',
        heading='Your password was changed',
        lines=['Hi {}, the password for your files.gg account was just set or changed.'.format(username),
               "If this wasn't you, reset your password now."],
        button_label='Reset your password', url=public_url('/app/forgot'))


def email_changed(*, username, new_email):
    return _notice(
        subject='Your files.gg email was changed',
        heading='Your email was changed',
        lines=['Hi {}, the email for your files.gg account was changed to {}.'.format(username, mask_email(new_email)),
               "If this wasn't you, reset your password and contact support."])


def discord_linked(*, username, discord_username):
    return _notice(
        subject='Discord was linked to your files.gg account',
        heading='Discord was linked',
        lines=['Hi {}, the Discord account {} can now sign in to your files.gg account.'.format(
            username, discord_username),
               "If this wasn't you, unlink it in Settings and change your password."])


def account_deletion_requested(*, username, date):
    from utils.urls import public_url
    return _notice(
        subject='Your files.gg account will be deleted',
        heading='Your account will be deleted',
        lines=['Hi {}, your files.gg account will be deleted for good on {}. Your files and albums are offline '
               'until then.'.format(username, date),
               'Sign in and choose Keep my account to cancel.'],
        button_label='Sign in', url=public_url('/app/login'))


def account_deletion_cancelled(*, username):
    return _notice(
        subject='Your files.gg account is staying',
        heading="Your account won't be deleted",
        lines=['Hi {}, you chose to keep your files.gg account. Your files and albums are back online.'.format(
            username)])


def account_deleted(*, username):
    from utils.urls import public_url
    return _notice(
        subject='Your files.gg account was deleted',
        heading='Your account was deleted',
        lines=['Hi {}, your files.gg account and its files were deleted for good, as you asked.'.format(username),
               'This is the last email we send to this address.'],
        button_label='Visit files.gg', url=public_url('/'))


DOMAIN_STATUS_LINES = {
    'failed': "{host} stopped working, so we disconnected it. Check its DNS records, then choose Retry in Settings.",
    'paused': "{host} is paused because your premium ended. It comes back if premium does.",
    'active': '{host} is working again.',
    'domain_only_paused': "Your domain isn't working, so your files are showing on files.gg again.",
    'domain_only_resumed': 'Your domain is working again, so your files show only on your domain.',
}


def domain_status(*, username, hostname, event):
    from utils.urls import public_url
    line = DOMAIN_STATUS_LINES[event].format(host=hostname)
    return _notice(subject='An update about your files.gg domain', heading='Your domain changed',
                   lines=['Hi {},'.format(username), line], button_label='Open domain settings',
                   url=public_url('/app/settings/domains'))


def premium_changed(*, username, event, expires_at=None):
    from utils.urls import public_url
    if event == 'granted':
        line = 'files.gg staff gave your account premium{}.'.format(
            ' until {}'.format(expires_at) if expires_at else '')
    elif event == 'revoked':
        line = 'Premium was removed from your account. Your files stay; new uploads use the standard limits.'
    else:
        line = 'Your premium ended. Your files stay; new uploads use the standard limits.'
    return _notice(subject='Your files.gg premium changed', heading='Premium changed',
                   lines=['Hi {}, {}'.format(username, line[0].lower() + line[1:])],
                   button_label='Open files.gg', url=public_url('/app'))
