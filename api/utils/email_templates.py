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
