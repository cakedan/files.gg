"""The real server, started with the `sanic` CLI as the Dockerfile does."""

import asyncio
import hashlib
import os
import signal
import tempfile
import time
import uuid

import httpx
from tests.conftest import ServerProcess, hash_of, s3_client, BUCKET


def signed_in(temp, user_id=4242):
    """A user in the server's database, and the headers of a signed-in request (milestone-6: the session
    cookie as the Worker forwards it from files.gg/api; signed-in uploads skip Turnstile and get the
    signed-in single-request limit)."""
    from tests.conftest import cookie_headers, new_session
    temp.execute("INSERT INTO users (id, email, email_verified, username) VALUES (%s, %s, true, %s)",
                 (user_id, 'u{}@example.com'.format(user_id), 'n{}'.format(user_id)))
    return cookie_headers(new_session(user_id, temp))


def live_leases(temp):
    return temp.fetchall(
        "SELECT node_id, holder FROM snowflake_nodes WHERE heartbeat_at > now() - interval '5 minutes' "
        "ORDER BY node_id")


def test_three_workers_lease_three_node_ids_and_release_them(migrated_db):
    server = ServerProcess(migrated_db, '--workers', '3').wait_ready()
    try:
        # every worker leases in before_server_start; give the slowest a moment
        for _ in range(50):
            leases = live_leases(migrated_db)
            if len(leases) == 3:
                break
            time.sleep(0.1)
        assert len({node for node, _ in leases}) == 3
        # one lease per worker process; none for the main process
        assert len({holder.split(':')[1] for _, holder in leases}) == 3
        assert str(server.proc.pid) not in {holder.split(':')[1] for _, holder in leases}
    finally:
        code, output = server.stop(signal.SIGTERM)
    assert code == 0, output
    assert live_leases(migrated_db) == [], output


async def test_200_concurrent_requests(migrated_db, monkeypatch):
    from tests.conftest import rate_limits_env
    # 200 at once from one client: over the global limit and POST /files' 60 a minute (milestone-5 §18.2)
    monkeypatch.setenv('RATE_LIMITS', rate_limits_env(file_upload='1000 per minute'))
    token = signed_in(migrated_db)
    server = ServerProcess(migrated_db, '--workers', '2').wait_ready()
    try:
        limits = httpx.Limits(max_connections=200, max_keepalive_connections=200)
        async with httpx.AsyncClient(base_url=server.url, limits=limits, timeout=60) as client:
            health = await asyncio.gather(*(client.get('/health') for _ in range(200)))
            assert [r.status_code for r in health] == [200] * 200

            bodies = [uuid.uuid4().bytes * 64 for _ in range(200)]
            uploads = await asyncio.gather(*(
                client.post('/files?type=raw&filename=f{}.txt'.format(i), content=body,
                            headers=dict(token, **{'Content-Type': 'text/plain'}))
                for i, body in enumerate(bodies)
            ))
    finally:
        code, output = server.stop()

    assert [r.status_code for r in uploads] == [200] * 200, [r.text for r in uploads if r.status_code != 200][:3]
    created = [r.json() for r in uploads]
    assert len({c['id'] for c in created}) == 200
    assert len({hash_of(migrated_db, c) for c in created}) == 200
    assert len({c['vanity'] for c in created}) == 200
    assert migrated_db.fetchone('SELECT count(*), count(DISTINCT id) FROM files WHERE user_id = 4242') == (200, 200)
    ids = [int(c['id']) for c in created] + [int(hash_of(migrated_db, c)) for c in created]
    assert len(set(ids)) == 400
    assert code == 0, output


def rss_kb(pid, field):
    with open('/proc/{}/status'.format(pid)) as handle:
        for line in handle:
            if line.startswith(field + ':'):
                return int(line.split()[1])
    raise RuntimeError(field)


