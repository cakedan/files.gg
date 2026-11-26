// Regional rules (docs/redesign/contracts/milestone-7.md §11.2) on the real Worker (workerd). In
// wrangler's harness `request.cf.country` is always US, so the blocked case runs with
// ADULT_BLOCKED_COUNTRIES=US, and the default (GB) must serve the same requests normally.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cases } from '../support/fixtures.js';
import {
  ALBUMS, FILES, REGION_PREVIEW_KINDS, S3_BUCKET, SECRETS, WEB_DIST, previewPath, signedForAlbum, signedForFile,
  signedForStaff, signedThroughAlbum, startS3, startUpstream, startWorker,
} from '../support/worker.js';


const browser = { ...cases.browser };
const SHAREX = { 'user-agent': 'ShareX/15.0' };
const SPOOFED_COUNTRY = { 'cf-ipcountry': 'GB', 'x-filesgg-client-country': 'GB' };

let upstream;
let s3;
let blocked;
let normal;
let noSecret;

before(async () => {
  upstream = await startUpstream();
  s3 = await startS3();
  blocked = await startWorker({ upstream, s3 }, { vars: { ADULT_BLOCKED_COUNTRIES: 'US' } });
  normal = await startWorker({ upstream, s3 });
  const { ORIGIN_SHARED_SECRET, ...withoutOriginSecret } = SECRETS;
  noSecret = await startWorker({ upstream, s3 }, { secrets: withoutOriginSecret, vars: { ADULT_BLOCKED_COUNTRIES: 'US' } });
});

after(async () => {
  assert.deepEqual(s3.rejected, [], 'every request to B2 carried a valid SigV4 signature');
  await blocked?.close();
  await normal?.close();
  await noSecret?.close();
  await s3?.close();
  await upstream?.close();
});

const at = (worker, host, path, options = {}) => worker.request(`https://${host}${path}`, { headers: browser, ...options });
const s3Reads = (key) => s3.requests.filter((r) => r.path === `/${S3_BUCKET}/${key}`).length;
// Every non-lookup request the API got after `since`: a view would be one.
const apiCallsSince = (since) => upstream.requests.slice(since).filter((r) => !r.path.startsWith('/internal/'));


