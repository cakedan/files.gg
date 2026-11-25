"""Milestone 4 scanning (contract §2-§5): publication gating per state, the strict order, failing
closed and the sweeper, the stand-in matcher and §3.6, PDQ near-match holds, NSFW, ClamAV,
archives, Office, PDFs, polyglots, Web Risk, rescans and upload-time refusals. Scans run for real
(the sandboxed child, clamd from docker-compose.test.yml); only Web Risk and the NSFW score (in
some tests) are stood in."""

import base64
import time

import pytest

from tests.conftest import EVIDENCE_BUCKET, EVIDENCE_PRIVATE_KEY, s3_client, s3_object
from tests.m4 import (
    EICAR, ELF, ORIGIN, PUA_STRING, anonymous, appdb, broken_png, docx, docx_remote_template, docx_with_vba,  # noqa: F401
    fixture_bytes, gif_html, hash_id_of, hash_row, lookup, new_user, nonce, nsfw_score, owner_file, pdf,  # noqa: F401
    pattern, pdf_embedded_exe, pdf_escaped_javascript_in_object_stream, pdf_javascript, pdf_launch, pdf_open_at_fit, png,
    rar5_header_encrypted,
    run_scan, send, xlsx_with_xlm, zip_aes, zip_declaring, zip_of, zipcrypto,
)

pytestmark = pytest.mark.scan_gating


def jobs_of(db, kind, hash_id):
    return db.fetchone("SELECT count(*) FROM jobs WHERE kind = %s AND payload->>'hash_id' = %s",
                       (kind, str(hash_id)))[0]


def findings(row):
    return [f['code'] for f in row['scan']['findings']]


# --- gating and the strict order (§2.1, §2.4) --------------------------------------------------------------

def test_a_new_hash_is_pending_until_its_scan_passes(client, appdb):
    _, owner = new_user(appdb)
    created = send(client, owner, png(), 'a.png', 'image/png')
    hash_id = hash_id_of(appdb, created)
    assert created['safety'] == {'state': 'pending', 'reason': None, 'notice_id': None, 'nsfw_source': None,
                                 'nsfw_locked': False, 'nsfw_review': 'none'}
    # scan queued (deduplicated, 10 attempts, the scan queue); nothing reads the blob yet
    assert appdb.fetchone("SELECT queue, max_attempts FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = %s",
                          (str(hash_id),)) == ('scan', 10)
    assert jobs_of(appdb, 'probe', hash_id) == 0
    from jobs import media as media_jobs
    assert media_jobs.probe(hash_id) is None  # the second guard
    # every surface: public API 409, lookup `pending`, the owner's "Checking"
    response = client.get('/files/' + created['vanity'])
    assert response.status_code == 409 and response.json() == {
        'code': 'FILE_PENDING', 'message': 'This file is still being checked', 'status': 409, 'retry_after': 5}
    body = lookup(client, created).json()
    assert body['safety'] == {'state': 'pending', 'reason': None} and body['serve_inline'] is True
    assert owner_file(client, owner, created).json()['safety']['state'] == 'pending'

    row = run_scan(appdb, created)
    assert row['scan_state'] == 'passed' and row['scan_reason'] is None
    checks = row['scan']['checks']
    assert checks['hash_list'] == {'result': 'clean'}
    assert checks['csam'] == {'result': 'clean', 'matcher': 'standin', 'images': 1, 'unmatchable': 0}
    assert checks['pdq'] == {'result': 'clean', 'frames': 1}
    assert checks['nsfw']['result'] == 'done' and checks['nsfw']['classified'] == 1
    assert checks['clamav']['result'] == 'clean' and checks['clamav']['engine']
    assert checks['web_risk']['result'] == 'skipped'
    assert row['scan']['kind'] == 'image' and row['scan']['sniffed'] == 'image/png'
    assert appdb.fetchone('SELECT count(*) FROM file_hash_pdq WHERE hash_id = %s', (hash_id,))[0] == 1
    # strict order: probe only now
    assert jobs_of(appdb, 'probe', hash_id) == 1
    assert client.get('/files/' + created['vanity']).status_code == 200
    assert lookup(client, created).json()['safety'] == {'state': 'ok', 'reason': None}
    # a duplicate of a passed hash is public at once and queues nothing
    again = send(client, owner, s3_object('files/{}'.format(hash_id)), 'b.png', 'image/png')
    assert again['safety']['state'] == 'ok' and jobs_of(appdb, 'scan', hash_id) == 1


def test_effective_states_per_surface(client, appdb):
    """§14.3, through the API: what the lookup, the public API and the owner see per state."""
    _, owner = new_user(appdb)
    cases = [
        ('pending', 'visible', 'link', 'pending', 409, 'pending'),
        ('passed', 'hidden', 'link', 'hidden', 410, 'hidden'),
        ('flagged', 'visible', 'link', 'ok', 200, 'flagged'),
        ('held', 'visible', 'link', 'hidden', 410, 'hidden'),
        ('blocked', 'removed', 'link', 'blocked', 404, 'blocked'),
        ('passed', 'removed', 'link', 'removed', 410, 'removed'),
    ]
    for scan_state, moderation, visibility, lookup_state, status, owner_state in cases:
        created = send(client, owner, nonce() * 10, 'n.txt', 'text/plain')
        reason = {'flagged': 'web_risk', 'held': 'pdq_near_match', 'blocked': 'malware'}.get(scan_state)
        appdb.execute('UPDATE file_hashes SET scan_state = %s, scan_reason = %s WHERE id = %s',
                      (scan_state, reason, hash_id_of(appdb, created)))
        appdb.execute("UPDATE files SET moderation_state = %s, moderation_rule = 'malware' WHERE id = %s",
                      (moderation, int(created['id'])))
        assert lookup(client, created).json()['safety']['state'] == lookup_state, scan_state
        response = client.get('/files/' + created['vanity'])
        assert response.status_code == status, (scan_state, moderation)
        assert owner_file(client, owner, created).json()['safety']['state'] == owner_state
    # hidden is `review` publicly; removed by a malware rule is `malware`
    assert response.json() == {'code': 'FILE_REMOVED', 'message': 'This file is unavailable', 'status': 410,
                               'reason': 'malware'}
    # a private pending file is missing to everyone but its owner
    secret = send(client, owner, nonce() * 10, 's.txt', 'text/plain', visibility='private')
    assert client.get('/files/' + secret['vanity']).status_code == 404


# --- failing closed and the sweeper (§2.6) ---------------------------------------------------------------------

def test_an_unavailable_matcher_keeps_the_hash_pending(client, appdb, monkeypatch):
    from safety import scan
    from safety.matchers import MatcherUnavailable
    _, owner = new_user(appdb)
    created = send(client, owner, png(), 'u.png', 'image/png')
    hash_id = hash_id_of(appdb, created)
    monkeypatch.setenv('STANDIN_MODE', 'unavailable')
    with pytest.raises(MatcherUnavailable):
        scan.scan(hash_id)
    assert hash_row(appdb, hash_id)['scan_state'] == 'pending'
    assert lookup(client, created).json()['safety']['state'] == 'pending'
    assert client.get('/files/' + created['vanity']).status_code == 409


def test_an_unreachable_clamd_keeps_the_hash_pending(client, appdb, monkeypatch):
    from safety import scan
    from safety.clamav import ClamAVUnavailable
    _, owner = new_user(appdb)
    created = send(client, owner, nonce() * 20, 'c.txt', 'text/plain')
    monkeypatch.setenv('CLAMAV_PORT', '1')
    with pytest.raises(ClamAVUnavailable):
        scan.scan(hash_id_of(appdb, created))
    assert hash_row(appdb, hash_id_of(appdb, created))['scan_state'] == 'pending'


def test_the_queue_retries_ten_times_and_the_sweeper_takes_over(client, appdb, monkeypatch):
    import jobs
    import jobs.tasks  # noqa: F401
    from safety import scan
    _, owner = new_user(appdb)
    created = send(client, owner, png(), 's.png', 'image/png')
    hash_id = hash_id_of(appdb, created)
    monkeypatch.setenv('STANDIN_MODE', 'unavailable')
    job_id = appdb.fetchone("SELECT id FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = %s",
                            (str(hash_id),))[0]
    appdb.execute('UPDATE jobs SET attempts = 9 WHERE id = %s', (job_id,))
    appdb.execute("UPDATE jobs SET run_at = now() + interval '1 hour' WHERE queue = 'scan' AND id <> %s "
                  'AND done_at IS NULL', (job_id,))
    try:
        assert jobs.run_next('w', queues=['scan'], conn=appdb.conn) == 'failed'
    finally:
        appdb.execute("UPDATE jobs SET run_at = now() WHERE queue = 'scan' AND done_at IS NULL AND failed_at IS NULL")
    assert hash_row(appdb, hash_id)['scan_state'] == 'pending'
    # the sweeper re-queues it (and only once)
    assert scan.sweep(appdb.conn) >= 1
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = %s AND "
                          'done_at IS NULL AND failed_at IS NULL', (str(hash_id),))[0] == 1
    scan.sweep(appdb.conn)
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = %s AND "
                          'done_at IS NULL AND failed_at IS NULL', (str(hash_id),))[0] == 1
    monkeypatch.setenv('STANDIN_MODE', 'list')
    assert run_scan(appdb, created)['scan_state'] == 'passed'


def test_stalled_scans_are_counted(client, appdb, monkeypatch):
    from safety import admin, moderation
    staff = moderation.Staff(0, 'admin', True)
    _, owner = new_user(appdb)
    send(client, owner, nonce() * 10, 'x.txt', 'text/plain')
    # nothing is 10 minutes old here; with SCAN_STALLED_AFTER=0 every pending hash counts
    monkeypatch.setenv('SCAN_STALLED_AFTER', '0')
    assert admin.summary(appdb.conn, staff)['scans_stalled'] >= 1
    monkeypatch.setenv('SCAN_STALLED_AFTER', '600')
    stalled = appdb.fetchone("SELECT count(*) FROM file_hashes WHERE scan_state = 'pending' AND id < %s",
                             (((int(time.time() * 1000) - 1550102400000 - 600000) << 22),))[0]
    assert admin.summary(appdb.conn, staff)['scans_stalled'] == stalled


