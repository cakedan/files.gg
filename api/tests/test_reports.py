"""Milestone 4 reports (contract §7): targets and reasons, URL targets, duplicates, rate limits,
distinct-reporter counting, automatic effects, and the reporter's view ("My reports")."""

import uuid

import pytest

from tests.m4 import REPORT_TOKEN, anonymous, appdb, new_user, nonce, send  # noqa: F401


def net():
    return '172.16.{}.{}'.format(*uuid.uuid4().bytes[:2])


def report(client, headers, body, ip=None, status=None):
    headers = dict(headers, **{'X-Forwarded-For': ip or net()})
    if 'Authorization' in headers:
        response = client.post('/reports', headers=headers, json=body)
    else:
        response = client.post('/reports/anonymous', headers=headers, json=dict(body, turnstile_token=REPORT_TOKEN))
    if status is not None:
        assert response.status_code == status, response.text
    return response


def file_of(client, appdb, owner=None, **fields):
    if owner is None:
        _, owner = new_user(appdb)
    return send(client, owner, nonce() * 4, 'r.txt', 'text/plain', **fields), owner


def state(appdb, created):
    return appdb.fetchone('SELECT moderation_state, moderation_rule, nsfw_override, nsfw_override_source FROM files '
                          'WHERE id = %s', (int(created['id']),))


# --- submitting -------------------------------------------------------------------------------------------

def test_a_signed_in_report_and_its_view(client, appdb):
    created, _ = file_of(client, appdb)
    _, reporter = new_user(appdb)
    body = report(client, reporter, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam',
                                     'details': 'Ads\x00 everywhere'}, status=201).json()['report']
    assert set(body) == {'id', 'kind', 'target', 'reason', 'status', 'closed', 'escalated', 'can_reopen', 'unread',
                         'created_at', 'updated_at', 'resolved_at', 'last_message_at'}
    assert body['target'] == {'type': 'file', 'vanity': created['vanity'], 'url': 'https://files.gg/' +
                              created['vanity'], 'part': None}
    assert (body['kind'], body['status'], body['escalated'], body['unread']) == ('file', 'open', False, 0)
    row = appdb.fetchone('SELECT priority, details, case_id, reporter_abuse_ip_hash IS NOT NULL FROM reports '
                         'WHERE id = %s', (int(body['id']),))
    assert row[0] == 3 and row[1] == 'Ads everywhere' and row[2] is not None and row[3] is True
    # the target's open case
    case = appdb.fetchone('SELECT kind, priority, status, file_id FROM moderation_cases WHERE id = %s', (row[2],))
    assert case == ('file', 3, 'open', int(created['id']))
    # a duplicate adds the new details to the thread
    again = report(client, reporter, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam',
                                      'details': 'Still there'}, status=200).json()
    assert again['duplicate'] is True and again['report']['id'] == body['id']
    messages = client.get('/users/@me/reports/{}/messages'.format(body['id']), headers=reporter).json()['items']
    assert [(m['author'], m['body']) for m in messages] == [('you', 'Still there')]


def test_an_anonymous_report_and_its_duplicate(client, appdb):
    created, _ = file_of(client, appdb)
    headers = anonymous()
    ip = net()
    body = report(client, headers, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'other',
                                    'details': 'Odd', 'contact_email': 'me@example.com'}, ip=ip, status=201).json()
    assert set(body) == {'id', 'status'} and body['status'] == 'open'
    again = report(client, headers, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'other',
                                     'details': 'Again'}, ip=ip, status=200).json()
    assert again == {'id': body['id'], 'status': 'open', 'duplicate': True}
    assert appdb.fetchone('SELECT contact_email FROM reports WHERE id = %s', (int(body['id']),)) == ('me@example.com',)
    # Turnstile, action `report`
    response = client.post('/reports/anonymous', headers=anonymous(), json={
        'target': {'type': 'bug'}, 'reason': 'bug', 'details': 'x', 'turnstile_token': 'mock:upload:files.gg'})
    assert response.json()['code'] == 'CAPTCHA_INVALID'


