"""Milestone 5 conversions, the API side (docs/redesign/contracts/milestone-5.md §15 "API"): the checks of §7.2 in
order, the access matrix of §5.1, output access (§5.3), the cache (§4.5), the moderation cascade (§5.4), tier queues
and queue positions on a real Redis (§3.1, §8), the brief wait, enqueue after commit and the sweeper (decision 17),
batches, history, cancelling, PDF pages, and document previews (§9).

No converter runs here: `quick_worker` stands in for one by storing an output through the same path the work horses
use (utils/conversion_outputs.py) the moment a conversion is enqueued.
"""

import io
import json
import os
import tempfile
import time
import uuid
import zipfile

import pytest

import db
from tests.conftest import turnstile_token, set_premium, sign_in, make_user
from tests.m4 import anonymous, appdb, docx, make_staff, new_user, png, send  # noqa: F401
from utils import conversion_outputs, convert_queue

CONVERT_TOKEN = turnstile_token('convert')
UNLOCK_TOKEN = turnstile_token('unlock')


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    """No brief wait unless a test asks for it, and members get room for many conversions at once."""
    from views import conversions as view
    monkeypatch.setattr(view, 'WAIT_SECONDS', 0)
    monkeypatch.setenv('CONVERSION_CONCURRENT', '100')
    yield


def fresh_ip():
    return '10.{}.{}.{}'.format(*uuid.uuid4().bytes[:3])


def anon():
    return anonymous(fresh_ip())


def member(appdb, premium=False):
    user_id, headers = new_user(appdb)
    if premium:
        set_premium(user_id)
        headers = sign_in(user_id)
    headers['X-Forwarded-For'] = fresh_ip()
    return user_id, headers


def is_guest(headers):
    return headers.get('Authorization', '').startswith('Guest ')


def upload_png(client, headers, **fields):
    return send(client, headers, png(), 'photo.png', 'image/png', anonymous_upload=is_guest(headers),
                **fields)


def convert(client, headers, status=None, path='/conversions', access_token=None, **body):
    if is_guest(headers):
        body.setdefault('turnstile_token', CONVERT_TOKEN)
    headers = dict(headers)
    if access_token:
        headers['X-Filesgg-Access'] = access_token
    response = client.post(path, headers=headers, json=body)
    if status is not None:
        assert response.status_code == status, response.text
    return response


def error_of(response):
    body = response.json()
    return response.status_code, body['code']


def row(appdb, conversion_id):
    from utils.conversions import SELECT, row_dict
    return row_dict(appdb.fetchone(SELECT + ' WHERE c.id = %s', (int(conversion_id),)))


def rq():
    from utils.redis import get_sync
    return get_sync()


def queued_ids(queue):
    from rq import Queue
    return Queue(queue, connection=rq()).job_ids


def store(conversion_id, content=None):
    """What a work horse does once its tool finished: store the output (or the pages) through the shared path."""
    with db.connect() as conn:
        found = conn.execute('SELECT source_kind, target, output_settings FROM conversions WHERE id = %s',
                             (conversion_id,)).fetchone()
        conn.execute("UPDATE conversions SET status = 'running', started_at = now() WHERE id = %s AND status = "
                     "'queued'", (conversion_id,))
        with tempfile.TemporaryDirectory() as tmp:
            if found[0] == 'pdf':
                paths = []
                for n in range(2):
                    paths.append(os.path.join(tmp, 'page-{}.png'.format(n)))
                    with open(paths[-1], 'wb') as handle:
                        handle.write(png())
                conversion_outputs.store_pages(conn, conversion_id, paths)
                return
            path = os.path.join(tmp, 'out')
            with open(path, 'wb') as handle:
                handle.write(content or png())
            conversion_outputs.store_output(conn, conversion_id, path, found[2]['mimetype'], 'out')


@pytest.fixture
def quick_worker(monkeypatch):
    """Enqueuing runs the conversion at once (a quick job): the output is stored before the brief wait reads it."""
    calls = []

    def run(conversion_id, queue, time_limit, connection=None):
        from utils import errors
        from utils.responses import ApiError
        calls.append(conversion_id)
        try:
            store(conversion_id)
        except ApiError as error:
            # as the worker class saves a horse's ApiError (§3.3)
            with db.connect() as conn:
                conn.execute("UPDATE conversions SET status = 'failed', error = %s::jsonb, failure_reason = %s, "
                             'finished_at = now() WHERE id = %s',
                             (json.dumps(errors.conversion_error(error)), error.code, conversion_id))
        return True
    monkeypatch.setattr(convert_queue, 'enqueue_conversion', run)
    return calls


def run_cascades(appdb):
    from safety import cascade
    for job_id, payload in appdb.fetchall("SELECT id, payload FROM jobs WHERE kind = 'moderation_cascade' AND "
                                          'done_at IS NULL ORDER BY id'):
        cascade.run(payload)
        appdb.execute('UPDATE jobs SET done_at = now() WHERE id = %s', (job_id,))


def file_state(appdb, file_id):
    return appdb.fetchone('SELECT moderation_state, moderation_rule, deleted_at IS NOT NULL FROM files WHERE id = %s',
                          (int(file_id),))


# --- §7.2: the checks, in order ---------------------------------------------------------------------------------------