# --- the stand-in matcher and §3.6 -----------------------------------------------------------------------------

def unseal(value):
    from nacl.public import SealedBox
    return SealedBox(EVIDENCE_PRIVATE_KEY).decrypt(base64.b64decode(value)).decode()


def test_a_standin_match_blocks_preserves_evidence_and_restricts_uploaders(client, appdb):
    user_id, owner = new_user(appdb)
    # the owner's other content, hidden pending child-safety review
    other = send(client, owner, png(), 'other.png', 'image/png')
    run_scan(appdb, other)
    created = send(client, owner, fixture_bytes('match.png'), 'match.png', 'image/png', ip='198.51.100.7')
    hash_id = hash_id_of(appdb, created)
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'blocked' and row['scan_reason'] == 'csam_match'
    # no vendor details in the scan record
    assert row['scan']['checks']['csam'] == {'result': 'match', 'matcher': 'standin'}
    # looks exactly like a missing file everywhere
    assert lookup(client, created).status_code == 404
    assert client.get('/files/' + created['vanity']).json()['code'] == 'UNKNOWN_FILE'
    # remembered with its PDQ, a PDQ sweep queued
    entry = appdb.fetchone("SELECT b.id, b.reason, b.source FROM blocked_hashes b JOIN file_hashes h ON h.blake2b = b.blake2b "
                           "AND h.sha1 = b.sha1 AND h.md5 = b.md5 WHERE h.id = %s", (hash_id,))
    assert entry[1:] == ('csam', 'standin')
    assert appdb.fetchone('SELECT count(*) FROM blocked_hash_pdq WHERE blocked_hash_id = %s', (entry[0],))[0] == 1
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind = 'pdq_sweep' AND payload->>'blocked_hash_id' = %s",
                          (str(entry[0]),))[0] == 1
    # evidence: copied with Object Lock, then the files bucket no longer has it
    case = appdb.fetchone("SELECT id, kind, priority, child_safety FROM moderation_cases WHERE hash_id = %s "
                          "AND status = 'open'", (hash_id,))
    assert case[1:] == ('hash', 0, True)
    key = 'csam/{}/{}'.format(case[0], hash_id)
    head = s3_client().head_object(Bucket=EVIDENCE_BUCKET, Key=key)
    assert head['ObjectLockMode'] == 'COMPLIANCE' and head['ObjectLockRetainUntilDate'].year >= 2026
    assert s3_object('files/{}'.format(hash_id)) is None
    hold = appdb.fetchone("SELECT bucket, storage_key, reason, snapshot FROM evidence_holds WHERE hash_id = %s",
                          (hash_id,))
    assert hold[:3] == ('evidence', key, 'csam')
    snapshot = hold[3]
    assert snapshot['matcher'] == 'standin' and snapshot['vendor_refs'][0].startswith('standin-0-')
    record = next(f for f in snapshot['files'] if f['id'] == created['id'])
    assert record['user_id'] == str(user_id) and unseal(record['ip_sealed']) == '198.51.100.7'
    from safety.ip import abuse_ip_hash
    assert record['abuse_ip_hash'] == abuse_ip_hash('198.51.100.7', 'test-abuse-hash-secret').hex()
    # the uploader: suspended (no notice), IP banned, other content hidden
    restriction = appdb.fetchone("SELECT kind, rule, ends_at, warning_id FROM user_restrictions WHERE user_id = %s",
                                 (user_id,))
    assert restriction == ('suspended', 'csam', None, None)
    assert appdb.fetchone('SELECT count(*) FROM user_warnings WHERE user_id = %s', (user_id,))[0] == 0
    assert appdb.fetchone('SELECT count(*) FROM bans WHERE abuse_ip_hash = %s AND rule = %s',
                          (abuse_ip_hash('198.51.100.7', 'test-abuse-hash-secret'), 'csam'))[0] == 1
    assert appdb.fetchone('SELECT moderation_state, moderation_rule FROM files WHERE id = %s',
                          (int(other['id']),)) == ('hidden', 'csam')
    # the owner sees only "blocked" with FILE_BLOCKED, no notice; the account is suspended
    body = client.get('/users/@me/badges', headers=owner).json()
    assert body['restrictions'] == [{'kind': 'suspended', 'until': None, 'notice_id': None}]
    assert client.get('/users/@me/files', headers=owner).json()['code'] == 'ACCOUNT_SUSPENDED'
    # recorded, all on the case
    actions = [r[0] for r in appdb.fetchall('SELECT action FROM moderation_actions WHERE case_id = %s ORDER BY id',
                                            (case[0],))]
    for action in ('csam_match', 'block', 'preserve_evidence', 'suspend_user', 'ban', 'hide'):
        assert action in actions
    assert appdb.fetchone('SELECT bool_and(child_safety) FROM moderation_actions WHERE case_id = %s', (case[0],))[0]
    # a re-upload is refused, stores nothing, and bans that uploader too
    guest = anonymous('198.51.100.9')
    response = client.post('/files', headers=guest, files={'file': ('again.png', fixture_bytes('match.png'),
                                                                          'image/png')},
                           data={'turnstile_token': 'mock:upload:files.gg'})
    assert response.status_code == 403 and response.json()['code'] == 'FILE_BLOCKED'
    from utils.tokens import GuestToken
    guest_id = int(GuestToken.deconstruct(guest['Authorization'].removeprefix('Guest ')))
    assert appdb.fetchone("SELECT count(*) FROM bans WHERE guest_id = %s AND rule = 'csam'", (guest_id,))[0] == 1
    # idempotent: running §3.6 again changes nothing
    from safety import csam
    csam.handle_match(hash_id, source='standin')
    assert appdb.fetchone('SELECT count(*) FROM evidence_holds WHERE hash_id = %s', (hash_id,))[0] == 1
    assert appdb.fetchone('SELECT count(*) FROM user_restrictions WHERE user_id = %s', (user_id,))[0] == 1


def test_the_half_size_jpeg_matches_through_pdq_and_clean_passes(client, appdb):
    _, owner = new_user(appdb)
    small = send(client, owner, fixture_bytes('match-small.jpg'), 'small.jpg', 'image/jpeg')
    assert run_scan(appdb, small)['scan_reason'] == 'csam_match'
    _, other = new_user(appdb)  # the first owner is suspended now
    clean = send(client, other, fixture_bytes('clean.png'), 'clean.png', 'image/png')
    row = run_scan(appdb, clean)
    assert row['scan_state'] == 'passed'
    # grey has PDQ quality 0: stored, never matched
    assert appdb.fetchone('SELECT quality FROM file_hash_pdq WHERE hash_id = %s', (hash_id_of(appdb, clean),))[0] < 50


def test_anonymous_matches_are_rejected_after_the_scan(client, appdb):
    headers = anonymous('198.51.100.20')
    content = zip_of([('n.txt', nonce()), ('match.png', fixture_bytes('match.png'))])
    created = send(client, headers, content, 'm.zip', 'application/zip', anonymous_upload=True)
    assert run_scan(appdb, created)['scan_reason'] == 'csam_match'
    response = client.get('/users/@me/files/' + created['id'], headers=headers)
    assert response.status_code == 410 and response.json()['reason'] == 'FILE_BLOCKED'
    from utils.tokens import GuestToken
    guest_id = int(GuestToken.deconstruct(headers['Authorization'].removeprefix('Guest ')))
    assert appdb.fetchone("SELECT count(*) FROM bans WHERE guest_id = %s AND rule = 'csam'", (guest_id,))[0] == 1
    # that guest and network can't upload any more
    response = client.post('/files', headers=headers, files={'file': ('x.txt', nonce(), 'text/plain')},
                           data={'turnstile_token': 'mock:upload:files.gg'})
    assert response.json()['code'] == 'BANNED'


# --- PDQ near-matches (§3.5) --------------------------------------------------------------------------------------

def block_pdq_of(db, image_bytes, reason):
    """A blocked_hashes entry (a different triple) whose PDQ is this image's."""
    import io

    import numpy as np
    import pdqhash
    from PIL import Image
    from safety.pdq import to_bits
    with Image.open(io.BytesIO(image_bytes)) as image:
        array = np.ascontiguousarray(np.asarray(image.convert('RGB'), dtype=np.uint8))
    vector, quality = pdqhash.compute(array)
    hex_hash = '{:064x}'.format(int(''.join('1' if b else '0' for b in vector), 2))
    entry = db.fetchone("INSERT INTO blocked_hashes (blake2b, sha1, md5, size, reason, source) VALUES "
                        "(%s, %s, %s, 1, %s, 'staff') RETURNING id", (nonce().decode(), nonce().decode(),
                                                                       nonce().decode(), reason))[0]
    db.execute('INSERT INTO blocked_hash_pdq (blocked_hash_id, frame, pdq, quality) VALUES (%s, 0, %s::bit(256), %s)',
               (entry, to_bits(hex_hash), quality))
    return entry


def test_a_pdq_near_match_holds_the_file_for_review(client, appdb):
    from PIL import Image
    import io
    _, owner = new_user(appdb)
    image = pattern()
    block_pdq_of(appdb, image, 'moderator')
    # the same picture re-encoded: a different hash, a near PDQ
    out = io.BytesIO()
    Image.open(io.BytesIO(image)).convert('RGB').save(out, 'JPEG', quality=85)
    created = send(client, owner, out.getvalue(), 'near.jpg', 'image/jpeg')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'held' and row['scan_reason'] == 'pdq_near_match'
    assert lookup(client, created).json()['safety'] == {'state': 'hidden', 'reason': 'review'}
    assert owner_file(client, owner, created).json()['safety']['state'] == 'hidden'
    assert jobs_of(appdb, 'probe', hash_id_of(appdb, created)) == 0
    case = appdb.fetchone("SELECT priority, child_safety FROM moderation_cases WHERE hash_id = %s AND status = 'open'",
                          (hash_id_of(appdb, created),))
    assert case == (1, False)