@pytest.mark.parametrize('body, code', [
    ({'target': {'type': 'file', 'vanity': 'nope-' + uuid.uuid4().hex}, 'reason': 'spam'}, 'UNKNOWN_FILE'),
    ({'target': {'type': 'file', 'vanity': 'x'}, 'reason': 'bug', 'details': 'x'}, 'INVALID_REPORT_TARGET'),
    ({'target': {'type': 'bug'}, 'reason': 'spam'}, 'INVALID_REPORT_TARGET'),
    ({'target': {'type': 'url', 'url': 'https://example.com/abc'}, 'reason': 'spam'}, 'INVALID_REPORT_TARGET'),
    ({'target': {'type': 'bug'}, 'reason': 'bug'}, 'DETAILS_REQUIRED'),
    ({'target': {'type': 'bug'}, 'reason': 'nope'}, 'INVALID_PARAMETERS'),
])
def test_invalid_reports(client, appdb, body, code):
    _, reporter = new_user(appdb)
    if body['target'].get('vanity') == 'x':
        body['target']['vanity'] = file_of(client, appdb)[0]['vanity']
    response = report(client, reporter, body)
    assert response.json()['code'] == code, response.text
    if code == 'DETAILS_REQUIRED':
        assert response.json()['errors'] == {'details': 'Add some details'}


def test_not_your_own_and_private_files(client, appdb):
    created, owner = file_of(client, appdb)
    assert report(client, owner, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam'}
                  ).json()['code'] == 'CANNOT_REPORT_YOURSELF'
    headers = anonymous()
    anon = send(client, headers, nonce(), 'a.txt', 'text/plain', anonymous_upload=True)
    assert report(client, headers, {'target': {'type': 'file', 'vanity': anon['vanity']}, 'reason': 'spam'}
                  ).json()['code'] == 'CANNOT_REPORT_YOURSELF'
    secret, _ = file_of(client, appdb, visibility='private')
    _, reporter = new_user(appdb)
    assert report(client, reporter, {'target': {'type': 'file', 'vanity': secret['vanity']}, 'reason': 'spam'}
                  ).json()['code'] == 'UNKNOWN_FILE'
    # user reports: signed in only
    assert report(client, anonymous(), {'target': {'type': 'user', 'id': '1'}, 'reason': 'spam'}
                  ).json()['code'] == 'INVALID_REPORT_TARGET'


def test_url_targets(client, appdb):
    created, owner = file_of(client, appdb)
    other = send(client, owner, nonce(), 'o.txt', 'text/plain')
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [created['id'], other['id']]}).json()
    _, reporter = new_user(appdb)
    cases = [
        ('https://files.gg/{}.txt?x=1#y'.format(created['vanity']), 'file', created['vanity']),
        ('https://files.gg/{}/report'.format(created['vanity']), 'file', created['vanity']),
        ('https://cdn.files.gg/files/{}.txt?expires=1&sig=x'.format(created['vanity']), 'file', created['vanity']),
        ('https://cdn.files.gg/previews/thumb/{}.webp?v=5'.format(created['vanity']), 'file', created['vanity']),
        # an album item: the reporter's view names the album and the position, never the item's vanity
        ('https://files.gg/a/{}/2'.format(album['vanity']), 'file', None),
        ('https://files.gg/a/{}/report'.format(album['vanity']), 'album', album['vanity']),
        ('https://cdn.files.gg/albums/download/{}.zip'.format(album['vanity']), 'album', album['vanity']),
    ]
    for reason, (url, kind, vanity) in zip(('spam', 'other', 'harassment', 'violence', 'spam', 'spam', 'other'),
                                           cases):
        body = report(client, reporter, {'target': {'type': 'url', 'url': url}, 'reason': reason, 'details': 'd'})
        assert body.status_code in (200, 201), (url, body.text)
        target = body.json()['report']['target']
        assert (target['type'], target['vanity']) == (kind, vanity), url
        if vanity is None:
            assert target['url'] == 'https://files.gg/a/{}/2'.format(album['vanity'])
            assert target['album'] == {'vanity': album['vanity'], 'item': 2}
            assert other['vanity'] not in body.text
            row = appdb.fetchone('SELECT kind, file_id FROM reports WHERE id = %s', (int(body.json()['report']['id']),))
            assert row == ('file', int(other['id']))