def test_checks_in_order_for_anonymous_callers(client, appdb, monkeypatch):
    owner_id, owner = member(appdb)
    document = send(client, owner, docx(), 'report.docx',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    private_document = send(client, owner, docx(), 'secret.docx',
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                            visibility='private')
    visitor = anon()
    # 1. Turnstile before anything else
    assert error_of(convert(client, visitor, source=document['vanity'], turnstile_token='mock-fail')) == \
        (403, 'CAPTCHA_INVALID')
    # 2. document -> pdf needs an account (the default target too)
    response = convert(client, visitor, source=document['vanity'], status=403)
    assert response.json()['code'] == 'CONVERSION_REQUIRES_ACCOUNT' and response.json()['sign_in'] is True
    assert error_of(convert(client, visitor, source=document['vanity'], target='pdf')) == \
        (403, 'CONVERSION_REQUIRES_ACCOUNT')
    # ... but only for a source the caller can see: anything else says nothing about the file
    assert error_of(convert(client, visitor, source=private_document['vanity'])) == (404, 'SOURCE_UNAVAILABLE')
    # 3. batches need an account
    response = convert(client, visitor, path='/conversions/batch', files=[document['vanity']], status=403)
    assert response.json()['message'] == 'Sign in to convert in bulk'
    # 4. source access
    assert error_of(convert(client, visitor, source='nope' + uuid.uuid4().hex[:8])) == (404, 'SOURCE_UNAVAILABLE')
    image = upload_png(client, owner)
    assert error_of(convert(client, visitor, source=image['vanity'], target='mp3')) == (400, 'UNSUPPORTED_CONVERSION')
    assert error_of(convert(client, visitor, source=image['vanity'], options={'speed': 2})) == (400, 'INVALID_OPTION')
    # 5. sizes, before 6. the daily count
    monkeypatch.setenv('CONVERSION_ANONYMOUS_MAX_INPUT', '10')
    monkeypatch.setenv('CONVERSION_ANONYMOUS_COUNT_PER_DAY', '0')
    response = convert(client, visitor, source=image['vanity'], status=413)
    body = response.json()
    assert (body['code'], body['limit'], body['unit'], body['sign_in']) == ('CONVERSION_TOO_LARGE', 10, 'bytes', True)
    assert body['value'] == image['size']
    monkeypatch.delenv('CONVERSION_ANONYMOUS_MAX_INPUT')
    response = convert(client, visitor, source=image['vanity'], status=429)
    assert (response.json()['code'], response.json()['limit'], response.json()['sign_in']) == \
        ('CONVERSION_LIMIT_REACHED', 'count', True)
    assert int(response.headers['retry-after']) >= 1
    monkeypatch.delenv('CONVERSION_ANONYMOUS_COUNT_PER_DAY')
    # 6. one at a time (anonymous), then the CPU budget
    first = convert(client, visitor, source=image['vanity'], status=202).json()
    assert first['status'] == 'queued'
    response = convert(client, visitor, source=image['vanity'], status=429)
    assert response.json()['limit'] == 'concurrent'
    # the same IP with another guest is the same anonymous caller
    other = anonymous(visitor['X-Forwarded-For'])
    assert convert(client, other, source=image['vanity'], status=429).json()['limit'] == 'concurrent'
    appdb.execute("UPDATE conversions SET status = 'cancelled' WHERE id = %s", (int(first['id']),))
    monkeypatch.setenv('CONVERSION_ANONYMOUS_CPU_SECONDS_PER_DAY', '0')
    assert convert(client, visitor, source=image['vanity'], status=429).json()['limit'] == 'cpu'


def test_count_is_per_guest_and_per_ip(client, appdb, monkeypatch):
    _, owner = member(appdb)
    image = upload_png(client, owner)
    visitor = anon()
    monkeypatch.setenv('CONVERSION_ANONYMOUS_COUNT_PER_DAY', '1')
    monkeypatch.setenv('CONVERSION_ANONYMOUS_CONCURRENT', '5')
    convert(client, visitor, source=image['vanity'], status=202)
    # a new guest on the same IP, and the same guest on a new IP, are both over the count
    assert convert(client, anonymous(visitor['X-Forwarded-For']), source=image['vanity'], status=429)
    moved = dict(visitor, **{'X-Forwarded-For': fresh_ip()})
    assert convert(client, moved, source=image['vanity'], status=429).json()['limit'] == 'count'
    assert convert(client, anon(), source=image['vanity'], status=202)


def test_durations_are_read_from_the_probe_in_milliseconds(client, appdb):
    """The probe stores `media.duration` in ms (media/process.py); the duration limit, trims and target_size work in
    seconds. A 2 s video was 2000 "seconds", over the anonymous 60 s and the member 30 min (found by e2e/run.mjs)."""
    _, owner = member(appdb)
    image = upload_png(client, owner)
    appdb.execute("UPDATE files SET mimetype_id = 'video/mp4' WHERE id = %s", (int(image['id']),))

    def probed(duration_ms):
        appdb.execute("UPDATE file_hashes SET processing_state = 'done', media = %s::jsonb WHERE id = (SELECT hash_id "
                      'FROM files WHERE id = %s)', (json.dumps({'duration': duration_ms, 'width': 640, 'height': 360}),
                                                    int(image['id'])))

    probed(2000)
    convert(client, anon(), source=image['vanity'], target='mp4', status=202)
    # trim_end is clamped to the duration in seconds, and target_size's bitrate uses seconds
    trimmed = convert(client, owner, source=image['vanity'], target='mp4', options={'trim_end': 30}, status=202)
    assert trimmed.json()['options']['trim_end'] == 2.0
    convert(client, owner, source=image['vanity'], target='mp4', options={'target_size': 1}, status=202)
    probed(61_000)
    body = convert(client, anon(), source=image['vanity'], target='mp4', status=413).json()
    assert (body['code'], body['limit'], body['value'], body['unit']) == ('CONVERSION_TOO_LARGE', 60, 61.0, 'seconds')


def test_members_limits(client, appdb, monkeypatch):
    _, owner = member(appdb)
    image = upload_png(client, owner)
    monkeypatch.setenv('CONVERSION_CONCURRENT', '1')
    convert(client, owner, source=image['vanity'], status=202)
    response = convert(client, owner, source=image['vanity'], status=429)
    assert response.json()['limit'] == 'concurrent' and 'sign_in' not in response.json()
    monkeypatch.setenv('CONVERSION_MAX_INPUT', '10')
    assert 'sign_in' not in convert(client, owner, source=image['vanity'], status=413).json()


# --- §5.1: who can convert what ------------------------------------------------------------------------------------------

def test_access_matrix(client, appdb):
    _, owner = member(appdb)
    _, other = member(appdb)
    link = upload_png(client, owner)
    password = upload_png(client, owner, visibility='password', password='correct horse')
    private = upload_png(client, owner, visibility='private')
    limited = upload_png(client, owner, view_limit=3)
    hidden, removed, expired, blocked = (upload_png(client, owner) for _ in range(4))
    appdb.execute("UPDATE files SET moderation_state = 'hidden' WHERE id = %s", (int(hidden['id']),))
    appdb.execute("UPDATE files SET moderation_state = 'removed' WHERE id = %s", (int(removed['id']),))
    appdb.execute("UPDATE files SET expires_at = now() - interval '1 minute' WHERE id = %s", (int(expired['id']),))
    appdb.execute("UPDATE file_hashes SET scan_state = 'blocked', scan_reason = 'malware' WHERE id = (SELECT hash_id FROM files WHERE id = %s)",
                  (int(blocked['id']),))

    assert convert(client, other, source=link['vanity']).status_code == 202
    assert error_of(convert(client, other, source=password['vanity'])) == (404, 'SOURCE_UNAVAILABLE')
    unlocked = client.post('/access/unlock/files/' + password['vanity'], headers={'X-Forwarded-For': fresh_ip()},
                           json={'password': 'correct horse', 'turnstile_token': UNLOCK_TOKEN})
    assert unlocked.status_code == 200, unlocked.text
    assert convert(client, other, source=password['vanity'],
                   access_token=unlocked.json()['token']).status_code == 202
    assert convert(client, other, source=password['vanity'], access_token='garbage').status_code == 404
    assert error_of(convert(client, other, source=private['vanity'])) == (404, 'SOURCE_UNAVAILABLE')
    assert error_of(convert(client, other, source=limited['vanity'])) == (403, 'VIEW_LIMITED_SOURCE')
    for gone in (hidden, removed, expired, blocked):
        assert error_of(convert(client, other, source=gone['vanity'])) == (404, 'SOURCE_UNAVAILABLE'), gone
    # the owner converts their own private, password and view-limited files
    for own in (password, private, limited):
        assert convert(client, owner, source=own['vanity']).status_code == 202
    # a view-limited file's views aren't used by converting
    assert appdb.fetchone('SELECT views_used FROM files WHERE id = %s', (int(limited['id']),))[0] == 0


def test_upload_keys_get_the_scope_error(client, appdb):
    from tests.test_upload_keys import create_key, key_header
    _, owner = member(appdb)
    secret = create_key(client, owner)['secret']
    response = client.post('/conversions', headers=key_header(secret), json={'source': 'x'})
    assert error_of(response) == (403, 'UPLOAD_KEY_SCOPE')
    assert error_of(client.get('/users/@me/conversions', headers=key_header(secret))) == (403, 'UPLOAD_KEY_SCOPE')


def test_callers_need_a_session_or_guest(client):
    assert error_of(client.post('/conversions', headers={'X-Forwarded-For': fresh_ip()}, json={'source': 'x'})) == \
        (401, 'UNAUTHORIZED')


# --- outputs (§4.4, §5.3, §5.5) ----------------------------------------------------------------------------------------

def test_outputs_are_normal_files_with_provenance(client, appdb, quick_worker):
    owner_id, owner = member(appdb)
    _, other = member(appdb)
    source = upload_png(client, owner, nsfw=True)
    created = convert(client, other, source=source['vanity'], target='webp', status=200).json()
    assert created['status'] == 'succeeded' and created['cached'] is False
    output = created['output']['file']
    assert output['name'] == 'photo' and output['extension'] == 'webp' and output['mimetype'] == 'image/webp'
    assert output['visibility'] == 'link' and output['expires_at'] is None
    assert output['nsfw'] is True and output['safety']['state'] == 'ok'
    assert created['source']['file']['vanity'] == source['vanity']
    assert created['output_size'] == output['size'] and created['input_size'] == source['size']
    assert created['progress'] == 1.0 and created['error'] is None
    stored = appdb.fetchone('SELECT user_id, derived_from_file_id, conversion_id, upload_key_id, nsfw_marked, hash_id '
                            'FROM files WHERE id = %s', (int(output['id']),))
    assert stored[1:5] == (int(source['id']), int(created['id']), None, True)
    assert stored[0] != owner_id
    # the new hash goes through the normal pipeline: its scan is queued (Postgres), nothing else
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = %s",
                          (str(stored[5]),))[0] == 1
    # and the cache remembers it
    recipe = row(appdb, created['id'])
    assert appdb.fetchone('SELECT output_hash_id FROM conversion_cache WHERE source_hash_id = %s AND recipe_hash = %s',
                          (recipe['source_hash_id'], recipe['recipe_hash']))[0] == stored[5]
    # the Postgres pipeline gets no conversion jobs: conversions are on RQ (§2.4)
    assert appdb.fetchone("SELECT count(*) FROM jobs WHERE kind LIKE '%%conver%%'")[0] == 0