def test_a_near_match_of_csam_is_p0_child_safety_and_never_a_match(client, appdb):
    import io
    from PIL import Image
    _, owner = new_user(appdb)
    image = pattern()
    block_pdq_of(appdb, image, 'csam')
    out = io.BytesIO()
    Image.open(io.BytesIO(image)).convert('RGB').save(out, 'JPEG', quality=80)
    created = send(client, owner, out.getvalue(), 'near.jpg', 'image/jpeg')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'held'
    case = appdb.fetchone("SELECT priority, child_safety FROM moderation_cases WHERE hash_id = %s AND status = 'open'",
                          (hash_id_of(appdb, created),))
    assert case == (0, True)
    assert appdb.fetchone("SELECT count(*) FROM evidence_holds WHERE hash_id = %s",
                          (hash_id_of(appdb, created),))[0] == 0


def test_a_new_blocked_pdq_holds_published_lookalikes(client, appdb):
    import io
    from PIL import Image
    from safety import scan
    _, owner = new_user(appdb)
    image = pattern()
    out = io.BytesIO()
    Image.open(io.BytesIO(image)).convert('RGB').save(out, 'JPEG', quality=88)
    created = send(client, owner, out.getvalue(), 'pub.jpg', 'image/jpeg')
    assert run_scan(appdb, created)['scan_state'] == 'passed'
    entry = block_pdq_of(appdb, image, 'ncii')
    assert hash_id_of(appdb, created) in scan.pdq_sweep(entry)
    assert hash_row(appdb, hash_id_of(appdb, created))['scan_state'] == 'held'
    assert appdb.fetchone("SELECT count(*) FROM moderation_actions WHERE action = 'pdq_sweep_hit' AND hash_id = %s",
                          (hash_id_of(appdb, created),))[0] == 1


# --- NSFW (§4) --------------------------------------------------------------------------------------------------

def test_the_real_model_scores_a_non_adult_image_low(client, appdb):
    from media import nsfw
    from safety.settings import safety_settings
    # the checked-in artefacts match their pinned hashes
    assert nsfw.sha256_file(nsfw.os.path.join(nsfw.MODELS_DIR, nsfw.MODEL_FILE)) == nsfw.MODEL_SHA256
    assert nsfw.sha256_file(nsfw.os.path.join(nsfw.MODELS_DIR, nsfw.CONFIG_FILE)) == nsfw.CONFIG_SHA256
    _, owner = new_user(appdb)
    created = send(client, owner, png(640, 480), 'landscape.png', 'image/png')
    row = run_scan(appdb, created)
    check = row['scan']['checks']['nsfw']
    assert check['model'] == 'marqo-vit-tiny-384@' + nsfw.MODEL_SHA256[:8] == nsfw.model_id()
    assert check['classified'] == 1 and 0 <= check['score'] < safety_settings().nsfw_threshold
    assert row['nsfw_auto'] is False and abs(row['nsfw_score'] - check['score']) < 1e-3


def test_nsfw_auto_marks_signed_in_files_and_rejects_anonymous_ones(client, appdb, nsfw_score):
    nsfw_score(0.92)
    user_id, owner = new_user(appdb)
    created = send(client, owner, png(), 'adult.png', 'image/png')
    row = run_scan(appdb, created)
    assert row['nsfw_auto'] is True and row['nsfw_score'] == pytest.approx(0.92)
    body = owner_file(client, owner, created).json()
    assert body['nsfw'] is True and body['safety']['nsfw_source'] == 'auto' and body['safety']['nsfw_locked'] is True
    assert client.get('/files/' + created['vanity']).json()['nsfw'] is True
    # the uploader can't unmark it (NSFW_LOCKED), but can ask for review once
    response = client.request('PATCH', '/users/@me/files/' + created['id'], headers=owner, json={'nsfw': False})
    assert response.json()['code'] == 'NSFW_LOCKED'
    assert client.post('/users/@me/files/{}/nsfw-review'.format(created['id']), headers=owner,
                       json={'message': 'It is a painting'}).status_code == 202
    assert client.post('/users/@me/files/{}/nsfw-review'.format(created['id']), headers=owner,
                       json={}).json()['code'] == 'APPEAL_NOT_ALLOWED'
    assert owner_file(client, owner, created).json()['safety']['nsfw_review'] == 'open'
    assert appdb.fetchone("SELECT c.priority FROM content_flags f JOIN moderation_cases c ON c.id = f.case_id "
                          "WHERE f.file_id = %s AND f.source = 'owner'", (int(created['id']),))[0] == 3

    # anonymous: rejected after the fact, 410 UPLOAD_REJECTED for 24 h
    headers = anonymous()
    anon = send(client, headers, png(), 'a.png', 'image/png', anonymous_upload=True)
    run_scan(appdb, anon)
    response = client.get('/users/@me/files/' + anon['id'], headers=headers)
    assert response.status_code == 410 and response.json()['code'] == 'UPLOAD_REJECTED'
    assert response.json()['reason'] == 'NSFW_REQUIRES_ACCOUNT'
    appdb.execute("UPDATE files SET deleted_at = now() - interval '25 hours' WHERE id = %s", (int(anon['id']),))
    assert client.get('/users/@me/files/' + anon['id'], headers=headers).json()['code'] == 'UNKNOWN_FILE'
    # de-duplicating onto that NSFW hash anonymously is refused at once; signed in it's accepted
    response = client.post('/files', headers=anonymous(), files={'file': ('a.png', s3_object(
        'files/{}'.format(hash_id_of(appdb, created))), 'image/png')}, data={'turnstile_token': 'mock:upload:files.gg'})
    assert response.json()['code'] == 'NSFW_REQUIRES_ACCOUNT'
    assert user_id


def test_three_unmarked_adult_files_give_a_notice_with_a_strike(client, appdb, nsfw_score):
    nsfw_score(0.97)
    user_id, owner = new_user(appdb)
    for _ in range(3):
        run_scan(appdb, send(client, owner, png(), 'x.png', 'image/png'))
    notice = appdb.fetchone("SELECT rule, appealable, counts_as_strike FROM user_warnings WHERE user_id = %s",
                            (user_id,))
    assert notice == ('adult_unmarked', True, True)
    # a marked one doesn't count
    run_scan(appdb, send(client, owner, png(), 'y.png', 'image/png', nsfw=True))
    assert appdb.fetchone('SELECT count(*) FROM user_warnings WHERE user_id = %s', (user_id,))[0] == 1


def test_nsfw_marks_and_the_upload_parameter(client, appdb):
    _, owner = new_user(appdb)
    response = client.post('/files', headers=anonymous(), files={'file': ('a.txt', b'x', 'text/plain')},
                           data={'nsfw': 'true', 'turnstile_token': 'mock:upload:files.gg'})
    assert response.status_code == 403 and response.json()['code'] == 'NSFW_REQUIRES_ACCOUNT'
    assert client.post('/uploads', headers=anonymous(), json={'filename': 'a.txt', 'size': 3, 'nsfw': True,
                                                              'turnstile_token': 'mock:upload:files.gg'}
                       ).json()['code'] == 'NSFW_REQUIRES_ACCOUNT'
    created = send(client, owner, nonce(), 'm.txt', 'text/plain', nsfw=True)
    assert created['nsfw'] is True and created['safety']['nsfw_source'] == 'uploader'
    assert created['safety']['nsfw_locked'] is False
    body = client.request('PATCH', '/users/@me/files/' + created['id'], headers=owner, json={'nsfw': False}).json()
    assert body['nsfw'] is False and body['safety']['nsfw_source'] is None
    other = send(client, owner, nonce(), 'o.txt', 'text/plain')
    body = client.post('/users/@me/files/nsfw', headers=owner,
                       json={'file_ids': [created['id'], other['id'], '1'], 'nsfw': True}).json()
    assert [i['nsfw'] for i in body['items']] == [True, True] and body['skipped'] == ['1']


# --- ClamAV (§5.2) ------------------------------------------------------------------------------------------------

def test_eicar_blocks_as_malware(client, appdb):
    user_id, owner = new_user(appdb)
    created = send(client, owner, EICAR, 'eicar.txt', 'text/plain')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'blocked' and row['scan_reason'] == 'malware'
    assert row['scan']['checks']['clamav']['signature'] == 'Filesgg.Test.EICAR-1.UNOFFICIAL'
    body = owner_file(client, owner, created).json()
    assert body['safety']['state'] == 'blocked' and body['safety']['reason'] == 'malware'
    assert body['safety']['notice_id'] is not None
    notice = appdb.fetchone('SELECT action, rule, appealable, counts_as_strike FROM user_warnings WHERE id = %s',
                            (int(body['safety']['notice_id']),))
    assert notice == ('scan_block', 'malware', True, False)
    assert lookup(client, created).json()['safety'] == {'state': 'blocked', 'reason': None}
    # known malware is refused at upload: 400 MALWARE_DETECTED, nothing stored
    response = client.post('/files', headers=owner, files={'file': ('again.txt', EICAR, 'text/plain')})
    assert response.status_code == 400 and response.json()['code'] == 'MALWARE_DETECTED'
    # anonymous: rejected after the fact (or at once, the hash being known)
    headers = anonymous()
    response = client.post('/files', headers=headers, files={'file': ('e.txt', EICAR, 'text/plain')},
                           data={'turnstile_token': 'mock:upload:files.gg'})
    assert response.json()['code'] == 'MALWARE_DETECTED'
    assert user_id


