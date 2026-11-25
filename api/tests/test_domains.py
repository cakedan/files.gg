"""Milestone 6 custom domains (docs/redesign/contracts/milestone-6.md §10, §16.8-§16.10): hostnames, records, the
status machine against a mocked Cloudflare (utils/cloudflare.py TRANSPORT) and mocked DNS (utils/domains.lookup),
the requirements, "Only my files", domain-only mode, owner links, the Worker's lookups, and staff actions."""

import json
import uuid

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from tests.conftest import APP_DATABASE, ORIGIN_SECRET, TempDatabase, make_user, set_premium, sign_in
from utils.generators import Snowflake

ORIGIN = {'X-Filesgg-Origin-Secret': ORIGIN_SECRET, 'X-Filesgg-Internal-Lookup': '1'}


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


class FakeCloudflare:
    """Custom hostnames as Cloudflare's API keeps them, by id."""

    def __init__(self):
        self.hostnames = {}
        self.calls = []
        self.fail = False

    def set(self, cf_id, status, ssl_status):
        self.hostnames[cf_id].update(status=status, ssl={'status': ssl_status})

    def __call__(self, request):
        self.calls.append((request.method, request.url.path, request.headers.get('authorization')))
        if self.fail:
            return httpx.Response(500, json={'success': False, 'errors': [{'code': 1000}]})
        parts = request.url.path.split('/')
        assert parts[:5] == ['', 'client', 'v4', 'zones', 'test-zone'] and parts[5] == 'custom_hostnames'
        if request.method == 'POST':
            body = json.loads(request.content)
            assert body['ssl'] == {'method': 'http', 'type': 'dv',
                                   'settings': {'min_tls_version': '1.2', 'http2': 'on', 'tls_1_3': 'on'}}
            cf_id = uuid.uuid4().hex
            self.hostnames[cf_id] = {'id': cf_id, 'hostname': body['hostname'], 'status': 'pending',
                                     'ssl': {'status': 'initializing'}}
            return httpx.Response(200, json={'success': True, 'result': self.hostnames[cf_id]})
        cf_id = parts[6]
        if cf_id not in self.hostnames:
            return httpx.Response(404, json={'success': False, 'errors': [{'code': 1436}]})
        if request.method == 'DELETE':
            del self.hostnames[cf_id]
            return httpx.Response(200, json={'success': True, 'result': {'id': cf_id}})
        return httpx.Response(200, json={'success': True, 'result': self.hostnames[cf_id]})


class FakeDns:
    def __init__(self):
        self.records = {}

    def __call__(self, name, rdtype):
        return list(self.records.get((name, rdtype), []))

    def point(self, domain, txt=True, cname=True):
        host = domain['hostname']
        txt_record = [r['value'] for r in domain['records'] if r['type'] == 'TXT'][0]
        self.records[('_filesgg-verify.' + host, 'TXT')] = [txt_record] if txt else ['something-else']
        self.records[(host, 'CNAME')] = ['edge.example.net', 'domains.files.gg'] if cname else []
        if cname:
            self.records[(host, 'CNAME')] = ['domains.files.gg']


@pytest.fixture
def cloud(monkeypatch):
    from utils import cloudflare, domains
    fake, dns = FakeCloudflare(), FakeDns()
    monkeypatch.setenv('CLOUDFLARE_API_TOKEN', 'test-cf-token')
    monkeypatch.setenv('CLOUDFLARE_ZONE_ID', 'test-zone')
    monkeypatch.setattr(cloudflare, 'TRANSPORT', httpx.MockTransport(fake))
    monkeypatch.setattr(domains, 'lookup', dns)
    fake.dns = dns
    return fake


def premium_user(appdb, **kwargs):
    user_id = make_user(appdb, created_days_ago=8, **kwargs)
    set_premium(user_id, appdb)
    return user_id, sign_in(user_id, appdb)


