"""Milestone 4 moderation (contract §8, §9): staff and the CLI, the admin 404, cases and claims,
every action, notices and appeals (SAME_MODERATOR), strikes and suspension, bans, the audit
log, lookups, target detail with staff grants, CyberTipline records and badges."""

import uuid

import pytest

from tests.m4 import anonymous, appdb, make_staff, new_user, nonce, send  # noqa: F401


def upload(client, owner, **fields):
    return send(client, owner, nonce() * 4, 'm.txt', 'text/plain', **fields)


def act(client, staff, action, kind, target_id, status=200, **extra):
    body = dict({'action': action, 'target': {'type': kind, 'id': str(target_id)}}, **extra)
    response = client.post('/admin/actions', headers=staff, json=body)
    assert response.status_code == status, response.text
    return response.json()


def file_row(appdb, created):
    return appdb.fetchone('SELECT moderation_state, moderation_rule, nsfw_override, deleted_at IS NOT NULL, '
                          'deleted_reason FROM files WHERE id = %s', (int(created['id']),))


def hash_of_file(appdb, created):
    return appdb.fetchone('SELECT hash_id FROM files WHERE id = %s', (int(created['id']),))[0]


# --- staff and access (§9.1) -----------------------------------------------------------------------------

def test_the_staff_cli_grants_revokes_and_logs(appdb):
    from tools import staff
    user_id, _ = new_user(appdb)
    assert staff.grant(appdb.conn, user_id, 'admin', True, 'ops-dan') == {
        'user_id': str(user_id), 'role': 'admin', 'child_safety': True}
    assert {'user_id': str(user_id), 'role': 'admin'}.items() <= next(
        s for s in staff.list_staff(appdb.conn) if s['user_id'] == str(user_id)).items()
    staff.revoke(appdb.conn, user_id, 'ops-dan')
    rows = appdb.fetchall("SELECT action, actor_kind, details->>'by' FROM moderation_actions WHERE user_id = %s "
                          "AND action LIKE '%%_staff' ORDER BY id", (user_id,))
    assert rows == [('grant_staff', 'cli', 'ops-dan'), ('revoke_staff', 'cli', 'ops-dan')]
    with pytest.raises(SystemExit):
        staff.revoke(appdb.conn, user_id, 'ops-dan')
    assert staff.main(['list']) == 0


def test_admin_endpoints_are_404_for_non_staff(client, appdb):
    unknown = client.get('/admin/nope-' + uuid.uuid4().hex)
    _, user = new_user(appdb)
    for path in ('/admin/summary', '/admin/cases', '/admin/audit', '/admin/staff', '/admin/lookup?q=x',
                 '/admin/files/1', '/admin/users/1', '/admin/bans'):
        for headers in ({}, {'Authorization': 'garbage'}, user):
            response = client.get(path, headers=headers)
            assert (response.status_code, response.json()) == (unknown.status_code, unknown.json()), (path, headers)
    response = client.post('/admin/actions', headers=user, json={})
    assert (response.status_code, response.json()) == (404, unknown.json())
    # a moderator gets 403 FORBIDDEN for admin-only things
    _, moderator = make_staff(appdb)
    assert client.get('/admin/staff', headers=moderator).json()['code'] == 'FORBIDDEN'
    assert client.get('/admin/audit', headers=moderator).json()['code'] == 'FORBIDDEN'
    assert client.post('/admin/rescans', headers=moderator, json={'checks': ['clamav']}).status_code == 403
    me = client.get('/users/@me', headers=moderator).json()
    assert me['staff'] == {'role': 'moderator', 'child_safety': False} and me['restrictions'] == []
    assert client.get('/users/@me', headers=user).json()['staff'] is None


# --- cases (§9.2) -------------------------------------------------------------------------------------------

def reported_case(client, appdb, reason='spam', details='d'):
    _, owner = new_user(appdb)
    created = upload(client, owner)
    _, reporter = new_user(appdb)
    response = client.post('/reports', headers=dict(reporter, **{'X-Forwarded-For': '10.9.{}.{}'.format(
        *uuid.uuid4().bytes[:2])}), json={'target': {'type': 'file', 'vanity': created['vanity']}, 'reason': reason,
                                          'details': details})
    assert response.status_code == 201, response.text
    report_id = response.json()['report']['id']
    case_id = appdb.fetchone('SELECT case_id FROM reports WHERE id = %s', (int(report_id),))[0]
    return case_id, created, owner, reporter, report_id


def test_cases_claims_messages_and_closing(client, appdb):
    case_id, created, _, reporter, report_id = reported_case(client, appdb)
    _, first = make_staff(appdb)
    second_id, second = make_staff(appdb)
    admin_id, admin = make_staff(appdb, 'admin')
    listing = client.get('/admin/cases?assignee=none&kind=file&reason=spam&limit=100', headers=first).json()
    summary = next(c for c in listing['items'] if c['id'] == str(case_id))
    assert summary['target']['type'] == 'file' and summary['target']['vanity'] == created['vanity']
    assert summary['target']['state'] == 'ok' and summary['reasons'] == {'spam': 1}
    assert summary['report_count'] == 1 and summary['distinct_reporters'] == 1 and summary['assignee'] is None
    case = client.post('/admin/cases/{}/claim'.format(case_id), headers=first).json()
    assert case['assignee']['id'] is not None and case['reports'][0]['reporter']['signed_in'] is True
    assert 'abuse_ip_hash' not in str(case['reports'])
    response = client.post('/admin/cases/{}/claim'.format(case_id), headers=second)
    assert response.status_code == 409 and response.json()['code'] == 'CASE_CLAIMED'
    # an admin can take it with force
    taken = client.post('/admin/cases/{}/claim'.format(case_id), headers=admin, json={'force': True}).json()
    assert taken['assignee']['id'] == str(admin_id)
    assert client.post('/admin/cases/{}/release'.format(case_id), headers=admin).json()['assignee'] is None
    # a staff message in the reporter's thread, as "files.gg staff"
    message = client.post('/admin/cases/{}/messages'.format(case_id), headers=second,
                          json={'report_id': report_id, 'body': 'Looking into it'})
    assert message.status_code == 201 and message.json()['author'] == 'staff'
    closed = client.post('/admin/cases/{}/close'.format(case_id), headers=second,
                         json={'outcome': 'actioned', 'reason': 'removed it'}).json()
    assert closed['status'] == 'closed' and closed['outcome'] == 'actioned'
    thread = client.get('/users/@me/reports/{}/messages'.format(report_id), headers=reporter).json()['items']
    assert [m['author'] for m in thread] == ['staff', 'staff']
    assert client.get('/users/@me/reports/' + report_id, headers=reporter).json()['status'] == 'resolved'
    actions = [a['action'] for a in client.get('/admin/cases/{}'.format(case_id), headers=admin).json()['actions']]
    for action in ('claim', 'release', 'staff_message', 'close_case'):
        assert action in actions
    assert second_id
    assert client.get('/admin/cases/999999999', headers=admin).json()['code'] == 'UNKNOWN_CASE'