def test_eicar_uploaded_anonymously_is_rejected_after_the_scan(client, appdb):
    headers = anonymous()
    # a fresh hash: the test database matches EICAR by its exact hash, so it goes inside a zip with a
    # unique second entry (clamd scans archives too)
    content = zip_of([('eicar.com.txt', EICAR), ('n.txt', nonce())])
    created = send(client, headers, content, 'e.zip', 'application/zip', anonymous_upload=True)
    row = run_scan(appdb, created)
    assert row['scan_reason'] == 'malware'
    response = client.get('/users/@me/files/' + created['id'], headers=headers)
    assert response.json() == {'code': 'UPLOAD_REJECTED', 'message': "This upload wasn't accepted", 'status': 410,
                               'reason': 'MALWARE_DETECTED'}


def test_a_pua_signature_flags_with_a_warning(client, appdb):
    _, owner = new_user(appdb)
    created = send(client, owner, PUA_STRING + b' ' + nonce(), 'tool.txt', 'text/plain')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'flagged' and row['scan_reason'] == 'unwanted_software'
    assert row['scan']['warnings'] == ['unwanted_software']
    public = client.get('/files/' + created['vanity']).json()
    assert public['warnings'] == ['unwanted_software']
    assert lookup(client, created).json()['safety']['state'] == 'ok'
    assert owner_file(client, owner, created).json()['safety'] == dict(
        owner_file(client, owner, created).json()['safety'], state='flagged', reason='unwanted_software')
    case = appdb.fetchone("SELECT priority FROM moderation_cases WHERE hash_id = %s AND status = 'open'",
                          (hash_id_of(appdb, created),))
    assert case == (2,)


# --- archives (§5.3) -----------------------------------------------------------------------------------------------

@pytest.mark.parametrize('name, content, reason', [
    ('exe.zip', lambda: zip_of([('setup.exe', nonce()), ('readme.txt', b'hi')]), 'blocked_type'),
    ('deep.zip', lambda: zip_of([('game/bin/tool.EXE', nonce())]), 'blocked_type'),
    ('app.zip', lambda: zip_of([('Foo.app/Contents/Info.plist', nonce())]), 'blocked_type'),
    ('elf.zip', lambda: zip_of([('readme.txt', ELF + nonce())]), 'blocked_type'),
    ('nested.zip', lambda: zip_of([('inner.zip', zip_of([('payload.scr', nonce())]))]), 'blocked_type'),
    ('bomb.zip', lambda: zip_declaring(30 * 1024 ** 3), 'archive_bomb'),
])
def test_archive_checks_block(client, appdb, name, content, reason):
    _, owner = new_user(appdb)
    created = send(client, owner, content(), name, 'application/zip')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'blocked' and reason in findings(row), row['scan']
    assert row['scan_reason'] in ('blocked_type', 'archive_bomb', 'malware')


def test_ten_thousand_entries_are_scanned_partially(client, appdb, monkeypatch):
    monkeypatch.setenv('ARCHIVE_MAX_ENTRIES', '50')
    _, owner = new_user(appdb)
    created = send(client, owner, zip_of([('f{}.txt'.format(i), b'') for i in range(60)] + [('n', nonce())]),
                   'many.zip', 'application/zip')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'passed'
    assert row['scan']['checks']['archive']['partial'] is True
    assert row['scan']['warnings'] == ['archive_partially_scanned']


def test_10001_entries_with_the_real_cap(client, appdb):
    _, owner = new_user(appdb)
    created = send(client, owner, zip_of([('e{}'.format(i), b'') for i in range(10001)] + [('n', nonce())]),
                   'big.zip', 'application/zip')
    row = run_scan(appdb, created)
    assert row['scan']['checks']['archive']['partial'] is True and row['scan']['checks']['archive']['entries'] == 10000


def nested_zip(depth, leaf):
    data = zip_of([('leaf.txt', leaf)])
    for level in range(depth - 1):
        data = zip_of([('level{}.zip'.format(level), data)])
    return data


def test_clamd_limits_scan_partially_with_a_warning(client, appdb, tmp_path):
    """Nesting past clamd's MaxRecursion (10): with AlertExceedsMax it's reported, not `OK`, and the
    scan treats it as a partial scan (the archive_partially_scanned warning), not unwanted software."""
    from safety.clamav import ClamAV
    from safety.settings import safety_settings
    content = nested_zip(12, nonce())
    _, owner = new_user(appdb)
    created = send(client, owner, content, 'deep.zip', 'application/zip')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'passed' and row['scan_reason'] is None, row['scan']
    clamav = row['scan']['checks']['clamav']
    assert clamav['result'] == 'clean' and clamav['partial'] is True
    assert clamav['signature'].startswith('Heuristics.Limits.Exceeded.MaxRecursion')
    # the archive check itself (nesting depth 3) didn't stop early: the warning is clamd's
    assert row['scan']['checks']['archive']['partial'] is False
    assert row['scan']['findings'] == [] and row['scan']['warnings'] == ['archive_partially_scanned']
    assert client.get('/files/' + created['vanity']).json()['warnings'] == ['archive_partially_scanned']
    assert appdb.fetchone("SELECT count(*) FROM moderation_cases WHERE hash_id = %s",
                          (hash_id_of(appdb, created),))[0] == 0
    # nesting within the limit is plain `OK`
    shallow = tmp_path / 'shallow.zip'
    shallow.write_bytes(nested_zip(8, nonce()))
    assert ClamAV.from_settings(safety_settings()).scan_file(str(shallow)) is None


def test_malware_next_to_content_over_clamd_limits_still_blocks(client, appdb):
    _, owner = new_user(appdb)
    content = zip_of([('deep.zip', nested_zip(12, nonce())), ('eicar.com.txt', EICAR)])
    row = run_scan(appdb, send(client, owner, content, 'mixed.zip', 'application/zip'))
    assert row['scan_state'] == 'blocked' and row['scan_reason'] == 'malware'
    assert row['scan']['checks']['clamav']['result'] == 'detected'


@pytest.mark.parametrize('build', [zipcrypto, zip_aes])
def test_encrypted_zips_signed_in_and_anonymous(client, appdb, build):
    _, owner = new_user(appdb)
    content = build([('secret.txt', nonce() * 4), ('payload.exe', b'x')])
    created = send(client, owner, content, 'enc.zip', 'application/zip')
    row = run_scan(appdb, created)
    assert row['scan']['checks']['archive']['encrypted'] is True
    # encrypted entries' names are still checked
    assert row['scan_state'] == 'blocked'
    content = build([('secret.txt', nonce() * 4)])
    created = send(client, owner, content, 'enc.zip', 'application/zip')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'passed' and row['scan']['warnings'] == ['encrypted_archive']
    assert client.get('/files/' + created['vanity']).json()['warnings'] == ['encrypted_archive']
    # the same bytes anonymously: refused at once (a known encrypted archive)
    response = client.post('/files', headers=anonymous(), files={'file': ('e.zip', content, 'application/zip')},
                           data={'turnstile_token': 'mock:upload:files.gg'})
    assert response.status_code == 403 and response.json()['code'] == 'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT'
    # a new encrypted archive anonymously: rejected after the scan
    headers = anonymous()
    anon = send(client, headers, build([('s.txt', nonce())]), 'x.zip', 'application/zip', anonymous_upload=True)
    run_scan(appdb, anon)
    assert client.get('/users/@me/files/' + anon['id'], headers=headers).json()['reason'] == \
        'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT'


def test_rar5_header_encryption_is_detected():
    import os
    import tempfile
    from media import scanning
    assert scanning.rar_headers_encrypted(rar5_header_encrypted())
    assert not scanning.rar_headers_encrypted(b'Rar!\x1a\x07\x01\x00' + b'\x00' * 4 + b'\x05\x01\x00\x00\x00\x00')
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'a.rar')
        with open(path, 'wb') as handle:
            handle.write(rar5_header_encrypted())
        state = scanning.ArchiveState({'max_entries': 10, 'max_depth': 3, 'max_unpacked': 1 << 40, 'max_ratio': 1000,
                                       'max_images': 0, 'max_image_bytes': 0}, 100)
        scanning.inspect_archive(path, state)
        assert state.encrypted is True


def test_images_inside_archives_are_matched(client, appdb):
    _, owner = new_user(appdb)
    content = zip_of([('photos/a.png', png()), ('photos/match.png', fixture_bytes('match.png'))])
    created = send(client, owner, content, 'photos.zip', 'application/zip')
    row = run_scan(appdb, created)
    assert row['scan_reason'] == 'csam_match'
    assert row['scan']['checks'].get('nsfw', {}).get('result') in (None, 'skipped')


# --- Office (§5.4), PDFs and polyglots (§5.5) -----------------------------------------------------------------------

DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


@pytest.mark.parametrize('name, build, mimetype', [
    ('macro.docx', docx_with_vba, DOCX),
    ('xlm.xlsx', xlsx_with_xlm, XLSX),
    ('template.docx', docx_remote_template, DOCX),
])
def test_office_checks_block(client, appdb, name, build, mimetype):
    _, owner = new_user(appdb)
    created = send(client, owner, build(), name, mimetype)
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'blocked' and 'blocked_type' in findings(row), row['scan']


def test_a_plain_docx_passes(client, appdb):
    _, owner = new_user(appdb)
    row = run_scan(appdb, send(client, owner, docx(), 'plain.docx', DOCX))
    assert row['scan_state'] == 'passed' and row['scan']['checks']['office'] == {'result': 'clean'}


@pytest.mark.parametrize('build, state, reason', [
    (pdf_javascript, 'flagged', 'pdf_javascript'),
    # an /OpenAction that only opens at a page and zoom (every LibreOffice export) is harmless
    (pdf_open_at_fit, 'passed', None),
    (pdf_escaped_javascript_in_object_stream, 'flagged', 'pdf_javascript'),
    (pdf_launch, 'blocked', 'pdf_dangerous'),
    (pdf_embedded_exe, 'blocked', 'pdf_dangerous'),
])
def test_pdf_checks(client, appdb, build, state, reason):
    _, owner = new_user(appdb)
    created = send(client, owner, build(), 'doc.pdf', 'application/pdf')
    row = run_scan(appdb, created)
    assert row['scan_state'] == state, row['scan']
    assert (reason in findings(row)) if reason else not findings(row), row['scan']