def host():
    return 'i{}.example.com'.format(uuid.uuid4().hex[:8])


def add(client, headers, hostname=None, status=201):
    response = client.post('/users/@me/domains', headers=headers, json={'hostname': hostname or host()})
    assert response.status_code == status, response.text
    return response.json()


def run_jobs(appdb):
    """The queued domain_delete jobs, as the worker runs them."""
    from jobs import queue
    import jobs.accounts  # noqa: F401
    with appdb.connect() as conn:
        while queue.run_next('test', queues=('default',), kinds=['domain_delete'], conn=conn):
            pass


def check(appdb, domain_id):
    from utils import domains
    with appdb.connect() as conn:
        return domains.check(conn, int(domain_id))


def status_of(appdb, domain_id):
    return appdb.fetchone('SELECT status, status_reason FROM custom_domains WHERE id = %s', (int(domain_id),))


# --- §10.1, §16.8 ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize('raw, result', [
    ('I.Example.COM.', 'i.example.com'), ('bücher.example.com', 'xn--bcher-kva.example.com'), ('example.com', 'apex'),
    ('i.example.co.uk', 'i.example.co.uk'), ('example.co.uk', 'apex'), ('co.uk', 'public_suffix'),
    ('*.example.com', 'wildcard'), ('192.0.2.1', 'ip'), ('x.files.gg', 'reserved'), ('files.gg', 'reserved'),
    ('domains.files.gg', 'reserved'), ('-bad.example.com', 'syntax'), ('cdn.files.gg', 'reserved'),
    ('a..example.com', 'syntax'), ('', 'syntax'),
    # nothing under files.gg, however it's spelled (owner, 2026-11-25)
    ('X.FILES.GG.', 'reserved'), ('files.gg.', 'reserved'), ('a.b.c.files.gg', 'reserved'),
    ('mail.files.gg', 'reserved'), ('api.files.gg', 'reserved'), ('www.files.gg', 'reserved'),
    ('x.fil\u00ades.gg', 'reserved'),  # a soft hyphen is removed by IDNA mapping, so it's still files.gg
    ('  x.files.gg  ', 'reserved'),
])
def test_hostname_vectors(raw, result):
    from utils import domains
    from utils.responses import ApiError
    try:
        assert domains.normalize(raw) == result
    except ApiError as error:
        assert (error.code, error.data['reason']) == ('INVALID_HOSTNAME', result)


# --- §10.3, §16.9: the status machine ---------------------------------------------------------------------------------

def domain_row(status, pending_hours=0, failing_days=None, verified=False):
    from utils import domains
    now = datetime.now(timezone.utc)
    values = dict.fromkeys(domains.COLUMNS)
    values.update(status=status, pending_since=now - timedelta(hours=pending_hours),
                  failing_since=now - timedelta(days=failing_days) if failing_days is not None else None,
                  verified_at=now - timedelta(days=9) if verified else None)
    return domains.Domain([values[c] for c in domains.COLUMNS]), now


@pytest.mark.parametrize('was, txt, cname, cf, ssl, becomes, delete', [
    (('pending_dns',), False, True, 'pending', 'initializing', 'pending_dns', False),
    (('pending_dns',), True, True, 'active', 'pending_validation', 'pending_cert', False),
    (('pending_cert',), True, True, 'active', 'active', 'active', False),
    (('active', 0, None, True), False, True, 'active', 'active', 'failing', False),
    (('failing', 0, 3, True), False, False, 'moved', 'active', 'failed', True),
    (('pending_dns', 72), False, False, 'pending', 'initializing', 'failed', True),
    (('failing', 0, 1, True), True, True, 'active', 'active', 'active', False),
    (('active', 0, None, True), True, True, 'active_redeploying', 'active', 'active', False),
])
def test_status_vectors(was, txt, cname, cf, ssl, becomes, delete):
    from utils import domains
    domain, now = domain_row(*was)
    result = domains.evaluate(domain, txt, cname, cf, ssl, now)
    assert (result['status'], result['delete_cf']) == (becomes, delete)
    if becomes == 'active' and was[0] == 'pending_cert':
        assert result['verified_at'] == now
    if becomes == 'failing':
        assert result['failing_since'] == now
    if was[0] == 'pending_dns' and becomes == 'failed':
        assert result['status_reason'] == 'dns_timeout'
    if was[0] == 'failing' and becomes == 'failed':
        assert result['status_reason'] == 'dns_changed'