def test_child_safety_cases_only_exist_for_child_safety_staff(client, appdb):
    case_id, created, _, _, report_id = reported_case(client, appdb, reason='csam')
    _, moderator = make_staff(appdb)
    _, guardian = make_staff(appdb, child_safety=True)
    assert client.get('/admin/cases/{}'.format(case_id), headers=moderator).json()['code'] == 'UNKNOWN_CASE'
    ids = [c['id'] for c in client.get('/admin/cases?limit=100&priority=0', headers=moderator).json()['items']]
    assert str(case_id) not in ids
    case = client.get('/admin/cases/{}'.format(case_id), headers=guardian).json()
    assert case['child_safety'] is True and case['priority'] == 0
    # staff never post details into escalated reports
    assert client.post('/admin/cases/{}/messages'.format(case_id), headers=guardian,
                       json={'report_id': report_id, 'body': 'x'}).json()['code'] == 'INVALID_ACTION'
    # the moderator can't open its media either
    assert client.get('/admin/files/' + created['id'], headers=moderator).json()['code'] == 'FORBIDDEN'
    # CyberTipline: child-safety staff record it
    before = client.get('/admin/summary', headers=guardian).json()['cybertip_unrecorded']
    assert client.post('/admin/cases/{}/cybertip'.format(case_id), headers=moderator,
                       json={'report_id': '123'}).status_code == 403
    recorded = client.post('/admin/cases/{}/cybertip'.format(case_id), headers=guardian,
                           json={'report_id': 'CT-12345'}).json()
    assert recorded['cybertip_report_id'] == 'CT-12345'
    assert client.get('/admin/summary', headers=guardian).json()['cybertip_unrecorded'] <= before


def test_summary_and_badges(client, appdb):
    staff_id, staff = make_staff(appdb, 'admin', child_safety=True)
    case_id, *_ = reported_case(client, appdb, reason='ncii')
    client.post('/admin/cases/{}/claim'.format(case_id), headers=staff)
    summary = client.get('/admin/summary', headers=staff).json()
    assert set(summary) >= {'open', 'unassigned', 'mine', 'past_goal', 'appeals', 'bugs', 'scans_stalled',
                            'cybertip_unrecorded', 'newest_p0_at'}
    assert summary['open']['p0'] >= 1 and summary['mine'] >= 1 and summary['newest_p0_at'] is not None
    badges = client.get('/users/@me/badges', headers=staff).json()
    assert badges['staff']['p0'] >= 1 and badges['staff']['mine'] >= 1 and badges['restrictions'] == []
    _, user = new_user(appdb)
    assert client.get('/users/@me/badges', headers=user).json() == {
        'reports_unread': 0, 'notices_unacknowledged': 0, 'restrictions': [], 'staff': None}
    assert staff_id


# --- actions (§9.3) --------------------------------------------------------------------------------------------

def test_hide_unhide_remove_restore_and_their_notices(client, appdb):
    owner_id, owner = new_user(appdb)
    created = upload(client, owner)
    _, staff = make_staff(appdb)
    assert act(client, staff, 'hide', 'file', created['id'], status=400)['code'] == 'INVALID_ACTION'  # no rule
    assert act(client, staff, 'hide', 'user', owner_id, status=400, rule='spam')['code'] == 'INVALID_ACTION'
    body = act(client, staff, 'hide', 'file', created['id'], rule='spam', note='staff only', message='Hidden: spam')
    assert body['action']['action'] == 'hide' and body['action']['note'] == 'staff only'
    assert len(body['notice_ids']) == 1
    assert file_row(appdb, created)[:2] == ('hidden', 'spam')
    notices = client.get('/users/@me/warnings', headers=owner).json()
    item = notices['items'][0]
    assert (item['action'], item['rule'], item['rule_text'], item['message']) == (
        'hide', 'spam', 'Spam', 'Hidden: spam')
    assert item['target'] == {'kind': 'file', 'id': created['id'], 'vanity': created['vanity'], 'name': 'm.txt'}
    assert item['appeal']['can_appeal'] is True and notices['unacknowledged'] == 1
    owner_view = client.get('/users/@me/files/' + created['id'], headers=owner).json()['safety']
    assert owner_view['state'] == 'hidden' and owner_view['reason'] == 'spam'
    assert owner_view['notice_id'] == item['id']
    act(client, staff, 'unhide', 'file', created['id'])
    assert file_row(appdb, created)[:2] == ('visible', None)
    act(client, staff, 'remove', 'file', created['id'], rule='copyright')
    assert client.get('/files/' + created['vanity']).json()['reason'] == 'copyright'
    strike = appdb.fetchone("SELECT counts_as_strike FROM user_warnings WHERE user_id = %s AND action = 'remove'",
                            (owner_id,))
    assert strike == (True,)
    act(client, staff, 'restore', 'file', created['id'])
    assert client.get('/files/' + created['vanity']).status_code == 200
    # notify: false sends nothing
    act(client, staff, 'hide', 'file', created['id'], rule='spam', notify=False)
    assert client.get('/users/@me/warnings', headers=owner).json()['count'] == 2
    # acknowledging
    ids = [i['id'] for i in client.get('/users/@me/warnings', headers=owner).json()['items']]
    assert client.post('/users/@me/warnings/acknowledge', headers=owner, json={'ids': ids + ['1']}).json() == {
        'acknowledged': ids}
    assert client.get('/users/@me/warnings?unacknowledged=true', headers=owner).json()['count'] == 0


def test_album_actions(client, appdb):
    owner_id, owner = new_user(appdb)
    created = upload(client, owner)
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [created['id']]}).json()
    _, staff = make_staff(appdb)
    act(client, staff, 'remove', 'album', album['id'], rule='other')
    assert client.get('/albums/' + album['vanity']).json()['reason'] == 'terms'
    owner_album = client.get('/users/@me/albums/' + album['id'], headers=owner).json()
    assert owner_album['safety']['state'] == 'removed' and owner_album['safety']['notice_id']
    act(client, staff, 'restore', 'album', album['id'])
    act(client, staff, 'mark_nsfw', 'album', album['id'], rule='adult_unmarked')
    assert client.get('/albums/' + album['vanity']).json()['nsfw'] is True
    # the owner can't unmark a staff mark
    response = client.request('PATCH', '/users/@me/albums/' + album['id'], headers=owner, json={'nsfw': False})
    assert response.json()['code'] == 'NSFW_LOCKED'
    act(client, staff, 'unmark_nsfw', 'album', album['id'])
    body = client.request('PATCH', '/users/@me/albums/' + album['id'], headers=owner, json={'nsfw': True}).json()
    assert body['nsfw_marked'] is True and body['nsfw'] is True
    assert owner_id