def test_a_plain_pdf_passes_and_its_pages_are_matched(client, appdb):
    _, owner = new_user(appdb)
    row = run_scan(appdb, send(client, owner, pdf(), 'plain.pdf', 'application/pdf'))
    assert row['scan_state'] == 'passed'
    assert row['scan']['checks']['csam']['images'] == 1 and row['scan']['kind'] == 'pdf'


def test_polyglots(client, appdb):
    _, owner = new_user(appdb)
    image = png()
    flagged = send(client, owner, image + zip_of([('notes.txt', nonce())]), 'p.png', 'image/png')
    row = run_scan(appdb, flagged)
    assert row['scan_state'] == 'flagged' and row['scan_reason'] == 'polyglot_archive'
    blocked = send(client, owner, png() + zip_of([('setup.exe', nonce())]), 'q.png', 'image/png')
    row = run_scan(appdb, blocked)
    assert row['scan_state'] == 'blocked' and 'polyglot_archive' in findings(row)
    gif = send(client, owner, gif_html(), 'g.gif', 'image/gif')
    assert run_scan(appdb, gif)['scan_state'] == 'passed'


def test_an_undecodable_image_is_served_as_a_download(client, appdb):
    _, owner = new_user(appdb)
    created = send(client, owner, broken_png(), 'broken.png', 'image/png')
    row = run_scan(appdb, created)
    assert row['scan']['decodable'] is False and row['serve_inline'] is False
    body = lookup(client, created).json()
    assert body['serve_inline'] is False and body['file']['kind'] == 'file'


def test_a_blocked_sniffed_type_is_refused_at_upload(client, appdb):
    _, owner = new_user(appdb)
    # a shell script named notes.txt: libmagic says text/x-shellscript... the executable sniffer
    # catches ELF and PE; libmagic adds the rest of BLOCKED_MIMETYPES
    response = client.post('/files', headers=owner, files={'file': ('notes.txt', ELF + nonce(), 'text/plain')})
    assert response.json()['code'] == 'FILE_TYPE_NOT_ALLOWED'
    from safety.uploads import sniff_blocked
    assert sniff_blocked(b'\xb8' + nonce() * 10) is False  # libmagic's COM guess isn't trusted


# --- Web Risk (§5.7) -------------------------------------------------------------------------------------------

def test_web_risk_flags_links_and_payloads_list_only_fresh_matches(client, appdb, monkeypatch, tmp_path):
    standin = tmp_path / 'webrisk.txt'
    standin.write_text('https://malware.example.test/download\n')
    monkeypatch.setenv('WEB_RISK_STANDIN_FILE', str(standin))
    _, owner = new_user(appdb)
    text = 'see https://malware.example.test/download and https://safe.example.test/ok {}'.format(nonce().decode())
    created = send(client, owner, text.encode(), 'links.txt', 'text/plain')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'flagged' and row['scan_reason'] == 'web_risk'
    match = row['scan']['link_warnings'][0]
    assert match['url'] == 'https://malware.example.test/download' and match['threat_types'] == ['MALWARE']
    assert match['expires_at'] > time.time()
    public = client.get('/files/' + created['vanity']).json()
    assert public['link_warnings'] == ['https://malware.example.test/download']
    assert public['link_warning_types'] == {'https://malware.example.test/download': ['MALWARE']}
    assert appdb.fetchone("SELECT priority FROM moderation_cases WHERE hash_id = %s AND status = 'open'",
                          (hash_id_of(appdb, created),)) == (1,)
    # an expired match drops out of every payload, and the rescan scheduler re-checks it
    appdb.execute("UPDATE file_hashes SET scan = jsonb_set(scan, '{link_warnings,0,expires_at}', '1'), "
                  'next_rescan_at = now() - interval \'1 minute\' WHERE id = %s', (hash_id_of(appdb, created),))
    assert client.get('/files/' + created['vanity']).json()['link_warnings'] == []
    from safety import scan
    scan.schedule_rescans(appdb.conn)
    checks = appdb.fetchone("SELECT payload->'checks' FROM jobs WHERE kind = 'rescan' AND payload->>'hash_id' = %s",
                            (str(hash_id_of(appdb, created)),))[0]
    assert 'web_risk' in checks and 'clamav' in checks
    scan.rescan(hash_id_of(appdb, created), checks)
    assert client.get('/files/' + created['vanity']).json()['link_warnings'] == [
        'https://malware.example.test/download']


def test_web_risk_fails_open(client, appdb):
    _, owner = new_user(appdb)
    created = send(client, owner, 'https://example.test/x {}'.format(nonce().decode()).encode(), 'l.txt',
                   'text/plain')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'passed'
    assert row['scan']['checks']['web_risk'] == {'result': 'skipped', 'error': 'unconfigured', 'urls': 1}


def test_album_text_is_checked_without_gating(client, appdb, monkeypatch, tmp_path):
    standin = tmp_path / 'webrisk.txt'
    standin.write_text('https://phish.example.test/login\n')
    monkeypatch.setenv('WEB_RISK_STANDIN_FILE', str(standin))
    _, owner = new_user(appdb)
    created = send(client, owner, nonce(), 'a.txt', 'text/plain')
    run_scan(appdb, created)
    album = client.post('/users/@me/albums', headers=owner, json={
        'title': 'Trip', 'description': 'More at https://phish.example.test/login', 'file_ids': [created['id']]}).json()
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind = 'album_text_scan' AND payload->>'album_id' = %s",
                          (album['id'],))[0] == 1
    assert client.get('/albums/' + album['vanity']).status_code == 200  # never gated
    from safety import scan
    assert [m['url'] for m in scan.album_text_scan(int(album['id']))] == ['https://phish.example.test/login']
    body = client.get('/users/@me/albums/' + album['id'], headers=owner).json()
    assert body['link_warnings'] == ['https://phish.example.test/login']
    assert client.get('/albums/' + album['vanity']).json()['link_warnings'] == ['https://phish.example.test/login']


# --- rescans (§2.7) -------------------------------------------------------------------------------------------------

def test_rescans_only_escalate_and_ignore_cleared_findings(client, appdb, monkeypatch, tmp_path):
    from safety import scan
    _, owner = new_user(appdb)
    created = send(client, owner, b'notes ' + nonce(), 'n.txt', 'text/plain')
    hash_id = hash_id_of(appdb, created)
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'passed'
    # scheduled: non-media kinds at +24 h
    next_at = appdb.fetchone('SELECT next_rescan_at - scanned_at FROM file_hashes WHERE id = %s', (hash_id,))[0]
    assert abs(next_at.total_seconds() - 86400) < 60
    # a clean rescan changes nothing and moves the schedule to +7 d
    appdb.execute("UPDATE file_hashes SET next_rescan_at = now() - interval '1 minute' WHERE id = %s", (hash_id,))
    assert scan.rescan(hash_id, ['clamav']) == 'passed'
    next_at = appdb.fetchone("SELECT next_rescan_at - to_timestamp((scan->>'first_at')::bigint) FROM file_hashes "
                             'WHERE id = %s', (hash_id,))[0]
    assert abs(next_at.total_seconds() - 7 * 86400) < 120
    # a finding staff cleared is ignored by rescans
    standin = tmp_path / 'webrisk.txt'
    standin.write_text('https://bad.example.test/\n')
    monkeypatch.setenv('WEB_RISK_STANDIN_FILE', str(standin))
    linked = send(client, owner, 'https://bad.example.test/ {}'.format(nonce().decode()).encode(), 'l.txt',
                  'text/plain')
    assert run_scan(appdb, linked)['scan_state'] == 'flagged'
    linked_hash = hash_id_of(appdb, linked)
    appdb.execute("UPDATE file_hashes SET scan_state = 'passed', scan_reason = NULL, scan = jsonb_set(scan, "
                  "'{cleared}', '[{\"check\": \"web_risk\", \"detail\": \"https://bad.example.test/\"}]') WHERE id = %s",
                  (linked_hash,))
    assert scan.rescan(linked_hash, ['web_risk']) == 'passed'
    # a pending hash is never rescanned (rescans never return anything to pending either)
    pending = send(client, owner, nonce(), 'p.txt', 'text/plain')
    assert scan.rescan(hash_id_of(appdb, pending), ['clamav']) == 'pending'


def test_a_rescan_that_finds_malware_blocks_and_notifies(client, appdb, monkeypatch):
    from safety import scan
    user_id, owner = new_user(appdb)
    created = send(client, owner, zip_of([('e.txt', EICAR), ('n', nonce())]), 'later.zip', 'application/zip')
    hash_id = hash_id_of(appdb, created)
    # the first scan "missed" it (signatures arrive later): pretend it passed
    appdb.execute("UPDATE file_hashes SET scan_state = 'passed', scan = '{\"version\": 1, \"kind\": \"archive\"}' "
                  'WHERE id = %s', (hash_id,))
    assert scan.rescan(hash_id, ['clamav']) == 'blocked'
    row = hash_row(appdb, hash_id)
    assert row['scan_reason'] == 'malware'
    assert appdb.fetchone("SELECT count(*) FROM moderation_cases WHERE hash_id = %s AND status = 'open'",
                          (hash_id,))[0] == 1
    assert appdb.fetchone("SELECT action FROM user_warnings WHERE user_id = %s", (user_id,)) == ('scan_block',)