def test_output_access(client, appdb, quick_worker):
    _, owner = member(appdb)
    _, other = member(appdb)
    link = upload_png(client, owner)
    protected = upload_png(client, owner, visibility='password', password='correct horse')
    token = client.post('/access/unlock/files/' + protected['vanity'], headers={'X-Forwarded-For': fresh_ip()},
                        json={'password': 'correct horse', 'turnstile_token': UNLOCK_TOKEN}).json()['token']
    # signed in: a protected source's output is private
    made = convert(client, other, source=protected['vanity'], access_token=token, status=200).json()
    assert made['output']['file']['visibility'] == 'private' and 'password' not in made['output']
    # ... unless the caller picks otherwise
    made = convert(client, other, source=protected['vanity'], access_token=token, visibility='link',
                   expires_in=7200, status=200).json()
    assert made['output']['file']['visibility'] == 'link'
    assert made['output']['file']['expires_at'] - time.time() == pytest.approx(7200, abs=30)
    made = convert(client, other, source=link['vanity'], view_limit=2, status=200).json()
    assert made['output']['file']['view_limit'] == 2
    # anonymous: a protected source's output gets a generated password, shown once
    visitor = anon()
    made = convert(client, visitor, source=protected['vanity'], access_token=token, status=200).json()
    assert made['output']['file']['visibility'] == 'password'
    assert len(made['output']['password']) > 10
    again = client.get('/conversions/' + made['id'], headers=visitor).json()
    assert 'password' not in again['output'] and again['output']['file']['vanity'] == made['output']['file']['vanity']
    # anonymous outputs expire within 21 days, and are `link` for a link source
    visitor = anon()
    made = convert(client, visitor, source=link['vanity'], status=200).json()
    assert made['output']['file']['visibility'] == 'link'
    assert made['output']['file']['expires_at'] - time.time() == pytest.approx(21 * 86400, abs=60)
    owned = appdb.fetchone('SELECT user_id, guest_id, uploader_abuse_ip_hash IS NOT NULL, uploader_ip_hash IS NOT '
                           'NULL FROM files WHERE id = %s', (int(made['output']['file']['id']),))
    assert owned[0] is None and owned[1] is not None and owned[2] and owned[3]
    assert error_of(convert(client, anon(), source=link['vanity'], visibility='private')) == \
        (400, 'PRIVATE_REQUIRES_ACCOUNT')
    assert error_of(convert(client, anon(), source=link['vanity'], view_limit=2))[1] == 'INVALID_PARAMETERS'