def test_mark_and_unmark_nsfw_override_everything(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner, nsfw=True)
    _, staff = make_staff(appdb)
    act(client, staff, 'unmark_nsfw', 'file', created['id'])
    body = client.get('/users/@me/files/' + created['id'], headers=owner).json()
    assert body['nsfw'] is False and body['safety']['nsfw_source'] == 'moderator' and body['safety']['nsfw_locked']
    act(client, staff, 'mark_nsfw', 'file', created['id'], rule='adult_unmarked')
    assert client.get('/files/' + created['vanity']).json()['nsfw'] is True


def test_delete_keeps_the_blob_for_the_hold(client, appdb, monkeypatch):
    from jobs import gc
    _, owner = new_user(appdb)
    created = upload(client, owner)
    hash_id = hash_of_file(appdb, created)
    _, staff = make_staff(appdb)
    assert act(client, staff, 'delete', 'file', created['id'], rule='malware', hold_days=400,
               status=400)['code'] == 'INVALID_ACTION'
    act(client, staff, 'delete', 'file', created['id'], rule='malware', hold_days=30)
    assert file_row(appdb, created)[3:] == (True, 'moderator')
    hold = appdb.fetchone("SELECT bucket, reason, retain_until > now() + interval '29 days' FROM evidence_holds "
                          'WHERE hash_id = %s', (hash_id,))
    assert hold == ('files', 'moderator', True)
    assert gc.delete_blob(hash_id) == 'held'
    # once the hold is over, the blob goes
    appdb.execute("UPDATE evidence_holds SET retain_until = now() - interval '1 second' WHERE hash_id = %s", (hash_id,))
    from safety import tasks
    assert tasks.retention(appdb.conn)['holds_released'] >= 1
    assert gc.delete_blob(hash_id) == 'deleted'


def test_block_and_unblock_a_hash(client, appdb):
    first_id, first = new_user(appdb)
    second_id, second = new_user(appdb)
    content = nonce() * 8
    a = send(client, first, content, 'a.txt', 'text/plain')
    b = send(client, second, content, 'b.txt', 'text/plain')
    hash_id = hash_of_file(appdb, a)
    _, staff = make_staff(appdb)
    body = act(client, staff, 'block_hash', 'file', a['id'], rule='malware')
    assert len(body['notice_ids']) == 2
    assert appdb.fetchone('SELECT scan_state, scan_reason FROM file_hashes WHERE id = %s', (hash_id,)) == (
        'blocked', 'hash_list')
    assert appdb.fetchone("SELECT reason, source FROM blocked_hashes b JOIN file_hashes h ON h.blake2b = b.blake2b "
                          "AND h.sha1 = b.sha1 AND h.md5 = b.md5 WHERE h.id = %s", (hash_id,)) == ('malware', 'staff')
    assert client.get('/files/' + b['vanity']).status_code == 404
    # re-uploads are refused (400 MALWARE_DETECTED for a malware entry)
    response = client.post('/files', headers=first, files={'file': ('again.txt', content, 'text/plain')})
    assert response.json()['code'] == 'MALWARE_DETECTED'
    act(client, staff, 'unblock_hash', 'hash', hash_id)
    assert appdb.fetchone('SELECT scan_state FROM file_hashes WHERE id = %s', (hash_id,)) == ('passed',)
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind = 'probe' AND payload->>'hash_id' = %s",
                          (str(hash_id),))[0] == 1
    assert client.get('/files/' + b['vanity']).status_code == 200
    assert first_id and second_id


def test_csam_blocks_cant_be_lifted_and_confirm_csam_is_child_safety_only(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner)
    hash_id = hash_of_file(appdb, created)
    _, moderator = make_staff(appdb, 'admin')
    _, guardian = make_staff(appdb, child_safety=True)
    assert act(client, moderator, 'confirm_csam', 'file', created['id'], status=403)['code'] == 'FORBIDDEN'
    body = act(client, guardian, 'confirm_csam', 'file', created['id'])
    assert body['action']['action'] == 'confirm_csam' and body['notice_ids'] == []
    assert appdb.fetchone('SELECT scan_state, scan_reason FROM file_hashes WHERE id = %s', (hash_id,)) == (
        'blocked', 'csam_match')
    assert appdb.fetchone("SELECT reason, source FROM blocked_hashes b JOIN file_hashes h ON h.blake2b = b.blake2b "
                          "AND h.sha1 = b.sha1 AND h.md5 = b.md5 WHERE h.id = %s", (hash_id,)) == ('csam', 'staff')
    assert client.get('/internal/files/' + created['vanity'],
                      headers={'X-Filesgg-Origin-Secret': 'test-origin-secret'}).status_code == 404
    for action in ('unblock_hash', 'block_hash'):
        assert act(client, guardian, action, 'hash', hash_id, status=400, rule='malware')['code'] == 'INVALID_ACTION'
    # no staff URL is ever signed for it
    detail = client.get('/admin/files/' + created['id'], headers=guardian).json()
    assert 'staff_urls' not in detail and detail['scan']['checks']['csam'] == {'result': 'match'}
    # its CSAM suspension can't be lifted through the API
    user_id = appdb.fetchone('SELECT user_id FROM files WHERE id = %s', (int(created['id']),))[0]
    assert act(client, moderator, 'unsuspend_user', 'user', user_id, status=400)['code'] == 'INVALID_ACTION'


def test_clear_flag(client, appdb):
    _, owner = new_user(appdb)
    created = upload(client, owner)
    hash_id = hash_of_file(appdb, created)
    appdb.execute("UPDATE file_hashes SET scan_state = 'flagged', scan_reason = 'pdf_javascript', scan = "
                  "'{\"findings\": [{\"check\": \"pdf\", \"code\": \"pdf_javascript\", \"detail\": \"JS\"}]}' "
                  'WHERE id = %s', (hash_id,))
    _, staff = make_staff(appdb)
    act(client, staff, 'clear_flag', 'hash', hash_id)
    row = appdb.fetchone('SELECT scan_state, scan FROM file_hashes WHERE id = %s', (hash_id,))
    assert row[0] == 'passed' and row[1]['cleared'] == [{'check': 'pdf', 'detail': 'JS'}]
    assert act(client, staff, 'clear_flag', 'hash', hash_id, status=400)['code'] == 'INVALID_ACTION'


