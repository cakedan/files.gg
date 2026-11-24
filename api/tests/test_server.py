"""The real server, started with the `sanic` CLI as the Dockerfile does."""

import asyncio
import hashlib
import os
import signal
import tempfile
import time
import uuid

import httpx
from tests.conftest import ServerProcess
from utils.tokens import FingerprintToken


def seed(temp):
    temp.execute("INSERT INTO mimetype_types (id) VALUES ('text'), ('application')")
    temp.execute("INSERT INTO mimetypes (id, flags, type_id) VALUES ('text/plain', 0, 'text'), "
                 "('application/octet-stream', 0, 'application')")
    temp.execute("INSERT INTO mimetype_extensions (mimetype_id, extension, priority) VALUES "
                 "('text/plain', 'txt', 1), ('application/octet-stream', 'bin', 0)")


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


async def test_200_concurrent_requests(migrated_db):
    seed(migrated_db)
    storage = tempfile.mkdtemp(prefix='filesgg-concurrency-')
    server = ServerProcess(migrated_db, '--workers', '2',
                           env={'STORAGE_BACKEND': 'local', 'LOCAL_STORAGE_PATH': storage}).wait_ready()
    try:
        limits = httpx.Limits(max_connections=200, max_keepalive_connections=200)
        async with httpx.AsyncClient(base_url=server.url, limits=limits, timeout=60) as client:
            health = await asyncio.gather(*(client.get('/health') for _ in range(200)))
            assert [r.status_code for r in health] == [200] * 200

            fingerprint = FingerprintToken.generate(424242)
            bodies = [uuid.uuid4().bytes * 64 for _ in range(200)]
            uploads = await asyncio.gather(*(
                client.post('/files?type=raw&filename=f{}.txt'.format(i), content=body,
                            headers={'X-Fingerprint': fingerprint, 'Content-Type': 'text/plain'})
                for i, body in enumerate(bodies)
            ))
    finally:
        code, output = server.stop()

    assert [r.status_code for r in uploads] == [200] * 200, [r.text for r in uploads if r.status_code != 200][:3]
    created = [r.json() for r in uploads]
    assert len({c['id'] for c in created}) == 200
    assert len({c['hash'] for c in created}) == 200
    assert len({c['vanity'] for c in created}) == 200
    assert migrated_db.fetchone('SELECT count(*), count(DISTINCT id) FROM files WHERE fingerprint = 424242') == (200, 200)
    ids = [int(c['id']) for c in created] + [int(c['hash']) for c in created]
    assert len(set(ids)) == 400
    assert code == 0, output


def rss_kb(pid, field):
    with open('/proc/{}/status'.format(pid)) as handle:
        for line in handle:
            if line.startswith(field + ':'):
                return int(line.split()[1])
    raise RuntimeError(field)


async def test_streaming_raw_upload_does_not_buffer_the_body(migrated_db):
    seed(migrated_db)
    storage = tempfile.mkdtemp(prefix='filesgg-stream-')
    server = ServerProcess(migrated_db, '--single-process',
                           env={'STORAGE_BACKEND': 'local', 'LOCAL_STORAGE_PATH': storage}).wait_ready()
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
        headers = {'X-Fingerprint': FingerprintToken.generate(777), 'Content-Type': 'application/octet-stream'}
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
    row = migrated_db.fetchone('SELECT blake2b, md5, sha1, size FROM file_hashes WHERE id = %s', (int(created['hash']),))
    assert row == (expected['blake2b'].hexdigest(), expected['md5'].hexdigest(), expected['sha1'].hexdigest(), size)
    with open(os.path.join(storage, 'files', created['hash']), 'rb') as handle:
        stored = hashlib.sha1()
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            stored.update(block)
    assert stored.hexdigest() == expected['sha1'].hexdigest()
    grew_mb = (peak_after - peak_before) / 1024
    assert grew_mb < 20, 'peak RSS grew by {:.1f} MB for a 50 MB upload'.format(grew_mb)
