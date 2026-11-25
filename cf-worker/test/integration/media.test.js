// Milestone 3 on cdn.files.gg, on the real Worker (workerd): previews by file vanity, album
// collages and the streamed "Download all" ZIP, with signed URLs for protected targets
// (docs/redesign/contracts/milestone-3.md §3, §5). The API and B2 are local mocks; B2 checks every
// SigV4 signature.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { crc32 as zlibCrc32 } from 'node:zlib';

import JSZip from 'jszip';

import { DAY_S, signUrl } from '../support/signing.js';
import {
  ALBUMS, COLLAGE_VERSION, FILES, NOW_S, OBJECTS, PREVIEWS_VERSION, S3_BUCKET,
  previewPath, signedForAlbum, signedForFile, signedThroughAlbum, startS3, startUpstream, startWorker,
} from '../support/worker.js';


const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://files.gg";
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'private, no-store';

function assertCdnHeaders(headers) {
  assert.equal(headers['content-security-policy'], SANDBOX);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(headers['access-control-allow-origin'], '*');
  assert.equal(headers['access-control-allow-credentials'], undefined);
}

let upstream;
let s3;
let worker;
const cdn = (path, options) => worker.request('https://cdn.files.gg' + path, options);
const preview = (vanity, kind, query = '', options) => cdn(previewPath(vanity, kind) + query, options);
const s3Reads = (key) => s3.requests.filter((r) => r.path === `/${S3_BUCKET}/${key}`);
const previewKey = (vanity, kind) => FILES[vanity].previews[kind].key;
const lookups = (kind, key) => upstream.requests.filter((r) => r.path === `/internal/${kind}/${key}`).length;
const collagePath = (vanity) => `/albums/collage/${vanity}.webp`;
const zipPath = (vanity) => `/albums/download/${vanity}.zip`;

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