def test_restrictions_and_suspensions(client, appdb):
    user_id, user = new_user(appdb)
    _, moderator = make_staff(appdb)
    _, admin = make_staff(appdb, 'admin')
    # moderators: up to 30 days
    assert act(client, moderator, 'restrict_uploads', 'user', user_id, rule='spam', duration=40 * 86400,
               status=403)['code'] == 'FORBIDDEN'
    body = act(client, moderator, 'restrict_uploads', 'user', user_id, rule='spam')
    assert len(body['notice_ids']) == 1
    response = client.post('/files', headers=user, files={'file': ('x.txt', nonce(), 'text/plain')})
    assert response.status_code == 403 and response.json()['code'] == 'UPLOADS_RESTRICTED'
    assert response.json()['until'] > 0
    assert client.post('/uploads', headers=user, json={'filename': 'a.txt', 'size': 3}).json()['code'] == \
        'UPLOADS_RESTRICTED'
    assert client.post('/users/@me/albums', headers=user, json={}).json()['code'] == 'UPLOADS_RESTRICTED'
    assert client.get('/users/@me/limits', headers=user).json()['nsfw_allowed'] is False
    badges = client.get('/users/@me/badges', headers=user).json()
    assert badges['restrictions'][0]['kind'] == 'uploads' and badges['restrictions'][0]['notice_id']
    act(client, moderator, 'unrestrict_uploads', 'user', user_id)
    assert client.post('/files', headers=user, files={'file': ('x.txt', nonce(), 'text/plain')}).status_code == 200
    # suspension: admin only
    assert act(client, moderator, 'suspend_user', 'user', user_id, rule='spam', status=403)['code'] == 'FORBIDDEN'
    act(client, admin, 'suspend_user', 'user', user_id, rule='spam')
    assert_suspended(client, user)
    act(client, admin, 'unsuspend_user', 'user', user_id)
    assert client.get('/users/@me/files', headers=user).status_code == 200


def assert_suspended(client, user):
    assert client.get('/users/@me/files', headers=user).json()['code'] == 'ACCOUNT_SUSPENDED'
    assert client.post('/reports', headers=user, json={'target': {'type': 'bug'}, 'reason': 'bug',
                                                       'details': 'x'}).json()['code'] == 'ACCOUNT_SUSPENDED'
    # what a suspended account can still do
    assert client.get('/users/@me', headers=user).status_code == 200
    assert client.get('/users/@me/badges', headers=user).status_code == 200
    assert client.get('/users/@me/warnings', headers=user).status_code == 200


# --- notices, appeals and strikes (§8, §9.4) ----------------------------------------------------------------------

def test_appeals_need_another_moderator_and_reverse_the_action(client, appdb):
    owner_id, owner = new_user(appdb)
    created = upload(client, owner)
    first_id, first = make_staff(appdb)
    _, second = make_staff(appdb)
    notice_id = act(client, first, 'remove', 'file', created['id'], rule='spam')['notice_ids'][0]
    url = '/users/@me/warnings/{}/appeal'.format(notice_id)
    assert client.post(url, headers=owner, json={}).json()['code'] == 'INVALID_PARAMETERS'
    notice = client.post(url, headers=owner, json={'message': 'It was not spam'}).json()
    assert notice['appeal']['state'] == 'open' and notice['appeal']['can_appeal'] is False
    assert client.post(url, headers=owner, json={'message': 'again'}).json()['code'] == 'APPEAL_NOT_ALLOWED'
    case = appdb.fetchone("SELECT id, priority, needs_second_review FROM moderation_cases WHERE kind = 'appeal' "
                          'AND warning_id = %s', (int(notice_id),))
    assert case[1:] == (2, True)
    second_review = client.get('/admin/cases?needs_second_review=true&kind=appeal&limit=100', headers=second).json()
    assert str(case[0]) in [c['id'] for c in second_review['items']]
    detail = client.get('/admin/cases/{}'.format(case[0]), headers=second).json()
    assert detail['notice']['appeal']['request'] == 'It was not spam' and detail['original_action']['action'] == 'remove'
    # the moderator who removed it can't decide while someone else can
    response = client.post('/admin/cases/{}/appeal'.format(case[0]), headers=first,
                           json={'decision': 'grant', 'message': 'ok'})
    assert response.status_code == 409 and response.json()['code'] == 'SAME_MODERATOR'
    decided = client.post('/admin/cases/{}/appeal'.format(case[0]), headers=second,
                          json={'decision': 'grant', 'message': 'You were right'}).json()
    assert decided['status'] == 'closed' and decided['outcome'] == 'actioned'
    assert file_row(appdb, created)[0] == 'visible'
    notice = client.get('/users/@me/warnings', headers=owner).json()['items'][0]
    assert notice['appeal'] == dict(notice['appeal'], state='granted', message='You were right')
    assert notice['counts_as_strike'] is False
    restore = appdb.fetchone("SELECT reverses_action_id IS NOT NULL FROM moderation_actions WHERE action = 'restore' "
                             'AND file_id = %s', (int(created['id']),))
    assert restore == (True,)
    assert owner_id and first_id


def test_unappealable_notices_and_counter_notices(client, appdb):
    owner_id, owner = new_user(appdb)
    created = upload(client, owner)
    _, staff = make_staff(appdb)
    notice_id = act(client, staff, 'remove', 'file', created['id'], rule='copyright')['notice_ids'][0]
    url = '/users/@me/warnings/{}/appeal'.format(notice_id)
    response = client.post(url, headers=owner, json={'message': 'I own it'})
    assert response.json()['code'] == 'DMCA_FIELDS_REQUIRED'
    counter = {'name': 'Owner', 'address': '1 Road', 'phone': '555', 'email': 'o@example.com',
               'material': 'm.txt at files.gg', 'mistake_statement': True, 'jurisdiction_consent': True,
               'service_consent': True, 'signature': 'Owner'}
    assert client.post(url, headers=owner, json={'message': 'I own it', 'counter_notice': counter}
                       ).json()['appeal']['state'] == 'open'
    assert appdb.fetchone("SELECT appeal_counter_notice->>'signature' FROM user_warnings WHERE id = %s",
                          (int(notice_id),)) == ('Owner',)
    # an automatic "under review" notice can't be appealed
    other = upload(client, owner)
    for _ in range(3):
        _, reporter = new_user(appdb)
        client.post('/reports', headers=dict(reporter, **{'X-Forwarded-For': '10.8.{}.{}'.format(
            *uuid.uuid4().bytes[:2])}), json={'target': {'type': 'file', 'vanity': other['vanity']},
                                              'reason': 'spam'})
    auto = appdb.fetchone("SELECT id FROM user_warnings WHERE user_id = %s AND action = 'auto_hide'", (owner_id,))[0]
    assert client.post('/users/@me/warnings/{}/appeal'.format(auto), headers=owner,
                       json={'message': 'x'}).json()['code'] == 'APPEAL_NOT_ALLOWED'
    assert client.post('/users/@me/warnings/1/appeal', headers=owner, json={'message': 'x'}).json()['code'] == \
        'UNKNOWN_WARNING'


