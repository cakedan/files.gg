// cdn.files.gg/files/* on the real Worker (workerd): signed URLs, B2 with SigV4, Range, the edge
// cache and the hardening headers. The API and B2 are local mocks.
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DAY_S, signUrl } from '../support/signing.js';
import {
  ALBUMS, FILES, NOW_S, S3_BUCKET, SECRETS, signedForFile, signedThroughAlbum, startS3, startUpstream, startWorker,
} from '../support/worker.js';


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

const s3Gets = (vanity) => s3.requests.filter((r) => r.path === `/${S3_BUCKET}/${FILES[vanity].storage.key}`);

// An old milestone 2 `?t=` token (base64url(claims).base64url(HMAC)), which the CDN no longer reads.
function oldToken(claims, secret) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}


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


describe('B2 only (milestone-3.md §0)', () => {
  it('404s, sandboxed, when B2 doesn\'t have the object', async () => {
    const response = await cdn('/files/nowhere.txt');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
    assert.equal(s3Gets('nowhere').length, 1);
  });

  it('503 (not 404) without the S3 bindings, and nothing else is tried', async () => {
    const before = upstream.requests.length;
    const unconfigured = await startWorker({ upstream, s3: null }, { vars: { S3_ENDPOINT: '' } });
    try {
      const response = await unconfigured.request('https://cdn.files.gg/files/img1.png');
      assert.equal(response.status, 503);
      assertCdnHeaders(response.headers);
      // Only the internal lookup reached the upstream: no other bucket.
      assert.deepEqual(upstream.requests.slice(before).map((r) => r.path), ['/internal/files/img1']);
    } finally {
      await unconfigured.close();
    }
  });
});