def test_storage_quota_and_blocked_outputs(client, appdb, quick_worker):
    owner_id = make_user(appdb, override=1)
    owner = sign_in(owner_id)
    _, uploader = member(appdb)
    source = upload_png(client, uploader)
    made = convert(client, owner, source=source['vanity'], status=200).json()
    assert made['status'] == 'failed' and made['output']['file'] is None
    assert made['error']['code'] == 'STORAGE_LIMIT_REACHED'
    assert row(appdb, made['id'])['failure_reason'] == 'STORAGE_LIMIT_REACHED'


def test_blocked_dedup_fails_the_conversion(client, appdb, monkeypatch):
    _, owner = member(appdb)
    blocked_bytes = png()
    victim = send(client, owner, blocked_bytes, 'b.png', 'image/png')
    appdb.execute("UPDATE file_hashes SET scan_state = 'blocked', scan_reason = 'malware' WHERE id = (SELECT hash_id FROM files WHERE id = %s)",
                  (int(victim['id']),))
    source = upload_png(client, owner)
    made = convert(client, owner, source=source['vanity'], status=202).json()
    from utils.responses import ApiError
    with pytest.raises(ApiError) as raised:
        store(int(made['id']), content=blocked_bytes)
    assert raised.value.code == 'FILE_BLOCKED'
    assert appdb.fetchone('SELECT count(*) FROM files WHERE conversion_id = %s', (int(made['id']),))[0] == 0


# --- §4.5: the cache -------------------------------------------------------------------------------------------------------

def test_cache_hit_creates_the_file_without_a_job(client, appdb, quick_worker):
    _, owner = member(appdb)
    _, other = member(appdb)
    content = png()
    source = send(client, owner, content, 'a.png', 'image/png')
    first = convert(client, owner, source=source['vanity'], target='jpg', status=200).json()
    assert len(quick_worker) == 1
    # the same bytes elsewhere, the same recipe (the defaults spelled out): no job, a File at once, count charged
    copy = send(client, other, content, 'copy.png', 'image/png')
    hit = convert(client, other, source=copy['vanity'], target='jpg', options={'quality': 85}, status=200).json()
    assert len(quick_worker) == 1
    assert hit['cached'] is True and hit['status'] == 'succeeded' and hit['cpu_seconds'] == 0
    assert hit['output']['file']['name'] == 'copy' and hit['output']['file']['extension'] == 'jpg'
    stored = row(appdb, hit['id'])
    assert stored['job_id'] is None and stored['cpu_ms'] == 0
    assert not convert_queue.job_exists(convert_queue.conversion_job_id(hit['id']))
    assert appdb.fetchone('SELECT hash_id FROM files WHERE id = %s', (int(hit['output']['file']['id']),))[0] == \
        appdb.fetchone('SELECT hash_id FROM files WHERE id = %s', (int(first['output']['file']['id']),))[0]
    assert appdb.fetchone("SELECT count FROM conversion_usage WHERE subject = %s AND day = (now() AT TIME ZONE "
                          "'UTC')::date", ('u:{}'.format(stored['owner_user_id']),))[0] >= 1
    # a hit whose output is held or blocked is ignored, and forgotten
    appdb.execute("UPDATE file_hashes SET scan_state = 'held', scan_reason = 'pdq_near_match' WHERE id = (SELECT hash_id FROM files WHERE id = %s)",
                  (int(first['output']['file']['id']),))
    missed = convert(client, other, source=copy['vanity'], target='jpg', status=200).json()
    assert missed['cached'] is False and len(quick_worker) == 2


def test_cache_hit_still_checks_access_and_limits(client, appdb, quick_worker, monkeypatch):
    _, owner = member(appdb)
    content = png()
    source = send(client, owner, content, 'a.png', 'image/png')
    convert(client, owner, source=source['vanity'], target='gif', status=200)
    private = send(client, owner, content, 'b.png', 'image/png', visibility='private')
    _, other = member(appdb)
    assert error_of(convert(client, other, source=private['vanity'], target='gif')) == (404, 'SOURCE_UNAVAILABLE')
    monkeypatch.setenv('CONVERSION_COUNT_PER_DAY', '0')
    assert error_of(convert(client, other, source=source['vanity'], target='gif')) == (429, 'CONVERSION_LIMIT_REACHED')


# --- §3.1, §8: tiers, queues and positions ------------------------------------------------------------------------------