def test_three_strikes_restrict_and_the_next_suspends(client, appdb):
    user_id, user = new_user(appdb)
    _, staff = make_staff(appdb)
    for _ in range(3):
        act(client, staff, 'remove', 'file', upload(client, user)['id'], rule='spam')
    restriction = appdb.fetchone("SELECT kind, ends_at > now() + interval '29 days' FROM user_restrictions "
                                 'WHERE user_id = %s AND lifted_at IS NULL', (user_id,))
    assert restriction == ('uploads', True)
    assert appdb.fetchone("SELECT actor_kind FROM moderation_actions WHERE action = 'restrict_uploads' "
                          'AND user_id = %s', (user_id,)) == ('system',)
    file_id = appdb.fetchone('SELECT id FROM files WHERE user_id = %s AND deleted_at IS NULL ORDER BY id LIMIT 1',
                             (user_id,))[0]
    act(client, staff, 'remove', 'file', file_id, rule='spam')
    assert appdb.fetchone("SELECT count(*) FROM user_restrictions WHERE user_id = %s AND kind = 'suspended'",
                          (user_id,)) == (1,)
    assert_suspended(client, user)
    assert appdb.fetchone("SELECT priority FROM moderation_cases WHERE user_id = %s AND kind = 'user' "
                          "AND status = 'open'", (user_id,)) == (2,)


def test_three_copyright_strikes_suspend_repeat_infringers(client, appdb):
    user_id, user = new_user(appdb)
    _, staff = make_staff(appdb)
    files = [upload(client, user) for _ in range(3)]
    for created in files:
        act(client, staff, 'remove', 'file', created['id'], rule='copyright')
    assert appdb.fetchone("SELECT count(*) FROM user_restrictions WHERE user_id = %s AND kind = 'suspended' "
                          "AND rule = 'copyright'", (user_id,)) == (1,)


# --- bans (§9.3) -----------------------------------------------------------------------------------------------

def test_bans(client, appdb):
    headers = anonymous('10.77.0.1')
    created = send(client, headers, nonce(), 'a.txt', 'text/plain', anonymous_upload=True, ip='10.77.0.1')
    _, moderator = make_staff(appdb)
    _, admin = make_staff(appdb, 'admin')
    assert client.post('/admin/bans', headers=moderator, json={
        'kind': 'fingerprint', 'from': {'file_id': created['id']}, 'rule': 'spam'}).status_code == 403  # no end
    ban = client.post('/admin/bans', headers=moderator, json={
        'kind': 'fingerprint', 'from': {'file_id': created['id']}, 'rule': 'spam', 'duration': 86400})
    assert ban.status_code == 201
    body = ban.json()
    assert body['kind'] == 'fingerprint' and body['source'] == {'file_id': created['id']}
    assert 'fingerprint' not in body and 'abuse_ip_hash' not in body
    response = client.post('/files', headers=dict(headers, **{'X-Forwarded-For': '10.77.0.2'}),
                           files={'file': ('b.txt', nonce(), 'text/plain')}, data={'turnstile_token':
                                                                                    'mock:upload:files.gg'})
    assert response.status_code == 403 and response.json()['code'] == 'BANNED'
    # an IP ban from the same file: another fingerprint on that network is refused too
    ip_ban = client.post('/admin/bans', headers=admin, json={'kind': 'ip', 'from': {'file_id': created['id']},
                                                             'rule': 'spam'}).json()
    response = client.post('/files', headers=anonymous('10.77.0.1'), files={'file': ('c.txt', nonce(), 'text/plain')},
                           data={'turnstile_token': 'mock:upload:files.gg'})
    assert response.json()['code'] == 'BANNED'
    # bans don't stop reports
    assert client.post('/reports/anonymous', headers=dict(anonymous(), **{'X-Forwarded-For': '10.77.0.1'}), json={
        'target': {'type': 'bug'}, 'reason': 'bug', 'details': 'x', 'turnstile_token': 'mock:report:files.gg'}
                       ).status_code == 201
    listing = client.get('/admin/bans', headers=moderator).json()['items']
    assert {body['id'], ip_ban['id']} <= {b['id'] for b in listing}
    assert client.request('DELETE', '/admin/bans/' + ip_ban['id'], headers=moderator).status_code == 403
    assert client.request('DELETE', '/admin/bans/' + ip_ban['id'], headers=admin).json()['lifted_at'] is not None
    # an IP hash older than 30 days can't be used
    appdb.execute('UPDATE files SET uploader_abuse_ip_hash = NULL WHERE id = %s', (int(created['id']),))
    assert client.post('/admin/bans', headers=admin, json={'kind': 'ip', 'from': {'file_id': created['id']},
                                                           'rule': 'spam'}).json()['code'] == 'INVALID_ACTION'


# --- audit, lookup and target detail (§9.5, §9.6) ----------------------------------------------------------------

def test_audit_log_visibility(client, appdb):
    case_id, created, *_ = reported_case(client, appdb)
    _, moderator = make_staff(appdb)
    _, admin = make_staff(appdb, 'admin')
    act(client, moderator, 'hide', 'file', created['id'], rule='spam', case_id=case_id, note='seen')
    rows = client.get('/admin/audit?case_id={}'.format(case_id), headers=moderator).json()['items']
    assert [r['action'] for r in rows] == ['hide'] and rows[0]['note'] == 'seen'
    assert rows[0]['actor']['kind'] == 'staff' and rows[0]['target']['file_id'] == created['id']
    everything = client.get('/admin/audit?action=hide&limit=5', headers=admin).json()
    assert everything['items'] and all(r['action'] == 'hide' for r in everything['items'])
    # child-safety rows are hidden from staff without the capability
    cs_case, *_ = reported_case(client, appdb, reason='csam')
    _, guardian = make_staff(appdb, 'admin', child_safety=True)
    assert any(r['action'] == 'auto_hide' for r in client.get(
        '/admin/audit?case_id={}'.format(cs_case), headers=guardian).json()['items'])
    assert client.get('/admin/audit?case_id={}'.format(cs_case), headers=admin).json()['items'] == []


def test_the_audit_log_is_append_only():
    """The app only ever INSERTs into moderation_actions (§9.5)."""
    import pathlib
    import re
    root = pathlib.Path(__file__).resolve().parents[1]
    for path in list(root.glob('*.py')) + list(root.glob('*/*.py')):
        if 'tests' in path.parts:
            continue
        text = path.read_text()
        assert not re.search(r'(UPDATE|DELETE FROM)\s+moderation_actions', text, re.IGNORECASE), path