describe('/previews/<kind>/<vanity>.<ext> for link files', () => {
  it('serves the preview inline from B2, immutable, sandboxed, from the vanity lookup', async () => {
    const response = await preview('mvid', 'poster', `?v=${PREVIEWS_VERSION}`);
    assert.equal(response.status, 200);
    assert.equal(response.text, 'WEBP poster');
    assert.equal(response.headers['content-type'], 'image/webp');
    assert.equal(response.headers['content-disposition'], 'inline');
    assert.equal(response.headers['cache-control'], IMMUTABLE);
    assertCdnHeaders(response.headers);
    assert.equal(s3Reads(previewKey('mvid', 'poster')).length, 1);
    assert.equal(lookups('files', 'mvid'), 1);
  });

  it('the payload\'s own preview URLs are exactly these paths', async () => {
    const url = new URL(FILES.mvid.file.assets.thumb.url);
    assert.equal(url.pathname, '/previews/thumb/mvid.webp');
    assert.equal((await cdn(url.pathname + url.search)).text, 'WEBP thumb');
    assert.equal(FILES.mvid.file.hover_url, FILES.mvid.file.assets.hover.url);
  });

  it('Content-Type comes from the stored row', async () => {
    const peaks = await preview('maudio', 'peaks');
    assert.equal(peaks.status, 200);
    assert.equal(peaks.headers['content-type'], 'application/json');
    const hover = await preview('mvid', 'hover');
    assert.equal(hover.headers['content-type'], 'video/mp4');
    const display = await preview('mheic', 'display');
    assert.equal(display.status, 200);
    assert.equal(display.text, 'WEBP display');
    const pdf = await preview('mpdf', 'thumb-2x');
    assert.equal(pdf.text, 'WEBP page1 2x');
  });

  it('never serves a stored type that could render as a page', async () => {
    const response = await preview('mhostile', 'thumb');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/webp');
    assertCdnHeaders(response.headers);
  });

  it('passes Range through (hover) and returns 206', async () => {
    const ranged = await preview('mvid', 'hover', '?v=1', { headers: { range: 'bytes=6-9' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.text, '0123');
    assert.equal(ranged.headers['content-range'], `bytes 6-9/${OBJECTS[previewKey('mvid', 'hover')].body.length}`);
    assert.equal(ranged.headers['content-type'], 'video/mp4');
    assert.equal(ranged.headers['content-disposition'], 'inline');
    assertCdnHeaders(ranged.headers);
    assert.equal(s3Reads(previewKey('mvid', 'hover')).at(-1).headers.range, 'bytes=6-9');
  });

  it('404 when the preview isn\'t listed (not made, failed, or not applicable)', async () => {
    const response = await preview('mvid', 'cover');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
    assert.equal(response.headers['cache-control'], undefined);
    assert.equal((await preview('img1', 'thumb')).status, 404, 'a file with no previews');
    assert.equal((await preview('nope', 'thumb')).status, 404, 'an unknown vanity');
    assert.equal((await preview('expired1', 'thumb')).status, 404, 'an expired file');
  });

  it('HEAD has no body; OPTIONS is answered without a lookup', async () => {
    const head = await preview('mvid', 'thumb', '', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-type'], 'image/webp');
    const before = upstream.requests.length;
    const preflight = await cdn(previewPath('mvid', 'thumb'), { method: 'OPTIONS', headers: { origin: 'https://files.gg' } });
    assert.equal(preflight.status, 204);
    assertCdnHeaders(preflight.headers);
    assert.equal(upstream.requests.length, before);
  });

  it('caches the vanity lookup for 5 s, and edge-caches the preview by key and previews_version', async () => {
    await preview('mwave', 'waveform');
    await preview('mwave', 'waveform');
    await preview('mwave', 'peaks');
    await cdn('/files/mwave.ogg');
    assert.equal(lookups('files', 'mwave'), 1, 'one lookup for the file and all its previews');
    assert.equal(s3Reads(previewKey('mwave', 'waveform')).length, 1);
  });

  it('503 while the API is down, not cached', async () => {
    assert.equal(lookups('files', 'thumb'), 0);
    upstream.failLookups.add('thumb');
    const response = await preview('thumb', 'thumb');
    upstream.failLookups.delete('thumb');
    assert.equal(response.status, 503);
    assert.equal(response.headers['cache-control'], NO_STORE);
    assert.equal((await preview('thumb', 'thumb')).status, 200);
  });
});


describe('/previews/ parsing (contract §3)', () => {
  it('multi-segment vanities, and a vanity named like a kind', async () => {
    assert.equal((await cdn('/previews/thumb/thumb.webp')).text, 'WEBP thumb of thumb');
    assert.equal((await cdn('/previews/cover/abcd/cover.webp')).text, 'WEBP deep cover');
    assert.ok(upstream.requests.some((r) => r.path === '/internal/files/abcd/cover'));
    assert.ok(upstream.requests.some((r) => r.path === '/internal/files/thumb'));
  });

  it('a wrong extension, an unknown kind, extra segments and the old /media/ paths: 404 without a lookup', async () => {
    const before = upstream.requests.length;
    for (const path of [
      '/previews/thumb/mvid.png', '/previews/thumb/mvid.jpg', '/previews/hover/mvid.webp', '/previews/peaks/maudio.webp', '/previews/poster/mvid',
      '/previews/original/mvid.mp4', '/previews/preview/mheic.webp', '/previews/thumb@2x/mpdf.webp', '/previews/mvid.webp', '/previews/thumb/',
      '/previews/thumb/mvid.webp/', '/previews/thumb/mvid.webp/extra', '/previews/thumb/mvid.webp/x.webp', '/previews/thumb//mvid.webp',
      `/media/${FILES.mvid.file.id}/poster.webp`, '/media/mvid/poster.webp', '/previews/thumb/%E0%A4%A.webp',
    ]) {
      const response = await cdn(path);
      assert.equal(response.status, 404, path);
      assertCdnHeaders(response.headers);
    }
    assert.equal(upstream.requests.length, before);
  });
});


describe('/previews/document/<vanity>.pdf (milestone-5.md §9.2)', () => {
  it('link file: the PDF inline, as application/pdf, immutable with ?v=, sandboxed', async () => {
    const url = new URL(FILES.mdoc.file.assets.document.url);
    assert.equal(url.pathname, '/previews/document/mdoc.pdf');
    const response = await cdn(url.pathname + url.search);
    assert.equal(response.status, 200);
    assert.equal(response.text, '%PDF-1.7 report');
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['content-disposition'], 'inline');
    assert.equal(response.headers['cache-control'], IMMUTABLE);
    assertCdnHeaders(response.headers);
    assert.equal(s3Reads(previewKey('mdoc', 'document')).length, 1);
  });

  it('always application/pdf, whatever the stored row says', async () => {
    const response = await preview('mdocodd', 'document');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/pdf');
  });

  it('a wrong extension, or a file without the asset, is a 404', async () => {
    assert.equal((await cdn('/previews/document/mdoc.webp')).status, 404);
    assert.equal((await cdn('/previews/document/mdoc')).status, 404);
    assert.equal((await preview('mvid', 'document')).status, 404);
  });

  it('password file: 401 unsigned, 200 with the file grant, never publicly cacheable', async () => {
    const unsigned = await preview('mdocpw', 'document');
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.headers['cache-control'], NO_STORE);
    assert.equal(s3Reads(previewKey('mdocpw', 'document')).length, 0);
    const response = await cdn(signedForFile('mdocpw', previewPath('mdocpw', 'document')));
    assert.equal(response.status, 200);
    assert.equal(response.text, '%PDF-1.7 secret');
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['content-disposition'], 'inline');
    assert.equal(response.headers['cache-control'], NO_STORE);
    // Signed for another file, or a stale version: refused.
    assert.equal((await cdn(signedForFile('mdocpw', previewPath('mdocpw', 'document'), { version: 1 }))).status, 401);
    assert.equal((await cdn(signedForFile('mdoc', previewPath('mdocpw', 'document')))).status, 401);
  });

  it('private file: 404 unsigned, 200 with the owner\'s signed URL', async () => {
    const hidden = await preview('mdocpriv', 'document');
    assert.equal(hidden.status, 404);
    assert.equal(hidden.headers['cache-control'], NO_STORE);
    const response = await cdn(signedForFile('mdocpriv', previewPath('mdocpriv', 'document')));
    assert.equal(response.status, 200);
    assert.equal(response.text, '%PDF-1.7 mine');
  });
});