def test_losing_premium_pauses():
    from utils import domains
    domain, now = domain_row('active', verified=True)
    assert domains.evaluate(domain, True, True, 'active', 'active', now, premium=False)['status'] == 'paused'


# --- the lifecycle against Cloudflare -----------------------------------------------------------------------------------

def test_requirements(client, appdb, cloud, monkeypatch):
    headers = sign_in(make_user(appdb, created_days_ago=8), appdb)
    assert add(client, headers, status=403)['code'] == 'PREMIUM_REQUIRED'
    user_id = make_user(appdb, verified=False, created_days_ago=8)
    set_premium(user_id, appdb)
    body = add(client, sign_in(user_id, appdb), status=403)
    assert body == {'code': 'DOMAIN_REQUIREMENTS', 'message': 'Verify your email to add domains', 'status': 403,
                    'reason': 'email_not_verified'}
    user_id = make_user(appdb, created_days_ago=2)
    set_premium(user_id, appdb)
    body = add(client, sign_in(user_id, appdb), status=403)
    assert body['reason'] == 'account_too_new' and body['available_at'] > 0
    _, headers = premium_user(appdb)
    assert add(client, headers, hostname='example.com', status=400)['reason'] == 'apex'
    monkeypatch.setenv('PREMIUM_CUSTOM_DOMAINS', '1')
    add(client, headers)
    assert add(client, headers, status=400) == {'code': 'DOMAIN_LIMIT_REACHED', 'limit': 1, 'status': 400,
                                                'message': 'You have reached the domain limit'}
    monkeypatch.delenv('PREMIUM_CUSTOM_DOMAINS')
    # Cloudflare down: nothing stored
    cloud.fail = True
    hostname = host()
    assert add(client, headers, hostname=hostname, status=503)['code'] == 'DOMAINS_UNAVAILABLE'
    assert appdb.fetchone('SELECT count(*) FROM custom_domains WHERE hostname = %s', (hostname,))[0] == 0
    cloud.fail = False
    # the global cap
    monkeypatch.setenv('CUSTOM_DOMAINS_GLOBAL_MAX', '0')
    assert add(client, headers, status=503)['code'] == 'DOMAINS_UNAVAILABLE'


def test_domains_off_without_cloudflare(client, appdb):
    _, headers = premium_user(appdb)
    assert add(client, headers, status=503)['code'] == 'DOMAINS_UNAVAILABLE'


