// CDN path parsing, preview types and the album ZIP plan (worker/utils/media.js, milestone-3.md §3-5).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PREVIEW_KINDS,
  ZIP_LIMIT,
  ZIP_MAX_ENTRIES,
  albumZipPlan,
  parseAlbumPath,
  parseFilePath,
  parsePreviewPath,
  previewContentType,
  zipEntryName,
  zipFilename,
} from '../worker/utils/media.js';


describe('parseFilePath: /files/<vanity>.<ext>', () => {
  it('the vanity is everything before the first dot, multi-segment vanities included', () => {
    assert.deepEqual(parseFilePath('/files/abc123.png'), { vanity: 'abc123' });
    assert.deepEqual(parseFilePath('/files/abc123'), { vanity: 'abc123' });
    assert.deepEqual(parseFilePath('/files/abcd/xyz.png'), { vanity: 'abcd/xyz' });
    assert.deepEqual(parseFilePath('/files/abcd/xyz.png.zip'), { vanity: 'abcd/xyz' });
    assert.deepEqual(parseFilePath('/files/caf%C3%A9.png'), { vanity: 'caf\u00e9' });
  });

  it('rejects empty vanities and segments, bad escapes and encoded separators', () => {
    for (const path of ['/files/', '/files/.png', '/files//a.png', '/files/a//b.png', '/files/a/.png', '/files/%E0%A4%A.png', '/files/a%2Fb.png', '/files/a%2Eb', '/previews/thumb/a.webp', '/file/a.png', `/files/${'a'.repeat(257)}.png`]) {
      assert.equal(parseFilePath(path), null, path);
    }
  });
});

describe('parsePreviewPath: /previews/<kind>/<vanity>.<kind ext>', () => {
  it('accepts every kind in the fixed set with its own extension', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(PREVIEW_KINDS).map(([kind, { ext }]) => [kind, ext])), {
      thumb: 'webp', 'thumb-2x': 'webp', display: 'webp', poster: 'webp', cover: 'webp', waveform: 'webp', peaks: 'json', hover: 'mp4',
    });
    for (const [kind, { ext }] of Object.entries(PREVIEW_KINDS)) {
      assert.deepEqual(parsePreviewPath(`/previews/${kind}/abc123.${ext}`), { kind, vanity: 'abc123' }, kind);
    }
  });

  it('multi-segment vanities, and a vanity that is itself a kind name', () => {
    assert.deepEqual(parsePreviewPath('/previews/thumb/abcd/xyz.webp'), { kind: 'thumb', vanity: 'abcd/xyz' });
    assert.deepEqual(parsePreviewPath('/previews/thumb/thumb.webp'), { kind: 'thumb', vanity: 'thumb' });
    assert.deepEqual(parsePreviewPath('/previews/poster/thumb/cover.webp'), { kind: 'poster', vanity: 'thumb/cover' });
    assert.deepEqual(parsePreviewPath('/previews/hover/hover.mp4'), { kind: 'hover', vanity: 'hover' });
  });

  it('a wrong extension for the kind is not a preview', () => {
    for (const path of ['/previews/thumb/abc.png', '/previews/thumb/abc.json', '/previews/peaks/abc.webp', '/previews/hover/abc.webp', '/previews/poster/abc.mp4', '/previews/thumb/abc.WEBP', '/previews/thumb/abc', '/previews/thumb/abc.webp.webp']) {
      assert.equal(parsePreviewPath(path), null, path);
    }
  });

  it('an unknown kind, or none, is not a preview', () => {
    for (const path of ['/previews/original/abc.png', '/previews/thumb@2x/abc.webp', '/previews/preview/abc.webp', '/previews/THUMB/abc.webp', '/previews/collage/abc.webp', '/previews/abc.webp', '/previews/', '/previews/thumb', '/previews//abc.webp', '/previews/constructor/abc.webp', '/previews/__proto__/abc.webp']) {
      assert.equal(parsePreviewPath(path), null, path);
    }
  });

  it('extra or empty segments: nothing after the extension, no empty vanity', () => {
    for (const path of ['/previews/thumb/abc.webp/', '/previews/thumb/abc.webp/extra', '/previews/thumb/abc.webp/x.webp', '/previews/thumb/.webp', '/previews/thumb//abc.webp', '/previews/thumb/a//b.webp', '/previews/thumb/%2e%2e/x.webp', '/previews/thumb/a%2Fb.webp']) {
      assert.equal(parsePreviewPath(path), null, path);
    }
  });
});