describe('/previews/ access: the file\'s own rules', () => {
  it('password file: 401 without a signature, before any byte or preview list is touched', async () => {
    for (const kind of ['poster', 'thumb', 'hover']) {
      const response = await preview('mpw', kind);
      assert.equal(response.status, 401, kind);
      assert.equal(response.headers['cache-control'], NO_STORE);
      assertCdnHeaders(response.headers);
    }
    assert.equal(s3Reads(previewKey('mpw', 'poster')).length, 0);
  });

  it('password file: 200 with the file grant, never publicly cacheable, ?v= not signed', async () => {
    const url = signedForFile('mpw', previewPath('mpw', 'thumb'));
    const response = await cdn(`${url}&v=${PREVIEWS_VERSION}`);
    assert.equal(response.status, 200);
    assert.equal(response.text, 'WEBP secret thumb');
    assert.equal(response.headers['cache-control'], NO_STORE);
    assert.equal(response.headers['content-disposition'], 'inline');
    assert.equal((await cdn(`${previewPath('mpw', 'thumb')}?v=1&${url.split('?')[1]}`)).status, 200);
  });

  it('a URL signed for one preview doesn\'t open another, or the file', async () => {
    const thumb = signedForFile('mpw', previewPath('mpw', 'thumb'));
    const query = thumb.split('?')[1];
    assert.equal((await cdn(`${previewPath('mpw', 'poster')}?${query}`)).status, 401);
    assert.equal((await cdn(`/files/mpw.mp4?${query}`)).status, 401);
  });

  it('password file: through an album that shows it', async () => {
    assert.equal((await cdn(signedThroughAlbum('albprot', previewPath('mpw', 'poster')))).status, 200);
    assert.equal((await cdn(signedThroughAlbum('albprot', '/files/mpw.mp4'))).text, 'bytes of hidden.mp4');
    assert.equal((await cdn(signedThroughAlbum('albprot', previewPath('deep/pw', 'poster')))).text, 'WEBP deep poster');
  });

  it('wrong signatures: another file\'s, stale versions, an album that doesn\'t show it, expired, past the cap', async () => {
    const path = previewPath('mpw', 'poster');
    const bad = [
      signedForFile('pw1', path),
      signedForFile('mpw', path, { version: 3 }),
      signedThroughAlbum('albprot', path, { version: 5 }),
      signedThroughAlbum('albpw', path),
      signedForFile('mpw', path, { expires: NOW_S() - 1 }),
      signedForFile('mpw', path, { expires: NOW_S() + 32 * DAY_S }),
      `${path}?t=garbage`,
    ];
    for (const url of bad) {
      const response = await cdn(url);
      assert.equal(response.status, 401, url);
      assert.equal(response.headers['cache-control'], NO_STORE);
    }
  });

  it('a protected preview that doesn\'t exist is still 401 unsigned, 404 signed', async () => {
    assert.equal((await preview('mpw', 'cover')).status, 401);
    const response = await cdn(signedForFile('mpw', previewPath('mpw', 'cover')));
    assert.equal(response.status, 404);
    assert.equal(response.headers['cache-control'], NO_STORE);
  });

  it('private file: 404 unsigned; the owner\'s URL or (§4) its protected album\'s opens it', async () => {
    const hidden = await preview('mpriv', 'thumb');
    assert.equal(hidden.status, 404);
    assert.equal(hidden.headers['cache-control'], NO_STORE);
    assert.equal((await cdn(signedForFile('mpriv', previewPath('mpriv', 'thumb')))).status, 200);
    const viaAlbum = await cdn(signedThroughAlbum('albprot', previewPath('mpriv', 'thumb')));
    assert.equal(viaAlbum.status, 200);
    assert.equal(viaAlbum.headers['cache-control'], NO_STORE);
  });
});


