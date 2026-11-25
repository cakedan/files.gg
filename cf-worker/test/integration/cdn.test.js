// cdn.files.gg on the real Worker (workerd): access checks, B2 with SigV4, the GCS fallback,
// Range, the edge cache and the hardening headers. The API, GCS and B2 are local mocks.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { signToken } from '../../worker/utils/token.js';
import { ALBUMS, FILES, NOW_S, S3_BUCKET, SECRETS, startS3, startUpstream, startWorker } from '../support/worker.js';


const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://files.gg";

function assertCdnHeaders(headers) {
  assert.equal(headers['content-security-policy'], SANDBOX);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(headers['access-control-allow-origin'], '*');
  assert.equal(headers['access-control-allow-credentials'], undefined);
  assert.equal(headers['access-control-expose-headers'], 'Accept-Ranges, Content-Disposition, Content-Length, Content-Range');
}

const token = (vanity, overrides = {}) => signToken({
  k: 'file', t: FILES[vanity].file.id, s: 'unlock', v: FILES[vanity].access.access_version,
  u: NOW_S() - 10, e: NOW_S() + 600, ...overrides,
}, SECRETS.CDN_TOKEN_SECRET);

const s3Gets = (vanity) => s3.requests.filter((r) => r.path === `/${S3_BUCKET}/${FILES[vanity].storage.key}`);


let upstream;
let s3;
let worker;
const cdn = (path, options) => worker.request('https://cdn.files.gg' + path, options);

before(async () => {
  upstream = await startUpstream();
  s3 = await startS3();
  worker = await startWorker({ upstream, s3 });
});

after(async () => {
  assert.deepEqual(s3.rejected, [], 'every request to B2 carried a valid SigV4 signature');
  await worker?.close();
  await s3?.close();
  await upstream?.close();
});


describe('link files from B2', () => {
  it('serves a PNG inline, signed with the read-only key, with the sandbox headers', async () => {
    const response = await cdn('/files/img1.png');
    assert.equal(response.status, 200);
    assert.equal(response.text, 'bytes of cat <photo> & "friends".png');
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['content-disposition'],
      `inline; filename="cat <photo> & \\"friends\\".png"; filename*=UTF-8''cat%20%3Cphoto%3E%20%26%20%22friends%22.png`);
    assert.equal(response.headers['cache-control'], 'public, max-age=3600');
    assertCdnHeaders(response.headers);

    const sent = s3Gets('img1').at(-1);
    assert.match(sent.headers.authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=${SECRETS.S3_READ_ACCESS_KEY_ID}/\\d{8}/us-west-004/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`));
    assert.equal(sent.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
    for (const name of Object.keys(response.headers)) {
      assert.doesNotMatch(name, /^x-(amz|bz|goog)-/, name);
    }
  });

  it('never sends the client\'s other headers to storage', async () => {
    await cdn('/files/img1.png?download=true', { headers: { cookie: 'a=b', authorization: 'Bearer x', 'x-forwarded-for': '1.2.3.4' } });
    const sent = s3Gets('img1').at(-1);
    assert.equal(sent.headers.cookie, undefined);
    assert.match(sent.headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(sent.headers['x-forwarded-for'], undefined);
  });

  it('forces HTML and SVG to text/plain', async () => {
    for (const path of ['/files/html1.html', '/files/svg1.svg', '/files/svg1']) {
      const response = await cdn(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers['content-type'], 'text/plain', path);
      assert.match(response.headers['content-disposition'], /^inline;/, path);
      assertCdnHeaders(response.headers);
    }
  });

  it('downloads PDFs as attachments', async () => {
    const response = await cdn('/files/pdf1.pdf');
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['content-disposition'], `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    assertCdnHeaders(response.headers);
  });

  it('keeps ?download and ?force-text', async () => {
    assert.match((await cdn('/files/vid1.mp4?download=true')).headers['content-disposition'], /^attachment;/);
    const text = await cdn('/files/pdf1.pdf?force-text=true');
    assert.equal(text.headers['content-type'], 'text/plain');
    assert.match(text.headers['content-disposition'], /^inline;/);
  });

  it('resolves multi-segment vanities with and without an extension', async () => {
    for (const path of ['/files/abcd/xyz.jpg', '/files/abcd/xyz', '/files/abcd/xyz.anything.else']) {
      const response = await cdn(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers['content-type'], 'image/jpeg', path);
    }
    assert.ok(upstream.requests.some((r) => r.path === '/internal/files/abcd/xyz'));
  });
});