describe('parseAlbumPath: /albums/collage/<vanity>.webp and /albums/download/<vanity>.zip', () => {
  it('accepts the two resources with their extensions', () => {
    assert.deepEqual(parseAlbumPath('/albums/collage/Ab3dE6gH.webp'), { resource: 'collage', vanity: 'Ab3dE6gH' });
    assert.deepEqual(parseAlbumPath('/albums/download/Ab3dE6gH.zip'), { resource: 'download', vanity: 'Ab3dE6gH' });
    assert.deepEqual(parseAlbumPath('/albums/collage/collage.webp'), { resource: 'collage', vanity: 'collage' });
  });

  it('rejects wrong extensions, unknown resources, ids-first paths and extra segments', () => {
    for (const path of [
      '/albums/collage/Ab3dE6gH.zip', '/albums/download/Ab3dE6gH.webp', '/albums/download/Ab3dE6gH', '/albums/cover/Ab3dE6gH.webp',
      '/albums/1234567890123456789/collage.webp', '/albums/1234567890123456789/download.zip', '/albums/collage/a/b.webp',
      '/albums/download/Ab3dE6gH.zip/x', '/albums/collage/.webp', '/albums/collage/', '/albums/Ab3dE6gH.zip',
    ]) {
      assert.equal(parseAlbumPath(path), null, path);
    }
  });
});

describe('previewContentType', () => {
  it('uses the stored row\'s type, but never one that renders as a page', () => {
    assert.equal(previewContentType('thumb', { content_type: 'image/webp' }), 'image/webp');
    assert.equal(previewContentType('hover', { content_type: 'video/mp4' }), 'video/mp4');
    assert.equal(previewContentType('peaks', {}), 'application/json');
    assert.equal(previewContentType('thumb', { content_type: 'text/html; charset=utf-8' }), 'image/webp');
    assert.equal(previewContentType('thumb', { content_type: 'image/svg+xml' }), 'image/webp');
  });
});