def test_the_lifecycle(client, appdb, cloud, outbox):
    user_id, headers = premium_user(appdb)
    hostname = host()
    domain = add(client, headers, hostname=hostname.upper() + '.')
    assert domain['hostname'] == hostname and domain['status'] == 'pending_dns' and domain['serving'] is False
    assert domain['records'][0] == {'type': 'CNAME', 'name': hostname, 'value': 'domains.files.gg', 'ok': False}
    txt = domain['records'][1]
    assert txt['name'] == '_filesgg-verify.' + hostname and txt['value'].startswith('filesgg-verify=')
    assert len(txt['value']) == len('filesgg-verify=') + 26
    assert domain['cloudflare'] == {'status': 'pending', 'ssl_status': 'initializing'}
    assert 71 * 3600 < domain['pending_until'] - domain['created_at'] <= 72 * 3600
    assert cloud.calls[0][2] == 'Bearer test-cf-token'
    # somebody else can't have it
    _, other = premium_user(appdb)
    assert add(client, other, hostname=hostname, status=409)['code'] == 'DOMAIN_TAKEN'
    cf_id = appdb.fetchone('SELECT cf_hostname_id FROM custom_domains WHERE id = %s', (int(domain['id']),))[0]
    # Check now: records seen, Cloudflare active but the certificate pending, then issued
    cloud.dns.point(domain)
    cloud.set(cf_id, 'active', 'pending_validation')
    body = client.post('/users/@me/domains/{}/verify'.format(domain['id']), headers=headers).json()
    assert body['status'] == 'pending_cert' and [r['ok'] for r in body['records']] == [True, True]
    assert ('PATCH', '/client/v4/zones/test-zone/custom_hostnames/' + cf_id, 'Bearer test-cf-token') in cloud.calls
    response = client.post('/users/@me/domains/{}/verify'.format(domain['id']), headers=headers)
    assert (response.status_code, response.json()['code']) == (429, 'DOMAIN_CHECK_RATE_LIMITED')
    cloud.set(cf_id, 'active', 'active')
    check(appdb, domain['id'])
    listing = client.get('/users/@me/domains', headers=headers).json()
    assert listing['limit'] == 5 and listing['domain_only'] == {'enabled': False, 'effective': False, 'paused': False}
    assert listing['items'][0]['status'] == 'active' and listing['items'][0]['serving'] is True
    assert listing['items'][0]['verified_at'] is not None
    # the Worker's lookup (both internal headers, or the plain 404)
    lookup = client.get('/internal/domains/' + hostname, headers=ORIGIN)
    assert lookup.json() == {'domain': {'id': domain['id'], 'hostname': hostname, 'user_id': str(user_id),
                                        'scope': 'own', 'serving': True}}
    assert client.get('/internal/domains/' + hostname, headers={'X-Filesgg-Origin-Secret': ORIGIN_SECRET}).status_code \
        == 404
    assert client.get('/internal/domains/nope.example.com', headers=ORIGIN).status_code == 404
    # the TXT goes away: failing (still served), then failed after 3 days with the hostname deleted
    cloud.dns.point(domain, txt=False)
    check(appdb, domain['id'])
    assert status_of(appdb, domain['id'])[0] == 'failing'
    assert client.get('/internal/domains/' + hostname, headers=ORIGIN).json()['domain']['serving'] is True
    appdb.execute("UPDATE custom_domains SET failing_since = now() - interval '3 days 1 minute' WHERE id = %s",
                  (int(domain['id']),))
    mails = check(appdb, domain['id'])
    assert status_of(appdb, domain['id']) == ('failed', 'dns_changed')
    assert [m.tag for m in mails] == ['domain-status'] and 'stopped working' in mails[0].text
    run_jobs(appdb)
    assert cf_id not in cloud.hostnames
    assert client.get('/internal/domains/' + hostname, headers=ORIGIN).json()['domain']['serving'] is False
    # retry: a new Cloudflare hostname and a new window
    response = client.post('/users/@me/domains/{}/retry'.format(domain['id']), headers=headers)
    assert response.status_code == 200 and response.json()['status'] == 'pending_dns'
    assert len(cloud.hostnames) == 1
    assert client.post('/users/@me/domains/{}/retry'.format(domain['id']), headers=headers).json()['code'] == \
        'DOMAIN_NOT_FAILED'
    # delete: soft, and the hostname goes
    assert client.delete('/users/@me/domains/' + domain['id'], headers=headers).status_code == 204
    run_jobs(appdb)
    assert cloud.hostnames == {}
    assert client.get('/internal/domains/' + hostname, headers=ORIGIN).status_code == 404
    assert client.get('/users/@me/domains', headers=headers).json()['items'] == []