def test_image_rescans_rematch(client, appdb):
    from safety import scan
    _, owner = new_user(appdb)
    created = send(client, owner, png(), 'r.png', 'image/png')
    hash_id = hash_id_of(appdb, created)
    run_scan(appdb, created)
    next_at = appdb.fetchone('SELECT next_rescan_at - scanned_at FROM file_hashes WHERE id = %s', (hash_id,))[0]
    assert abs(next_at.total_seconds() - 7 * 86400) < 60
    appdb.execute("UPDATE file_hashes SET next_rescan_at = now() - interval '1 minute' WHERE id = %s", (hash_id,))
    scan.schedule_rescans(appdb.conn)
    checks = appdb.fetchone("SELECT payload->'checks' FROM jobs WHERE kind = 'rescan' AND payload->>'hash_id' = %s",
                            (str(hash_id),))[0]
    assert checks == ['csam', 'pdq']
    assert scan.rescan(hash_id, checks) == 'passed'
    assert appdb.fetchone('SELECT next_rescan_at FROM file_hashes WHERE id = %s', (hash_id,))[0] is None


# --- lookups and albums (§6.3, §6.4) -------------------------------------------------------------------------------

def test_album_lookups_show_only_ok_items_and_pending_counts(client, appdb):
    _, owner = new_user(appdb)
    ready = send(client, owner, nonce(), 'ready.txt', 'text/plain')
    run_scan(appdb, ready)
    waiting = send(client, owner, nonce(), 'waiting.txt', 'text/plain')
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [waiting['id']]}).json()
    body = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert body['safety'] == {'state': 'ok', 'reason': None} and body['pending_count'] == 1
    assert body['album']['items'] == [] and body['items_storage'] == {}
    public = client.get('/albums/' + album['vanity']).json()
    assert public['items'] == [] and public['pending_count'] == 1
    owner_body = client.get('/users/@me/albums/' + album['id'], headers=owner).json()
    assert owner_body['items'][0]['shown'] is False and owner_body['items'][0]['safety']['state'] == 'pending'
    client.post('/users/@me/albums/{}/files'.format(album['id']), headers=owner, json={'file_ids': [ready['id']]})
    body = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert [i['id'] for i in body['album']['items']] == [ready['id']] and list(body['items_storage']) == [ready['id']]
    # the file lookup's albums leave out hidden albums
    assert lookup(client, ready).json()['albums'][0]['vanity'] == album['vanity']
    appdb.execute("UPDATE albums SET moderation_state = 'hidden' WHERE id = %s", (int(album['id']),))
    assert lookup(client, ready).json()['albums'] == []
    body = client.get('/internal/albums/' + album['vanity'], headers=ORIGIN).json()
    assert body['safety'] == {'state': 'hidden', 'reason': 'review'} and body['album']['items'] == []
    assert client.get('/albums/' + album['vanity']).json() == {
        'code': 'ALBUM_REMOVED', 'message': 'This album is unavailable', 'status': 410, 'reason': 'review'}


# --- more kinds, sizes and paths ---------------------------------------------------------------------------------

def test_video_frames_and_animated_frames_are_matched_and_classified(client, appdb):
    from tests.m3 import gif, mp4
    _, owner = new_user(appdb)
    row = run_scan(appdb, send(client, owner, mp4(seconds=2), 'clip.mp4', 'video/mp4'))
    assert row['scan_state'] == 'passed' and row['scan']['kind'] == 'video'
    # 1 frame per 10 s, at least 8; 8 of them classified
    assert row['scan']['checks']['csam']['images'] == 8 and row['scan']['checks']['nsfw']['classified'] == 8
    row = run_scan(appdb, send(client, owner, gif(frames=12), 'loop.gif', 'image/gif'))
    assert row['scan']['kind'] == 'animated' and row['scan']['checks']['csam']['images'] == 8


def test_audio_cover_art_is_matched(client, appdb):
    from tests.m3 import mp3
    _, owner = new_user(appdb)
    row = run_scan(appdb, send(client, owner, mp3(seconds=1, art=True), 'song.mp3', 'audio/mpeg'))
    assert row['scan']['kind'] == 'audio' and row['scan']['checks']['csam']['images'] == 1
    # audio gets no scheduled rescan
    assert appdb.fetchone("SELECT next_rescan_at FROM file_hashes WHERE scan->>'kind' = 'audio' ORDER BY id DESC "
                          'LIMIT 1') == (None,)


def test_too_large_to_scan(client, appdb, monkeypatch):
    monkeypatch.setenv('CLAMAV_MAX_BYTES', '10')
    _, owner = new_user(appdb)
    row = run_scan(appdb, send(client, owner, nonce() * 4, 'big.txt', 'text/plain'))
    assert row['scan_state'] == 'passed' and row['scan']['warnings'] == ['too_large_to_scan']
    assert row['scan']['checks']['clamav'] == {'result': 'skipped', 'reason': 'too_large'}
    # media just skip it
    row = run_scan(appdb, send(client, owner, png(), 'p.png', 'image/png'))
    assert row['scan']['warnings'] == []


def test_a_rescan_block_clears_the_albums_collage(client, appdb):
    from safety import scan
    _, owner = new_user(appdb)
    created = send(client, owner, zip_of([('e.txt', EICAR), ('n', nonce())]), 'c.zip', 'application/zip')
    hash_id = hash_id_of(appdb, created)
    appdb.execute("UPDATE file_hashes SET scan_state = 'passed', scan = '{\"version\": 1, \"kind\": \"archive\"}' "
                  'WHERE id = %s', (hash_id,))
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [created['id']]}).json()
    appdb.execute("UPDATE albums SET collage_key = 'derived/albums/x/collage-1.webp', collage_version = 1 "
                  'WHERE id = %s', (int(album['id']),))
    assert scan.rescan(hash_id, ['clamav']) == 'blocked'
    assert appdb.fetchone('SELECT collage_key FROM albums WHERE id = %s', (int(album['id']),)) == (None,)
    assert appdb.fetchone("SELECT payload->>'old_key' FROM jobs WHERE kind = 'album_collage' AND "
                          "payload->>'album_id' = %s AND done_at IS NULL", (album['id'],)) == (
        'derived/albums/x/collage-1.webp',)


def test_chunked_uploads_of_known_content_fail_at_finalize(client, appdb):
    from jobs.finalize import finalize
    _, owner = new_user(appdb)
    known = send(client, owner, zip_of([('e.txt', EICAR), ('n', nonce())]), 'k.zip', 'application/zip')
    assert run_scan(appdb, known)['scan_reason'] == 'malware'
    data = zip_of([('e.txt', EICAR), ('n', nonce())])
    session = client.post('/uploads', headers=owner, json={'filename': 'k.zip', 'size': len(data),
                                                           'mimetype': 'application/zip'}).json()
    client.request('PUT', '/uploads/{}/chunks/0'.format(session['upload_id']), headers=owner, content=data)
    client.post('/uploads/{}/complete'.format(session['upload_id']), headers=owner)
    file_id = finalize(int(session['upload_id']))
    # a new hash: finalized and queued for its scan
    hash_id = appdb.fetchone('SELECT hash_id FROM files WHERE id = %s', (file_id,))[0]
    assert jobs_of(appdb, 'scan', hash_id) == 1 and jobs_of(appdb, 'probe', hash_id) == 0
    # the same bytes again once they're known to be malware: the session fails with the code
    from safety import scan
    scan.scan(hash_id)
    session = client.post('/uploads', headers=owner, json={'filename': 'k2.zip', 'size': len(data),
                                                           'mimetype': 'application/zip'}).json()
    client.request('PUT', '/uploads/{}/chunks/0'.format(session['upload_id']), headers=owner, content=data)
    client.post('/uploads/{}/complete'.format(session['upload_id']), headers=owner)
    assert finalize(int(session['upload_id'])) is None
    body = client.get('/uploads/' + session['upload_id'], headers=owner).json()
    assert body['status'] == 'failed' and body['error'] == 'MALWARE_DETECTED'
    # a refused upload stores nothing: the completed staging object is gone at once
    assert s3_object('staging/' + session['upload_id']) is None


# --- hardening: §3.6 retries, failing scans, "couldn't check" isn't clean -------------------------------------

def runnable_jobs(db, kind, hash_id):
    return db.fetchall("SELECT id FROM jobs WHERE kind = %s AND payload->>'hash_id' = %s AND done_at IS NULL "
                       'AND failed_at IS NULL', (kind, str(hash_id)))


def run_csam_job(db, hash_id):
    import jobs
    # only this hash's job is runnable (other tests may have left theirs)
    db.execute("UPDATE jobs SET run_at = now() + interval '1 hour' WHERE kind = 'csam_handle' AND "
               "payload->>'hash_id' <> %s AND done_at IS NULL AND failed_at IS NULL", (str(hash_id),))
    db.execute("UPDATE jobs SET run_at = now() WHERE kind = 'csam_handle' AND payload->>'hash_id' = %s",
               (str(hash_id),))
    return jobs.run_next('w-csam', queues=['scan'], kinds=['csam_handle'], conn=db.conn)


def match_variant():
    """match.png's pixels in new bytes: the stand-in matches it (by PDQ), the hash is new."""
    import io
    from PIL import Image, PngImagePlugin
    info = PngImagePlugin.PngInfo()
    info.add_text('nonce', nonce().decode())
    out = io.BytesIO()
    with Image.open(io.BytesIO(fixture_bytes('match.png'))) as image:
        image.save(out, 'PNG', pnginfo=info)
    return out.getvalue()


def assert_csam_handled(db, hash_id):
    case = db.fetchone("SELECT id, priority, child_safety FROM moderation_cases WHERE hash_id = %s AND status = 'open'",
                       (hash_id,))
    assert case[1:] == (0, True)
    hold = db.fetchone("SELECT bucket, storage_key FROM evidence_holds WHERE hash_id = %s AND reason = 'csam'",
                       (hash_id,))
    assert hold == ('evidence', 'csam/{}/{}'.format(case[0], hash_id))
    assert s3_client().head_object(Bucket=EVIDENCE_BUCKET, Key=hold[1])['ObjectLockMode'] == 'COMPLIANCE'
    assert s3_object('files/{}'.format(hash_id)) is None
    actions = {r[0] for r in db.fetchall('SELECT action FROM moderation_actions WHERE case_id = %s', (case[0],))}
    assert {'csam_match', 'block', 'preserve_evidence'} <= actions


