// Milestone 4 (trust & safety) on the real Worker (workerd): every state on files.gg pages and on
// cdn.files.gg files, previews, collages and ZIPs; NSFW; serve_inline; the report routes; the staff
// grant; security.txt. The API (extended with milestone-4.md §6.3's fields) and B2 are local mocks.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import JSZip from 'jszip';

import { cases } from '../support/fixtures.js';
import {
  ALBUMS, FILES, S3_BUCKET, WEB_DIST, previewPath, signedForAlbum, signedForFile, signedForStaff,
  startS3, startUpstream, startWorker,
} from '../support/worker.js';


const browser = { ...cases.browser };
const NO_STORE = 'private, no-store';
const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://files.gg";
const BOTS = {
  sharex: { 'user-agent': 'ShareX/15.0' },
  telegram: { 'user-agent': 'TelegramBot (like TwitterBot)' },
  'no accept-language': { 'user-agent': 'Mozilla/5.0', accept: 'text/html' },
  'no accept': { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' },
  'accept image/*': { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', accept: 'image/*' },
  'accept video/*': { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', accept: 'video/*' },
};

let upstream;
let s3;
let worker;
const page = (path, options = {}) => worker.request('https://files.gg' + path, { headers: browser, ...options });
const cdn = (path, options) => worker.request('https://cdn.files.gg' + path, options);
const lookups = (kind, vanity) => upstream.requests.filter((r) => r.path === `/internal/${kind}/${vanity}`).length;
const s3Reads = (key) => s3.requests.filter((r) => r.path === `/${S3_BUCKET}/${key}`).length;

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


// The shell's #root attributes, boot JSON (file, album or report) and meta block.
function parseShell(html) {
  const root = /<div id="root"([^>]*)><\/div>/.exec(html);
  assert.ok(root, 'has #root');
  const attributes = Object.fromEntries([...root[1].matchAll(/ (data-[a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const script = /<div id="root"[^>]*><\/div><script id="(file-data|album-data|report-data)" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const start = html.indexOf('-->', html.indexOf('filesgg:meta:start')) + 3;
  return {
    page: attributes['data-page'],
    state: attributes['data-state'],
    dataId: script ? script[1] : undefined,
    rawData: script ? script[2] : undefined,
    data: script ? JSON.parse(script[2]) : undefined,
    meta: html.slice(start, html.indexOf('<!-- filesgg:meta:end')),
  };
}

const VIEWER_HTML = readFileSync(join(WEB_DIST, 'viewer.html'), 'utf8');
const DEFAULT_META = VIEWER_HTML.slice(VIEWER_HTML.indexOf('-->', VIEWER_HTML.indexOf('filesgg:meta:start')) + 3, VIEWER_HTML.indexOf('<!-- filesgg:meta:end'));


describe('file pages per state (milestone-4.md §10.1, §14.3)', () => {
  it('pending: 200, private no-store, { vanity, pending }, "Checking this file", nothing else', async () => {
    for (const vanity of ['spend', 'spendpw', 'snosafety', 'sflagged']) {
      const response = await page(`/${vanity}.png`);
      assert.equal(response.status, 200, vanity);
      assert.equal(response.headers['cache-control'], NO_STORE, vanity);
      const shell = parseShell(response.text);
      assert.deepEqual([shell.page, shell.state, shell.dataId], ['file', 'pending', 'file-data'], vanity);
      assert.deepEqual(shell.data, { vanity, pending: true });
      assert.match(shell.meta, /<meta property="og:title" content="Checking this file · files\.gg">/);
      assert.doesNotMatch(response.text, new RegExp(`og:image|${FILES[vanity].file.filename.replace('.', '\\.')}|previews/`), vanity);
    }
  });

  it('hidden and removed: 410, no-cache, the public reason, no name', async () => {
    const expected = { shid: 'review', shidpw: 'review', srem: 'copyright', sremmal: 'malware', sremx: 'terms' };
    for (const [vanity, reason] of Object.entries(expected)) {
      const response = await page(`/${vanity}`);
      assert.equal(response.status, 410, vanity);
      assert.equal(response.headers['cache-control'], 'no-cache', vanity);
      const shell = parseShell(response.text);
      assert.deepEqual([shell.page, shell.state, shell.data], ['file', 'removed', { vanity, removed: reason }], vanity);
      assert.match(shell.meta, /<meta property="og:title" content="This file was removed · files\.gg">/);
      assert.doesNotMatch(response.text, new RegExp(`og:image|${FILES[vanity].file.filename.replace(/\./g, '\\.')}`), vanity);
    }
  });

  it('blocked, hash-matched CSAM (lookup 404) and private in any state: missing, 404', async () => {
    for (const vanity of ['sblk', 'sblkpw', 'scsam', 'spendpriv', 'shidpriv', 'nope-never']) {
      const response = await page(`/${vanity}.png`);
      assert.equal(response.status, 404, vanity);
      const shell = parseShell(response.text);
      assert.deepEqual([shell.page, shell.state, shell.data], ['file', 'missing', null], vanity);
      assert.doesNotMatch(response.text, /blocked|never-shown|pending-priv|hidden-priv/, vanity);
    }
  });

  it('blocked looks byte-for-byte like a missing file', async () => {
    const blocked = await page('/sblk');
    const missing = await page('/sblk-not-a-file');
    assert.equal(blocked.text, missing.text);
    assert.equal(blocked.headers['cache-control'], missing.headers['cache-control']);
  });

  it('no state ever redirects a bot or embed to the CDN, except ok', async () => {
    for (const [name, headers] of Object.entries(BOTS)) {
      for (const vanity of ['spend', 'shid', 'srem', 'sblk', 'scsam']) {
        const response = await page(`/${vanity}.png`, { headers });
        assert.notEqual(response.status, 302, `${name} ${vanity}`);
        assert.equal(response.headers.location, undefined, `${name} ${vanity}`);
      }
    }
  });
});


describe('NSFW pages (milestone-4.md §4.6, §10.1)', () => {
  it('an NSFW link file never redirects to the CDN, for any user agent', async () => {
    for (const [name, headers] of Object.entries(BOTS)) {
      for (const vanity of ['snsfw', 'snsfwvid', 'mnsfw']) {
        const response = await page(`/${vanity}`, { headers });
        assert.equal(response.status, 200, `${name} ${vanity}`);
        assert.equal(response.headers.location, undefined, `${name} ${vanity}`);
        const shell = parseShell(response.text);
        assert.deepEqual([shell.state, shell.data.nsfw], ['file', true], `${name} ${vanity}`);
      }
    }
    // The same bots are still redirected for a file that isn't NSFW.
    assert.equal((await page('/img1.png', { headers: BOTS.sharex })).status, 302);
  });

  it('og tags without media: no og:image, og:video or og:audio, "Sensitive content", summary card', async () => {
    for (const vanity of ['snsfw', 'snsfwvid']) {
      const { meta } = parseShell((await page(`/${vanity}`, { headers: BOTS['no accept-language'] })).text);
      assert.doesNotMatch(meta, /og:image|og:video|og:audio|twitter:image|twitter:player|cdn\.files\.gg/, vanity);
      assert.match(meta, /<meta property="og:description" content="Sensitive content · /, vanity);
      assert.match(meta, /<meta name="twitter:card" content="summary">/, vanity);
    }
  });

  it('the album flag: an NSFW item, or the mark, makes the album NSFW, with no collage or og:image', async () => {
    for (const vanity of ['ansfwitem', 'amarked']) {
      const response = await page(`/a/${vanity}`);
      assert.equal(response.status, 200, vanity);
      const shell = parseShell(response.text);
      assert.equal(shell.data.nsfw, true, vanity);
      assert.equal(shell.data.collage, undefined, vanity);
      assert.doesNotMatch(shell.meta, /og:image|collage/, vanity);
    }
    assert.equal(ALBUMS.ansfwitem.album.nsfw, false);
  });

  it('the CDN serves NSFW bytes, previews and collages normally', async () => {
    const file = await cdn('/files/snsfw.png');
    assert.equal(file.status, 200);
    assert.match(file.headers['content-disposition'], /^inline;/);
    assert.equal((await cdn(previewPath('snsfw', 'thumb'))).status, 200);
    assert.equal((await cdn('/albums/collage/ansfwitem.webp')).status, 200);
  });
});


describe('serve_inline: false (milestone-4.md §2.3, §10.2)', () => {
  it('the file downloads as an attachment, whatever its type and ?download', async () => {
    for (const path of ['/files/sraw.png', '/files/sraw.png?download=false', '/files/srawvid.mp4', '/files/srawnone.png']) {
      const response = await cdn(path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers['content-disposition'], /^attachment; filename="/, path);
      assert.equal(response.headers['content-security-policy'], SANDBOX, path);
    }
  });

  it('its previews are 404, even ones that exist', async () => {
    const before = s3.requests.length;
    for (const [vanity, kind] of [['sraw', 'thumb'], ['sraw', 'display'], ['srawvid', 'poster'], ['srawnone', 'thumb']]) {
      assert.ok(FILES[vanity].previews[kind], `${vanity} has ${kind}`);
      assert.equal((await cdn(previewPath(vanity, kind))).status, 404, `${vanity} ${kind}`);
    }
    assert.equal(s3.requests.length, before);
  });

  it('the page shows it as kind "file" with no preview URLs, and embeds no media', async () => {
    const shell = parseShell((await page('/sraw.png')).text);
    assert.equal(shell.state, 'file');
    assert.equal(shell.data.kind, 'file');
    assert.equal(shell.data.assets, undefined);
    assert.equal(shell.data.thumbnail, undefined);
    assert.doesNotMatch(shell.meta, /cdn\.files\.gg|summary_large_image/);
  });
});


describe('album pages per state (milestone-4.md §6.3, §10.1)', () => {
  it('only ok items are shown; the pending count never shows on the page', async () => {
    const response = await page('/a/amix');
    assert.equal(response.status, 200);
    const shell = parseShell(response.text);
    assert.equal(shell.state, 'album');
    assert.deepEqual(shell.data.items.map((item) => item.vanity), ['img1']);
    assert.doesNotMatch(response.text, /pending\.png|hidden\.png|blocked\.png|pending-priv/);
    assert.equal(ALBUMS.amix.pending_count, 1);
  });

  it('nothing shown yet, items pending: pending, 200, private no-store; before locked; private stays missing', async () => {
    for (const vanity of ['apend', 'apendpw', 'anosafety']) {
      const response = await page(`/a/${vanity}`);
      assert.equal(response.status, 200, vanity);
      assert.equal(response.headers['cache-control'], NO_STORE, vanity);
      const shell = parseShell(response.text);
      assert.deepEqual([shell.page, shell.state, shell.data], ['album', 'pending', { vanity, pending: true }], vanity);
      assert.match(shell.meta, /Checking this album · files\.gg/);
      assert.doesNotMatch(response.text, new RegExp(ALBUMS[vanity].album.title), vanity);
    }
    const hidden = await page('/a/apendpriv');
    assert.equal(hidden.status, 404);
    assert.equal(parseShell(hidden.text).state, 'missing');
  });

  it('hidden or removed: 410, no-cache, "This album was removed", even with items pending or locked', async () => {
    const expected = { arem: 'terms', ahid: 'review', ahidpw: 'review', aremhid: 'copyright' };
    for (const [vanity, reason] of Object.entries(expected)) {
      const response = await page(`/a/${vanity}`);
      assert.equal(response.status, 410, vanity);
      assert.equal(response.headers['cache-control'], 'no-cache', vanity);
      const shell = parseShell(response.text);
      assert.deepEqual([shell.page, shell.state, shell.data], ['album', 'removed', { vanity, removed: reason }], vanity);
      assert.match(shell.meta, /<meta property="og:title" content="This album was removed · files\.gg">/);
      assert.doesNotMatch(response.text, new RegExp(`og:image|${ALBUMS[vanity].album.title}`), vanity);
    }
  });
});


describe('CDN files and previews per state (milestone-4.md §10.2, §14.3)', () => {
  const PATHS = (vanity) => [`/files/${vanity}.png`, previewPath(vanity, 'thumb')];

  it('pending, blocked and no safety: 404, private no-store, and B2 is never read', async () => {
    for (const vanity of ['spend', 'sblk', 'snosafety', 'sflagged']) {
      for (const path of PATHS(vanity)) {
        const response = await cdn(path);
        assert.equal(response.status, 404, path);
        assert.equal(response.headers['cache-control'], NO_STORE, path);
        assert.equal(response.headers['content-security-policy'], SANDBOX, path);
      }
      assert.equal(s3Reads(FILES[vanity].storage.key), 0, vanity);
    }
  });

  it('hash-matched CSAM: the lookup is 404, so the CDN is too', async () => {
    for (const path of PATHS('scsam')) {
      assert.equal((await cdn(path)).status, 404, path);
    }
    assert.equal(s3Reads(FILES.scsam.storage.key), 0);
  });

  it('hidden and removed: 410, private no-store, and B2 is never read', async () => {
    for (const vanity of ['shid', 'srem', 'sremx']) {
      for (const path of PATHS(vanity)) {
        const response = await cdn(path);
        assert.equal(response.status, 410, path);
        assert.equal(response.headers['cache-control'], NO_STORE, path);
        assert.equal(response.headers['content-security-policy'], SANDBOX, path);
      }
      assert.equal(s3Reads(FILES[vanity].storage.key), 0, vanity);
    }
  });

  it('access comes first: a hidden password file is 401 unsigned and 410 with a valid signature', async () => {
    for (const path of PATHS('shidpw')) {
      assert.equal((await cdn(path)).status, 401, path);
      const signed = await cdn(signedForFile('shidpw', path));
      assert.equal(signed.status, 410, path);
      assert.equal(signed.headers['cache-control'], NO_STORE, path);
    }
  });

  it('a pending or blocked password file: 401 unsigned, 404 signed; private: 404 either way', async () => {
    for (const [vanity, unsigned] of [['spendpw', 401], ['sblkpw', 401], ['spendpriv', 404], ['shidpriv', 404]]) {
      for (const path of PATHS(vanity)) {
        assert.equal((await cdn(path)).status, unsigned, path);
        const signed = await cdn(signedForFile(vanity, path));
        assert.equal(signed.status, vanity === 'shidpriv' ? 410 : 404, path);
        assert.equal(signed.headers['cache-control'], NO_STORE, path);
      }
    }
  });

  it('ok is served as before', async () => {
    const response = await cdn('/files/img1.png');
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=3600');
  });
});


describe('CDN albums per state (milestone-4.md §10.2)', () => {
  it('the ZIP has only ok items', async () => {
    const response = await cdn('/albums/download/amix.zip');
    assert.equal(response.status, 200);
    const zip = await JSZip.loadAsync(response.buffer);
    assert.deepEqual(Object.keys(zip.files), [FILES.img1.file.filename]);
    for (const vanity of ['spend', 'shid', 'sblk', 'spendpriv']) {
      assert.equal(s3Reads(FILES[vanity].storage.key), 0, vanity);
    }
  });

  it('nothing shown yet: collage and ZIP 404, private no-store', async () => {
    for (const path of ['/albums/collage/apend.webp', '/albums/download/apend.zip', '/albums/collage/anosafety.webp', '/albums/download/anosafety.zip']) {
      const response = await cdn(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers['cache-control'], NO_STORE, path);
    }
    assert.equal(s3Reads(ALBUMS.apend.collage.key), 0);
  });

  it('hidden or removed: collage and ZIP 410, private no-store', async () => {
    for (const vanity of ['arem', 'ahid', 'aremhid']) {
      for (const path of [`/albums/collage/${vanity}.webp`, `/albums/download/${vanity}.zip`]) {
        const response = await cdn(path);
        assert.equal(response.status, 410, path);
        assert.equal(response.headers['cache-control'], NO_STORE, path);
        assert.equal(response.text.includes('ZIP_TOO_LARGE'), false);
      }
    }
    assert.equal(s3Reads(ALBUMS.arem.collage.key), 0);
  });

  it('a hidden password album: 401 unsigned, 410 with the album grant', async () => {
    for (const path of ['/albums/collage/ahidpw.webp', '/albums/download/ahidpw.zip']) {
      assert.equal((await cdn(path)).status, 401, path);
      assert.equal((await cdn(signedForAlbum('ahidpw', path))).status, 410, path);
    }
  });

  it('a hidden album\'s items are not opened through it', async () => {
    assert.deepEqual(FILES.pwalb.albums.map((album) => album.vanity), ['albpw']);
  });
});


describe('the staff grant on the CDN (milestone-4.md §10.3)', () => {
  it('opens a private file and its previews, private no-store, never edge-cached', async () => {
    const path = signedForStaff('sstaff', '/files/sstaff.png');
    const first = await cdn(path);
    assert.equal(first.status, 200);
    assert.equal(first.text, 'bytes of staff-only.png');
    assert.equal(first.headers['cache-control'], NO_STORE);
    assert.equal(first.headers['content-security-policy'], SANDBOX);
    assert.match(first.headers['content-disposition'], /^inline;/);
    await cdn(path);
    assert.equal(s3Reads(FILES.sstaff.storage.key), 2, 'every staff view reads B2: nothing was cached');

    const preview = await cdn(signedForStaff('sstaff', previewPath('sstaff', 'thumb')));
    assert.equal(preview.status, 200);
    assert.equal(preview.headers['cache-control'], NO_STORE);
    await cdn(signedForStaff('sstaff', previewPath('sstaff', 'thumb')));
    assert.equal(s3Reads(FILES.sstaff.previews.thumb.key), 2);
  });

  it('skips the access and safety checks: pending, hidden, removed, (non-CSAM) blocked, protected', async () => {
    for (const vanity of ['spend', 'spendpw', 'spendpriv', 'shid', 'shidpw', 'srem', 'sblk', 'sblkpw', 'snosafety']) {
      for (const path of [`/files/${vanity}.png`, previewPath(vanity, 'thumb')]) {
        const response = await cdn(signedForStaff(vanity, path));
        assert.equal(response.status, 200, path);
        assert.equal(response.headers['cache-control'], NO_STORE, path);
      }
    }
  });

  it('a link file through a staff URL is private no-store too', async () => {
    const response = await cdn(signedForStaff('img1', '/files/img1.png'));
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], NO_STORE);
  });

  it('never for hash-matched CSAM: its lookup is 404, so there is nothing to serve', async () => {
    assert.equal((await cdn(signedForStaff('scsam', '/files/scsam.png'))).status, 404);
    assert.ok(lookups('files', 'scsam') >= 1);
    assert.equal(s3Reads(FILES.scsam.storage.key), 0);
  });

  it('serve_inline: false still forces attachment, and previews stay 404', async () => {
    const response = await cdn(signedForStaff('sraw', '/files/sraw.png'));
    assert.equal(response.status, 200);
    assert.match(response.headers['content-disposition'], /^attachment;/);
    assert.equal((await cdn(signedForStaff('sraw', previewPath('sraw', 'thumb')))).status, 404);
  });

  it('valid for at most 10 minutes, and not once expired', async () => {
    const tooLong = signedForStaff('sstaff', '/files/sstaff.png', { ttl: 601 });
    const expired = signedForStaff('sstaff', '/files/sstaff.png', { ttl: -1 });
    for (const path of [tooLong, expired]) {
      const response = await cdn(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers['cache-control'], NO_STORE, path);
    }
    assert.equal((await cdn(signedForStaff('sstaff', '/files/sstaff.png', { ttl: 600 }))).status, 200);
  });

  it('an invalid staff URL is a bad signature: 401 for password files, 404 for private ones', async () => {
    const wrongStaff = (vanity, path) => signedForStaff(vanity, path, { grantStaffId: '555555555555555556' });
    const otherFile = (vanity, path) => signedForStaff(vanity, path, { fileId: FILES.img1.file.id });
    for (const make of [wrongStaff, otherFile]) {
      assert.equal((await cdn(make('shidpw', '/files/shidpw.png'))).status, 401);
      assert.equal((await cdn(make('sstaff', '/files/sstaff.png'))).status, 404);
      assert.equal((await cdn(make('spendpriv', previewPath('spendpriv', 'thumb')))).status, 404);
      // A link file in a refused state answers for its state.
      assert.equal((await cdn(make('shid', '/files/shid.png'))).status, 410);
      assert.equal((await cdn(make('spend', '/files/spend.png'))).status, 404);
    }
  });

  it('signed for one path: a file URL doesn\'t open a preview, nor another file', async () => {
    const fileUrl = signedForStaff('sstaff', '/files/sstaff.png');
    assert.equal((await cdn(fileUrl.replace('/files/sstaff.png', previewPath('sstaff', 'thumb')))).status, 404);
    assert.equal((await cdn(fileUrl.replace('/files/sstaff.png', '/files/spendpriv.png'))).status, 404);
  });

  it('an invalid staff URL on an ok link file is ignored: public, as before', async () => {
    const response = await cdn(signedForStaff('img1', '/files/img1.png', { grantStaffId: '1' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=3600');
  });

  it('only for files and previews: not album collages or ZIPs', async () => {
    const zip = signedForStaff('sstaff', '/albums/download/arem.zip', { fileId: ALBUMS.arem.album.id });
    assert.equal((await cdn(zip)).status, 410);
  });
});


describe('report routes (milestone-4.md §7.2, §10.1)', () => {
  const report = async (path, data) => {
    const before = upstream.requests.length;
    const response = await page(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['cache-control'], 'no-cache', path);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8', path);
    const shell = parseShell(response.text);
    assert.deepEqual([shell.page, shell.state, shell.dataId, shell.data], ['report', undefined, 'report-data', data], path);
    assert.equal(shell.meta, DEFAULT_META, `${path}: the default meta tags`);
    assert.equal(upstream.requests.length, before, `${path}: no lookup`);
    return response;
  };

  it('/report: the public form', async () => {
    await report('/report', { type: 'any' });
    await report('/report/', { type: 'any' });
  });

  it('/report/a/<vanity>: the album, whatever its state, with no lookup', async () => {
    for (const vanity of ['alb1', 'arem', 'albprivate', 'never-an-album']) {
      await report(`/report/a/${vanity}`, { type: 'album', vanity });
    }
  });

  it('/report/<vanity>[.<ext>]: the file, never saying whether it exists', async () => {
    const paths = {
      '/report/img1': 'img1', '/report/img1.png': 'img1', '/report/abcd/xyz': 'abcd/xyz', '/report/abcd/xyz.jpg': 'abcd/xyz',
      '/report/sblk': 'sblk', '/report/scsam': 'scsam', '/report/priv1': 'priv1', '/report/nope-never': 'nope-never',
      '/report/unlock/view': 'unlock/view', '/report/report/x': 'report/x',
    };
    for (const [path, vanity] of Object.entries(paths)) {
      await report(path, { type: 'file', vanity });
    }
  });

  it('the vanity in #report-data is escaped', async () => {
    const response = await report('/report/%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E', { type: 'file', vanity: '</script><script>alert(1)</script>' });
    assert.doesNotMatch(parseShell(response.text).rawData, /</);
  });

  it('HEAD has no body; other methods are 405', async () => {
    const head = await page('/report/img1', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal((await page('/report', { method: 'POST' })).status, 405);
  });

  it('`report` is reserved: a vanity containing it is missing, without a lookup', async () => {
    const before = upstream.requests.length;
    // the old report paths (milestone-6.md §20.2) included: nothing after a vanity names a page
    for (const path of ['/report.png', '/abc/report/x', '/REPORT/x', '/abc%2Freport', '/img1/report', '/a/alb1/report', '/a/alb1/2/report']) {
      const response = await page(path);
      assert.equal(response.status, 404, path);
      assert.deepEqual([parseShell(response.text).page, parseShell(response.text).state], ['file', 'missing'], path);
    }
    assert.equal(upstream.requests.length, before);
  });
});


describe('security.txt (milestone-4.md §10.4)', () => {
  const BODY = readFileSync(join(WEB_DIST, '.well-known/security.txt'), 'utf8');

  it('files.gg serves it from web/dist as text/plain; charset=utf-8, without a lookup', async () => {
    const before = upstream.requests.length;
    const response = await page('/.well-known/security.txt');
    assert.equal(response.status, 200);
    assert.equal(response.text, BODY);
    assert.match(BODY, /^Contact: mailto:security@files\.gg$/m);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'public, max-age=86400');
    assert.equal(upstream.requests.length, before);
  });

  it('cdn.files.gg serves the same file, with the CDN security headers', async () => {
    const before = upstream.requests.length;
    const response = await cdn('/.well-known/security.txt');
    assert.equal(response.status, 200);
    assert.equal(response.text, BODY);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.headers['content-security-policy'], SANDBOX);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    const head = await cdn('/.well-known/security.txt', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(upstream.requests.length, before);
  });

  it('nothing else under /.well-known/ is served on the CDN', async () => {
    for (const path of ['/.well-known/other.txt', '/.well-known/security.txt.bak', '/.well-known/']) {
      assert.equal((await cdn(path)).status, 404, path);
    }
  });
});