def test_pending_too_long_fails_and_premium_pauses_and_resumes(client, appdb, cloud):
    user_id, headers = premium_user(appdb)
    domain = add(client, headers)
    appdb.execute("UPDATE custom_domains SET pending_since = now() - interval '73 hours' WHERE id = %s",
                  (int(domain['id']),))
    check(appdb, domain['id'])
    assert status_of(appdb, domain['id']) == ('failed', 'dns_timeout')
    run_jobs(appdb)
    assert cloud.hostnames == {}
    # an active domain whose owner loses premium pauses (the checker), then resumes
    domain = add(client, headers)
    cf_id = appdb.fetchone('SELECT cf_hostname_id FROM custom_domains WHERE id = %s', (int(domain['id']),))[0]
    cloud.dns.point(domain)
    cloud.set(cf_id, 'active', 'active')
    check(appdb, domain['id'])
    assert status_of(appdb, domain['id'])[0] == 'active'
    appdb.execute("UPDATE user_entitlements SET expires_at = now() - interval '1 second' WHERE user_id = %s",
                  (user_id,))
    from utils import domains
    with appdb.connect() as conn:
        domains.run_checker(conn)
    assert status_of(appdb, domain['id']) == ('paused', 'premium_ended')
    assert client.get('/users/@me/domains', headers=headers).json()['limit'] == 0
    from utils import entitlements
    with appdb.connect() as conn:
        with conn.transaction():
            entitlements.record_expired(conn, user_id)
    set_premium(user_id, appdb)
    with appdb.connect() as conn:
        with conn.transaction():
            domains.resume_user_domains(conn, user_id)
    assert status_of(appdb, domain['id'])[0] == 'pending_cert'
    check(appdb, domain['id'])
    assert status_of(appdb, domain['id'])[0] == 'active'
    # paused for 30 days: failed, hostname deleted
    appdb.execute("UPDATE custom_domains SET status = 'paused', paused_at = now() - interval '31 days' WHERE id = %s",
                  (int(domain['id']),))
    with appdb.connect() as conn:
        domains.run_checker(conn)
    assert status_of(appdb, domain['id']) == ('failed', 'premium_ended')


def active_domain(client, appdb, cloud, headers):
    domain = add(client, headers)
    cf_id = appdb.fetchone('SELECT cf_hostname_id FROM custom_domains WHERE id = %s', (int(domain['id']),))[0]
    cloud.dns.point(domain)
    cloud.set(cf_id, 'active', 'active')
    check(appdb, domain['id'])
    return domain


def upload(client, headers, **fields):
    response = client.post('/files', headers=headers, files={'file': ('a.txt', uuid.uuid4().bytes, 'text/plain')},
                           data={k: str(v) for k, v in fields.items()})
    assert response.status_code == 200, response.text
    return response.json()