describe('/albums/collage/<vanity>.webp', () => {
  it('a link album\'s collage: inline, immutable, from the vanity lookup', async () => {
    const url = new URL(ALBUMS.albmedia.album.collage.url);
    assert.equal(url.pathname + url.search, `${collagePath('albmedia')}?v=${COLLAGE_VERSION}`);
    const response = await cdn(url.pathname + url.search);
    assert.equal(response.status, 200);
    assert.equal(response.text, 'WEBP collage of albmedia');
    assert.equal(response.headers['content-type'], 'image/webp');
    assert.equal(response.headers['content-disposition'], 'inline');
    assert.equal(response.headers['cache-control'], IMMUTABLE);
    assertCdnHeaders(response.headers);
    assert.equal(lookups('albums', 'albmedia'), 1);
  });

  it('an album whose vanity is "collage"', async () => {
    assert.equal((await cdn('/albums/collage/collage.webp')).text, 'WEBP collage of collage');
  });

  it('404 without a collage, for an unknown vanity, for an album with nothing to show, and for old or malformed paths', async () => {
    for (const path of [
      collagePath('albnocollage'), collagePath('nope'), collagePath('albempty'), '/albums/collage/albmedia.png', '/albums/collage/albmedia',
      `/albums/${ALBUMS.albmedia.album.id}/collage.webp`, '/albums/albmedia/collage.webp', '/albums/cover/albmedia.webp', '/albums/collage/a/albmedia.webp',
    ]) {
      const response = await cdn(path);
      assert.equal(response.status, 404, path);
      assertCdnHeaders(response.headers);
    }
  });

  it('password album: 401 unsigned; 200 (no-store) with the album grant', async () => {
    const locked = await cdn(collagePath('albprot'));
    assert.equal(locked.status, 401);
    assert.equal(locked.headers['cache-control'], NO_STORE);
    const open = await cdn(signedForAlbum('albprot', collagePath('albprot')));
    assert.equal(open.status, 200);
    assert.equal(open.headers['cache-control'], NO_STORE);
  });

  it('password album: a stale version, another album\'s grant, an item\'s file grant, or the ZIP\'s URL are refused', async () => {
    const path = collagePath('albprot');
    const zipQuery = signedForAlbum('albprot', zipPath('albprot')).split('?')[1];
    for (const url of [
      signedForAlbum('albprot', path, { version: 5 }),
      signUrl(path, `album:${ALBUMS.albpw.album.id}:3`),
      signUrl(path, `file:${FILES.mpw.file.id}:4`),
      `${path}?${zipQuery}`,
      signedForAlbum('albprot', path, { expires: NOW_S() + 32 * DAY_S }),
    ]) {
      assert.equal((await cdn(url)).status, 401, url);
    }
  });

  it('private album: 404 unsigned, 200 with the owner\'s signed URL', async () => {
    assert.equal((await cdn(collagePath('albprivate'))).status, 404);
    assert.equal((await cdn(signedForAlbum('albprivate', collagePath('albprivate')))).status, 200);
  });
});