def test_dmca_reports(client, appdb):
    a, owner = file_of(client, appdb)
    b = send(client, owner, nonce(), 'b.txt', 'text/plain')
    _, reporter = new_user(appdb)
    base = {'target': {'type': 'file', 'vanity': a['vanity']}, 'reason': 'copyright', 'details': 'My song'}
    response = report(client, reporter, dict(base, dmca={'name': 'Ann'}))
    assert response.json()['code'] == 'DMCA_FIELDS_REQUIRED'
    assert set(response.json()['errors']) == {'address', 'phone', 'email', 'work', 'urls', 'good_faith',
                                              'accurate_and_authorised', 'signature'}
    dmca = {'name': 'Ann Example', 'address': '1 Road', 'phone': '555', 'email': 'ann@example.com',
            'work': 'The song', 'urls': ['https://files.gg/' + a['vanity'], 'https://files.gg/' + b['vanity']],
            'good_faith': True, 'accurate_and_authorised': True, 'signature': 'Ann Example'}
    body = report(client, reporter, dict(base, dmca=dmca), status=201).json()
    # one report per file
    assert len(body['report_ids']) == 2
    assert appdb.fetchone('SELECT dmca->>\'signature\' FROM reports WHERE id = %s', (int(body['report_ids'][1]),)) == (
        'Ann Example',)


# --- rate limits (§7.7) ------------------------------------------------------------------------------------