describe('albumZipPlan', () => {
  const OK = { state: 'ok', reason: null };
  const item = (id, filename, visibility = 'link', extra = {}) => ({ id, filename, visibility, size: 10, ...extra });
  const storage = (id, size = 10, filename = 'x') => ({ key: `files/${id}`, size, filename });
  const data = (visibility, items, overrides = {}) => ({
    album: { id: '9', vanity: 'Ab3dE6gH', title: 'Trip', items },
    access: { visibility, access_version: 0 },
    items_access: Object.fromEntries(items.map((i) => [i.id, { visibility: i.visibility, access_version: 0, safety: OK, expires_at: i.expires_at ?? null }])),
    items_storage: Object.fromEntries(items.map((i) => [i.id, storage(i.id, i.size)])),
    ...overrides,
  });

  it('shown items in album order, cleaned and de-duplicated names, link items only in a link album', () => {
    const plan = albumZipPlan(data('link', [
      item('3', 'b.png', 'link', { position: 2 }),
      item('1', 'a.png', 'link', { position: 0 }),
      item('2', 'A.png', 'link', { position: 1 }),
      item('4', 'secret.png', 'password', { position: 3 }),
      item('5', 'mine.png', 'private', { position: 4 }),
      item('6', 'evil‮/../x.txt', 'link', { position: 5 }),
      item('7', 'gone.png', 'link', { position: 6, expires_at: Math.floor(Date.now() / 1000) - 1 }),
    ]));
    assert.deepEqual(plan.entries.map((e) => [e.id, e.name]), [['1', 'a.png'], ['2', 'A (2).png'], ['3', 'b.png'], ['6', 'evil_.._x.txt']]);
    assert.equal(plan.total, 40);
    assert.equal(plan.tooLarge, false);
    assert.deepEqual(plan.entries[0].storage, storage('1'));
  });

  it('entry dates come from uploaded_at, in epoch seconds', () => {
    const plan = albumZipPlan(data('link', [item('1', 'a.png', 'link', { uploaded_at: 1795600000 }), item('2', 'b.png')]));
    assert.equal(plan.entries[0].date.toISOString(), new Date(1795600000 * 1000).toISOString());
    assert.equal(plan.entries[1].date, null);
  });

  it('a protected album zips every item', () => {
    const plan = albumZipPlan(data('password', [item('1', 'a.png', 'private'), item('2', 'b.png', 'password'), item('3', 'c.png')]));
    assert.deepEqual(plan.entries.map((e) => e.id), ['1', '2', '3']);
  });

  it('items without a storage entry are skipped', () => {
    const d = data('link', [item('1', 'a.png'), item('2', 'b.png')]);
    delete d.items_storage['2'];
    assert.deepEqual(albumZipPlan(d).entries.map((e) => e.id), ['1']);
  });

  it('a paginated payload adds the rest from items_storage, with the same visibility rule', () => {
    const d = data('link', [item('1', 'a.png')], {});
    d.album.next_cursor = 'abc';
    d.items_storage['8'] = storage('8', 5, 'later.png');
    d.items_access['8'] = { visibility: 'link', access_version: 0, safety: OK };
    d.items_storage['9'] = storage('9', 5, 'hidden.png');
    d.items_access['9'] = { visibility: 'password', access_version: 0, safety: OK };
    assert.deepEqual(albumZipPlan(d).entries.map((e) => [e.id, e.name]), [['1', 'a.png'], ['8', 'later.png']]);
    delete d.album.next_cursor;
    assert.deepEqual(albumZipPlan(d).entries.map((e) => e.id), ['1']);
  });

  it('the cap: exactly 2 GiB is fine, one byte more is too large', () => {
    assert.equal(ZIP_LIMIT, 2147483648);
    const at = data('link', [item('1', 'a', 'link', { size: ZIP_LIMIT - 1 }), item('2', 'b', 'link', { size: 1 })]);
    assert.equal(albumZipPlan(at).tooLarge, false);
    const over = data('link', [item('1', 'a', 'link', { size: ZIP_LIMIT - 1 }), item('2', 'b', 'link', { size: 2 })]);
    assert.equal(albumZipPlan(over).tooLarge, true);
    // Hidden items don't count.
    const hidden = data('link', [item('1', 'a', 'link', { size: 1 }), item('2', 'b', 'private', { size: ZIP_LIMIT })]);
    assert.equal(albumZipPlan(hidden).tooLarge, false);
  });

  it('fails closed: no items_access entry, no ok safety, or expired means not zipped', () => {
    const d = data('password', [item('1', 'a.png'), item('2', 'b.png'), item('3', 'c.png'), item('4', 'd.png'), item('5', 'e.png')]);
    delete d.items_access['2'];
    delete d.items_access['3'].safety;
    d.items_access['4'].safety = { state: 'hidden', reason: 'review' };
    d.items_access['5'].expires_at = Math.floor(Date.now() / 1000) - 1;
    assert.deepEqual(albumZipPlan(d).entries.map((e) => e.id), ['1']);
    // the same on the items_storage-only (paginated) path
    d.album.next_cursor = 'abc';
    d.items_storage['8'] = storage('8', 5, 'later.png');
    assert.deepEqual(albumZipPlan(d).entries.map((e) => e.id), ['1']);
    d.items_access['8'] = { visibility: 'link', access_version: 0, safety: { state: 'flagged', reason: null } };
    assert.deepEqual(albumZipPlan(d).entries.map((e) => e.id), ['1', '8']);
  });

  it('more items than ZIP_MAX_ENTRIES is too large, whatever the bytes', () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => item(String(i + 1), `f${i}.txt`, 'link', { size: 1 }));
    assert.equal(albumZipPlan(data('link', many)).tooLarge, true);
    assert.equal(albumZipPlan(data('link', many.slice(0, ZIP_MAX_ENTRIES))).tooLarge, false);
  });

  it('an unknown size leaves the total unknown (streamed without a length)', () => {
    const d = data('link', [item('1', 'a')]);
    delete d.items_storage['1'].size;
    delete d.album.items[0].size;
    assert.deepEqual([albumZipPlan(d).total, albumZipPlan(d).tooLarge], [null, false]);
  });
});

describe('ZIP names', () => {
  it('zipEntryName cleans like the CDN and never keeps a path separator', () => {
    assert.equal(zipEntryName('../../etc/passwd'), '_.._etc_passwd');
    assert.equal(zipEntryName('a\\b.txt'), 'a_b.txt');
    assert.equal(zipEntryName('..'), 'file');
    assert.equal(zipEntryName('  name​\n.png  '), 'name .png');
    assert.equal(zipEntryName(null), 'file');
  });

  it('zipFilename is the title, or the vanity', () => {
    assert.equal(zipFilename({ title: 'Trip / 2026', vanity: 'v' }), 'Trip _ 2026.zip');
    assert.equal(zipFilename({ title: '  ', vanity: 'Ab3dE6gH' }), 'Ab3dE6gH.zip');
  });
});