def test_default_scope_owner_links_and_passes(client, appdb, cloud):
    from tests.conftest import assert_signed
    user_id, headers = premium_user(appdb)
    pending = add(client, headers)
    response = client.patch('/users/@me/domains/' + pending['id'], headers=headers, json={'default': True})
    assert response.json()['code'] == 'DOMAIN_NOT_ACTIVE'
    domain = active_domain(client, appdb, cloud, headers)
    assert client.patch('/users/@me/domains/' + domain['id'], headers=headers, json={'scope': 'any'}).json()['code'] \
        == 'INVALID_PARAMETERS'
    body = client.patch('/users/@me/domains/' + domain['id'], headers=headers,
                        json={'scope': 'any', 'confirm': True, 'default': True}).json()
    assert body['scope'] == 'any' and body['is_default'] is True
    # owner-facing links use the default domain; public ones stay on files.gg
    created = upload(client, headers, generate_password='true')
    hostname = domain['hostname']
    assert created['url'] == 'https://{}/{}.txt'.format(hostname, created['vanity'])
    assert created['url_with_password'].startswith('https://{}/{}#pw='.format(hostname, created['vanity']))
    assert created['direct_url'].startswith('https://{}/files/{}.txt?expires='.format(hostname, created['vanity']))
    assert created['cdn_url'].startswith('https://cdn.files.gg/files/')
    assert created['direct_url'].split('?')[1] == created['cdn_url'].split('?')[1]
    owner = client.get('/users/@me/files/' + created['id'], headers=headers).json()
    assert owner['url'].startswith('https://' + hostname) and owner['direct_url'].startswith('https://' + hostname)
    unlocked = client.get('/users/@me/files', headers=headers).json()['items'][0]
    assert unlocked['url'].startswith('https://' + hostname)
    # an owner pass on the domain, and on a domain that isn't serving
    response = client.post('/users/@me/files/{}/pass'.format(created['id']), headers=headers,
                           json={'domain_id': domain['id']})
    assert response.json()['url'].startswith('https://{}/{}#t='.format(hostname, created['vanity']))
    response = client.post('/users/@me/files/{}/pass'.format(created['id']), headers=headers,
                           json={'domain_id': pending['id']})
    assert (response.status_code, response.json()['code']) == (409, 'DOMAIN_NOT_ACTIVE')
    assert client.post('/users/@me/files/{}/pass'.format(created['id']), headers=headers).json()['url'].startswith(
        'https://files.gg/')
    # a key pinned to the domain uses it for its uploads
    key = client.post('/users/@me/upload-keys', headers=headers, json={'domain_id': domain['id']}).json()
    assert key['key']['domain'] == {'id': domain['id'], 'hostname': hostname}
    keyed = client.post('/files', headers={'Authorization': 'Key ' + key['secret']},
                        files={'file': ('b.txt', b'bytes', 'text/plain')}).json()
    assert keyed['url'] == 'https://{}/{}.txt'.format(hostname, keyed['vanity'])
    # a staff-disabled domain stops serving and can't be removed by its owner
    from tests.m4 import make_staff
    _, staff = make_staff(appdb)
    response = client.post('/admin/actions', headers=staff, json={
        'action': 'disable_domain', 'target': {'type': 'domain', 'id': domain['id']}})
    assert response.json()['code'] == 'INVALID_ACTION'
    response = client.post('/admin/actions', headers=staff, json={
        'action': 'disable_domain', 'target': {'type': 'domain', 'id': domain['id']}, 'rule': 'phishing'})
    assert response.status_code == 200, response.text
    assert response.json()['action']['target']['domain_id'] == domain['id']
    assert client.get('/internal/domains/' + hostname, headers=ORIGIN).json()['domain']['serving'] is False
    assert client.delete('/users/@me/domains/' + domain['id'], headers=headers).json()['code'] == 'DOMAIN_DISABLED'
    notice = appdb.fetchone("SELECT target, appealable FROM user_warnings WHERE user_id = %s AND action = "
                            "'disable_domain'", (user_id,))
    assert notice[0] == {'kind': 'domain', 'id': domain['id'], 'hostname': hostname} and notice[1] is True
    after = upload(client, headers)
    assert after['url'].startswith('https://files.gg/')
    assert client.post('/admin/actions', headers=staff, json={
        'action': 'enable_domain', 'target': {'type': 'domain', 'id': domain['id']}}).status_code == 200
    check(appdb, domain['id'])
    assert status_of(appdb, domain['id'])[0] == 'active'
    assert client.post('/admin/actions', headers=staff, json={
        'action': 'set_domain_scope', 'target': {'type': 'domain', 'id': domain['id']},
        'rule': 'other'}).status_code == 200
    assert appdb.fetchone('SELECT scope FROM custom_domains WHERE id = %s', (int(domain['id']),))[0] == 'own'
    # admin views
    detail = client.get('/admin/domains/' + domain['id'], headers=staff).json()
    assert detail['owner']['id'] == str(user_id) and detail['cf_hostname_id']
    assert [a['action'] for a in detail['actions']][:3] == ['set_domain_scope', 'enable_domain', 'disable_domain']
    listing = client.get('/admin/domains?q=' + hostname[:6], headers=staff).json()
    assert domain['id'] in [d['id'] for d in listing['items']]
    assert client.get('/admin/lookup?q=' + hostname, headers=staff).json()['domains'][0]['id'] == domain['id']


