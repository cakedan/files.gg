"""Postmark email client, templates and the sign-up mail-domain check."""

import json

import httpx
import pytest

from utils import email_domain, email_templates, http
from utils.email import POSTMARK_URL, Email, EmailUnavailable, format_address


@pytest.fixture
def postmark(monkeypatch):
    """Route the shared outbound client through a mock transport and record requests."""
    calls = []
    state = {'status': 200, 'body': {'ErrorCode': 0, 'Message': 'OK', 'MessageID': 'abc'}}

    def handler(request):
        calls.append(request)
        return httpx.Response(state['status'], json=state['body'])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(http, '_client', client)
    Email.configure(token='server-token', sender='files.gg <noreply@mail.files.gg>')
    yield calls, state
    Email.configure(token=None)


async def test_send_posts_the_postmark_payload(postmark):
    calls, _ = postmark
    await Email.send(to='a@example.com', to_name='alice', subject='Hi', html='<p>x</p>', text='x', tag='auth-verify')

    assert len(calls) == 1
    request = calls[0]
    assert str(request.url) == POSTMARK_URL
    assert request.headers['X-Postmark-Server-Token'] == 'server-token'
    body = json.loads(request.content)
    assert body == {
        'From': 'files.gg <noreply@mail.files.gg>',
        'To': '"alice" <a@example.com>',
        'Subject': 'Hi',
        'HtmlBody': '<p>x</p>',
        'TextBody': 'x',
        'Tag': 'auth-verify',
        'MessageStream': 'outbound',
        'TrackOpens': False,
        'TrackLinks': 'None',
    }


async def test_refusal_raises_generic_503_without_leaking_details(postmark):
    _, state = postmark
    state['status'], state['body'] = 422, {'ErrorCode': 406, 'Message': 'Inactive recipient secret detail'}
    with pytest.raises(EmailUnavailable) as raised:
        await Email.send(to='a@example.com', subject='s', html='h', text='t', tag='auth-forgot')
    assert raised.value.status == 503
    assert 'secret detail' not in raised.value.message


async def test_missing_token_raises_503_without_calling_postmark(postmark):
    calls, _ = postmark
    Email.configure(token=None)
    with pytest.raises(EmailUnavailable):
        await Email.send(to='a@example.com', subject='s', html='h', text='t', tag='auth-verify')
    assert calls == []


def test_display_name_cannot_inject_headers():
    assert format_address('a@example.com', 'eve"\r\nBcc: x@evil.test <') == '"eveBcc: x@evil.test" <a@example.com>'
    assert format_address('a@example.com\r\nBcc: x@evil.test') == 'a@example.comBcc: x@evil.test'


@pytest.mark.parametrize('render', [email_templates.verify_email, email_templates.reset_password])
def test_templates_escape_usernames_and_include_link(render):
    url = 'https://files.gg/auth/verify/tok"en&x=1'
    subject, html, text = render(username='<script>alert(1)</script>', url=url)
    assert '<script>' not in html and '&lt;script&gt;' in html
    assert 'tok&quot;en&amp;x=1' in html  # attribute-escaped link
    assert url in text
    assert subject and '!' not in subject and 'please' not in (html + text).lower()


async def test_domain_check(monkeypatch):
    records = {('example.com', 'MX'): True, ('noemail.test', 'MX'): False, ('noemail.test', 'A'): False,
               ('noemail.test', 'AAAA'): False, ('aonly.test', 'MX'): False, ('aonly.test', 'A'): True}

    async def has_records(domain, rdtype):
        return records.get((domain, rdtype), False)

    class Answer(list):
        pass

    class Resolver:
        lifetime = None

        async def resolve(self, domain, rdtype):
            exchange = '.' if domain == 'nullmx.test' else 'mx.example.com.'
            return Answer([type('MX', (), {'exchange': exchange})()])

    monkeypatch.setattr(email_domain, '_has_records', has_records)
    monkeypatch.setattr(email_domain.dns.asyncresolver, 'Resolver', Resolver)
    records[('nullmx.test', 'MX')] = True

    assert await email_domain.domain_accepts_mail('a@example.com') is True
    assert await email_domain.domain_accepts_mail('a@aonly.test') is True   # RFC 5321 A fallback
    assert await email_domain.domain_accepts_mail('a@noemail.test') is False
    assert await email_domain.domain_accepts_mail('a@nullmx.test') is False  # RFC 7505 null MX


async def test_domain_check_allows_on_dns_outage(monkeypatch):
    async def has_records(domain, rdtype):
        raise email_domain.dns.exception.Timeout()

    monkeypatch.setattr(email_domain, '_has_records', has_records)
    assert await email_domain.domain_accepts_mail('a@example.com') is True