def failing_once(monkeypatch, module, name):
    original = getattr(module, name)
    calls = []

    def wrapper(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError('evidence bucket unreachable')
        return original(*args, **kwargs)
    monkeypatch.setattr(module, name, wrapper)
    return calls


def test_csam_handling_that_fails_is_retried_by_its_job(client, appdb, monkeypatch):
    from safety import csam
    user_id, owner = new_user(appdb)
    created = send(client, owner, match_variant(), 'm.png', 'image/png', ip='198.51.100.41')
    hash_id = hash_id_of(appdb, created)
    calls = failing_once(monkeypatch, csam, 'preserve')
    row = run_scan(appdb, created)
    # the match is committed (never displayable), with its csam_handle job in the same transaction
    assert row['scan_state'] == 'blocked' and row['scan_reason'] == 'csam_match' and len(calls) == 1
    assert appdb.fetchone('SELECT count(*) FROM evidence_holds WHERE hash_id = %s', (hash_id,))[0] == 0
    assert s3_object('files/{}'.format(hash_id)) is not None
    assert len(runnable_jobs(appdb, 'csam_handle', hash_id)) == 1
    payload = appdb.fetchone("SELECT payload, queue FROM jobs WHERE kind = 'csam_handle' AND payload->>'hash_id' = %s",
                             (str(hash_id),))
    assert payload[1] == 'scan' and payload[0]['outcome']['matcher'] == 'standin' and payload[0]['outcome']['hits']
    # the scan itself is done: running it again changes nothing
    from safety import scan
    assert scan.scan(hash_id) == 'blocked'
    # the job finishes every step
    assert run_csam_job(appdb, hash_id) == 'done'
    assert_csam_handled(appdb, hash_id)
    snapshot = appdb.fetchone('SELECT snapshot FROM evidence_holds WHERE hash_id = %s', (hash_id,))[0]
    assert snapshot['matcher'] == 'standin' and snapshot['vendor_refs']
    assert appdb.fetchone("SELECT kind, rule FROM user_restrictions WHERE user_id = %s", (user_id,)) == \
        ('suspended', 'csam')
    assert runnable_jobs(appdb, 'csam_handle', hash_id) == []


def test_csam_handling_that_succeeds_at_once_closes_its_job(client, appdb):
    _, owner = new_user(appdb)
    created = send(client, owner, match_variant(), 'm.png', 'image/png', ip='198.51.100.42')
    hash_id = hash_id_of(appdb, created)
    run_scan(appdb, created)
    assert_csam_handled(appdb, hash_id)
    assert runnable_jobs(appdb, 'csam_handle', hash_id) == []
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind = 'csam_handle' AND payload->>'hash_id' = %s "
                          'AND done_at IS NOT NULL', (str(hash_id),))[0] == 1


def test_a_rescan_match_whose_handling_fails_is_retried(client, appdb, monkeypatch):
    from safety import csam, scan
    from safety.matchers import MatchOutcome
    user_id, owner = new_user(appdb)
    created = send(client, owner, match_variant(), 'm.png', 'image/png', ip='198.51.100.43')
    hash_id = hash_id_of(appdb, created)

    class Nothing:
        def match(self, images, blake2b=None):
            return MatchOutcome(matcher='standin')
    original = scan.get_matcher
    monkeypatch.setattr(scan, 'get_matcher', lambda: Nothing())
    # held when an earlier test already blocked match.png (a PDQ near match), else passed
    assert run_scan(appdb, created)['scan_state'] in ('passed', 'held')
    # the list gained it since: the rescan matches, and §3.6 fails the first time
    monkeypatch.setattr(scan, 'get_matcher', original)
    failing_once(monkeypatch, csam, 'restrict_uploaders')
    assert scan.rescan(hash_id, ['csam', 'pdq']) == 'blocked'
    assert len(runnable_jobs(appdb, 'csam_handle', hash_id)) == 1
    assert run_csam_job(appdb, hash_id) == 'done'
    assert_csam_handled(appdb, hash_id)
    assert appdb.fetchone('SELECT kind, rule FROM user_restrictions WHERE user_id = %s', (user_id,)) == \
        ('suspended', 'csam')


def test_delete_blob_never_removes_an_unpreserved_match(client, appdb):
    from jobs import gc
    _, owner = new_user(appdb)
    created = send(client, owner, png(), 'c.png', 'image/png')
    hash_id = hash_id_of(appdb, created)
    run_scan(appdb, created)
    # matched, but §3.6 never got as far as the evidence (and its files were deleted meanwhile)
    appdb.execute("UPDATE file_hashes SET scan_state = 'blocked', scan_reason = 'csam_match' WHERE id = %s",
                  (hash_id,))
    appdb.execute('UPDATE files SET deleted_at = now() WHERE hash_id = %s', (hash_id,))
    assert gc.delete_blob(hash_id) == 'unpreserved'
    assert s3_object('files/{}'.format(hash_id)) is not None
    assert appdb.fetchone('SELECT count(*) FROM file_hashes WHERE id = %s', (hash_id,))[0] == 1
    # and §3.6 is queued to preserve it (once)
    assert len(runnable_jobs(appdb, 'csam_handle', hash_id)) == 1
    assert gc.delete_blob(hash_id) == 'unpreserved'
    assert len(runnable_jobs(appdb, 'csam_handle', hash_id)) == 1
    # a released files-bucket hold isn't evidence either
    row = appdb.fetchone('SELECT blake2b, sha1, md5 FROM file_hashes WHERE id = %s', (hash_id,))
    appdb.execute("INSERT INTO evidence_holds (hash_id, blake2b, sha1, md5, bucket, storage_key, reason, retain_until, "
                  "released_at) VALUES (%s, %s, %s, %s, 'files', %s, 'moderator', now() + interval '1 day', now())",
                  (hash_id, row[0], row[1], row[2], 'files/{}'.format(hash_id)))
    assert gc.delete_blob(hash_id) == 'unpreserved'
    # preserved in the evidence bucket: the files bucket copy can go
    appdb.execute("INSERT INTO evidence_holds (hash_id, blake2b, sha1, md5, bucket, storage_key, reason, retain_until) "
                  "VALUES (%s, %s, %s, %s, 'evidence', %s, 'csam', now() + interval '1 day')",
                  (hash_id, row[0], row[1], row[2], 'csam/0/{}'.format(hash_id)))
    assert gc.delete_blob(hash_id) == 'deleted'
    assert s3_object('files/{}'.format(hash_id)) is None
    appdb.execute("UPDATE jobs SET done_at = now() WHERE kind = 'csam_handle' AND payload->>'hash_id' = %s",
                  (str(hash_id),))


def test_a_scan_that_keeps_failing_is_held_for_staff(client, appdb, monkeypatch):
    from safety import scan
    monkeypatch.setenv('SCAN_MAX_FAILURES', '2')
    _, owner = new_user(appdb)
    created = send(client, owner, png(), 'f.png', 'image/png')
    hash_id = hash_id_of(appdb, created)

    def fail_scan_job(error):
        appdb.execute("UPDATE jobs SET failed_at = now(), last_error = %s WHERE kind = 'scan' "
                      "AND payload->>'hash_id' = %s AND done_at IS NULL AND failed_at IS NULL", (error, str(hash_id)))
    fail_scan_job('ScanFailed: scan child failed: python3 timed out after 120 s')
    scan.sweep(appdb.conn)
    assert appdb.fetchone('SELECT scan_failures, scan_stuck_at FROM file_hashes WHERE id = %s', (hash_id,)) == (1, None)
    assert len(runnable_jobs(appdb, 'scan', hash_id)) == 1
    fail_scan_job('ScanFailed: scan child failed: python3 ran out of CPU time')
    scan.sweep(appdb.conn)
    failures, stuck = appdb.fetchone('SELECT scan_failures, scan_stuck_at FROM file_hashes WHERE id = %s', (hash_id,))
    assert failures == 2 and stuck is not None
    # not re-queued; still pending everywhere (failing closed)
    assert runnable_jobs(appdb, 'scan', hash_id) == []
    assert hash_row(appdb, hash_id)['scan_state'] == 'pending'
    assert lookup(client, created).json()['safety']['state'] == 'pending'
    # staff see a P1 case with the flag and the last error
    case = appdb.fetchone("SELECT id, priority FROM moderation_cases WHERE hash_id = %s AND status = 'open'",
                          (hash_id,))
    assert case[1] == 1
    flag = appdb.fetchone("SELECT source, details FROM content_flags WHERE hash_id = %s AND reason = 'scan_failing'",
                          (hash_id,))
    assert flag[0] == 'scan' and flag[1]['failures'] == 2 and 'out of CPU time' in flag[1]['last_error']
    assert appdb.fetchone("SELECT details->>'reason' FROM moderation_actions WHERE case_id = %s AND "
                          "action = 'scan_hold'", (case[0],))[0] == 'scan_failing'
    # the sweeper leaves it alone from now on
    scan.sweep(appdb.conn)
    assert runnable_jobs(appdb, 'scan', hash_id) == []
    # staff can try again
    with appdb.conn.transaction():
        scan.retry_failing(appdb.conn, hash_id)
    assert len(runnable_jobs(appdb, 'scan', hash_id)) == 1
    assert run_scan(appdb, created)['scan_state'] == 'passed'


def encrypt_pdf(tmp_path, content, user_password):
    import subprocess
    source, target = tmp_path / 'plain.pdf', tmp_path / 'encrypted.pdf'
    source.write_bytes(content)
    subprocess.run(['qpdf', '--encrypt', user_password, 'owner-secret', '256', '--', str(source), str(target)],
                   check=True)
    return target.read_bytes()