def test_lookup_and_target_detail_with_staff_urls(client, appdb):
    from urllib.parse import parse_qs, urlsplit
    from utils.cdn_signing import verify_staff
    owner_id, owner = new_user(appdb)
    created = upload(client, owner, visibility='private')
    staff_id, staff = make_staff(appdb)
    email = appdb.fetchone('SELECT email FROM users WHERE id = %s', (owner_id,))[0]
    found = client.get('/admin/lookup?q=' + created['vanity'], headers=staff).json()
    assert [f['id'] for f in found['files']] == [created['id']]
    assert [u['id'] for u in client.get('/admin/lookup?q=' + email, headers=staff).json()['users']] == [str(owner_id)]
    by_url = client.get('/admin/lookup?q=https://files.gg/' + created['vanity'], headers=staff).json()
    assert by_url['files'][0]['id'] == created['id']
    detail = client.get('/admin/files/' + created['id'], headers=staff).json()
    assert detail['owner']['user_id'] == str(owner_id) and detail['owner']['anonymous'] is False
    assert detail['scan_state'] == 'passed' and detail['same_hash']['count'] == 0
    content = detail['staff_urls']['content']
    query = {k: v[0] for k, v in parse_qs(urlsplit(content).query).items()}
    assert query['staff'] == str(staff_id)
    assert verify_staff(urlsplit(content).path, staff_id, int(created['id']), query['expires'], query['sig'])
    assert appdb.fetchone("SELECT count(*) FROM moderation_actions WHERE action = 'view_content' AND file_id = %s",
                          (int(created['id']),))[0] == 1
    user = client.get('/admin/users/{}'.format(owner_id), headers=staff).json()
    assert user['user']['email'] == email and user['counts']['files'] == 1 and user['files'][0]['id'] == created['id']
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [created['id']]}).json()
    detail = client.get('/admin/albums/' + album['id'], headers=staff).json()
    assert detail['items'][0]['staff_urls']['content'] and detail['moderation_state'] == 'visible'


def test_admin_rescans(client, appdb):
    _, admin = make_staff(appdb, 'admin')
    _, owner = new_user(appdb)
    upload(client, owner)
    response = client.post('/admin/rescans', headers=admin, json={'checks': ['clamav'], 'uploaded_after': 0})
    assert response.status_code == 202 and response.json()['queued'] >= 1
    assert client.post('/admin/rescans', headers=admin, json={'checks': ['nope']}).status_code == 400
    assert client.get('/admin/staff', headers=admin).json()['items']


# --- staff privilege boundaries (§8.4, §9.1, §9.4) ---------------------------------------------------------------

def appeal_case(client, appdb, headers, notice_id, message='Please'):
    response = client.post('/users/@me/warnings/{}/appeal'.format(notice_id), headers=headers, json={'message': message})
    assert response.status_code == 200, response.text
    return appdb.fetchone("SELECT id FROM moderation_cases WHERE kind = 'appeal' AND warning_id = %s",
                          (int(notice_id),))[0]


def decide(client, headers, case_id, decision='grant'):
    return client.post('/admin/cases/{}/appeal'.format(case_id), headers=headers,
                       json={'decision': decision, 'message': 'ok'})


def suspended(appdb, user_id):
    return appdb.fetchone("SELECT count(*) FROM user_restrictions WHERE user_id = %s AND kind = 'suspended' AND "
                          'lifted_at IS NULL', (user_id,))[0] > 0


def test_suspended_staff_get_404_on_admin(client, appdb):
    unknown = client.get('/admin/nope-' + uuid.uuid4().hex)
    moderator_id, moderator = make_staff(appdb)
    admin_id, admin = make_staff(appdb, 'admin')
    _, other_admin = make_staff(appdb, 'admin')
    assert client.get('/admin/summary', headers=moderator).status_code == 200
    for staff_id, headers in ((moderator_id, moderator), (admin_id, admin)):
        act(client, other_admin, 'suspend_user', 'user', staff_id, rule='spam')
        for method, path in (('GET', '/admin/summary'), ('GET', '/admin/cases'), ('GET', '/admin/staff'),
                             ('GET', '/admin/users/{}'.format(staff_id)), ('POST', '/admin/actions')):
            response = client.request(method, path, headers=headers, json={} if method == 'POST' else None)
            assert (response.status_code, response.json()) == (unknown.status_code, unknown.json()), (staff_id, path)
        # what any suspended account can still do
        assert client.get('/users/@me', headers=headers).status_code == 200
    act(client, other_admin, 'unsuspend_user', 'user', moderator_id)
    assert client.get('/admin/summary', headers=moderator).status_code == 200


def test_a_suspended_moderator_cant_appeal_grant_themselves(client, appdb):
    moderator_id, moderator = make_staff(appdb)
    _, admin = make_staff(appdb, 'admin')
    notice_id = act(client, admin, 'suspend_user', 'user', moderator_id, rule='spam')['notice_ids'][0]
    case_id = appeal_case(client, appdb, moderator, notice_id)
    for decision in ('grant', 'deny'):
        response = decide(client, moderator, case_id, decision)
        assert response.status_code == 404 and response.json()['code'] != 'SAME_MODERATOR', response.text
    # nor reverse it directly
    act(client, moderator, 'unsuspend_user', 'user', moderator_id, status=404)
    assert suspended(appdb, moderator_id)
    assert appdb.fetchone('SELECT appeal_state FROM user_warnings WHERE id = %s', (int(notice_id),)) == ('open',)
    # and a staff member who isn't suspended still can't decide (or open) their own appeal
    other_id, other = make_staff(appdb)
    notice_id = act(client, admin, 'restrict_uploads', 'user', other_id, rule='spam')['notice_ids'][0]
    case_id = appeal_case(client, appdb, other, notice_id)
    assert decide(client, other, case_id).json()['code'] == 'FORBIDDEN'
    assert client.get('/admin/cases/{}'.format(case_id), headers=other).json()['code'] == 'FORBIDDEN'
    assert client.post('/admin/cases/{}/claim'.format(case_id), headers=other).json()['code'] == 'FORBIDDEN'
    assert appdb.fetchone("SELECT count(*) FROM user_restrictions WHERE user_id = %s AND kind = 'uploads' AND "
                          'lifted_at IS NULL', (other_id,))[0] == 1


def test_a_moderator_cant_reverse_an_admin_only_suspension(client, appdb):
    user_id, user = new_user(appdb)
    _, moderator = make_staff(appdb)
    _, admin = make_staff(appdb, 'admin')
    _, second_admin = make_staff(appdb, 'admin')
    notice_id = act(client, admin, 'suspend_user', 'user', user_id, rule='spam')['notice_ids'][0]
    case_id = appeal_case(client, appdb, user, notice_id)
    # deciding needs the reversing action's own permission (unsuspend_user: admin only), grant or deny
    for decision in ('grant', 'deny'):
        response = decide(client, moderator, case_id, decision)
        assert (response.status_code, response.json()['code']) == (403, 'FORBIDDEN'), response.text
    assert suspended(appdb, user_id)
    assert appdb.fetchone('SELECT appeal_state FROM user_warnings WHERE id = %s', (int(notice_id),)) == ('open',)
    # the admin who suspended can't decide while another admin can
    assert decide(client, admin, case_id).json()['code'] == 'SAME_MODERATOR'
    decided = decide(client, second_admin, case_id)
    assert decided.status_code == 200 and decided.json()['outcome'] == 'actioned', decided.text
    assert not suspended(appdb, user_id)