def test_domain_only_mode_and_the_lookups(client, appdb, cloud):
    from tests.conftest import assert_signed
    user_id, headers = premium_user(appdb)
    created = upload(client, headers)
    album = client.post('/users/@me/albums', headers=headers, json={'file_ids': [created['id']]}).json()
    response = client.put('/users/@me/domain-only', headers=headers, json={'enabled': True, 'confirm': True})
    assert (response.status_code, response.json()['code']) == (409, 'DOMAIN_ONLY_NOT_AVAILABLE')
    domain = active_domain(client, appdb, cloud, headers)
    assert client.get('/users/@me/domain-only/preview', headers=headers).json() == {'affected_files': 1,
                                                                                    'affected_albums': 1}
    assert client.put('/users/@me/domain-only', headers=headers, json={'enabled': True}).json()['code'] == \
        'INVALID_PARAMETERS'
    body = client.put('/users/@me/domain-only', headers=headers, json={'enabled': True, 'confirm': True}).json()
    assert body == {'enabled': True, 'effective': True, 'paused': False, 'affected_files': 1, 'affected_albums': 1}
    lookup = client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()
    assert (lookup['served_on'], lookup['owner_state'], lookup['owner_user_id']) == ('custom', 'active', str(user_id))
    album_lookup = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert (album_lookup['served_on'], album_lookup['owner_user_id']) == ('custom', str(user_id))
    # the API's public reads don't apply it
    assert client.get('/files/' + created['vanity']).status_code == 200
    # owner payloads sign every URL, link files too
    owner = client.get('/users/@me/files/' + created['id'], headers=headers).json()
    assert_signed(owner['cdn_url'], 'file:{}:0'.format(created['id']))
    assert owner['url'].startswith('https://files.gg/')  # no default domain set
    # someone else's file: files.gg
    other = upload(client, sign_in(make_user(appdb), appdb))
    assert client.get('/internal/files/' + other['vanity'], headers=ORIGIN).json()['served_on'] == 'files.gg'
    # the domain fails: domain-only pauses (one email), files.gg serves again
    appdb.execute("UPDATE custom_domains SET status = 'failed' WHERE id = %s", (int(domain['id']),))
    listing = client.get('/users/@me/domains', headers=headers).json()
    assert listing['domain_only'] == {'enabled': True, 'effective': False, 'paused': True}
    assert client.get('/internal/files/' + created['vanity'], headers=ORIGIN).json()['served_on'] == 'files.gg'
    from utils import domains
    with appdb.connect() as conn:
        with conn.transaction():
            mails = domains.refresh_domain_only(conn, user_id)
            again = domains.refresh_domain_only(conn, user_id)
    assert len(mails) == 1 and again == []
    # premium ends: no domain-only (403 to turn it on)
    appdb.execute('UPDATE user_entitlements SET revoked_at = now() WHERE user_id = %s', (user_id,))
    assert client.put('/users/@me/domain-only', headers=headers, json={'enabled': True, 'confirm': True}).json()[
        'code'] == 'PREMIUM_REQUIRED'
    assert client.put('/users/@me/domain-only', headers=headers, json={'enabled': False}).json()['enabled'] is False


def test_a_pending_deletion_stops_serving(client, appdb, cloud):
    user_id, headers = premium_user(appdb)
    domain = active_domain(client, appdb, cloud, headers)
    appdb.execute("UPDATE users SET deletion_requested_at = now(), deletion_scheduled_for = now() + interval '14 days' "
                  'WHERE id = %s', (user_id,))
    found = client.get('/internal/domains/' + domain['hostname'], headers=ORIGIN).json()['domain']
    assert found['serving'] is False
    assert status_of(appdb, domain['id'])[0] == 'active'