def test_report_rate_limits(client, appdb, monkeypatch):
    monkeypatch.setenv('REPORT_RATE_PER_HOUR', '2')
    _, reporter = new_user(appdb)
    for _ in range(2):
        created, _ = file_of(client, appdb)
        report(client, reporter, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam'},
               status=201)
    created, _ = file_of(client, appdb)
    response = report(client, reporter, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam'})
    assert response.status_code == 429 and response.json()['code'] == 'MAX_REPORTS'
    assert 1 <= response.json()['retry_after'] <= 3600
    # CSAM reports aren't limited for signed-in reporters
    report(client, reporter, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'csam'}, status=201)
    # anonymous: per fingerprint and per IP hash
    ip = net()
    for _ in range(2):
        created, _ = file_of(client, appdb)
        report(client, anonymous(), {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam'},
               ip=ip, status=201)
    assert report(client, anonymous(), {'target': {'type': 'bug'}, 'reason': 'bug', 'details': 'x'},
                  ip=ip).json()['code'] == 'MAX_REPORTS'


def test_report_message_rate_limit(client, appdb, monkeypatch):
    monkeypatch.setenv('REPORT_MESSAGE_RATE_PER_HOUR', '1')
    created, _ = file_of(client, appdb)
    _, reporter = new_user(appdb)
    body = report(client, reporter, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam'},
                  status=201).json()['report']
    url = '/users/@me/reports/{}/messages'.format(body['id'])
    assert client.post(url, headers=reporter, json={'body': 'one'}).status_code == 201
    assert client.post(url, headers=reporter, json={'body': 'two'}).json()['code'] == 'MAX_MESSAGES'


# --- distinct reporters and automatic effects (§7.4) ---------------------------------------------------------

def test_two_distinct_malware_reports_hide_and_rescan(client, appdb):
    created, owner = file_of(client, appdb)
    owner_id = appdb.fetchone('SELECT user_id FROM files WHERE id = %s', (int(created['id']),))[0]
    target = {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'malware'}
    shared = net()
    _, first = new_user(appdb)
    _, second = new_user(appdb)
    report(client, first, target, ip=shared, status=201)
    # a rescan with clamav was queued at once
    hash_id = appdb.fetchone('SELECT hash_id FROM files WHERE id = %s', (int(created['id']),))[0]
    assert appdb.fetchone("SELECT payload->'checks' FROM jobs WHERE kind = 'rescan' AND payload->>'hash_id' = %s",
                          (str(hash_id),)) == (['clamav'],)
    # another account on the same network isn't distinct
    report(client, second, target, ip=shared, status=201)
    assert state(appdb, created)[0] == 'visible'
    _, third = new_user(appdb)
    report(client, third, target, status=201)
    assert state(appdb, created)[:2] == ('hidden', 'malware')
    assert client.get('/files/' + created['vanity']).json() == {
        'code': 'FILE_REMOVED', 'message': 'This file is unavailable', 'status': 410, 'reason': 'review'}
    # the owner: a non-appealable notice, `review`
    notice = appdb.fetchone('SELECT action, message, appealable, counts_as_strike FROM user_warnings WHERE user_id = %s',
                            (owner_id,))
    assert notice == ('auto_hide', 'Hidden while we review a report', False, False)
    body = client.get('/users/@me/files/' + created['id'], headers=owner).json()
    assert body['safety']['state'] == 'hidden' and body['safety']['reason'] == 'review'
    assert appdb.fetchone("SELECT count(*) FROM moderation_actions WHERE action = 'auto_hide' AND file_id = %s",
                          (int(created['id']),))[0] == 1


def test_adult_unmarked_reports_mark_nsfw(client, appdb):
    created, _ = file_of(client, appdb)
    target = {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'adult_unmarked'}
    for _ in range(2):
        report(client, new_user(appdb)[1], target, status=201)
    assert state(appdb, created)[2:] == ('nsfw', 'reports')
    assert client.get('/files/' + created['vanity']).json()['nsfw'] is True
    case = appdb.fetchone("SELECT status FROM moderation_cases WHERE file_id = %s AND kind = 'file'",
                          (int(created['id']),))
    assert case == ('open',)


def test_csam_reports_hide_at_once_escalate_and_notify_no_one(client, appdb):
    created, owner = file_of(client, appdb)
    owner_id = appdb.fetchone('SELECT user_id FROM files WHERE id = %s', (int(created['id']),))[0]
    body = report(client, anonymous(), {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'csam'},
                  status=201).json()
    assert body['escalated'] is True
    assert state(appdb, created)[:2] == ('hidden', 'csam')
    assert appdb.fetchone('SELECT count(*) FROM user_warnings WHERE user_id = %s', (owner_id,))[0] == 0
    case = appdb.fetchone("SELECT priority, child_safety FROM moderation_cases WHERE file_id = %s AND status = 'open'",
                          (int(created['id']),))
    assert case == (0, True)
    assert client.get('/users/@me/files/' + created['id'], headers=owner).json()['safety']['reason'] == 'review'


def test_a_csam_report_on_an_album_hides_every_item(client, appdb):
    a, owner = file_of(client, appdb)
    b = send(client, owner, nonce(), 'b.txt', 'text/plain')
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [a['id'], b['id']]}).json()
    _, reporter = new_user(appdb)
    body = report(client, reporter, {'target': {'type': 'album', 'vanity': album['vanity']}, 'reason': 'csam'},
                  status=201).json()
    assert body['escalated'] is True
    assert appdb.fetchone('SELECT moderation_state FROM albums WHERE id = %s', (int(album['id']),)) == ('hidden',)
    assert {state(appdb, f)[0] for f in (a, b)} == {'hidden'}
    assert client.get('/albums/' + album['vanity']).json()['code'] == 'ALBUM_REMOVED'


def test_user_reports_never_hide(client, appdb):
    user_id, _ = new_user(appdb)
    for _ in range(3):
        report(client, new_user(appdb)[1], {'target': {'type': 'user', 'id': str(user_id)}, 'reason': 'ncii'},
               status=201)
    assert appdb.fetchone("SELECT count(*) FROM moderation_cases WHERE user_id = %s AND kind = 'user'",
                          (user_id,)) == (1,)
    assert appdb.fetchone('SELECT count(*) FROM moderation_actions WHERE user_id = %s', (user_id,)) == (0,)


# --- the reporter's view (§7.6) ---------------------------------------------------------------------------------