def test_same_moderator_counts_only_staff_who_could_have_acted(appdb):
    from safety import moderation
    first_id, _ = make_staff(appdb, 'admin')
    appellant_id, _ = new_user(appdb)
    staff = moderation.Staff(first_id, 'admin', False)
    warning = {'user_id': appellant_id}

    def eligible(action, child_safety=False):
        return moderation.eligible_deciders(appdb.conn, staff, warning, action, child_safety)
    admins, moderators, guardians = eligible('unsuspend_user'), eligible('restore'), eligible('restore', True)
    make_staff(appdb)  # a moderator can't reverse a suspension
    assert (eligible('unsuspend_user'), eligible('restore'), eligible('restore', True)) == (
        admins, moderators + 1, guardians)
    admin_id, _ = make_staff(appdb, 'admin', child_safety=True)
    assert (eligible('unsuspend_user'), eligible('restore'), eligible('restore', True)) == (
        admins + 1, moderators + 2, guardians + 1)
    # suspended staff can't decide anything
    from safety import core
    with appdb.conn.transaction():
        core.restrict(appdb.conn, admin_id, 'suspended', 'spam', notify_owner=False)
    assert (eligible('unsuspend_user'), eligible('restore')) == (admins, moderators + 1)


def test_staff_cant_act_on_their_own_content_or_account(client, appdb):
    staff_id, staff = make_staff(appdb, 'admin')
    _, colleague = make_staff(appdb)
    own = upload(client, staff)
    album = client.post('/users/@me/albums', headers=staff, json={'file_ids': [own['id']]}).json()
    hash_id = hash_of_file(appdb, own)
    for action, kind, target_id, extra in (
            ('hide', 'file', own['id'], {'rule': 'spam'}), ('unhide', 'file', own['id'], {}),
            ('restore', 'file', own['id'], {}), ('unmark_nsfw', 'file', own['id'], {}),
            ('delete', 'file', own['id'], {'rule': 'spam'}), ('hide', 'album', album['id'], {'rule': 'spam'}),
            ('restore', 'album', album['id'], {}), ('clear_flag', 'hash', hash_id, {}),
            ('unblock_hash', 'file', own['id'], {}), ('unrestrict_uploads', 'user', staff_id, {}),
            ('unsuspend_user', 'user', staff_id, {}), ('restrict_uploads', 'user', staff_id, {'rule': 'spam'})):
        body = act(client, staff, action, kind, target_id, status=403, **extra)
        assert body['code'] == 'FORBIDDEN', (action, kind)
    assert file_row(appdb, own)[0] == 'visible' and file_row(appdb, own)[3] is False
    # a colleague's restriction on them can't be lifted by themselves
    act(client, colleague, 'restrict_uploads', 'user', staff_id, rule='spam')
    assert act(client, staff, 'unrestrict_uploads', 'user', staff_id, status=403)['code'] == 'FORBIDDEN'
    # nor can they open, claim, message or close a case about their own content (its reports name reporters)
    _, reporter = new_user(appdb)
    response = client.post('/reports', headers=dict(reporter, **{'X-Forwarded-For': '10.8.{}.{}'.format(
        *uuid.uuid4().bytes[:2])}), json={'target': {'type': 'file', 'vanity': own['vanity']}, 'reason': 'spam'})
    assert response.status_code == 201, response.text
    report_id = response.json()['report']['id']
    case_id = appdb.fetchone('SELECT case_id FROM reports WHERE id = %s', (int(report_id),))[0]
    for method, path, body in (
            ('GET', '/admin/cases/{}'.format(case_id), None),
            ('POST', '/admin/cases/{}/claim'.format(case_id), {}),
            ('POST', '/admin/cases/{}/messages'.format(case_id), {'report_id': report_id, 'body': 'x'}),
            ('POST', '/admin/cases/{}/close'.format(case_id), {'outcome': 'dismissed'}),
            ('PATCH', '/admin/cases/{}'.format(case_id), {'needs_second_review': False})):
        response = client.request(method, path, headers=staff, json=body)
        assert (response.status_code, response.json()['code']) == (403, 'FORBIDDEN'), (path, response.text)
    assert appdb.fetchone('SELECT status FROM moderation_cases WHERE id = %s', (case_id,)) == ('open',)
    # a colleague can
    assert client.get('/admin/cases/{}'.format(case_id), headers=colleague).status_code == 200


def test_admin_payloads_carry_no_owner_grants(client, appdb):
    import json
    from tests.conftest import url_query
    owner_id, owner = new_user(appdb)
    locked = upload(client, owner, password='hunter222')
    private = upload(client, owner, visibility='private')
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [locked['id'], private['id']]}).json()
    patched = client.request('PATCH', '/users/@me/albums/' + album['id'], headers=owner,
                             json={'visibility': 'password', 'password': 'album-pass-9'})
    assert patched.status_code == 200, patched.text
    # the owner's own payloads are signed (the baseline this test guards against)
    assert 'sig=' in client.get('/users/@me/albums/' + album['id'], headers=owner).text
    staff_id, staff = make_staff(appdb)

    def without_staff_urls(value):
        if isinstance(value, dict):
            return {k: without_staff_urls(v) for k, v in value.items() if k != 'staff_urls'}
        if isinstance(value, list):
            return [without_staff_urls(v) for v in value]
        return value

    def staff_url_list(value):
        if isinstance(value, dict):
            found = []
            for k, v in value.items():
                if k == 'staff_urls' and v:
                    found += [v['content']] + list(v['previews'].values())
                else:
                    found += staff_url_list(v)
            return found
        if isinstance(value, list):
            return [u for v in value for u in staff_url_list(v)]
        return []

    responses = [client.get(path, headers=staff) for path in (
        '/admin/files/' + locked['id'], '/admin/files/' + private['id'], '/admin/albums/' + album['id'],
        '/admin/users/{}'.format(owner_id))]
    for response in responses:
        assert response.status_code == 200, response.text
        text = json.dumps(without_staff_urls(response.json()))
        for marker in ('sig=', 'expires=', 'album=', 'staff='):
            assert marker not in text, (response.url, marker)
    detail, album_detail, user = responses[0].json(), responses[2].json(), responses[3].json()
    assert detail['cdn_url'].startswith('https://cdn.files.gg/files/') and url_query(detail['cdn_url']) == {}
    assert {i['id'] for i in user['files']} >= {locked['id'], private['id']}
    # media only through the staff grant
    urls = staff_url_list(detail) + staff_url_list(album_detail)
    assert len(urls) >= 3
    for url in urls:
        query = url_query(url)
        assert query['staff'] == str(staff_id) and 'sig' in query and 'album' not in query, url