// Raw request that survives a connection cut mid-body (an aborted ZIP).
function rawGet(path) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = http.request({ host: worker.url.hostname, port: worker.url.port, path, headers: { host: 'cdn.files.gg' } }, (res) => {
      res.on('data', (chunk) => chunks.push(chunk));
      const done = (error) => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete, error });
      res.on('end', () => done(null));
      res.on('error', (error) => done(error));
      res.on('close', () => done(new Error('closed')));
    });
    req.on('error', (error) => resolve({ error, body: Buffer.concat(chunks) }));
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}


describe('/albums/download/<vanity>.zip', () => {
  it('streams the shown items, in order, as a valid store-mode ZIP with correct CRCs', async () => {
    const response = await cdn(zipPath('albzip'));
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/zip');
    assert.equal(response.headers['content-disposition'], `attachment; filename="Zip: \\"all\\"_files.zip"; filename*=UTF-8''Zip%3A%20%22all%22_files.zip`);
    assert.equal(response.headers['cache-control'], NO_STORE);
    assertCdnHeaders(response.headers);
    assert.equal(Number(response.headers['content-length']), response.buffer.length, 'exact Content-Length');

    const zip = await JSZip.loadAsync(response.buffer, { checkCRC32: true });
    const expected = [
      ['big.bin', 'zbig'], ['notes.txt', 'za1'], ['notes (2).txt', 'za2'], ['NOTES (3).txt', 'za3'], ['café 日本_.._evil.txt', 'zuni'],
    ];
    assert.deepEqual(Object.keys(zip.files), expected.map(([name]) => name));
    for (const [name, vanity] of expected) {
      const bytes = Buffer.from(await zip.file(name).async('uint8array'));
      const original = Buffer.from(FILES[vanity].bytes.body);
      assert.ok(bytes.equals(original), name);
      assert.equal(zip.files[name]._data.crc32 >>> 0, zlibCrc32(original), name);
    }
    // Store mode with data descriptors and UTF-8 names, on every entry.
    const buffer = response.buffer;
    for (let at = buffer.indexOf('PK\x01\x02'); at !== -1; at = buffer.indexOf('PK\x01\x02', at + 4)) {
      assert.equal(buffer.readUInt16LE(at + 8), 0x0808);
      assert.equal(buffer.readUInt16LE(at + 10), 0);
    }
    assert.ok(FILES.zbig.bytes.body.length > 64 * 1024, 'the big item spans many stream chunks');
    // Password and private files in a link album are never included.
    assert.equal(s3Reads(FILES.zpw.storage.key).length + s3Reads(FILES.zpriv.storage.key).length, 0);
  });

  it('reads items with the read-only key, a plain GET each (no client Range)', async () => {
    const before = s3Reads(FILES.za2.storage.key).length;
    const response = await cdn(zipPath('albzip'), { headers: { range: 'bytes=0-3' } });
    assert.equal(response.status, 200);
    const read = s3Reads(FILES.za2.storage.key);
    assert.equal(read.length, before + 1);
    assert.equal(read.at(-1).headers.range, undefined);
  });

  it('HEAD: the headers and exact length, without reading any item', async () => {
    const before = s3.requests.length;
    const head = await cdn(zipPath('albzip'), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-type'], 'application/zip');
    const full = await cdn(zipPath('albzip'));
    assert.equal(head.headers['content-length'], String(full.buffer.length));
    assert.equal(s3.requests.length - before, 5, 'only the GET read the five items');
  });

  it('a protected album needs a URL signed with the album grant, and then includes every item', async () => {
    const path = zipPath('albzippw');
    const locked = await cdn(path);
    assert.equal(locked.status, 401);
    assert.equal(locked.headers['cache-control'], NO_STORE);
    for (const url of [
      signedForFile('zpw', path), signedForAlbum('albzippw', path, { version: 1 }), signUrl(path, `album:${ALBUMS.albzip.album.id}:0`),
      signedForAlbum('albzippw', collagePath('albzippw')).replace(collagePath('albzippw'), path),
    ]) {
      assert.equal((await cdn(url)).status, 401, url);
    }
    const response = await cdn(signedForAlbum('albzippw', path));
    assert.equal(response.status, 200);
    const zip = await JSZip.loadAsync(response.buffer, { checkCRC32: true });
    assert.deepEqual(Object.keys(zip.files), ['pw.txt', 'priv.txt', 'notes.txt']);
    assert.equal(await zip.file('priv.txt').async('string'), 'private');
    assert.equal(response.headers['content-disposition'], `attachment; filename="Locked zip.zip"; filename*=UTF-8''Locked%20zip.zip`);
  });

  it('over 2 GiB: 413 ZIP_TOO_LARGE, nothing read', async () => {
    const before = s3.requests.length;
    const response = await cdn(zipPath('albhuge'));
    assert.equal(response.status, 413);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers['cache-control'], NO_STORE);
    assertCdnHeaders(response.headers);
    const body = JSON.parse(response.text);
    assert.equal(body.code, 'ZIP_TOO_LARGE');
    assert.equal(body.limit, 2147483648);
    assert.equal(body.status, 413);
    assert.equal(s3.requests.length, before);
  });

  it('exactly 2 GiB is allowed (no ZIP64 needed)', async () => {
    const head = await cdn(zipPath('albexact'), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(2147483648 + 30 + 9 + 16 + 46 + 9 + 22));
  });

  it('the 413 comes after the access check', async () => {
    assert.equal((await cdn(zipPath('albzippw'))).status, 401);
  });

  it('an item missing from storage aborts the stream instead of finishing a short archive', async () => {
    const response = await rawGet(zipPath('albbroken'));
    assert.equal(response.status, 200);
    const declared = Number(response.headers['content-length']);
    assert.ok(response.error || !response.complete || response.body.length < declared, 'the client sees a failed download');
    assert.ok(response.body.length < declared);
  });

  it('404 for an album with nothing to show, an unknown vanity, or an old or malformed path', async () => {
    for (const path of [zipPath('albempty'), zipPath('nope'), `/albums/${ALBUMS.albzip.album.id}/download.zip`, '/albums/albzip/download.zip', '/albums/download/albzip.webp', '/albums/download/albzip']) {
      const response = await cdn(path);
      assert.equal(response.status, 404, path);
      assertCdnHeaders(response.headers);
    }
  });

  it('caches the album lookup for 5 s', async () => {
    assert.equal(lookups('albums', 'albzip'), 1);
  });

  it('the album payload\'s download_url is exactly this path', () => {
    assert.equal(ALBUMS.albzip.album.download_url, `https://cdn.files.gg${zipPath('albzip')}`);
  });
});