def test_domain_reports(client, appdb, cloud):
    from tests.m4 import REPORT_TOKEN, make_staff
    _, headers = premium_user(appdb)
    domain = active_domain(client, appdb, cloud, headers)
    reporter = sign_in(make_user(appdb), appdb)
    response = client.post('/reports', headers=reporter, json={'target': {'type': 'domain',
                                                                          'hostname': domain['hostname'].upper()},
                                                               'reason': 'malware'})
    assert response.status_code == 201, response.text
    case_id = appdb.fetchone('SELECT case_id FROM reports WHERE domain_id = %s', (int(domain['id']),))[0]
    assert appdb.fetchone('SELECT kind FROM moderation_cases WHERE id = %s', (case_id,))[0] == 'domain'
    response = client.post('/reports/anonymous', json={'target': {'type': 'domain', 'hostname': domain['hostname']},
                                                       'reason': 'copyright', 'turnstile_token': REPORT_TOKEN,
                                                       'details': 'x'})
    assert response.status_code == 400
    # no automatic effect
    assert status_of(appdb, domain['id'])[0] == 'active'
    # url targets resolve on live custom domains
    created = upload(client, headers)
    response = client.post('/reports', headers=reporter, json={
        'target': {'type': 'url', 'url': 'https://{}/{}.txt'.format(domain['hostname'], created['vanity'])},
        'reason': 'spam'})
    assert response.status_code == 201 and response.json()['report']['target']['type'] == 'file'
    _, staff = make_staff(appdb)
    case = client.get('/admin/cases/{}'.format(case_id), headers=staff).json()
    assert case['target']['type'] == 'domain' and case['target']['name'] == domain['hostname']


@pytest.mark.parametrize('url, expected', [
    ('https://cdn.files.gg/files/abc123.png', 'https://i.example.com/files/abc123.png'),
    ('https://cdn.files.gg/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8',
     'https://i.example.com/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8'),
    ('https://cdn.files.gg/previews/thumb/abc123.webp?v=5', 'https://i.example.com/previews/thumb/abc123.webp?v=5'),
    ('https://files.gg/abc123', 'https://i.example.com/abc123'),
    ('https://files.gg/a/Ab3dE6gH#pw=amber-tunnel-oxide-violet',
     'https://i.example.com/a/Ab3dE6gH#pw=amber-tunnel-oxide-violet'),
    ('https://cdn.discordapp.com/avatars/1/a.png', 'https://cdn.discordapp.com/avatars/1/a.png'),
    ('https://cdn.files.gg.evil.example/files/x.png', 'https://cdn.files.gg.evil.example/files/x.png'),
])
def test_rehost_vectors(url, expected):
    """§16.5: the API's owner links rehost exactly as the Worker and the viewer do."""
    from utils import links
    assert links.rehost(url, 'i.example.com') == expected


def test_rehost_keeps_the_configured_scheme_and_port(monkeypatch):
    """A local http stack (PUBLIC_URL=http://files.localhost:8787): only the hostname changes, so owner links
    on a custom domain reach the same server, as the Worker's own rehosting does."""
    from utils import links
    monkeypatch.setenv('PUBLIC_URL', 'http://files.localhost:8787')
    monkeypatch.setenv('CDN_URL', 'http://cdn.files.localhost:8787')
    assert links.rehost('http://files.localhost:8787/abc#t=x', 'i.example.localhost') == \
        'http://i.example.localhost:8787/abc#t=x'
    assert links.rehost('http://cdn.files.localhost:8787/files/abc.png?expires=1&sig=s', 'i.example.localhost') == \
        'http://i.example.localhost:8787/files/abc.png?expires=1&sig=s'
    # an origin that isn't ours is never touched
    assert links.rehost('http://files.localhost:9999/abc', 'i.example.localhost') == 'http://files.localhost:9999/abc'