describe('password files: signed URLs (contract §3)', () => {
  it('401 without a signature, with no bytes read', async () => {
    const before = s3Gets('pw1').length;
    const response = await cdn('/files/pw1.png');
    assert.equal(response.status, 401);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assertCdnHeaders(response.headers);
    assert.equal(s3Gets('pw1').length, before);
  });

  it('200 with a URL signed with the file grant, and never publicly cacheable', async () => {
    const response = await cdn(signedForFile('pw1', '/files/pw1.png'));
    assert.equal(response.status, 200);
    assert.equal(response.text, 'bytes of secret.png');
    assert.equal(response.headers['content-disposition'], `inline; filename="secret.png"; filename*=UTF-8''secret.png`);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assertCdnHeaders(response.headers);
  });

  it('?download=true on the same signed URL downloads it (not part of the signature)', async () => {
    const url = signedForFile('pw1', '/files/pw1.png');
    const response = await cdn(`${url}&download=true`);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-disposition'], /^attachment; filename="secret\.png"/);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal((await cdn(`/files/pw1.png?download=true&${url.split('?')[1]}`)).status, 200, 'parameter order doesn\'t matter');
  });

  it('a multi-segment vanity: signed for its exact path', async () => {
    const url = signedForFile('deep/pw', '/files/deep/pw.mp4');
    assert.equal((await cdn(url)).status, 200);
    assert.equal((await cdn(url.replace('/files/deep/pw.mp4', '/files/deep/pw.mov'))).status, 401);
  });

  it('401 for an expired URL, and one past the 31-day cap', async () => {
    assert.equal((await cdn(signedForFile('pw1', '/files/pw1.png', { expires: NOW_S() - 1 }))).status, 401);
    assert.equal((await cdn(signedForFile('pw1', '/files/pw1.png', { expires: NOW_S() + 30 * DAY_S }))).status, 200);
    const tooFar = await cdn(signedForFile('pw1', '/files/pw1.png', { expires: NOW_S() + 32 * DAY_S }));
    assert.equal(tooFar.status, 401);
    assert.equal(tooFar.headers['cache-control'], 'private, no-store');
  });

  it('401 for a URL signed before the access_version changed', async () => {
    assert.equal(FILES.pw1.access.access_version, 2);
    assert.equal((await cdn(signedForFile('pw1', '/files/pw1.png', { version: 1 }))).status, 401);
    assert.equal((await cdn(signedForFile('pw1', '/files/pw1.png', { version: 3 }))).status, 401);
  });

  it('401 for another file\'s URL, an edited path or expiry, another secret, or garbage', async () => {
    const good = signedForFile('pw1', '/files/pw1.png');
    const query = new URLSearchParams(good.split('?')[1]);
    const other = signedForFile('pwname', '/files/pwname.png');
    const bad = [
      `/files/pw1.png?${other.split('?')[1]}`,
      good.replace('/files/pw1.png', '/files/pw1.jpg'),
      `/files/pw1.png?expires=${Number(query.get('expires')) + 1}&sig=${query.get('sig')}`,
      `/files/pw1.png?expires=${query.get('expires')}&sig=${query.get('sig').slice(0, -2)}AA`,
      signUrl('/files/pw1.png', `file:${FILES.pw1.file.id}:2`, { secret: 'not-the-secret' }),
      signUrl('/files/pw1.png', `album:${FILES.pw1.file.id}:2`),
      `/files/pw1.png?expires=${query.get('expires')}`,
      `/files/pw1.png?sig=${query.get('sig')}`,
      '/files/pw1.png?expires=garbage&sig=garbage',
    ];
    for (const url of bad) {
      const response = await cdn(url);
      assert.equal(response.status, 401, url);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
  });

  it('?t= no longer opens anything, however it was signed', async () => {
    const { file, access } = FILES.pw1;
    const claims = { e: NOW_S() + 600, k: 'file', s: 'owner', t: file.id, u: NOW_S(), v: access.access_version };
    for (const secret of ['test-cdn-token-secret', SECRETS.CDN_SIGNING_SECRET]) {
      const response = await cdn(`/files/pw1.png?t=${oldToken(claims, secret)}`);
      assert.equal(response.status, 401);
    }
    assert.equal((await cdn(`/files/priv1.png?t=${oldToken({ ...claims, t: FILES.priv1.file.id, v: 0 }, 'test-cdn-token-secret')}`)).status, 404);
    // ...and a stray ?t= next to a good signature changes nothing.
    assert.equal((await cdn(`${signedForFile('pw1', '/files/pw1.png')}&t=x`)).status, 200);
  });

  it('through an album: album=<vanity> and the album grant, when the file is shown in it', async () => {
    assert.deepEqual(FILES.pwalb.albums, [{ id: ALBUMS.albpw.album.id, vanity: 'albpw', access_version: 3 }]);
    const response = await cdn(signedThroughAlbum('albpw', '/files/pwalb.png'));
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    // One lookup only: never an album lookup.
    assert.ok(!upstream.requests.some((r) => r.path === '/internal/albums/albpw'));
  });

  it('through an album: a stale album version is refused', async () => {
    assert.equal((await cdn(signedThroughAlbum('albpw', '/files/pwalb.png', { version: 2 }))).status, 401);
  });

  it('through an album: refused for an album the file isn\'t in, or when albums is missing', async () => {
    assert.deepEqual(FILES.pw1.albums, []);
    assert.equal((await cdn(signedThroughAlbum('albpw', '/files/pw1.png'))).status, 401);
    assert.equal(FILES.noalbums.albums, undefined);
    assert.equal((await cdn(signedThroughAlbum('albpw', '/files/noalbums.png'))).status, 401);
  });

  it('through an album: the grant must match album=, and an album grant needs album=', async () => {
    const viaAlbum = signedThroughAlbum('albpw', '/files/pwalb.png');
    // album= swapped for another album: that album's grant is computed, and doesn't match.
    assert.equal((await cdn(viaAlbum.replace('album=albpw', 'album=albmedia'))).status, 401);
    // The album grant without album=: the file grant is computed instead.
    assert.equal((await cdn(viaAlbum.replace('album=albpw&', ''))).status, 401);
    // The file grant with album=: the album grant is computed instead.
    assert.equal((await cdn(`${signedForFile('pwalb', '/files/pwalb.png')}&album=albpw`)).status, 401);
  });

  it('a lookup without file.id denies every URL (fail closed)', async () => {
    assert.equal(FILES.noid.file.id, undefined);
    for (const url of ['/files/noid.png', signUrl('/files/noid.png', 'file:undefined:0'), signUrl('/files/noid.png', 'file::0'), signedThroughAlbum('albnoid', '/files/noid.png')]) {
      const response = await cdn(url);
      assert.equal(response.status, 401, url);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
  });
});


describe('private files', () => {
  it('404 without a signature (existence not revealed), whatever the client', async () => {
    for (const headers of [{}, { 'user-agent': 'ShareX/15.0' }, { 'user-agent': 'Discordbot/2.0', accept: 'image/*' }]) {
      const response = await cdn('/files/priv1.png', { headers });
      assert.equal(response.status, 404);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assertCdnHeaders(response.headers);
    }
  });

  it('200 with the owner\'s signed URL (the file grant)', async () => {
    const response = await cdn(signedForFile('priv1', '/files/priv1.png'));
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  it('404 for a bad or expired signature', async () => {
    assert.equal((await cdn(signedForFile('priv1', '/files/priv1.png', { expires: NOW_S() - 1 }))).status, 404);
    assert.equal((await cdn(signedForFile('priv1', '/files/priv1.png', { version: 1 }))).status, 404);
  });

  it('a link album never opens its private item', async () => {
    assert.ok(!FILES.priv1.albums.some((album) => album.vanity === 'alb1'));
    assert.equal((await cdn(signedThroughAlbum('alb1', '/files/priv1.png'))).status, 404);
  });
});


describe('link files ignore signatures', () => {
  it('a link file is public with or without one, and stays publicly cacheable', async () => {
    const plain = await cdn('/files/img1.png');
    const signed = await cdn(signUrl('/files/img1.png', 'file:1:0', { expires: NOW_S() - 1 }));
    assert.equal(plain.status, 200);
    assert.equal(signed.status, 200);
    assert.equal(signed.headers['cache-control'], 'public, max-age=3600');
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

  it('checks access before the cache: a cached protected blob still needs a signature', async () => {
    assert.equal((await cdn(signedForFile('pw1', '/files/pw1.png'))).status, 200);
    assert.equal((await cdn(signedForFile('pw1', '/files/pw1.png'))).status, 200);
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

  it('anything that isn\'t one of the four URL shapes is a 404, with no lookup and no storage read', async () => {
    const before = { upstream: upstream.requests.length, s3: s3.requests.length };
    for (const path of [
      '/', '/nothing/here', '/assets/stable/evil.html', '/assets/stable/favicon.ico', '/favicon.ico', '/files/', '/files',
      `/media/${FILES.mvid.file.id}/thumb.webp`, `/albums/${ALBUMS.albmedia.album.id}/collage.webp`, `/albums/${ALBUMS.albzip.album.id}/download.zip`,
      '/files/%E0%A4%A.png', '/previews/original/img1.png',
    ]) {
      const response = await cdn(path);
      assert.equal(response.status, 404, path);
      assertCdnHeaders(response.headers);
    }
    assert.deepEqual({ upstream: upstream.requests.length, s3: s3.requests.length }, before);
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
});