def test_user_detail_is_gated_for_child_safety(client, appdb):
    case_id, created, owner, _, _ = reported_case(client, appdb, reason='csam')
    owner_id = appdb.fetchone('SELECT user_id FROM files WHERE id = %s', (int(created['id']),))[0]
    _, moderator = make_staff(appdb)
    _, guardian = make_staff(appdb, child_safety=True)
    assert client.get('/admin/users/{}'.format(owner_id), headers=moderator).json()['code'] == 'FORBIDDEN'
    assert client.get('/admin/users/{}'.format(owner_id), headers=guardian).status_code == 200
    assert case_id and owner


# --- security review leftovers (2026-11-25) --------------------------------------------------------------------

def test_retry_scan_releases_a_scan_failing_hold(client, appdb):
    from safety import scan as scan_rules
    _, owner = new_user(appdb)
    created = upload(client, owner)
    hash_id = hash_of_file(appdb, created)
    _, moderator = make_staff(appdb)
    # not held: nothing to retry
    assert act(client, moderator, 'retry_scan', 'file', created['id'], status=400)['code'] == 'INVALID_ACTION'
    appdb.execute("UPDATE file_hashes SET scan_state = 'pending', scan_failures = 5 WHERE id = %s", (hash_id,))
    scan_rules.hold_failing(appdb.conn, hash_id, 5)
    assert client.get('/admin/files/' + created['id'], headers=moderator).json()['scan_stuck'] is True

    body = act(client, moderator, 'retry_scan', 'file', created['id'])
    assert body['action']['action'] == 'retry_scan'
    assert appdb.fetchone('SELECT scan_state, scan_failures, scan_stuck_at FROM file_hashes WHERE id = %s',
                          (hash_id,)) == ('pending', 0, None)
    assert appdb.fetchone("SELECT count(*) FROM content_flags WHERE hash_id = %s AND reason = 'scan_failing' "
                          'AND resolved_at IS NULL', (hash_id,)) == (0,)
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = %s "
                          'AND done_at IS NULL AND failed_at IS NULL', (str(hash_id),))[0] >= 1
    assert client.get('/admin/files/' + created['id'], headers=moderator).json()['scan_stuck'] is False
    # released: a second retry has nothing to do
    assert act(client, moderator, 'retry_scan', 'hash', hash_id, status=400)['code'] == 'INVALID_ACTION'

    # nor on their own upload
    staff_id, staff = make_staff(appdb)
    own = upload(client, staff)
    own_hash = hash_of_file(appdb, own)
    appdb.execute("UPDATE file_hashes SET scan_state = 'pending' WHERE id = %s", (own_hash,))
    scan_rules.hold_failing(appdb.conn, own_hash, 5)
    assert act(client, staff, 'retry_scan', 'file', own['id'], status=403)['code'] == 'FORBIDDEN'
    assert staff_id


def test_staff_cant_ban_or_unban_their_own_device_or_network(client, appdb):
    staff_id, admin = make_staff(appdb, 'admin')
    _, colleague = make_staff(appdb, 'admin')
    # an anonymous upload from the admin's own device and network
    device = anonymous('10.66.0.1')
    created = send(client, device, nonce(), 'a.txt', 'text/plain', anonymous_upload=True, ip='10.66.0.1')
    from_here = dict(admin, **{'X-Forwarded-For': '10.66.0.1'})
    same_device = dict(admin, **{'X-Fingerprint': device['X-Fingerprint'], 'X-Forwarded-For': '10.67.0.1'})
    elsewhere = dict(admin, **{'X-Forwarded-For': '10.68.0.1'})
    for headers, kind in ((from_here, 'ip'), (same_device, 'fingerprint')):
        response = client.post('/admin/bans', headers=headers, json={'kind': kind, 'from': {'file_id': created['id']},
                                                                     'rule': 'spam'})
        assert (response.status_code, response.json()['code']) == (403, 'FORBIDDEN'), (kind, response.text)

    # the admin's own signed-in upload from that network ties it to them even from elsewhere
    send(client, admin, nonce(), 'mine.txt', 'text/plain', ip='10.66.0.1')
    # a colleague bans that network; the admin can't lift it from there (or elsewhere), the colleague can
    ip_ban = client.post('/admin/bans', headers=dict(colleague, **{'X-Forwarded-For': '10.69.0.1'}), json={
        'kind': 'ip', 'from': {'file_id': created['id']}, 'rule': 'spam'})
    assert ip_ban.status_code == 201, ip_ban.text
    response = client.request('DELETE', '/admin/bans/' + ip_ban.json()['id'], headers=from_here)
    assert (response.status_code, response.json()['code']) == (403, 'FORBIDDEN')
    assert client.request('DELETE', '/admin/bans/' + ip_ban.json()['id'], headers=elsewhere).status_code == 403
    assert client.request('DELETE', '/admin/bans/' + ip_ban.json()['id'],
                          headers=dict(colleague, **{'X-Forwarded-For': '10.69.0.1'})).json()['lifted_at'] is not None

    # a ban taken from their own upload is about themselves
    own = upload(client, admin)
    response = client.post('/admin/bans', headers=elsewhere, json={'kind': 'ip', 'from': {'file_id': own['id']},
                                                                   'rule': 'spam'})
    assert (response.status_code, response.json()['code']) == (403, 'FORBIDDEN')
    assert staff_id


def test_case_lists_and_counts_leave_out_their_own_content(client, appdb):
    staff_id, staff = make_staff(appdb, 'admin', child_safety=True)
    _, colleague = make_staff(appdb, 'admin', child_safety=True)
    own = upload(client, staff)
    _, reporter = new_user(appdb)
    response = client.post('/reports', headers=dict(reporter, **{'X-Forwarded-For': '10.7.{}.{}'.format(
        *uuid.uuid4().bytes[:2])}), json={'target': {'type': 'file', 'vanity': own['vanity']}, 'reason': 'spam'})
    assert response.status_code == 201, response.text
    own_case = str(appdb.fetchone('SELECT case_id FROM reports WHERE id = %s',
                                  (int(response.json()['report']['id']),))[0])
    other_case, *_ = reported_case(client, appdb)

    def listed(headers):
        ids, cursor = set(), None
        while True:
            page = client.get('/admin/cases' + ('?cursor=' + cursor if cursor else ''), headers=headers).json()
            ids |= {c['id'] for c in page['items']}
            cursor = page['next_cursor']
            if not cursor:
                return ids

    mine, theirs = listed(staff), listed(colleague)
    assert own_case not in mine and str(other_case) in mine
    assert own_case in theirs and str(other_case) in theirs
    # the counts follow the list
    assert client.get('/admin/summary', headers=colleague).json()['unassigned'] == \
        client.get('/admin/summary', headers=staff).json()['unassigned'] + 1
    assert client.get('/users/@me/badges', headers=colleague).json()['staff']['open'] == \
        client.get('/users/@me/badges', headers=staff).json()['staff']['open'] + 1
    assert staff_id