def test_tier_queues_and_positions(client, appdb):
    _, owner = member(appdb)
    image = upload_png(client, owner)
    _, premium = member(appdb, premium=True)
    _, plain = member(appdb)
    visitor = anon()
    first_premium = convert(client, premium, source=image['vanity'], status=202).json()
    second_premium = convert(client, premium, source=image['vanity'], status=202).json()
    first_member = convert(client, plain, source=image['vanity'], status=202).json()
    second_member = convert(client, plain, source=image['vanity'], status=202).json()
    guest = convert(client, visitor, source=image['vanity'], status=202).json()
    assert [c['queue'] for c in (first_premium, first_member, guest)] == ['premium', 'member', 'anonymous']
    assert [c['time_limit'] for c in (first_premium, first_member, guest)] == [1800, 600, 120]
    assert queued_ids('convert_premium') == ['conversion-' + first_premium['id'], 'conversion-' + second_premium['id']]
    assert queued_ids('convert_member') == ['conversion-' + first_member['id'], 'conversion-' + second_member['id']]
    assert queued_ids('convert_anonymous') == ['conversion-' + guest['id']]
    assert row(appdb, guest['id'])['job_id'] == 'conversion-' + guest['id']

    def position(headers, conversion):
        return client.get('/conversions/' + conversion['id'], headers=headers).json()['position']
    # LPOS in its own queue, plus every queue its pool drains first
    assert position(premium, first_premium) == 0 and position(premium, second_premium) == 1
    assert position(plain, first_member) == 2 and position(plain, second_member) == 3
    assert position(visitor, guest) == 2
    # a job taken by a horse is no longer in the list
    from rq import Queue
    rq().lpop(Queue('convert_premium', connection=rq()).key)
    assert position(plain, first_member) == 1


def test_brief_wait(client, appdb, monkeypatch):
    from views import conversions as view
    monkeypatch.setattr(view, 'WAIT_SECONDS', 2.0)
    _, owner = member(appdb)
    image = upload_png(client, owner)
    started = time.monotonic()
    waiting = convert(client, owner, source=image['vanity'], status=202).json()
    assert time.monotonic() - started >= 1.9
    assert waiting['status'] == 'queued' and waiting['took'] >= 1900

    # a job a horse finishes within the wait answers 200
    import threading

    def later(conversion_id, queue, time_limit, connection=None):
        threading.Timer(0.3, store, (conversion_id,)).start()
        return True
    monkeypatch.setattr(convert_queue, 'enqueue_conversion', later)
    started = time.monotonic()
    done = convert(client, owner, source=image['vanity'], status=200).json()
    assert done['status'] == 'succeeded' and time.monotonic() - started < 1.9
    # a conversion that failed during the wait is a 200 too, with its error
    monkeypatch.setattr(convert_queue, 'enqueue_conversion', lambda conversion_id, *a, **k: appdb.execute(
        "UPDATE conversions SET status = 'failed', error = %s::jsonb, finished_at = now() WHERE id = %s",
        (json.dumps({'code': 'CONVERSION_FAILED', 'message': 'The conversion failed',
                     'metadata': {'reason': 'unreadable_source'}}), conversion_id)))
    failed = convert(client, owner, source=image['vanity'], target='webp', status=200).json()
    assert failed['error'] == {'code': 'CONVERSION_FAILED', 'message': 'The conversion failed',
                               'metadata': {'reason': 'unreadable_source'}}
    assert 'failure_reason' not in failed


# --- decision 17: enqueue after commit, and the sweeper --------------------------------------------------------------------

def test_enqueue_after_commit_and_the_sweeper(client, appdb, monkeypatch):
    from rq import Queue
    from utils import conversions
    _, owner = member(appdb)
    image = upload_png(client, owner)
    real = convert_queue.enqueue_conversion
    committed = []

    def failing(conversion_id, queue, time_limit, connection=None):
        # the row is committed before the enqueue
        committed.append(appdb.fetchone('SELECT status FROM conversions WHERE id = %s', (conversion_id,)))
        return real(conversion_id, queue, time_limit, connection=_Broken())
    monkeypatch.setattr(convert_queue, 'enqueue_conversion', failing)
    made = convert(client, owner, source=image['vanity'], status=202).json()
    assert committed == [('queued',)]
    job_id = 'conversion-' + made['id']
    assert not convert_queue.job_exists(job_id)
    monkeypatch.setattr(convert_queue, 'enqueue_conversion', real)
    # younger than 30 s: left to its own enqueue
    conversions.sweep(appdb.conn)
    assert not convert_queue.job_exists(job_id)
    appdb.execute("UPDATE conversions SET created_at = now() - interval '1 minute' WHERE id = %s", (int(made['id']),))
    conversions.sweep(appdb.conn)
    assert convert_queue.job_exists(job_id)
    conversions.sweep(appdb.conn)
    # re-enqueued once: the same job id is never put on the queue twice
    assert Queue('convert_member', connection=rq()).job_ids.count(job_id) == 1