describe('the B2 mock really checks signatures', () => {
  it('rejects unsigned, forged and write requests', async () => {
    const url = `${s3.origin}/${S3_BUCKET}/${FILES.img1.storage.key}`;
    const { AwsClient } = await import('aws4fetch');
    const forged = new AwsClient({ accessKeyId: SECRETS.S3_READ_ACCESS_KEY_ID, secretAccessKey: 'wrong', service: 's3', region: 'us-west-004', retries: 0 });
    const real = new AwsClient({ accessKeyId: SECRETS.S3_READ_ACCESS_KEY_ID, secretAccessKey: SECRETS.S3_READ_SECRET_ACCESS_KEY, service: 's3', region: 'us-west-004', retries: 0 });
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(await forged.sign(url))).status, 403);
    assert.equal((await fetch(await real.sign(url, { method: 'PUT', body: 'x' }))).status, 403);
    assert.equal((await fetch(await real.sign(url))).status, 200);
    s3.rejected.length = 0;
  });
});


describe('Range and conditional requests', () => {
  it('passes Range through to B2 and returns 206', async () => {
    const response = await cdn('/files/ranged.mp4', { headers: { range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.text, 'cdef');
    assert.equal(response.headers['content-range'], 'bytes 2-5/26');
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['content-type'], 'video/mp4');
    assertCdnHeaders(response.headers);
    assert.equal(s3Gets('ranged').at(-1).headers.range, 'bytes=2-5');
  });

  it('passes If-None-Match through and returns 304', async () => {
    const full = await cdn('/files/ranged.mp4');
    assert.ok(full.headers.etag);
    const response = await cdn('/files/ranged.mp4', { headers: { 'if-none-match': full.headers.etag } });
    assert.equal(response.status, 304);
    assert.equal(s3Gets('ranged').at(-1).headers['if-none-match'], full.headers.etag);
  });

  it('passes If-Modified-Since through', async () => {
    await cdn('/files/ranged.mp4', { headers: { 'if-modified-since': 'Tue, 01 Sep 2026 00:00:00 GMT' } });
    assert.equal(s3Gets('ranged').at(-1).headers['if-modified-since'], 'Tue, 01 Sep 2026 00:00:00 GMT');
  });

  it('keeps an unsatisfiable range a 416', async () => {
    const response = await cdn('/files/ranged.mp4', { headers: { range: 'bytes=100-' } });
    assert.equal(response.status, 416);
    assert.equal(response.headers['content-range'], 'bytes */26');
    assertCdnHeaders(response.headers);
  });

  it('answers HEAD without a body', async () => {
    const response = await cdn('/files/ranged.mp4', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.text, '');
    assert.equal(s3Gets('ranged').at(-1).method, 'HEAD');
  });
});


describe('GCS fallback (contract §3)', () => {
  it('reads a storage.backend "gcs" file from GCS when B2 doesn\'t have it', async () => {
    const response = await cdn('/files/gcsonly.txt');
    assert.equal(response.status, 200);
    assert.equal(response.text, 'bytes of legacy.txt');
    assert.equal(response.headers['x-goog-generation'], undefined);
    assert.ok(upstream.requests.some((r) => r.path === '/' + FILES.gcsonly.storage.key));
  });

  it('during the migration, retries any object B2 doesn\'t have on GCS', async () => {
    const response = await cdn('/files/migrating.txt');
    assert.equal(response.status, 200);
    assert.equal(response.text, 'bytes of not-copied-yet.txt');
    assert.equal(s3Gets('migrating').length, 1);
  });

  it('passes Range through to GCS too', async () => {
    const response = await cdn('/files/gcsonly.txt', { headers: { range: 'bytes=0-4' } });
    assert.equal(response.status, 206);
    assert.equal(response.text, 'bytes');
  });

  it('404s, sandboxed, when neither has the object', async () => {
    const response = await cdn('/files/nowhere.txt');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
  });

  it('with STORAGE_GCS_FALLBACK=false, only storage.backend "gcs" files fall back', async () => {
    const strict = await startWorker({ upstream, s3 }, { vars: { STORAGE_GCS_FALLBACK: 'false' } });
    try {
      assert.equal((await strict.request('https://cdn.files.gg/files/migrating.txt')).status, 404);
      assert.equal((await strict.request('https://cdn.files.gg/files/gcsonly.txt')).status, 200);
    } finally {
      await strict.close();
    }
  });

  it('reads from GCS only when the S3 bindings are not set', async () => {
    const before = s3.requests.length;
    const gcs = await startWorker({ upstream, s3: null }, { vars: { S3_ENDPOINT: '' } });
    try {
      const response = await gcs.request('https://cdn.files.gg/files/gcsonly.txt');
      assert.equal(response.status, 200);
      assert.equal(s3.requests.length, before);
    } finally {
      await gcs.close();
    }
  });
});


describe('password files (contract §1)', () => {
  it('401 without a token, with no bytes read', async () => {
    const before = s3Gets('pw1').length;
    const response = await cdn('/files/pw1.png');
    assert.equal(response.status, 401);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assertCdnHeaders(response.headers);
    assert.equal(s3Gets('pw1').length, before);
  });

  it('200 with a valid token, and never publicly cacheable', async () => {
    const response = await cdn(`/files/pw1.png?t=${await token('pw1')}`);
    assert.equal(response.status, 200);
    assert.equal(response.text, 'bytes of secret.png');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assertCdnHeaders(response.headers);
  });

  it('an owner pass works too', async () => {
    assert.equal((await cdn(`/files/pw1.png?t=${await token('pw1', { s: 'owner' })}`)).status, 200);
  });

  it('401 for an expired token', async () => {
    const expired = await token('pw1', { u: NOW_S() - 7200, e: NOW_S() - 1 });
    assert.equal((await cdn(`/files/pw1.png?t=${expired}`)).status, 401);
  });

  it('401 for a token from before the access_version changed', async () => {
    assert.equal(FILES.pw1.access.access_version, 2);
    assert.equal((await cdn(`/files/pw1.png?t=${await token('pw1', { v: 1 })}`)).status, 401);
  });

  it('401 for another file\'s token, a tampered token, or one signed with another secret', async () => {
    const other = await token('pwname');
    const good = await token('pw1');
    const [body, signature] = good.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), v: 3 })).toString('base64url');
    const foreign = await signToken({ k: 'file', t: FILES.pw1.file.id, s: 'unlock', v: 2, u: NOW_S(), e: NOW_S() + 60 }, 'not-the-secret');
    for (const bad of [other, `${tamperedBody}.${signature}`, foreign, 'garbage', '']) {
      assert.equal((await cdn(`/files/pw1.png?t=${encodeURIComponent(bad)}`)).status, 401, bad.slice(0, 20));
    }
  });

  it('an album token passes with the album\'s id and current access_version', async () => {
    const claims = { k: 'album', t: ALBUMS.albpw.album.id, s: 'unlock', v: 3, u: NOW_S(), e: NOW_S() + 600 };
    assert.deepEqual(FILES.pwalb.albums, [{ id: ALBUMS.albpw.album.id, access_version: 3 }]);
    assert.equal((await cdn(`/files/pwalb.png?t=${await signToken(claims, SECRETS.CDN_TOKEN_SECRET)}`)).status, 200);
    // One lookup only: never an album lookup by id.
    assert.ok(!upstream.requests.some((r) => r.path === `/internal/albums/${ALBUMS.albpw.album.id}`));
  });

  it('an album token fails with a stale access_version (the album\'s password changed)', async () => {
    const claims = { k: 'album', t: ALBUMS.albpw.album.id, s: 'unlock', v: 2, u: NOW_S(), e: NOW_S() + 600 };
    assert.equal((await cdn(`/files/pwalb.png?t=${await signToken(claims, SECRETS.CDN_TOKEN_SECRET)}`)).status, 401);
  });

  it('an album token fails for an unlisted album, or when albums is missing', async () => {
    const claims = { k: 'album', t: ALBUMS.albpw.album.id, s: 'unlock', v: 3, u: NOW_S(), e: NOW_S() + 600 };
    const albumToken = await signToken(claims, SECRETS.CDN_TOKEN_SECRET);
    assert.deepEqual(FILES.pw1.albums, []);
    assert.equal((await cdn(`/files/pw1.png?t=${albumToken}`)).status, 401);
    assert.equal(FILES.noalbums.albums, undefined);
    assert.equal((await cdn(`/files/noalbums.png?t=${albumToken}`)).status, 401);
  });

  it('a lookup without file.id denies every token (fail closed)', async () => {
    assert.equal(FILES.noid.file.id, undefined);
    const fileToken = await signToken({ k: 'file', t: '1', s: 'owner', v: 0, u: NOW_S(), e: NOW_S() + 600 }, SECRETS.CDN_TOKEN_SECRET);
    for (const query of ['', `?t=${fileToken}`]) {
      const response = await cdn(`/files/noid.png${query}`);
      assert.equal(response.status, 401, query);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
  });
});