def test_a_pdf_with_a_user_password_is_handled_like_an_encrypted_archive(client, appdb, tmp_path):
    _, owner = new_user(appdb)
    content = encrypt_pdf(tmp_path, pdf(), 'user-secret')
    created = send(client, owner, content, 'locked.pdf', 'application/pdf')
    row = run_scan(appdb, created)
    assert row['scan_state'] == 'passed' and row['scan']['warnings'] == ['encrypted_pdf']
    assert row['scan']['checks']['pdf']['encrypted'] is True
    assert client.get('/files/' + created['vanity']).json()['warnings'] == ['encrypted_pdf']
    # the same bytes anonymously: refused at once
    response = client.post('/files', headers=anonymous(), files={'file': ('l.pdf', content, 'application/pdf')},
                           data={'turnstile_token': 'mock:upload:files.gg'})
    assert response.status_code == 403 and response.json() == {
        'code': 'ENCRYPTED_PDF_REQUIRES_ACCOUNT', 'message': 'Sign in to upload password-protected PDFs',
        'status': 403}
    # a new one anonymously: rejected after the scan
    headers = anonymous()
    anon = send(client, headers, encrypt_pdf(tmp_path, pdf(), 'other-secret'), 'x.pdf', 'application/pdf',
                anonymous_upload=True)
    run_scan(appdb, anon)
    assert client.get('/users/@me/files/' + anon['id'], headers=headers).json()['reason'] == \
        'ENCRYPTED_PDF_REQUIRES_ACCOUNT'
    # an owner password only (anyone can open it) is checked as usual
    readable = send(client, owner, encrypt_pdf(tmp_path, pdf_javascript(), ''), 'r.pdf', 'application/pdf')
    row = run_scan(appdb, readable)
    assert row['scan']['warnings'] == [] and not row['scan']['checks']['pdf'].get('encrypted')
    assert row['scan_state'] == 'flagged' and row['scan_reason'] == 'pdf_javascript'


def broken_after_first_entry(entries):
    """A zip whose second local header is corrupt: libarchive fails part-way; the central directory
    still names every entry."""
    import io
    import zipfile
    data = bytearray(zip_of(entries, compression=zipfile.ZIP_STORED))
    with zipfile.ZipFile(io.BytesIO(bytes(data))) as archive:
        second = archive.infolist()[1].header_offset
    data[second:second + 4] = b'XXXX'
    return bytes(data)


def test_an_archive_that_breaks_part_way_is_partial_and_its_names_are_checked(client, appdb):
    _, owner = new_user(appdb)
    content = broken_after_first_entry([('readme.txt', nonce() * 50), ('setup.exe', nonce()), ('n', nonce())])
    row = run_scan(appdb, send(client, owner, content, 'broken.zip', 'application/zip'))
    archive = row['scan']['checks']['archive']
    assert archive['partial'] is True, row['scan']
    assert row['scan_state'] == 'blocked' and 'blocked_type' in findings(row)
    # without a blocked name: passed, with the partial warning
    content = broken_after_first_entry([('readme.txt', nonce() * 50), ('notes.txt', nonce()), ('n', nonce())])
    row = run_scan(appdb, send(client, owner, content, 'broken2.zip', 'application/zip'))
    assert row['scan_state'] == 'passed' and row['scan']['checks']['archive']['partial'] is True
    assert 'archive_partially_scanned' in row['scan']['warnings']


def tar_of(entries):
    import io
    import tarfile
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:gz') as archive:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return out.getvalue()


@pytest.mark.parametrize('build, name, mimetype', [
    (zip_of, 'many.zip', 'application/zip'),
    (tar_of, 'many.tar.gz', 'application/gzip'),
])
def test_entries_past_the_cap_still_get_the_name_check(client, appdb, monkeypatch, build, name, mimetype):
    monkeypatch.setenv('ARCHIVE_MAX_ENTRIES', '50')
    _, owner = new_user(appdb)
    entries = [('f{}.txt'.format(i), b'x') for i in range(60)] + [('later/tool.exe', nonce())]
    row = run_scan(appdb, send(client, owner, build(entries), name, mimetype))
    assert row['scan']['checks']['archive']['partial'] is True
    assert row['scan_state'] == 'blocked' and 'blocked_type' in findings(row), row['scan']


def test_resource_errors_are_retries_and_decode_failures_are_not(tmp_path, monkeypatch):
    from media import sandbox, scanning
    assert scanning.resource_error(MemoryError())
    assert scanning.resource_error(sandbox.Timeout('ffmpeg timed out'))
    assert scanning.resource_error(sandbox.Failed(['qpdf'], -11, b''))
    assert not scanning.resource_error(sandbox.Failed(['qpdf'], 2, b'damaged'))
    assert not scanning.resource_error(OSError('image file is truncated'))
    images = scanning.Images(str(tmp_path))
    corrupt = tmp_path / 'corrupt.png'
    corrupt.write_bytes(png()[:200])
    assert scanning.image_frames(str(corrupt), images) == (False, False)
    good = tmp_path / 'good.png'
    good.write_bytes(png())
    Image = scanning.pillow()

    def out_of_memory(*args, **kwargs):
        raise MemoryError()
    monkeypatch.setattr(Image, 'open', out_of_memory)
    with pytest.raises(MemoryError):
        scanning.image_frames(str(good), images)


def test_a_scan_child_that_runs_out_of_resources_keeps_the_hash_pending(client, appdb, monkeypatch):
    from safety import scan
    from media import sandbox
    _, owner = new_user(appdb)
    created = send(client, owner, png(), 't.png', 'image/png')

    def killed(*args, **kwargs):
        raise sandbox.Timeout('python3 ran out of CPU time')
    monkeypatch.setattr(sandbox, 'run', killed)
    with pytest.raises(scan.ScanFailed):
        scan.scan(hash_id_of(appdb, created))
    assert hash_row(appdb, hash_id_of(appdb, created))['scan_state'] == 'pending'


def test_find_appended_maps_the_file(tmp_path):
    import io
    from PIL import Image
    from media import scanning
    out = io.BytesIO()
    Image.effect_noise((256, 256), 64).convert('RGB').save(out, 'JPEG', quality=95)
    jpeg = out.getvalue()
    archive = zip_of([('inside.txt', nonce())])
    path = tmp_path / 'poly.jpg'
    path.write_bytes(jpeg + archive)
    work = tmp_path / 'work'
    work.mkdir()
    finding, carved = scanning.find_appended(str(path), str(work))
    assert finding == {'container': 'jpeg', 'offset': len(jpeg), 'archive': 'zip'}
    with open(carved, 'rb') as handle:
        assert handle.read() == archive
    plain = tmp_path / 'plain.jpg'
    plain.write_bytes(jpeg)
    assert scanning.find_appended(str(plain), str(work)) == (None, None)
    empty = tmp_path / 'empty.png'
    empty.write_bytes(b'')
    assert scanning.find_appended(str(empty), str(work)) == (None, None)
    # a 7z appended to a PDF
    document = tmp_path / 'doc.pdf'
    seven = b"7z\xbc\xaf\x27\x1c" + nonce()
    document.write_bytes(pdf() + seven)
    finding, carved = scanning.find_appended(str(document), str(work))
    assert finding['container'] == 'pdf' and finding['archive'] == '7z'
    with open(carved, 'rb') as handle:
        assert handle.read() == seven


def test_finalize_queues_the_scan_of_a_hash_left_pending(client, appdb):
    """The hash row is inserted before the file's transaction: a retry after a crash in between finds
    it, and must still queue its scan."""
    import hashlib
    from jobs.finalize import finalize
    from utils.generators import Snowflake
    from tests.conftest import BUCKET
    _, owner = new_user(appdb)
    data = nonce() * 8
    hash_id = Snowflake.generate()
    appdb.execute('INSERT INTO file_hashes (id, blake2b, sha1, md5, size) VALUES (%s, %s, %s, %s, %s)',
                  (hash_id, hashlib.blake2b(data).hexdigest(), hashlib.sha1(data).hexdigest(),
                   hashlib.md5(data).hexdigest(), len(data)))
    s3_client().put_object(Bucket=BUCKET, Key='files/{}'.format(hash_id), Body=data)
    session = client.post('/uploads', headers=owner, json={'filename': 'p.txt', 'size': len(data)}).json()
    client.request('PUT', '/uploads/{}/chunks/0'.format(session['upload_id']), headers=owner, content=data)
    client.post('/uploads/{}/complete'.format(session['upload_id']), headers=owner)
    file_id = finalize(int(session['upload_id']))
    assert appdb.fetchone('SELECT hash_id FROM files WHERE id = %s', (file_id,))[0] == hash_id
    assert jobs_of(appdb, 'scan', hash_id) == 1


def test_derive_drops_previews_when_the_hash_is_held_meanwhile(client, appdb, monkeypatch):
    from jobs import media as media_jobs
    from tests.conftest import s3_keys
    _, owner = new_user(appdb)
    # big enough for previews
    created = send(client, owner, png(1600, 1200), 'd.png', 'image/png')
    hash_id = hash_id_of(appdb, created)
    run_scan(appdb, created)
    assert media_jobs.probe(hash_id) == 'probed'
    real = media_jobs.s3()
    uploaded = []

    class HeldAfterUpload:
        def __getattr__(self, name):
            return getattr(real, name)

        def put_object(self, **kwargs):
            result = real.put_object(**kwargs)
            uploaded.append(kwargs['Key'])
            appdb.execute("UPDATE file_hashes SET scan_state = 'held', scan_reason = 'pdq_near_match' WHERE id = %s",
                          (hash_id,))
            return result
    assert media_jobs.derive(hash_id, client=HeldAfterUpload()) is None
    assert uploaded and all(key.startswith('derived/{}/'.format(hash_id)) for key in uploaded)
    assert s3_keys('derived/{}/'.format(hash_id)) == []
    assert appdb.fetchone('SELECT count(*) FROM file_hash_assets WHERE hash_id = %s', (hash_id,))[0] == 0