function parseShell(html) {
  const root = /<div id="root"([^>]*)><\/div>/.exec(html);
  assert.ok(root, 'has #root');
  const attributes = Object.fromEntries([...root[1].matchAll(/ (data-[a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const script = /<div id="root"[^>]*><\/div><script id="(file-data|album-data)" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const start = html.indexOf('-->', html.indexOf('filesgg:meta:start')) + 3;
  return {
    page: attributes['data-page'],
    state: attributes['data-state'],
    dataId: script ? script[1] : undefined,
    data: script ? JSON.parse(script[2]) : undefined,
    meta: html.slice(start, html.indexOf('<!-- filesgg:meta:end')),
  };
}

const VIEWER_HTML = readFileSync(join(WEB_DIST, 'viewer.html'), 'utf8');
const DEFAULT_META = VIEWER_HTML.slice(VIEWER_HTML.indexOf('-->', VIEWER_HTML.indexOf('filesgg:meta:start')) + 3, VIEWER_HTML.indexOf('<!-- filesgg:meta:end'));

// Nothing of the file or album beyond its vanity: no name, title, description, size or URL.
const LEAKS = /adult-secret-name|adult-locked-name|Adult album title|Adult album description|Marked album title|Locked adult title|derived\/|previews\/|collage\//;

function assertRegionPage(response, page, vanity, label = vanity, meta = DEFAULT_META) {
  assert.equal(response.status, 451, label);
  assert.equal(response.headers['cache-control'], 'no-store', label);
  assert.match(response.headers['content-type'], /^text\/html/, label);
  const shell = parseShell(response.text);
  assert.deepEqual([shell.page, shell.state, shell.dataId], [page, 'region', `${page}-data`], label);
  assert.deepEqual(shell.data, { vanity }, label);
  assert.equal(shell.meta, meta, label);
  assert.doesNotMatch(response.text, LEAKS, label);
}

function assertRegionCdn(response, label) {
  assert.equal(response.status, 451, label);
  assert.equal(response.headers['cache-control'], 'no-store', label);
  const body = JSON.parse(response.text);
  assert.equal(body.status, 451, label);
  assert.doesNotMatch(response.text, LEAKS, label);
  assert.equal(response.headers['content-disposition'], undefined, label);
}


describe('viewer shells from a blocked country', () => {
  it('an NSFW file, link or password: 451, the vanity only, the default meta, no view', async () => {
    const since = upstream.requests.length;
    for (const vanity of ['rnsfw', 'rnsfwpw']) {
      assertRegionPage(await at(blocked, 'files.gg', `/${vanity}`), 'file', vanity);
    }
    assert.deepEqual(apiCallsSince(since), []);
  });

  it('bots get the same 451, never a redirect to the CDN', async () => {
    assertRegionPage(await at(blocked, 'files.gg', '/rnsfw.mp4', { headers: SHAREX }), 'file', 'rnsfw', 'sharex');
    assertRegionPage(await at(blocked, 'files.gg', '/rnsfw', { headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*' } }), 'file', 'rnsfw', 'image/*');
  });

  it('an album with an NSFW item, a marked album and a locked NSFW album: 451', async () => {
    for (const vanity of ['rnsfwalb', 'rmarked', 'rnsfwalbpw']) {
      assertRegionPage(await at(blocked, 'files.gg', `/a/${vanity}`), 'album', vanity);
    }
  });

  it('removed keeps its own state; files and albums that are not NSFW are served as before', async () => {
    const removed = await at(blocked, 'files.gg', '/rnsfwrem');
    assert.equal(removed.status, 410);
    assert.equal(parseShell(removed.text).state, 'removed');
    const clean = await at(blocked, 'files.gg', '/rclean');
    assert.equal(clean.status, 200);
    assert.equal(parseShell(clean.text).data.filename, 'clean-name.png');
    assert.equal((await at(blocked, 'files.gg', '/rclean.png', { headers: SHAREX })).status, 302);
    const album = await at(blocked, 'files.gg', '/a/rcleanalb');
    assert.equal(album.status, 200);
    assert.equal(parseShell(album.text).state, 'album');
  });

  it('custom domains reuse the same decisions', async () => {
    // viewer.html's defaults, with the default og:image rehosted like every custom page's.
    const meta = DEFAULT_META.replace('https://files.gg/og-image.png', 'https://i.example.com/og-image.png');
    assertRegionPage(await at(blocked, 'i.example.com', '/rnsfw'), 'file', 'rnsfw', 'custom file', meta);
    assertRegionPage(await at(blocked, 'i.example.com', '/a/rnsfwalb'), 'album', 'rnsfwalb', 'custom album', meta);
    assert.equal((await at(blocked, 'i.example.com', '/rclean')).status, 200);
  });
});


describe('the CDN from a blocked country', () => {
  it("an NSFW file's bytes and every preview kind: 451, nothing read from B2", async () => {
    assertRegionCdn(await at(blocked, 'cdn.files.gg', '/files/rnsfw.mp4'), 'bytes');
    assertRegionCdn(await at(blocked, 'cdn.files.gg', '/files/rnsfw.mp4', { method: 'GET', headers: { range: 'bytes=0-3' } }), 'range');
    for (const kind of REGION_PREVIEW_KINDS) {
      assertRegionCdn(await at(blocked, 'cdn.files.gg', `${previewPath('rnsfw', kind)}?v=${FILES.rnsfw.previews_version}`), kind);
    }
    assert.equal(s3Reads(FILES.rnsfw.storage.key), 0);
    for (const kind of REGION_PREVIEW_KINDS) {
      assert.equal(s3Reads(FILES.rnsfw.previews[kind].key), 0, kind);
    }
  });

  it('a valid signed URL or staff URL does not get past it', async () => {
    assertRegionCdn(await at(blocked, 'cdn.files.gg', signedForFile('rnsfwpw', '/files/rnsfwpw.png')), 'signed file');
    assertRegionCdn(await at(blocked, 'cdn.files.gg', signedForFile('rnsfwpw', previewPath('rnsfwpw', 'thumb'))), 'signed preview');
    assertRegionCdn(await at(blocked, 'cdn.files.gg', signedThroughAlbum('rnsfwalbpw', '/files/rnsfwpw.png')), 'through album');
    assertRegionCdn(await at(blocked, 'cdn.files.gg', signedForStaff('rnsfw', '/files/rnsfw.mp4')), 'staff');
    assertRegionCdn(await at(blocked, 'cdn.files.gg', signedForStaff('rnsfwpw', '/files/rnsfwpw.png')), 'staff, password');
  });

  it("an NSFW album's collage and ZIP: 451, signed or not", async () => {
    for (const vanity of ['rnsfwalb', 'rmarked']) {
      assertRegionCdn(await at(blocked, 'cdn.files.gg', `/albums/collage/${vanity}.webp`), `${vanity} collage`);
      assertRegionCdn(await at(blocked, 'cdn.files.gg', `/albums/download/${vanity}.zip`), `${vanity} zip`);
      assert.equal(s3Reads(ALBUMS[vanity].collage.key), 0, vanity);
    }
    assertRegionCdn(await at(blocked, 'cdn.files.gg', signedForAlbum('rnsfwalbpw', '/albums/collage/rnsfwalbpw.webp')), 'signed collage');
    assertRegionCdn(await at(blocked, 'cdn.files.gg', signedForAlbum('rnsfwalbpw', '/albums/download/rnsfwalbpw.zip')), 'signed zip');
  });

  it('missing and removed keep their answers; clean files and albums are served', async () => {
    assert.equal((await at(blocked, 'cdn.files.gg', '/files/rnsfwrem.png')).status, 410);
    assert.equal((await at(blocked, 'cdn.files.gg', '/files/nothing-here.png')).status, 404);
    assert.equal((await at(blocked, 'cdn.files.gg', '/files/rclean.png')).status, 200);
    assert.equal((await at(blocked, 'cdn.files.gg', previewPath('rclean', 'thumb'))).status, 200);
    assert.equal((await at(blocked, 'cdn.files.gg', '/albums/collage/rcleanalb.webp')).status, 200);
    assert.equal((await at(blocked, 'cdn.files.gg', '/albums/download/rcleanalb.zip')).status, 200);
  });

  it("a custom domain's byte paths too", async () => {
    assertRegionCdn(await at(blocked, 'i.example.com', '/files/rnsfw.mp4'), 'custom bytes');
    assertRegionCdn(await at(blocked, 'i.example.com', previewPath('rnsfw', 'poster')), 'custom preview');
    assertRegionCdn(await at(blocked, 'i.example.com', '/albums/download/rnsfwalb.zip'), 'custom zip');
    assert.equal((await at(blocked, 'i.example.com', '/files/rclean.png')).status, 200);
  });
});


describe('the default (GB) serves the harness country (US) normally', () => {
  it('pages', async () => {
    const file = await at(normal, 'files.gg', '/rnsfw');
    assert.equal(file.status, 200);
    assert.deepEqual([parseShell(file.text).state, parseShell(file.text).data.filename], ['file', 'adult-secret-name.mp4']);
    assert.equal(parseShell((await at(normal, 'files.gg', '/rnsfwpw')).text).state, 'locked');
    const album = await at(normal, 'files.gg', '/a/rnsfwalb');
    assert.equal(album.status, 200);
    assert.equal(parseShell(album.text).data.nsfw, true);
  });

  it('the CDN', async () => {
    assert.equal((await at(normal, 'cdn.files.gg', '/files/rnsfw.mp4')).status, 200);
    for (const kind of REGION_PREVIEW_KINDS) {
      assert.equal((await at(normal, 'cdn.files.gg', previewPath('rnsfw', kind))).status, 200, kind);
    }
    assert.equal((await at(normal, 'cdn.files.gg', signedForFile('rnsfwpw', '/files/rnsfwpw.png'))).status, 200);
    assert.equal((await at(normal, 'cdn.files.gg', '/albums/collage/rnsfwalb.webp')).status, 200);
    assert.equal((await at(normal, 'cdn.files.gg', '/albums/download/rnsfwalb.zip')).status, 200);
  });
});


describe('X-Filesgg-Client-Country (§11.1)', () => {
  const lastApiRequest = () => upstream.requests.findLast((r) => !r.path.startsWith('/internal/'));

  it("is the Worker's own country, with the secret; a client's copies never reach the API", async () => {
    for (const base of ['https://api.files.gg', 'https://files.gg/api']) {
      await blocked.request(`${base}/users/@me`, { headers: { ...SPOOFED_COUNTRY, 'cf-connecting-ip': '203.0.113.9' } });
      const sent = lastApiRequest();
      assert.equal(sent.path, '/users/@me', base);
      assert.equal(sent.headers['x-filesgg-origin-secret'], SECRETS.ORIGIN_SHARED_SECRET, base);
      assert.equal(sent.headers['x-filesgg-client-country'], 'US', base);
      assert.equal(sent.headers['cf-ipcountry'], undefined, base);
    }
  });

  it('is never sent without the secret, and the client copies are still removed', async () => {
    await noSecret.request('https://api.files.gg/users/@me', { headers: SPOOFED_COUNTRY });
    const sent = lastApiRequest();
    assert.equal(sent.headers['x-filesgg-origin-secret'], undefined);
    assert.equal(sent.headers['x-filesgg-client-country'], undefined);
    assert.equal(sent.headers['cf-ipcountry'], undefined);
  });

  it('a client-sent CF-IPCountry never changes the Worker\'s own decision', async () => {
    // GB is blocked by default, but the request's own country (US) decides.
    assert.equal((await at(normal, 'files.gg', '/rnsfw', { headers: { ...browser, ...SPOOFED_COUNTRY } })).status, 200);
    assert.equal((await at(normal, 'cdn.files.gg', '/files/rnsfw.mp4', { headers: SPOOFED_COUNTRY })).status, 200);
    assert.equal((await at(blocked, 'files.gg', '/rnsfw', { headers: { ...browser, 'cf-ipcountry': 'FR' } })).status, 451);
  });

  it('internal lookups never carry it', async () => {
    await blocked.request('https://cdn.files.gg/files/rclean.png', { headers: SPOOFED_COUNTRY });
    const lookup = upstream.requests.findLast((r) => r.path === '/internal/files/rclean');
    assert.equal(lookup.headers['x-filesgg-client-country'], undefined);
    assert.equal(lookup.headers['cf-ipcountry'], undefined);
  });
});