def test_my_reports_unread_reopen_and_closing(client, appdb, monkeypatch):
    from safety import tasks
    created, _ = file_of(client, appdb)
    reporter_id, reporter = new_user(appdb)
    body = report(client, reporter, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam'},
                  status=201).json()['report']
    listing = client.get('/users/@me/reports?query=' + created['vanity'][:4], headers=reporter).json()
    assert listing['count'] == 1 and listing['items'][0]['id'] == body['id']
    assert client.get('/users/@me/reports?status=resolved', headers=reporter).json()['count'] == 0
    # staff dismiss it with a message: two unread (the message and the status change)
    case_id = appdb.fetchone('SELECT case_id FROM reports WHERE id = %s', (int(body['id']),))[0]
    from tests.m4 import make_staff
    _, staff = make_staff(appdb)
    closed = client.post('/admin/cases/{}/close'.format(case_id), headers=staff,
                         json={'outcome': 'dismissed', 'reason': 'not spam'})
    assert closed.status_code == 200, closed.text
    mine = client.get('/users/@me/reports/' + body['id'], headers=reporter).json()
    assert mine['status'] == 'dismissed' and mine['unread'] == 2 and mine['can_reopen'] is True
    assert client.get('/users/@me/badges', headers=reporter).json()['reports_unread'] == 2
    messages = client.get('/users/@me/reports/{}/messages'.format(body['id']), headers=reporter).json()['items']
    assert [m['author'] for m in messages] == ['staff'] and 'staff' == messages[0]['author']
    assert client.get('/users/@me/reports/' + body['id'], headers=reporter).json()['unread'] == 0
    # reopen once
    reopened = client.request('PATCH', '/users/@me/reports/' + body['id'], headers=reporter,
                              json={'status': 'open'}).json()
    assert reopened['status'] == 'open' and reopened['can_reopen'] is False
    new_case = appdb.fetchone('SELECT case_id FROM reports WHERE id = %s', (int(body['id']),))[0]
    assert new_case != case_id
    client.post('/admin/cases/{}/close'.format(new_case), headers=staff, json={'outcome': 'dismissed'})
    assert client.request('PATCH', '/users/@me/reports/' + body['id'], headers=reporter,
                          json={'status': 'open'}).json()['code'] == 'REOPEN_NOT_ALLOWED'
    # closed 30 days after resolution: read only
    appdb.execute("UPDATE reports SET resolved_at = now() - interval '31 days' WHERE id = %s", (int(body['id']),))
    assert tasks.close_reports(appdb.conn) >= 1
    mine = client.get('/users/@me/reports/' + body['id'], headers=reporter).json()
    assert mine['closed'] is True
    assert client.post('/users/@me/reports/{}/messages'.format(body['id']), headers=reporter,
                       json={'body': 'hello'}).json()['code'] == 'REPORT_CLOSED'
    assert client.get('/users/@me/reports/1', headers=reporter).json()['code'] == 'UNKNOWN_REPORT'
    assert reporter_id


def test_retention_clears_ip_hashes_and_old_reports(client, appdb):
    from safety import tasks
    created, _ = file_of(client, appdb)
    _, reporter = new_user(appdb)
    body = report(client, reporter, {'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': 'spam'},
                  status=201).json()['report']
    appdb.execute("UPDATE reports SET created_at = now() - interval '31 days' WHERE id = %s", (int(body['id']),))
    out = tasks.retention(appdb.conn)
    assert out['report_ips'] >= 1
    assert appdb.fetchone('SELECT reporter_abuse_ip_hash FROM reports WHERE id = %s', (int(body['id']),)) == (None,)
    appdb.execute("UPDATE reports SET status = 'resolved', closed_at = now() - interval '400 days' WHERE id = %s",
                  (int(body['id']),))
    tasks.retention(appdb.conn)
    assert appdb.fetchone('SELECT count(*) FROM reports WHERE id = %s', (int(body['id']),)) == (0,)
    # uploader IP hashes and sealed IPs past 30 days
    appdb.execute("UPDATE files SET uploader_abuse_ip_hash = '\\x01', uploader_ip_sealed = '\\x02' WHERE id = %s",
                  (int(created['id']),))
    import os
    os.environ['ABUSE_IP_KEEP_DAYS'] = '0'
    try:
        tasks.retention(appdb.conn)
    finally:
        os.environ.pop('ABUSE_IP_KEEP_DAYS')
    assert appdb.fetchone('SELECT uploader_abuse_ip_hash, uploader_ip_sealed FROM files WHERE id = %s',
                          (int(created['id']),)) == (None, None)


# --- album items of protected albums --------------------------------------------------------------------------