async def test_streaming_raw_upload_does_not_buffer_the_body(migrated_db):
    token = signed_in(migrated_db)
    server = ServerProcess(migrated_db, '--single-process').wait_ready()
    size = 50 * 1024 * 1024
    chunk = os.urandom(1024 * 1024)
    expected = {'blake2b': hashlib.blake2b(), 'md5': hashlib.md5(), 'sha1': hashlib.sha1()}
    for _ in range(size // len(chunk)):
        for h in expected.values():
            h.update(chunk)

    async def body():
        for _ in range(size // len(chunk)):
            yield chunk

    try:
        headers = dict(token, **{'Content-Type': 'application/octet-stream'})
        async with httpx.AsyncClient(base_url=server.url, timeout=120) as client:
            # warm up the upload path, then measure the peak RSS around a 50 MB upload
            warm = await client.post('/files?type=raw&filename=warm.bin', content=b'x' * 1024 * 1024, headers=headers)
            assert warm.status_code == 200, warm.text
            peak_before = rss_kb(server.proc.pid, 'VmHWM')
            response = await client.post('/files?type=raw&filename=big.bin', content=body(), headers=headers)
            peak_after = rss_kb(server.proc.pid, 'VmHWM')
    finally:
        server.stop()

    assert response.status_code == 200, response.text
    created = response.json()
    assert created['size'] == size
    row = migrated_db.fetchone('SELECT blake2b, md5, sha1, size FROM file_hashes WHERE id = %s', (int(hash_of(migrated_db, created)),))
    assert row == (expected['blake2b'].hexdigest(), expected['md5'].hexdigest(), expected['sha1'].hexdigest(), size)
    stored = hashlib.sha1()
    for block in s3_client().get_object(Bucket=BUCKET, Key='files/' + hash_of(migrated_db, created))['Body'].iter_chunks(1024 * 1024):
        stored.update(block)
    assert stored.hexdigest() == expected['sha1'].hexdigest()
    # the body is on disk; only one 8 MB multipart part is in memory at a time
    grew_mb = (peak_after - peak_before) / 1024
    assert grew_mb < 30, 'peak RSS grew by {:.1f} MB for a 50 MB upload'.format(grew_mb)


async def test_chunked_upload_at_the_limit_across_two_api_workers(migrated_db):
    """The 1 GB chunked limit, scaled down (40 MiB limit, 5 MiB chunks): chunks
    sent in parallel and out of order to a 2-worker server, then finalized by
    `python -m worker`."""
    import random
    import subprocess
    import sys
    from tests.conftest import API_DIR, subprocess_env

    token = signed_in(migrated_db)
    limits = {'LIMIT_CHUNKED_BYTES': str(40 * 1024 * 1024), 'UPLOAD_CHUNK_SIZE': str(5 * 1024 * 1024)}
    server = ServerProcess(migrated_db, '--workers', '2', env=limits).wait_ready()
    worker = subprocess.Popen([sys.executable, '-m', 'worker'], cwd=API_DIR,
                              env=subprocess_env(DATABASE_URL=migrated_db.url, WORKER_POLL_INTERVAL='0.2'),
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    size = 40 * 1024 * 1024
    data = os.urandom(size)
    headers = dict(token)
    try:
        async with httpx.AsyncClient(base_url=server.url, timeout=120) as client:
            response = await client.post('/uploads', headers=headers, json={'filename': 'movie.bin', 'size': size + 1})
            assert response.status_code == 413 and response.json()['code'] == 'FILE_TOO_LARGE'

            session = (await client.post('/uploads', headers=headers,
                                         json={'filename': 'movie.bin', 'size': size})).json()
            upload_id, chunk = session['upload_id'], session['chunk_size']
            assert session['chunk_count'] == 8
            order = list(range(8))
            random.Random(7).shuffle(order)
            order += order[:2]  # some chunks twice (retries are idempotent)
            semaphore = asyncio.Semaphore(4)

            async def send(index):
                async with semaphore:
                    response = await client.put('/uploads/{}/chunks/{}'.format(upload_id, index), headers=headers,
                                                content=data[index * chunk:(index + 1) * chunk])
                    return response.status_code

            assert await asyncio.gather(*(send(i) for i in order)) == [204] * len(order)
            response = await client.post('/uploads/{}/complete'.format(upload_id), headers=headers)
            assert response.status_code == 202 and response.json() == {'status': 'processing'}

            deadline = time.time() + 120
            while time.time() < deadline:
                state = (await client.get('/uploads/' + upload_id, headers=headers)).json()
                if state['status'] != 'processing':
                    break
                await asyncio.sleep(0.25)
    finally:
        worker.terminate()
        worker.wait(timeout=30)
        server.stop()

    assert state['status'] == 'complete', state
    created = state['file']
    assert created['size'] == size and state['received'] == list(range(8))
    row = migrated_db.fetchone('SELECT sha1, size FROM file_hashes WHERE id = %s', (int(hash_of(migrated_db, created)),))
    assert row == (hashlib.sha1(data).hexdigest(), size)
    stored = hashlib.sha1()
    for block in s3_client().get_object(Bucket=BUCKET, Key='files/' + hash_of(migrated_db, created))['Body'].iter_chunks(1 << 20):
        stored.update(block)
    assert stored.hexdigest() == hashlib.sha1(data).hexdigest()
    assert migrated_db.fetchone("SELECT status FROM upload_sessions WHERE id = %s", (int(upload_id),))[0] == 'complete'
