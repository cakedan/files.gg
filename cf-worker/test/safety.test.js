// Milestone 4 (trust & safety) in the Worker's pure code: lookup states (milestone-4.md §6.3), the
// shells for each state (§10.1, §14.3), NSFW, report routes, the staff grant (§10.3, §14.1) and
// the album ZIP's items.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { albumZipPlan } from '../worker/utils/media.js';
import {
  albumSafety,
  cdnStateStatus,
  fileSafety,
  itemShowable,
  pendingCount,
  servesInline,
} from '../worker/utils/safety.js';
import { decideCdnResponse } from '../worker/utils/security.js';
import {
  MAX_STAFF_URL_SECONDS,
  staffGrant,
  verifySignedUrl,
  verifyStaffUrl,
} from '../worker/utils/signing.js';
import {
  PENDING_FILE_TITLE,
  REMOVED_ALBUM_TITLE,
  REMOVED_FILE_TITLE,
  classifyStablePath,
  decideAlbumShell,
  decideFileShell,
  hasReservedSegment,
  visibleAlbumItems,
} from '../worker/utils/viewer.js';
import { signature } from './support/signing.js';


const SECRET = 'test-cdn-signing-secret';
const NOW = Date.UTC(2026, 10, 24, 12);
const NOW_S = NOW / 1000;
const browser = new Headers({ 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en' });
const bots = {
  sharex: new Headers({ 'user-agent': 'ShareX/15.0' }),
  telegram: new Headers({ 'user-agent': 'TelegramBot (like TwitterBot)' }),
  'no accept-language': new Headers({ 'user-agent': 'Mozilla/5.0', accept: 'text/html' }),
  'no accept': new Headers({ 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' }),
  'accept image/*': new Headers({ 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', accept: 'image/*' }),
};

const imageFile = {
  id: '1111', vanity: 'img1', kind: 'image', filename: 'cat.png', mimetype: 'image/png', extension: 'png',
  size: 123456, width: 800, height: 600, cdn_url: 'https://cdn.files.gg/files/img1.png', url: 'https://files.gg/img1.png',
  uploaded_at: NOW_S - 1, expires_at: null, nsfw: false,
  assets: { thumb: { url: 'https://cdn.files.gg/previews/thumb/img1.webp?v=1' } },
  thumbnail: { url: 'https://cdn.files.gg/previews/thumb/img1.webp?v=1', type: 'thumb' },
};
const lookup = (state, { visibility = 'link', reason = null, file = imageFile, extra = {} } = {}) => ({
  status: 'found',
  data: {
    file,
    access: { visibility, access_version: 0, unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: true },
    safety: (state === undefined) ? undefined : { state, reason },
    serve_inline: true,
    ...extra,
  },
});
const shellOf = (state, options) => decideFileShell({ lookup: lookup(state, options), vanity: 'img1', headers: browser, nowMs: NOW });


describe('lookup states (milestone-4.md §6.3)', () => {
  it('fileSafety: known states, public reasons with defaults, and fail closed', () => {
    assert.deepEqual(fileSafety({ safety: { state: 'ok', reason: 'terms' } }), { state: 'ok', reason: null });
    assert.deepEqual(fileSafety({ safety: { state: 'hidden', reason: null } }), { state: 'hidden', reason: 'review' });
    assert.deepEqual(fileSafety({ safety: { state: 'removed' } }), { state: 'removed', reason: 'terms' });
    assert.deepEqual(fileSafety({ safety: { state: 'removed', reason: 'copyright' } }), { state: 'removed', reason: 'copyright' });
    assert.deepEqual(fileSafety({ safety: { state: 'hidden', reason: 'malware' } }), { state: 'hidden', reason: 'malware' });
    assert.deepEqual(fileSafety({ safety: { state: 'removed', reason: 'csam_match' } }), { state: 'removed', reason: 'terms' });
    assert.deepEqual(fileSafety({ safety: { state: 'blocked', reason: 'review' } }), { state: 'blocked', reason: null });
    // Without safety, with an unknown state (the owner-only `flagged` included) or garbage: pending.
    for (const data of [{}, null, { safety: null }, { safety: 'ok' }, { safety: { state: 'flagged' } }, { safety: { state: 'OK' } }]) {
      assert.deepEqual(fileSafety(data), { state: 'pending', reason: null }, JSON.stringify(data));
    }
  });

  it('albumSafety: ok, hidden and removed only', () => {
    assert.deepEqual(albumSafety({ safety: { state: 'ok', reason: null } }), { state: 'ok', reason: null });
    assert.deepEqual(albumSafety({ safety: { state: 'hidden' } }), { state: 'hidden', reason: 'review' });
    assert.deepEqual(albumSafety({ safety: { state: 'removed', reason: 'copyright' } }), { state: 'removed', reason: 'copyright' });
    assert.equal(albumSafety({ safety: { state: 'blocked' } }).state, 'pending');
    assert.equal(albumSafety({}).state, 'pending');
  });

  it('pendingCount and servesInline', () => {
    assert.equal(pendingCount({ pending_count: 3 }), 3);
    for (const value of [undefined, null, 0, -1, '2', 1.5, NaN]) {
      assert.equal(pendingCount({ pending_count: value }), 0, String(value));
    }
    assert.equal(servesInline({ serve_inline: true }), true);
    for (const value of [false, undefined, null, 'true', 1]) {
      assert.equal(servesInline({ serve_inline: value }), false, String(value));
    }
  });

  it('cdnStateStatus: 404 for pending and blocked, 410 for hidden and removed', () => {
    assert.deepEqual(['ok', 'pending', 'hidden', 'removed', 'blocked', 'weird'].map(cdnStateStatus), [null, 404, 410, 410, 404, 404]);
  });

  it('itemShowable: an item that carries a state other than ok or flagged is never shown', () => {
    assert.equal(itemShowable({}, null), true);
    assert.equal(itemShowable({ safety: { state: 'ok' } }, { safety: { state: 'flagged' } }), true);
    assert.equal(itemShowable({ safety: { state: 'pending' } }, null), false);
    assert.equal(itemShowable({}, { safety: { state: 'removed' } }), false);
  });
});


describe('file shells per state (milestone-4.md §10.1, §14.3)', () => {
  it('pending: 200, private no-store, the vanity only, "Checking this file", no image', () => {
    const shell = shellOf('pending');
    assert.deepEqual([shell.page, shell.state, shell.dataId, shell.status, shell.cacheControl], ['file', 'pending', 'file-data', 200, 'private, no-store']);
    assert.deepEqual(shell.data, { vanity: 'img1', pending: true });
    assert.match(shell.meta, new RegExp(`<meta property="og:title" content="${PENDING_FILE_TITLE}">`));
    assert.doesNotMatch(shell.meta, /og:image|cat\.png/);
  });

  it('hidden and removed: 410, no-cache, the public reason, "This file was removed"', () => {
    for (const [state, reason, expected] of [['hidden', 'review', 'review'], ['hidden', null, 'review'], ['removed', 'copyright', 'copyright'], ['removed', 'malware', 'malware'], ['removed', null, 'terms']]) {
      const shell = shellOf(state, { reason });
      assert.deepEqual([shell.state, shell.status, shell.cacheControl], ['removed', 410, 'no-cache'], state);
      assert.deepEqual(shell.data, { vanity: 'img1', removed: expected });
      assert.match(shell.meta, new RegExp(`og:title" content="${REMOVED_FILE_TITLE}"`));
      assert.doesNotMatch(shell.meta, /og:image|cat\.png/);
    }
  });

  it('blocked looks exactly like a missing file, whatever the visibility', () => {
    const missing = decideFileShell({ lookup: { status: 'missing' }, vanity: 'img1', headers: browser, nowMs: NOW });
    for (const visibility of ['link', 'password', 'private']) {
      assert.deepEqual(shellOf('blocked', { visibility }), missing, visibility);
    }
  });

  it('private is missing in every state; a lookup without safety is pending', () => {
    for (const state of ['ok', 'pending', 'hidden', 'removed', 'blocked', undefined]) {
      assert.equal(shellOf(state, { visibility: 'private' }).state, 'missing', String(state));
    }
    assert.equal(shellOf(undefined).state, 'pending');
    assert.equal(shellOf('flagged').state, 'pending');
  });

  it('§14.3: pending beats locked, removed beats locked, locked only when ok', () => {
    assert.equal(shellOf('pending', { visibility: 'password' }).state, 'pending');
    const hidden = shellOf('hidden', { visibility: 'password', reason: 'review' });
    assert.deepEqual([hidden.state, hidden.status, hidden.data], ['removed', 410, { vanity: 'img1', removed: 'review' }]);
    // show_name_when_locked never leaks the name into a pending or removed shell.
    assert.equal(JSON.stringify(hidden).includes('cat.png'), false);
    assert.equal(shellOf('ok', { visibility: 'password' }).state, 'locked');
  });

  it('expired comes before every state', () => {
    const file = { ...imageFile, expires_at: NOW_S - 1 };
    for (const state of ['pending', 'hidden', 'removed']) {
      assert.equal(shellOf(state, { file }).state, 'missing');
    }
  });

  it('never redirects a pending or removed file to the CDN', () => {
    for (const headers of Object.values(bots)) {
      for (const state of ['pending', 'hidden', 'removed']) {
        assert.equal(decideFileShell({ lookup: lookup(state), vanity: 'img1', headers, nowMs: NOW }).redirect, undefined);
      }
    }
  });
});


describe('NSFW (milestone-4.md §4.6, §10.1)', () => {
  const nsfw = { ...imageFile, nsfw: true };

  it('an NSFW link file never redirects to the CDN, for any user agent; others still do', () => {
    for (const [name, headers] of Object.entries(bots)) {
      const shell = decideFileShell({ lookup: lookup('ok', { file: nsfw }), vanity: 'img1', headers, nowMs: NOW });
      assert.equal(shell.redirect, undefined, name);
      assert.deepEqual([shell.state, shell.status, shell.data.nsfw], ['file', 200, true], name);
      assert.equal(decideFileShell({ lookup: lookup('ok'), vanity: 'img1', headers, nowMs: NOW }).redirect, imageFile.cdn_url, name);
    }
  });

  it('og tags without media, starting with "Sensitive content"', () => {
    const shell = decideFileShell({ lookup: lookup('ok', { file: nsfw }), vanity: 'img1', headers: browser, nowMs: NOW });
    assert.doesNotMatch(shell.meta, /og:image|og:video|og:audio|twitter:image|twitter:player/);
    assert.match(shell.meta, /<meta property="og:description" content="Sensitive content · /);
    assert.match(shell.meta, /<meta name="twitter:card" content="summary">/);
  });

  const album = {
    id: '900', vanity: 'alb1', title: 'Trip', url: 'https://files.gg/a/alb1', nsfw: false,
    collage: { url: 'https://cdn.files.gg/albums/collage/alb1.webp?v=5', width: 1200, height: 630 },
    items: [{ ...imageFile, id: '1', visibility: 'link' }, { ...imageFile, id: '2', visibility: 'link', nsfw: true }],
  };
  const albumLookup = (overrides = {}, extra = {}) => ({
    status: 'found',
    data: { album: { ...album, ...overrides }, access: { visibility: 'link', access_version: 0 }, items_access: {}, safety: { state: 'ok', reason: null }, pending_count: 0, ...extra },
  });

  it('the album flag: an NSFW item makes the album NSFW, without a collage or og:image', () => {
    const shell = decideAlbumShell({ lookup: albumLookup(), vanity: 'alb1', nowMs: NOW });
    assert.equal(shell.data.nsfw, true);
    assert.equal(shell.data.collage, undefined);
    assert.doesNotMatch(shell.meta, /og:image|collage/);
  });

  it('a marked album is NSFW too; a clean album keeps its collage', () => {
    const marked = decideAlbumShell({ lookup: albumLookup({ nsfw: true, items: [album.items[0]] }), vanity: 'alb1', nowMs: NOW });
    assert.deepEqual([marked.data.nsfw, marked.data.collage], [true, undefined]);
    const clean = decideAlbumShell({ lookup: albumLookup({ items: [album.items[0]] }), vanity: 'alb1', nowMs: NOW });
    assert.deepEqual([clean.data.nsfw, clean.data.collage], [false, album.collage]);
    assert.match(clean.meta, /og:image/);
  });

  it('the flag only counts shown items', () => {
    const shell = decideAlbumShell({ lookup: albumLookup({ items: [album.items[0], { ...album.items[1], visibility: 'private' }] }), vanity: 'alb1', nowMs: NOW });
    assert.deepEqual([shell.data.items.length, shell.data.nsfw], [1, false]);
  });
});


describe('serve_inline: false (milestone-4.md §2.3)', () => {
  it('the page gets kind "file" and no preview URLs; meta tags never embed the bytes', () => {
    for (const extra of [{ serve_inline: false }, { serve_inline: undefined }]) {
      const shell = decideFileShell({ lookup: lookup('ok', { extra }), vanity: 'img1', headers: browser, nowMs: NOW });
      assert.equal(shell.data.kind, 'file');
      assert.equal(shell.data.assets, undefined);
      assert.equal(shell.data.thumbnail, undefined);
      assert.equal(shell.data.cdn_url, imageFile.cdn_url);
      assert.doesNotMatch(shell.meta, /cdn\.files\.gg|summary_large_image/);
      assert.match(shell.meta, /og-image\.png/);
    }
  });

  it('the CDN forces attachment, ?download or not', () => {
    assert.match(decideCdnResponse({ mimetype: 'image/png', filename: 'a.png', inline: false }).contentDisposition, /^attachment;/);
    assert.match(decideCdnResponse({ mimetype: 'video/mp4', filename: 'a.mp4', inline: false }).contentDisposition, /^attachment;/);
    assert.match(decideCdnResponse({ mimetype: 'image/png', filename: 'a.png' }).contentDisposition, /^inline;/);
  });
});


describe('album shells per state (milestone-4.md §6.3, §10.1)', () => {
  const item = { ...imageFile, id: '1', visibility: 'link' };
  const albumLookup = ({ visibility = 'link', items = [item], safety = { state: 'ok', reason: null }, pending = 0 } = {}) => ({
    status: 'found',
    data: {
      album: { id: '900', vanity: 'alb1', title: 'Secret title', url: 'https://files.gg/a/alb1', items },
      access: { visibility, access_version: 0, show_name_when_locked: true }, items_access: {},
      safety, pending_count: pending,
    },
  });
  const decide = (options) => decideAlbumShell({ lookup: albumLookup(options), vanity: 'alb1', nowMs: NOW });

  it('nothing shown yet and pending_count > 0: pending, 200, private no-store', () => {
    const shell = decide({ items: [], pending: 2 });
    assert.deepEqual([shell.page, shell.state, shell.dataId, shell.status, shell.cacheControl], ['album', 'pending', 'album-data', 200, 'private, no-store']);
    assert.deepEqual(shell.data, { vanity: 'alb1', pending: true });
    assert.match(shell.meta, /Checking this album · files\.gg/);
    assert.doesNotMatch(JSON.stringify(shell), /Secret title/);
  });

  it('pending comes before locked; private stays missing; nothing shown and nothing pending is missing', () => {
    assert.equal(decide({ visibility: 'password', items: [], pending: 1 }).state, 'pending');
    assert.equal(decide({ visibility: 'private', items: [], pending: 1 }).state, 'missing');
    assert.equal(decide({ items: [], pending: 0 }).state, 'missing');
    // Some items shown: the album, with only those.
    assert.equal(decide({ pending: 3 }).state, 'album');
  });

  it('hidden or removed: 410, no-cache, "This album was removed", even with items pending', () => {
    for (const [safety, reason] of [[{ state: 'removed', reason: 'terms' }, 'terms'], [{ state: 'hidden', reason: null }, 'review'], [{ state: 'removed', reason: 'copyright' }, 'copyright']]) {
      for (const options of [{ safety }, { safety, visibility: 'password' }, { safety, items: [], pending: 1 }]) {
        const shell = decide(options);
        assert.deepEqual([shell.state, shell.status, shell.cacheControl, shell.data], ['removed', 410, 'no-cache', { vanity: 'alb1', removed: reason }]);
        assert.match(shell.meta, new RegExp(REMOVED_ALBUM_TITLE));
        assert.doesNotMatch(JSON.stringify(shell), /Secret title/);
      }
    }
    assert.equal(decide({ safety: { state: 'removed' }, visibility: 'private' }).state, 'missing');
  });

  it('an album lookup without safety is pending (fail closed)', () => {
    assert.equal(decide({ safety: null }).state, 'pending');
    assert.equal(decide({ safety: { state: 'blocked' } }).state, 'pending');
  });

  it('items carrying a non-ok state are never shown, and never zipped', () => {
    const items = [item, { ...item, id: '2', safety: { state: 'pending' } }];
    assert.deepEqual(visibleAlbumItems({ album: { items }, access: { visibility: 'link' } }, NOW).map((i) => i.id), ['1']);
    const data = {
      album: { items: [item], next_cursor: 'c' }, access: { visibility: 'link' },
      items_access: {
        1: { visibility: 'link', safety: { state: 'ok' } }, 3: { visibility: 'link', safety: { state: 'ok' } },
        4: { visibility: 'link', safety: { state: 'removed' } }, 5: { visibility: 'link' },
      },
      items_storage: {
        1: { key: 'files/1', size: 1, filename: 'a' }, 3: { key: 'files/3', size: 1, filename: 'b' },
        4: { key: 'files/4', size: 1, filename: 'c' }, 5: { key: 'files/5', size: 1, filename: 'd' },
      },
    };
    // 5 has no `safety` in items_access: fail closed
    assert.deepEqual(albumZipPlan(data, NOW).entries.map((e) => e.id), ['1', '3']);
  });
});


describe('report routes and the reserved segment (milestone-4.md §7.2, §10.1)', () => {
  const report = (path) => classifyStablePath(path);

  it('/report: the public form', () => {
    for (const path of ['/report', '/report/']) {
      assert.deepEqual(report(path), { route: 'report', data: { type: 'any' } }, path);
    }
  });

  it('/a/<vanity>/report (and /a/<vanity>/<n>/report): the album', () => {
    for (const path of ['/a/Ab3dE6gH/report', '/a/Ab3dE6gH/report/', '/a/Ab3dE6gH/3/report']) {
      assert.deepEqual(report(path), { route: 'report', data: { type: 'album', vanity: 'Ab3dE6gH' } }, path);
    }
  });

  it('/<vanity>[.<ext>]/report: the file, multi-segment vanities included', () => {
    const cases = {
      '/abc123/report': 'abc123', '/abc123.png/report': 'abc123', '/abc123/report/': 'abc123',
      '/abcd/xyz/report': 'abcd/xyz', '/abcd/xyz.jpg/report': 'abcd/xyz', '/caf%C3%A9/report': 'café',
      // Never a lookup for `report` itself: a vanity can't contain it.
      '/a/report': 'a',
    };
    for (const [path, vanity] of Object.entries(cases)) {
      assert.deepEqual(report(path), { route: 'report', data: { type: 'file', vanity } }, path);
    }
  });

  it('security.txt is its own route', () => {
    assert.deepEqual(report('/.well-known/security.txt'), { route: 'security-txt' });
  });

  it('a vanity with a `report` segment is missing without a lookup', () => {
    for (const path of ['/report.png', '/abc/report/x', '/REPORT/x', '/abc%2Freport', '/x/Report.png', '/report/abc.png']) {
      assert.equal(report(path).route, 'missing', path);
    }
    assert.equal(hasReservedSegment('reports/x'), false);
    assert.equal(report('/reports').route, 'file');
    assert.equal(report('/reporting/x').route, 'file');
  });

  it('report routes come after the API, the app and static files', () => {
    assert.equal(report('/api/report').route, 'api');
    assert.equal(report('/app/report').route, 'app');
    assert.equal(report('/assets/x/report').route, 'asset');
  });
});


describe('the staff grant (milestone-4.md §10.3, §14.1)', () => {
  const EXPIRES = 1795603600;
  const STAFF = '555555555555555555';
  const FILE_ID = '1234567890123456789';
  const VECTORS = [
    { path: '/files/abc123.png', sig: 'xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk', accepted: true },
    { path: '/previews/thumb/abc123.webp', sig: 'iFEB3jhXpXydlpjhc4oefiKwO4n2afK7iXj3MJ4mIVY', accepted: true },
    // Signed for staff:555555555555555556:…, so the grant built from staff= doesn't match.
    { path: '/files/abc123.png', sig: 'yw_60Ca7UMA3Y07HsKVPtC9j-1TwPAo3rx7Ne4r2Epw', accepted: false },
  ];
  const query = (sig, { staff = STAFF, expires = EXPIRES } = {}) => new URLSearchParams({ staff, expires: String(expires), sig });
  const verify = (path, sig, { now = EXPIRES - 300, fileId = FILE_ID, ...options } = {}) => verifyStaffUrl({
    secret: SECRET, path, query: query(sig, options), fileId, now,
  });

  VECTORS.forEach((vector, i) => {
    it(`vector ${i + 1}: ${vector.path} is ${vector.accepted ? 'accepted' : 'rejected'}`, async () => {
      assert.equal(await verify(vector.path, vector.sig), vector.accepted);
    });
  });

  it('vector 4: the first row is rejected when expires is more than 600 s away', async () => {
    assert.equal(await verify(VECTORS[0].path, VECTORS[0].sig, { now: 1795602900 }), false);
  });

  it('the test helper reproduces every vector, including the rejected one', () => {
    assert.equal(signature('/files/abc123.png', EXPIRES, `staff:${STAFF}:${FILE_ID}`), VECTORS[0].sig);
    assert.equal(signature('/previews/thumb/abc123.webp', EXPIRES, `staff:${STAFF}:${FILE_ID}`), VECTORS[1].sig);
    assert.equal(signature('/files/abc123.png', EXPIRES, `staff:555555555555555556:${FILE_ID}`), VECTORS[2].sig);
  });

  it('valid only while now < expires <= now + 600', async () => {
    assert.equal(MAX_STAFF_URL_SECONDS, 600);
    const [path, sig] = [VECTORS[0].path, VECTORS[0].sig];
    assert.equal(await verify(path, sig, { now: EXPIRES - 600 }), true);
    assert.equal(await verify(path, sig, { now: EXPIRES - 601 }), false);
    assert.equal(await verify(path, sig, { now: EXPIRES - 1 }), true);
    assert.equal(await verify(path, sig, { now: EXPIRES }), false);
    assert.equal(await verify(path, sig, { now: EXPIRES + 1 }), false);
  });

  it('bound to the lookup\'s file id, the path and the staff id', async () => {
    const [path, sig] = [VECTORS[0].path, VECTORS[0].sig];
    assert.equal(await verify(path, sig, { fileId: '1234567890123456780' }), false);
    assert.equal(await verify('/files/abc124.png', sig), false);
    assert.equal(await verify(path, sig, { staff: '555555555555555556' }), false);
    assert.equal(await verify(path, sig, { fileId: null }), false);
    assert.equal(await verify(path, sig, { staff: '' }), false);
    assert.equal(await verify(path, sig, { staff: 'abc' }), false);
    assert.equal(await verifyStaffUrl({ secret: '', path, query: query(sig), fileId: FILE_ID, now: EXPIRES - 300 }), false);
    assert.equal(await verifyStaffUrl({ secret: SECRET, path, query: new URLSearchParams({ expires: String(EXPIRES), sig }), fileId: FILE_ID, now: EXPIRES - 300 }), false);
  });

  it('a staff signature is never a file or album grant, and the reverse', async () => {
    const [path, sig] = [VECTORS[0].path, VECTORS[0].sig];
    const q = new URLSearchParams({ expires: String(EXPIRES), sig });
    assert.equal(await verifySignedUrl({ secret: SECRET, path, query: q, grant: `file:${FILE_ID}:0`, now: EXPIRES - 300 }), false);
    // milestone-3 vector 1 (a file grant) presented as a staff URL.
    assert.equal(await verify(path, '2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8'), false);
  });

  it('staffGrant: decimal ids only', () => {
    assert.equal(staffGrant(STAFF, FILE_ID), `staff:${STAFF}:${FILE_ID}`);
    assert.equal(staffGrant(STAFF, 42), `staff:${STAFF}:42`);
    for (const [staff, file] of [[null, FILE_ID], [STAFF, null], ['1:2', FILE_ID], [STAFF, '1:2'], [' 5', FILE_ID], [5, FILE_ID]]) {
      assert.equal(staffGrant(staff, file), null, `${staff} ${file}`);
    }
  });
});