def test_sweeper_busy_and_lost(client, appdb):
    from rq.job import Job
    from utils import conversions
    _, owner = member(appdb)
    image = upload_png(client, owner)
    _, premium = member(appdb, premium=True)
    guest = convert(client, anon(), source=image['vanity'], status=202).json()
    plain = convert(client, owner, source=image['vanity'], status=202).json()
    patient = convert(client, premium, source=image['vanity'], status=202).json()
    lost = convert(client, owner, source=image['vanity'], status=202).json()
    appdb.execute("UPDATE conversions SET created_at = now() - interval '2 hours', queued_at = now() - interval "
                  "'11 minutes' WHERE id = %s", (int(guest['id']),))
    appdb.execute("UPDATE conversions SET created_at = now() - interval '2 hours', queued_at = now() - interval "
                  "'59 minutes' WHERE id = %s", (int(plain['id']),))
    appdb.execute("UPDATE conversions SET created_at = now() - interval '9 hours', queued_at = now() - interval "
                  "'9 hours' WHERE id = %s", (int(patient['id']),))
    rq().delete(Job.key_for('conversion-' + lost['id']))
    appdb.execute("UPDATE conversions SET status = 'running', started_at = now() - interval '13 minutes' WHERE id = %s",
                  (int(lost['id']),))
    conversions.sweep(appdb.conn)
    busy = row(appdb, guest['id'])
    assert busy['status'] == 'cancelled' and busy['failure_reason'] == 'CONVERTER_BUSY'
    assert busy['error'] == {'code': 'CONVERTER_BUSY', 'message': 'Busy right now. Try again, or sign in to skip the '
                             'queue', 'metadata': {'sign_in': True}}
    assert 'conversion-' + guest['id'] not in queued_ids('convert_anonymous')
    assert row(appdb, plain['id'])['status'] == 'queued'
    assert row(appdb, patient['id'])['status'] == 'queued'
    failed = row(appdb, lost['id'])
    assert (failed['status'], failed['failure_reason'], failed['error']['code']) == \
        ('failed', 'work_horse_lost', 'CONVERSION_FAILED')
    appdb.execute("UPDATE conversions SET queued_at = now() - interval '61 minutes' WHERE id = %s",
                  (int(plain['id']),))
    conversions.sweep(appdb.conn)
    member_busy = row(appdb, plain['id'])
    assert member_busy['status'] == 'cancelled' and member_busy['error']['metadata'] == {}


class _Broken:
    """A Redis connection that's down."""

    def __getattr__(self, name):
        raise ConnectionError('redis is down')


# --- §10.4, §10.5: cancel, forget, history -------------------------------------------------------------------------------

def test_cancel_forget_and_history(client, appdb, quick_worker, monkeypatch):
    from rq.job import Job
    _, owner = member(appdb)
    _, other = member(appdb)
    image = upload_png(client, owner)
    done = convert(client, owner, source=image['vanity'], status=200).json()
    monkeypatch.undo()
    from views import conversions as view
    monkeypatch.setattr(view, 'WAIT_SECONDS', 0)
    # another recipe (the first one's output is cached now)
    waiting = convert(client, owner, source=image['vanity'], target='jpg', status=202).json()
    # someone else's conversion is unknown
    assert error_of(client.get('/conversions/' + waiting['id'], headers=other)) == (404, 'UNKNOWN_CONVERSION')
    assert error_of(client.delete('/conversions/' + waiting['id'], headers=other)) == (404, 'UNKNOWN_CONVERSION')
    assert error_of(client.get('/conversions/12x', headers=owner)) == (404, 'UNKNOWN_CONVERSION')
    cancelled = client.delete('/conversions/' + waiting['id'], headers=owner)
    assert cancelled.status_code == 200 and cancelled.json()['status'] == 'cancelled'
    assert row(appdb, waiting['id'])['failure_reason'] == 'cancelled'
    assert Job.fetch('conversion-' + waiting['id'], connection=rq()).get_status() == 'canceled'
    assert 'conversion-' + waiting['id'] not in queued_ids('convert_member')
    # history: newest first, paged
    third = convert(client, owner, source=image['vanity'], target='gif', status=202).json()
    page = client.get('/users/@me/conversions?limit=2', headers=owner).json()
    assert [c['id'] for c in page['items']] == [third['id'], waiting['id']] and page['next'] == waiting['id']
    rest = client.get('/users/@me/conversions?limit=2&before=' + page['next'], headers=owner).json()
    assert [c['id'] for c in rest['items']] == [done['id']] and rest['next'] is None
    assert client.get('/users/@me/conversions?limit=0', headers=owner).status_code == 400
    # forgetting a finished one keeps its output
    assert client.delete('/conversions/' + done['id'], headers=owner).status_code == 204
    assert client.get('/conversions/' + done['id'], headers=owner).status_code == 404
    assert done['id'] not in [c['id'] for c in client.get('/users/@me/conversions', headers=owner).json()['items']]
    assert client.get('/users/@me/files/' + done['output']['file']['id'], headers=owner).status_code == 200
    # anonymous callers see their own
    visitor = anon()
    mine = convert(client, visitor, source=image['vanity'], target='webp', status=202).json()
    assert [c['id'] for c in client.get('/users/@me/conversions', headers=visitor).json()['items']] == [mine['id']]
    assert client.get('/users/@me/conversions', headers={'X-Forwarded-For': fresh_ip()}).status_code == 401


# --- §10.6: batches --------------------------------------------------------------------------------------------------------

def test_batch(client, appdb, monkeypatch):
    _, owner = member(appdb)
    images = [upload_png(client, owner) for _ in range(3)]
    text = send(client, owner, uuid.uuid4().bytes * 4, 'notes.txt', 'text/plain')
    monkeypatch.setenv('CONVERSION_CONCURRENT', '1')
    response = convert(client, owner, path='/conversions/batch', files=[i['vanity'] for i in images] +
                       [text['vanity'], 'missing' + uuid.uuid4().hex[:6]], target='webp', status=202)
    body = response.json()
    assert body['skipped'] == [{'source': text['vanity'], 'code': 'UNSUPPORTED_CONVERSION'},
                               {'source': body['skipped'][1]['source'], 'code': 'SOURCE_UNAVAILABLE'}]
    items = body['items']
    assert len(items) == 3 and {i['batch_id'] for i in items} == {body['batch_id']}
    # the concurrent limit doesn't refuse a batch: the rest wait for a slot
    assert [row(appdb, i['id'])['queued_at'] is not None for i in items] == [True, False, False]
    assert queued_ids('convert_member') == ['conversion-' + items[0]['id']]
    assert [i['position'] for i in items] == [0, 1, 2]
    # the count covers every item
    monkeypatch.setenv('CONVERSION_COUNT_PER_DAY', '4')
    assert error_of(convert(client, owner, path='/conversions/batch', files=[i['vanity'] for i in images])) == \
        (429, 'CONVERSION_LIMIT_REACHED')
    # a slot frees up: polling the batch puts the next item on the queue
    appdb.execute("UPDATE conversions SET status = 'succeeded', finished_at = now() WHERE id = %s",
                  (int(items[0]['id']),))
    listed = client.get('/conversions?batch=' + body['batch_id'], headers=owner).json()
    assert [i['id'] for i in listed['items']] == [i['id'] for i in items] and listed['next'] is None
    # the result card's "Scanning…" reads the owner payload's safety
    assert all(i['output'] == {'file': None, 'album': None} for i in listed['items'])
    assert row(appdb, items[1]['id'])['queued_at'] is not None and row(appdb, items[2]['id'])['queued_at'] is None
    assert 'conversion-' + items[1]['id'] in queued_ids('convert_member')
    assert client.get('/conversions?batch=nope', headers=owner).status_code == 400


