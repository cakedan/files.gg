"""Cloudflare Email Service client (REST), templates and the sign-up mail-domain check."""

import json

import httpx
import pytest

from utils import email_domain, email_templates, http
from utils.email import Email, EmailUnavailable, send_url

ACCOUNT = '0123456789abcdef0123456789abcdef'
SENT = {'success': True, 'errors': [], 'messages': [],
        'result': {'message_id': 'abc', 'delivered': ['a@example.com'], 'queued': [], 'permanent_bounces': [],
                   'suppressed_recipients': []}}


@pytest.fixture
def cloudflare(monkeypatch):
    """Route the shared outbound client through a mock transport and record requests."""
    calls = []
    state = {'status': 200, 'body': SENT}

    def handler(request):
        calls.append(request)
        return httpx.Response(state['status'], json=state['body'])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(http, '_client', client)
    Email.configure(token='email-token', account_id=ACCOUNT, sender='noreply@mail.files.gg')
    yield calls, state
    Email.configure()


async def test_send_posts_the_cloudflare_payload(cloudflare):
    calls, _ = cloudflare
    await Email.send(to='a@example.com', subject='Hi', html='<p>x</p>', text='x', tag='auth-verify')

    assert len(calls) == 1
    request = calls[0]
    assert str(request.url) == send_url(ACCOUNT) == \
        'https://api.cloudflare.com/client/v4/accounts/{}/email/sending/send'.format(ACCOUNT)
    assert request.method == 'POST'
    assert request.headers['Authorization'] == 'Bearer email-token'
    assert json.loads(request.content) == {
        'from': 'noreply@mail.files.gg',
        'to': ['a@example.com'],
        'subject': 'Hi',
        'html': '<p>x</p>',
        'text': 'x',
        'headers': {'X-Filesgg-Email': 'auth-verify'},
    }


async def test_refusal_raises_generic_503_without_leaking_details(cloudflare):
    _, state = cloudflare
    state['status'], state['body'] = 400, {'success': False, 'messages': [], 'result': None,
                                           'errors': [{'code': 10001, 'message': 'suppressed secret detail'}]}
    with pytest.raises(EmailUnavailable) as raised:
        await Email.send(to='a@example.com', subject='s', html='h', text='t', tag='auth-forgot')
    assert raised.value.status == 503
    assert 'secret detail' not in raised.value.message


@pytest.mark.parametrize('token, account', [(None, ACCOUNT), ('email-token', None)])
async def test_unconfigured_raises_503_without_calling_cloudflare(cloudflare, token, account):
    calls, _ = cloudflare
    Email.configure(token=token, account_id=account)
    with pytest.raises(EmailUnavailable):
        await Email.send(to='a@example.com', subject='s', html='h', text='t', tag='auth-verify')
    assert calls == []


def test_the_recipient_and_tag_cannot_inject_headers():
    Email.configure(token='t', account_id=ACCOUNT)
    _, payload, _ = Email._request('a@example.com\r\nBcc: x@evil.test', 's', 'h', 't', 'auth\r\nX-Evil: 1')
    assert payload['to'] == ['a@example.comBcc: x@evil.test']
    assert payload['headers'] == {'X-Filesgg-Email': 'authX-Evil: 1'}
    Email.configure()


def test_configure_from_env(monkeypatch):
    monkeypatch.setenv('CLOUDFLARE_EMAIL_TOKEN', 'tok')
    monkeypatch.setenv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT)
    monkeypatch.delenv('EMAIL_FROM', raising=False)
    Email.configure_from_env()
    assert (Email.token, Email.account_id, Email.sender, Email.configured()) == ('tok', ACCOUNT, 'noreply@mail.files.gg',
                                                                               True)
    Email.configure()


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