describe('private files', () => {
  it('404 without a token (existence not revealed), whatever the client', async () => {
    for (const headers of [{}, { 'user-agent': 'ShareX/15.0' }, { 'user-agent': 'Discordbot/2.0', accept: 'image/*' }]) {
      const response = await cdn('/files/priv1.png', { headers });
      assert.equal(response.status, 404);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assertCdnHeaders(response.headers);
    }
  });

  it('200 with an owner pass', async () => {
    const response = await cdn(`/files/priv1.png?t=${await token('priv1', { s: 'owner' })}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });
});


describe('edge cache and lookups', () => {
  it('caches whole blobs by key: the second GET never reaches B2', async () => {
    const first = await cdn('/files/cached1.png');
    const second = await cdn('/files/cached1.png?download=true');
    assert.equal(first.text, second.text);
    assert.match(second.headers['content-disposition'], /^attachment;/);
    assert.equal(s3Gets('cached1').length, 1);
  });

  it('checks access before the cache: a cached protected blob still needs a token', async () => {
    assert.equal((await cdn(`/files/pw1.png?t=${await token('pw1')}`)).status, 200);
    assert.equal((await cdn(`/files/pw1.png?t=${await token('pw1')}`)).status, 200);
    assert.equal((await cdn('/files/pw1.png')).status, 401);
  });

  it('caches lookups for 30 s, negative ones too', async () => {
    const count = (vanity) => upstream.requests.filter((r) => r.path === `/internal/files/${vanity}`).length;
    await cdn('/files/cached1.png');
    assert.equal(count('cached1'), 1);
    await cdn('/files/never-existed.png');
    await cdn('/files/never-existed.png');
    assert.equal(count('never-existed'), 1);
  });

  it('expired files are gone even while their lookup is cached', async () => {
    const response = await cdn('/files/expired1.png');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
  });

  it('503 when the API is down, and that is not cached', async () => {
    upstream.failLookups.add('flaky');
    assert.equal((await cdn('/files/flaky.png')).status, 503);
    upstream.failLookups.delete('flaky');
    assert.equal((await cdn('/files/flaky.png')).status, 404);
  });
});


describe('everything else on cdn.files.gg', () => {
  it('passes an unknown file 404 through, sandboxed', async () => {
    const response = await cdn('/files/nope.png');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
  });

  it('turns a storage 403 on a raw path into a 404, still sandboxed', async () => {
    const response = await cdn('/nothing/here');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
  });

  it('forces markup from the raw storage route to text/plain', async () => {
    const response = await cdn('/assets/stable/evil.html');
    assert.equal(response.headers['content-type'], 'text/plain');
    assertCdnHeaders(response.headers);
  });

  it('never serves the app\'s files from web/dist', async () => {
    const response = await cdn('/assets/brand/files-gg-mark.svg');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
  });

  it('sandboxes the router 405 too', async () => {
    const response = await cdn('/files/img1.png', { method: 'POST', body: 'x' });
    assert.equal(response.status, 405);
    assertCdnHeaders(response.headers);
  });

  it('answers a preflight without a lookup', async () => {
    const before = upstream.requests.length;
    const response = await cdn('/files/img1.png', { method: 'OPTIONS', headers: { origin: 'https://files.gg', 'access-control-request-headers': 'range' } });
    assert.equal(response.status, 204);
    assertCdnHeaders(response.headers);
    assert.equal(upstream.requests.length, before);
  });

  it('serves the old favicon with the CDN headers', async () => {
    const response = await cdn('/favicon.ico');
    assert.equal(response.status, 200);
    assert.equal(response.text, 'ICO');
    assertCdnHeaders(response.headers);
  });
});