def test_batch_shares_one_generated_password(client, appdb):
    _, owner = member(appdb)
    images = [upload_png(client, owner) for _ in range(2)]
    body = convert(client, owner, path='/conversions/batch', files=[i['vanity'] for i in images],
                   generate_password=True, status=202).json()
    passwords = {i['output']['password'] for i in body['items']}
    assert len(passwords) == 1 and len(passwords.pop()) > 10
    settings = [row(appdb, i['id'])['output_settings'] for i in body['items']]
    assert settings[0]['visibility'] == 'password' and settings[0]['password_hash'] == settings[1]['password_hash']


# --- §4.6, images -> PDF ----------------------------------------------------------------------------------------------------

def test_pdf_pages_make_an_album_or_a_zip(client, appdb, quick_worker):
    from tests.m3 import pdf, process
    _, owner = member(appdb)
    created = send(client, owner, pdf(3), 'Slides.pdf', 'application/pdf')
    process(appdb, created)
    made = convert(client, owner, source=created['vanity'], options={'pages': '1-2'}, status=200).json()
    album = made['output']['album']
    assert album['title'] == 'Slides' and album['layout'] == 'grid' and made['output']['file'] is None
    names = [r[0] for r in appdb.fetchall('SELECT f.filename FROM album_files af JOIN files f ON f.id = af.file_id '
                                          'WHERE af.album_id = %s ORDER BY af.position', (int(album['id']),))]
    assert names == ['Slides-p1', 'Slides-p2']
    assert appdb.fetchone('SELECT count(*) FROM files WHERE conversion_id = %s AND derived_from_file_id = %s',
                          (int(made['id']), int(created['id'])))[0] == 2
    visitor = anon()
    made = convert(client, visitor, source=created['vanity'], status=200).json()
    output = made['output']['file']
    assert (output['name'], output['extension'], output['mimetype']) == ('Slides-pages', 'zip', 'application/zip')
    from tests.conftest import s3_object
    blob = s3_object('files/' + str(appdb.fetchone('SELECT hash_id FROM files WHERE id = %s',
                                                   (int(output['id']),))[0]))
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert archive.namelist() == ['Slides-p1.png', 'Slides-p2.png']
        assert {i.compress_type for i in archive.infolist()} == {zipfile.ZIP_STORED}


def test_images_to_pdf(client, appdb):
    _, owner = member(appdb)
    first, second = upload_png(client, owner), upload_png(client, owner)
    text = send(client, owner, uuid.uuid4().bytes * 4, 'notes.txt', 'text/plain')
    response = convert(client, owner, sources=[first['vanity'], text['vanity'], second['vanity']],
                       options={'page_size': 'a4', 'margin_mm': 5}, status=202)
    body = response.json()
    assert body['source']['kind'] == 'images' and body['source']['count'] == 2 and body['target'] == 'pdf'
    assert body['skipped'] == [{'source': text['vanity'], 'code': 'UNSUPPORTED_CONVERSION'}]
    assert appdb.fetchall('SELECT file_id FROM conversion_sources WHERE conversion_id = %s ORDER BY position',
                          (int(body['id']),)) == [(int(first['id']),), (int(second['id']),)]
    album = client.post('/users/@me/albums', headers=owner, json={'file_ids': [second['id'], first['id']],
                                                                  'title': 'Trip'}).json()
    by_album = convert(client, owner, album=album['vanity'], status=202).json()
    assert by_album['source']['album']['vanity'] == album['vanity']
    assert appdb.fetchall('SELECT file_id FROM conversion_sources WHERE conversion_id = %s ORDER BY position',
                          (int(by_album['id']),)) == [(int(second['id']),), (int(first['id']),)]
    assert row(appdb, by_album['id'])['output_settings']['name'] == 'Trip'
    assert error_of(convert(client, owner, sources=[text['vanity']])) == (404, 'SOURCE_UNAVAILABLE')
    assert convert(client, owner, source=first['vanity'], album=album['vanity']).status_code == 400


# --- §5.4: the moderation cascade --------------------------------------------------------------------------------------------

def test_cascade(client, appdb, quick_worker):
    from tests.test_moderation import act
    _, staff = make_staff(appdb)
    _, owner = member(appdb)
    _, converter = member(appdb)
    source = upload_png(client, owner)
    child = convert(client, converter, source=source['vanity'], target='jpg', status=200).json()['output']['file']
    grandchild = convert(client, owner, source=child['vanity'], target='gif', status=200).json()['output']['file']
    # hide cascades; unhide shows only what the cascade hid
    act(client, staff, 'hide', 'file', source['id'], rule='spam')
    run_cascades(appdb)
    assert file_state(appdb, child['id']) == ('hidden', 'derived_from_hidden', False)
    assert file_state(appdb, grandchild['id']) == ('hidden', 'derived_from_hidden', False)
    act(client, staff, 'unhide', 'file', source['id'])
    run_cascades(appdb)
    assert file_state(appdb, child['id']) == ('visible', None, False)
    assert file_state(appdb, grandchild['id']) == ('visible', None, False)
    # remove cascades, recursively, with an audit entry per file
    act(client, staff, 'remove', 'file', source['id'], rule='spam')
    run_cascades(appdb)
    assert file_state(appdb, child['id']) == ('removed', 'derived_from_removed', False)
    assert file_state(appdb, grandchild['id']) == ('removed', 'derived_from_removed', False)
    assert appdb.fetchone("SELECT count(*) FROM moderation_actions WHERE action = 'remove' AND rule = "
                          "'derived_from_removed' AND file_id = ANY(%s)",
                          ([int(child['id']), int(grandchild['id'])],))[0] == 2