def test_items_of_a_password_album_need_its_token_and_never_echo_their_vanity(client, appdb):
    from tests.conftest import UNLOCK_TOKEN
    created, owner = file_of(client, appdb)
    other = send(client, owner, nonce(), 'o.txt', 'text/plain')
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [created['id'], other['id']]}).json()
    patched = client.request('PATCH', '/users/@me/albums/' + album['id'], headers=owner,
                             json={'visibility': 'password', 'password': 'album-pass-9'})
    assert patched.status_code == 200, patched.text
    _, reporter = new_user(appdb)
    anon = anonymous()

    def item(n, headers, token=None, reason='spam'):
        extra = {'X-Filesgg-Access': token} if token else {}
        return report(client, dict(headers, **extra), {
            'target': {'type': 'url', 'url': 'https://files.gg/a/{}/{}'.format(album['vanity'], n)}, 'reason': reason,
            'details': 'd'})

    # without the album's token, every position answers the same: no enumeration of what's inside
    for headers in (reporter, anon):
        answers = {(r.status_code, r.json()['code']) for r in (item(n, headers) for n in (1, 2, 3, 99))}
        assert answers == {(400, 'INVALID_REPORT_TARGET')}, answers
        response = report(client, headers, {'target': {'type': 'album', 'vanity': album['vanity'], 'item': 1},
                                            'reason': 'spam'})
        assert response.json()['code'] == 'INVALID_REPORT_TARGET'
    # another album's token doesn't open it
    elsewhere = client.post('/users/@me/albums', headers=owner, json={'file_ids': [created['id']]}).json()
    client.request('PATCH', '/users/@me/albums/' + elsewhere['id'], headers=owner,
                   json={'visibility': 'password', 'password': 'other-pass-9'})

    def unlock(vanity, password):
        response = client.post('/albums/{}/unlock'.format(vanity), json={
            'password': password, 'turnstile_token': UNLOCK_TOKEN}, headers={'X-Forwarded-For': net()})
        assert response.status_code == 200, response.text
        return response.json()['token']
    assert item(1, reporter, unlock(elsewhere['vanity'], 'other-pass-9')).json()['code'] == 'INVALID_REPORT_TARGET'
    assert item(1, reporter, 'garbage').json()['code'] == 'INVALID_REPORT_TARGET'
    # the album itself can still be reported by anyone with its link
    report(client, reporter, {'target': {'type': 'album', 'vanity': album['vanity'], 'part': 'title'},
                              'reason': 'spam'}, status=201)

    # with its token: the item is reported, and the reporter's view shows the album and the position only
    # (another reporter: failed attempts count towards the hourly limit too)
    _, reporter = new_user(appdb)
    token = unlock(album['vanity'], 'album-pass-9')
    response = item(2, reporter, token)
    assert response.status_code == 201, response.text
    body = response.json()['report']
    assert body['target'] == {'type': 'file', 'vanity': None, 'url': 'https://files.gg/a/{}/2'.format(album['vanity']),
                              'part': None, 'album': {'vanity': album['vanity'], 'item': 2}}
    assert other['vanity'] not in response.text
    assert appdb.fetchone('SELECT kind, file_id FROM reports WHERE id = %s', (int(body['id']),)) == (
        'file', int(other['id']))
    for listed in (client.get('/users/@me/reports/' + body['id'], headers=reporter),
                   client.get('/users/@me/reports?query=' + album['vanity'], headers=reporter)):
        assert listed.status_code == 200 and other['vanity'] not in listed.text and created['vanity'] not in listed.text
    assert client.get('/users/@me/reports?query=' + album['vanity'], headers=reporter).json()['count'] == 1
    anonymous_body = item(1, anon, token, reason='other')
    assert anonymous_body.status_code == 201 and set(anonymous_body.json()) == {'id', 'status'}
    # a position past the end, with the token
    assert item(99, reporter, token).json()['code'] == 'UNKNOWN_FILE'
    # positions are 1 or more
    assert report(client, reporter, {'target': {'type': 'album', 'vanity': album['vanity'], 'item': 0},
                                     'reason': 'spam'}).json()['code'] == 'INVALID_REPORT_TARGET'