def test_cascade_from_a_blocked_hash_and_several_sources(client, appdb, quick_worker):
    from tests.test_moderation import act
    _, staff = make_staff(appdb)
    _, owner = member(appdb)
    _, converter = member(appdb)
    source = upload_png(client, owner)
    child = convert(client, converter, source=source['vanity'], target='jpg', status=200).json()['output']['file']
    act(client, staff, 'block_hash', 'file', source['id'], rule='other')
    run_cascades(appdb)
    assert file_state(appdb, child['id']) == ('removed', 'derived_from_removed', False)
    # images -> PDF: removing any one source removes the output
    first, second = upload_png(client, owner), upload_png(client, owner)
    made = convert(client, converter, sources=[first['vanity'], second['vanity']], status=200).json()
    output = made['output']['file']
    assert appdb.fetchone('SELECT derived_from_file_id FROM files WHERE id = %s', (int(output['id']),))[0] == \
        int(first['id'])
    act(client, staff, 'delete', 'file', second['id'], rule='spam')
    run_cascades(appdb)
    assert file_state(appdb, output['id'])[2] is True
    assert appdb.fetchone('SELECT deleted_reason FROM files WHERE id = %s', (int(output['id']),))[0] == 'moderator'


def test_cascade_takes_pdf_page_albums_with_their_pages(client, appdb, quick_worker):
    from tests.m3 import pdf, process
    from tests.test_moderation import act
    _, staff = make_staff(appdb)
    _, owner = member(appdb)
    _, converter = member(appdb)
    created = send(client, owner, pdf(2), 'Deck.pdf', 'application/pdf')
    process(appdb, created)
    album = convert(client, converter, source=created['vanity'], status=200).json()['output']['album']
    act(client, staff, 'remove', 'file', created['id'], rule='spam')
    run_cascades(appdb)
    assert appdb.fetchone('SELECT moderation_state, moderation_rule FROM albums WHERE id = %s',
                          (int(album['id']),)) == ('removed', 'derived_from_removed')


# --- §9: document previews ---------------------------------------------------------------------------------------------------

DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


@pytest.mark.scan_gating
def test_scanned_documents_of_users_get_a_preview(client, appdb):
    from tests.m4 import hash_id_of, run_scan
    _, owner = member(appdb)
    created = send(client, owner, docx(), 'report.docx', DOCX)
    hash_id = hash_id_of(appdb, created)
    assert run_scan(appdb, created)['scan_state'] == 'passed'
    assert appdb.fetchone('SELECT preview_state FROM file_hashes WHERE id = %s', (hash_id,))[0] == 'queued'
    assert queued_ids('convert_previews') == ['preview-{}'.format(hash_id)]
    from rq.job import Job
    job = Job.fetch('preview-{}'.format(hash_id), connection=rq())
    assert job.func_name == 'jobs.convert.preview' and job.args == (hash_id,)
    # anonymous documents get none
    anonymous_doc = send(client, anon(), docx(), 'anon.docx', DOCX, anonymous_upload=True)
    run_scan(appdb, anonymous_doc)
    assert appdb.fetchone('SELECT preview_state FROM file_hashes WHERE id = %s',
                          (hash_id_of(appdb, anonymous_doc),))[0] == 'none'


def test_the_sweeper_enqueues_queued_previews_and_gives_up(client, appdb):
    from utils import conversions
    _, owner = member(appdb)
    created = send(client, owner, docx(), 'report.docx', DOCX)
    hash_id = appdb.fetchone('SELECT hash_id FROM files WHERE id = %s', (int(created['id']),))[0]
    with db.connect() as conn:
        from utils import document_previews
        assert document_previews.mark(conn, [hash_id]) == [hash_id]
        assert document_previews.mark(conn, [hash_id]) == []
    conversions.sweep(appdb.conn)
    assert convert_queue.job_exists('preview-{}'.format(hash_id))
    for _ in range(conversions.PREVIEW_REQUEUES):
        rq().delete('rq:job:preview-{}'.format(hash_id))
        conversions.sweep(appdb.conn)
    rq().delete('rq:job:preview-{}'.format(hash_id))
    conversions.sweep(appdb.conn)
    assert appdb.fetchone('SELECT preview_state FROM file_hashes WHERE id = %s', (hash_id,))[0] == 'failed'


def test_document_asset_in_payloads(client, appdb):
    from tests.conftest import assert_signed
    _, owner = member(appdb)
    created = send(client, owner, docx(), 'report.docx', DOCX, visibility='private')
    hash_id = appdb.fetchone('SELECT hash_id FROM files WHERE id = %s', (int(created['id']),))[0]
    appdb.execute("INSERT INTO file_hash_assets (hash_id, kind, storage_key, content_type, size, pages) VALUES "
                  "(%s, 'document', %s, 'application/pdf', 1234, 7)", (hash_id, 'derived/{}/document.pdf'.format(hash_id)))
    body = client.get('/users/@me/files/' + created['id'], headers=owner).json()
    document = body['assets']['document']
    assert (document['size'], document['pages']) == (1234, 7)
    assert '/previews/document/{}.pdf?v='.format(created['vanity']) in document['url']
    file_id, version = int(created['id']), appdb.fetchone('SELECT access_version FROM files WHERE id = %s',
                                                          (int(created['id']),))[0]
    assert_signed(document['url'], 'file:{}:{}'.format(file_id, version))


def test_changelog_is_reserved():
    from utils.vanity import is_reserved
    assert is_reserved('changelog') and is_reserved('a/changelog')
