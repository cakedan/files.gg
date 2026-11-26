// Runs the real Worker (bundled by wrangler from wrangler.toml, in workerd) with wrangler's
// createTestHarness, against local mocks of the API and B2 (S3).
//
// Static assets come from test/fixtures/web-dist (a real `web` build's viewer.html and app.html,
// plus placeholder files). Set WEB_DIST to run against a real build instead, for example
// `WEB_DIST=../web/dist npm run test:integration`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AwsV4Signer } from 'aws4fetch';

import { cases } from './fixtures.js';
import { NOW_S, SIGNING_SECRET, albumGrant, fileGrant, signUrl } from './signing.js';

process.env.WRANGLER_SEND_METRICS = 'false';
const { createTestHarness, experimental_readRawConfig } = await import('wrangler');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WEB_DIST = resolve(ROOT, process.env.WEB_DIST || 'test/fixtures/web-dist');

export const SECRETS = Object.freeze({
  ORIGIN_SHARED_SECRET: 'origin-secret',
  CDN_SIGNING_SECRET: SIGNING_SECRET,
  S3_READ_ACCESS_KEY_ID: 'test-read-key-id',
  S3_READ_SECRET_ACCESS_KEY: 'test-read-secret',
});
export const S3_BUCKET = 'filesgg-test';
export const S3_REGION = 'us-west-004';
export { NOW_S };


// --- Fixture data --------------------------------------------------------------------------
// The internal lookups (milestone-3.md §5, milestone-4.md §6.3) for every file of the page
// fixtures, plus files and albums for each access and safety case. Payloads are snake_case with
// times in epoch seconds (§4), and their URLs are unsigned, as the internal lookup returns them.

const files = {};
const albums = {};
// Every object in the mock bucket, by key: { s3, body } (body: string or Buffer).
const objects = {};
let nextId = 1000000000000000000n;
export const PREVIEWS_VERSION = 1795600000;
export const COLLAGE_VERSION = 1795600100;

const PREVIEW_EXT = { peaks: 'json', hover: 'mp4', document: 'pdf' };
const PREVIEW_TYPE = { json: 'application/json', mp4: 'video/mp4', webp: 'image/webp', pdf: 'application/pdf' };
export const previewExt = (kind) => PREVIEW_EXT[kind] || 'webp';

export const OK = Object.freeze({ state: 'ok', reason: null });

// The accounts in the fixtures (milestone-6.md §16.10): U owns most files and the domain
// i.example.com, V is another user, P's account is pending deletion.
export const USER_U = '42';
export const USER_V = '77';
export const USER_P = '88';

// `previews`: { '<kind>': body | { body, content_type, width?, height? } } (contract §3, §5).
// milestone-4.md §6.3: `safety` is the lookup's { state, reason } (null leaves it out, like an API
// that doesn't send it), `serveInline` its `serve_inline` (null leaves it out), and `csam: true`
// makes the lookup answer 404 like an unknown vanity, as the API does for hash-matched CSAM.
// milestone-6.md §10.7: `owner` is `owner_user_id` (null for anonymous), `servedOn` `served_on`
// and `ownerState` `owner_state`. milestone-6.md §19.5: `viewLimit` is `view_limit` ({ limit, used, action }
// or null).
function addFile(vanity, {
  visibility = 'link', s3 = true, accessVersion = 0, previews, safety = OK, serveInline = true, csam = false,
  owner = USER_U, servedOn = 'files.gg', ownerState = 'active', viewLimit = null, ...file
}) {
  const id = String(nextId++);
  const hash = `h-${vanity.replace(/\W/g, '-')}`;
  const extension = (file.filename.match(/\.([^.]+)$/) || [])[1] || '';
  const body = file.body || `bytes of ${file.filename}`;
  files[vanity] = {
    file: {
      id, vanity, kind: 'file', mimetype: 'application/octet-stream', extension, size: 1,
      cdn_url: `https://cdn.files.gg/files/${vanity}${extension ? '.' + extension : ''}`,
      url: `https://files.gg/${vanity}${extension ? '.' + extension : ''}`,
      uploaded_at: NOW_S() - 60, expires_at: null, nsfw: false, processing: false,
      ...file,
    },
    access: {
      visibility, access_version: accessVersion, unlock_ttl: 3600,
      password_expires_at: file.password_expires_at ?? null,
      show_name_when_locked: !!file.show_name_when_locked,
    },
    owner_user_id: owner,
    served_on: servedOn,
    owner_state: ownerState,
    view_limit: viewLimit,
    albums: [],
    storage: { key: `files/${hash}`, size: Buffer.byteLength(body) },
    previews: {},
    previews_version: null,
    safety,
    serve_inline: serveInline,
    bytes: { s3, body },
    csam,
  };
  if (safety === null) {
    delete files[vanity].safety;
  }
  if (serveInline === null) {
    delete files[vanity].serve_inline;
  }
  delete files[vanity].file.password_expires_at;
  delete files[vanity].file.show_name_when_locked;
  delete files[vanity].file.body;
  objects[files[vanity].storage.key] = files[vanity].bytes;
  if (previews) {
    const entry = files[vanity];
    entry.previews_version = PREVIEWS_VERSION;
    entry.file.assets = {};
    for (const [kind, value] of Object.entries(previews)) {
      const preview = (typeof(value) === 'object' && !Buffer.isBuffer(value)) ? value : { body: value };
      const ext = previewExt(kind);
      const key = `derived/${hash}/${kind}.${ext}`;
      objects[key] = { s3: true, body: preview.body };
      entry.previews[kind] = { key, content_type: preview.content_type || PREVIEW_TYPE[ext], size: Buffer.byteLength(preview.body) };
      entry.file.assets[kind] = {
        url: `https://cdn.files.gg/previews/${kind}/${vanity}.${ext}?v=${PREVIEWS_VERSION}`,
        ...(preview.width ? { width: preview.width, height: preview.height } : {}),
      };
    }
    if (entry.file.assets.hover) {
      entry.file.hover_url = entry.file.assets.hover.url;
    }
  }
  return files[vanity];
}

const KIND = { image: 'image', video: 'video', audio: 'audio', text: 'text' };
for (const [vanity, file] of Object.entries(cases.files)) {
  const major = file.mimetype.split('/')[0];
  const kind = file.mimetype === 'application/pdf' ? 'pdf' : (file.mimetype === 'image/svg+xml' ? 'file' : (KIND[major] || 'file'));
  addFile(vanity, {
    kind, filename: file.filename, mimetype: file.mimetype, size: file.size,
    width: file.width, height: file.height, cdn_url: file.cdn_url, url: file.url,
  });
}
addFile('pw1', { visibility: 'password', accessVersion: 2, kind: 'image', filename: 'secret.png', mimetype: 'image/png', size: 9 });
addFile('pwname', { visibility: 'password', kind: 'image', filename: 'named.png', mimetype: 'image/png', size: 9, show_name_when_locked: true });
addFile('pwexp', { visibility: 'password', kind: 'image', filename: 'old.png', mimetype: 'image/png', size: 9, password_expires_at: NOW_S() - 60 });
addFile('priv1', { visibility: 'private', kind: 'image', filename: 'mine.png', mimetype: 'image/png', size: 9 });
addFile('pwalb', { visibility: 'password', kind: 'image', filename: 'in-album.png', mimetype: 'image/png', size: 9 });
addFile('hostile', { kind: 'image', filename: '</script><script>alert(1)</script>.png', mimetype: 'image/png', size: 9 });
addFile('expired1', { kind: 'image', filename: 'gone.png', mimetype: 'image/png', size: 9, expires_at: NOW_S() - 1 });
addFile('nowhere', { s3: false, kind: 'text', filename: 'lost.txt', mimetype: 'text/plain', size: 9 });
addFile('cached1', { kind: 'image', filename: 'cache-me.png', mimetype: 'image/png', size: 9 });
addFile('noid', { visibility: 'password', kind: 'image', filename: 'no-id.png', mimetype: 'image/png', size: 9 });
delete files.noid.file.id;
addFile('noalbums', { visibility: 'password', kind: 'image', filename: 'no-albums.png', mimetype: 'image/png', size: 9 });
delete files.noalbums.albums;
addFile('ranged', { kind: 'video', filename: 'range.mp4', mimetype: 'video/mp4', size: 26, body: 'abcdefghijklmnopqrstuvwxyz' });

// Milestone 3: previews (contract §2, §3).
const poster = { body: 'WEBP poster', width: 1280, height: 720 };
addFile('mvid', {
  kind: 'video', filename: 'clip.mp4', mimetype: 'video/mp4', size: 12, width: 1920, height: 1080,
  previews: { poster, thumb: 'WEBP thumb', hover: 'HOVER-0123456789abcdefghijklmnopqrstuvwxyz' },
});
addFile('maudio', { kind: 'audio', filename: 'song.mp3', mimetype: 'audio/mpeg', size: 12, previews: { cover: { body: 'WEBP cover', width: 1200, height: 1200 }, peaks: '{"version":1}' } });
addFile('mwave', { kind: 'audio', filename: 'voice.ogg', mimetype: 'audio/ogg', size: 12, previews: { waveform: { body: 'WEBP wave', width: 1600, height: 240 }, peaks: '{"version":1}' } });
addFile('mheic', { kind: 'image', filename: 'photo.heic', mimetype: 'image/heic', size: 12, width: 4032, height: 3024, previews: { display: { body: 'WEBP display', width: 4032, height: 3024 }, thumb: 'WEBP thumb' } });
addFile('mpdf', { kind: 'pdf', filename: 'doc.pdf', mimetype: 'application/pdf', size: 12, previews: { thumb: { body: 'WEBP page1', width: 248, height: 320 }, 'thumb-2x': { body: 'WEBP page1 2x', width: 495, height: 640 } } });
addFile('mpw', { visibility: 'password', accessVersion: 4, kind: 'video', filename: 'hidden.mp4', mimetype: 'video/mp4', size: 12, previews: { poster, thumb: 'WEBP secret thumb' } });
addFile('mpriv', { visibility: 'private', kind: 'image', filename: 'private.png', mimetype: 'image/png', size: 12, previews: { thumb: 'WEBP private thumb' } });
addFile('mhostile', { kind: 'image', filename: 'x.png', mimetype: 'image/png', size: 12, previews: { thumb: { body: '<html>', content_type: 'text/html' } } });
addFile('mnsfw', { kind: 'video', filename: 'nsfw.mp4', mimetype: 'video/mp4', size: 12, nsfw: true, previews: { poster } });
for (const vanity of ['mvid', 'mpw', 'mnsfw']) {
  files[vanity].file.thumbnail = { url: files[vanity].file.assets.poster.url, type: 'poster', width: 1280, height: 720 };
}
files.maudio.file.thumbnail = { url: files.maudio.file.assets.cover.url, type: 'cover', width: 1200, height: 1200 };
// Milestone 5 §9: Office documents previewed as a PDF (the `document` asset), in each visibility.
const docx = { kind: 'file', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 12 };
addFile('mdoc', { ...docx, filename: 'report.docx', previews: { document: '%PDF-1.7 report', thumb: 'WEBP doc page1' } });
addFile('mdocpw', { ...docx, visibility: 'password', accessVersion: 2, filename: 'secret.docx', previews: { document: '%PDF-1.7 secret' } });
addFile('mdocpriv', { ...docx, visibility: 'private', filename: 'mine.docx', previews: { document: '%PDF-1.7 mine' } });
// A stored row with a wrong type is still served as a PDF.
addFile('mdocodd', { ...docx, filename: 'odd.docx', previews: { document: { body: '%PDF-1.7 odd', content_type: 'text/html' } } });
// A vanity that is a preview kind, and multi-segment ones.
addFile('thumb', { kind: 'image', filename: 'named-thumb.png', mimetype: 'image/png', size: 12, previews: { thumb: 'WEBP thumb of thumb' } });
addFile('abcd/cover', { kind: 'audio', filename: 'deep.mp3', mimetype: 'audio/mpeg', size: 12, previews: { cover: 'WEBP deep cover' } });
addFile('deep/pw', { visibility: 'password', accessVersion: 1, kind: 'video', filename: 'deep.mp4', mimetype: 'video/mp4', size: 12, previews: { poster: 'WEBP deep poster' } });

// ZIP items: a body big enough to arrive in many chunks, and names that collide.
const bigBody = Buffer.alloc(300 * 1024 + 7);
for (let i = 0; i < bigBody.length; i++) {
  bigBody[i] = (i * 7 + (i >> 9)) & 0xFF;
}
addFile('zbig', { kind: 'file', filename: 'big.bin', mimetype: 'application/octet-stream', size: bigBody.length, body: bigBody });
addFile('za1', { kind: 'text', filename: 'notes.txt', mimetype: 'text/plain', size: 7, body: 'first!\n' });
addFile('za2', { kind: 'text', filename: 'notes.txt', mimetype: 'text/plain', size: 8, body: 'second!\n' });
addFile('za3', { kind: 'text', filename: 'NOTES.txt', mimetype: 'text/plain', size: 7, body: 'third!\n' });
addFile('zuni', { kind: 'text', filename: 'café 日本/..\\evil‮.txt', mimetype: 'text/plain', size: 3, body: 'uni' });
addFile('zpw', { visibility: 'password', kind: 'text', filename: 'pw.txt', mimetype: 'text/plain', size: 6, body: 'secret' });
addFile('zpriv', { visibility: 'private', kind: 'text', filename: 'priv.txt', mimetype: 'text/plain', size: 7, body: 'private' });
addFile('zmissing', { s3: false, kind: 'text', filename: 'lost.txt', mimetype: 'text/plain', size: 4, body: 'lost' });

// `collage`: true stores a collage object. `sizes`: { '<file vanity>': size } overrides the
// items_storage sizes (the ZIP cap). Item `visibility` is part of the public payload.
// milestone-4.md §6.3, as the API does it: album.items, items_access and items_storage list only
// items whose state is `ok`, and `pending_count` counts the pending ones that would be shown.
// `safety` is the album's own (null leaves it out).
function addAlbum(vanity, {
  visibility = 'link', accessVersion = 0, items: allItems, title = 'Trip', collage = false, sizes = {}, safety = OK,
  owner = USER_U, servedOn = 'files.gg', ownerState = 'active', ...album
}) {
  const id = String(nextId++);
  const stateOf = (item) => (files[item].safety && files[item].safety.state) || 'pending';
  const eligible = (item) => visibility !== 'link' || files[item].access.visibility === 'link';
  const items = allItems.filter((item) => stateOf(item) === 'ok');
  const pendingCount = allItems.filter((item) => stateOf(item) === 'pending' && eligible(item)).length;
  // milestone-3.md §4: a link album shows only link items; a protected album shows every item.
  const shown = items.filter(eligible);
  albums[vanity] = {
    album: {
      id, vanity, title, visibility, url: `https://files.gg/a/${vanity}`,
      download_url: `https://cdn.files.gg/albums/download/${vanity}.zip`,
      expires_at: null,
      items: items.map((item, position) => ({ ...files[item].file, visibility: files[item].access.visibility, position, caption: '' })),
      count: items.length,
      nsfw: false,
      ...(collage ? { collage: { url: `https://cdn.files.gg/albums/collage/${vanity}.webp?v=${COLLAGE_VERSION}`, width: 1200, height: 630 } } : {}),
      ...album,
    },
    access: { visibility, access_version: accessVersion, unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: false },
    items_access: Object.fromEntries(items.map((item) => [files[item].file.id, {
      visibility: files[item].access.visibility, access_version: files[item].access.access_version,
      safety: { state: 'ok', reason: null }, expires_at: files[item].file.expires_at ?? null,
    }])),
    items_storage: Object.fromEntries(shown.map((item) => [files[item].file.id, {
      key: files[item].storage.key, size: sizes[item] ?? Buffer.byteLength(files[item].bytes.body), filename: files[item].file.filename,
    }])),
    collage: collage ? { key: `derived/albums/${id}/collage-${COLLAGE_VERSION}.webp`, version: COLLAGE_VERSION } : null,
    safety,
    pending_count: pendingCount,
    owner_user_id: owner,
    served_on: servedOn,
    owner_state: ownerState,
  };
  if (safety === null) {
    delete albums[vanity].safety;
  }
  if (collage) {
    objects[albums[vanity].collage.key] = { s3: true, body: `WEBP collage of ${vanity}` };
  }
  // contract §5: each file lookup lists the albums it is shown in, with their vanities and versions
  // (a hidden or removed album shows nothing).
  for (const item of (safety && safety.state === 'ok') ? shown : []) {
    files[item].albums.push({ id, vanity, access_version: accessVersion });
  }
  return albums[vanity];
}
addAlbum('alb1', { items: ['img1', 'vid1', 'priv1'] });
addAlbum('albpw', { visibility: 'password', accessVersion: 3, items: ['pwalb', 'img1'] });
addAlbum('albempty', { items: ['priv1'] });
addAlbum('albmedia', { items: ['mvid', 'mheic', 'mpw'], title: 'Media', collage: true });
addAlbum('albaudio', { items: ['maudio', 'mwave'], title: '', collage: true, cover: { url: files.maudio.file.assets.cover.url, type: 'cover', width: 1200, height: 1200 } });
files.maudio.file.media = { tags: { album: 'Greatest Hits' } };
albums.albaudio.album.items[0].media = { tags: { album: 'Greatest Hits' } };
addAlbum('albprot', { visibility: 'password', accessVersion: 6, items: ['mpw', 'mpriv', 'deep/pw'], title: 'Protected', collage: true });
addAlbum('albprivate', { visibility: 'private', accessVersion: 1, items: ['za1'], title: 'Mine', collage: true });
addAlbum('albnocollage', { items: ['za1'], title: 'Plain' });
addAlbum('albzip', { items: ['zbig', 'za1', 'za2', 'zpw', 'za3', 'zpriv', 'zuni'], title: 'Zip: "all"/files' });
addAlbum('albzippw', { visibility: 'password', accessVersion: 2, items: ['zpw', 'zpriv', 'za1'], title: 'Locked zip' });
addAlbum('albhuge', { items: ['za1', 'za2'], title: 'Huge', sizes: { za1: 2147483000, za2: 1000 } });
addAlbum('albexact', { items: ['za1'], title: 'Exact', sizes: { za1: 2147483648 } });
addAlbum('albbroken', { items: ['za1', 'zmissing'], title: 'Broken' });
// An album whose vanity is also the name of an album resource.
addAlbum('collage', { items: ['img1'], title: 'Named collage', collage: true });
// A file without an id (a broken lookup) that is still listed in a protected album.
addAlbum('albnoid', { visibility: 'password', accessVersion: 0, items: ['noid'], title: 'No id' });

// Milestone 4: every safety state (milestone-4.md §2.4, §6.3, §10), each with a preview.
const thumbOnly = { thumb: 'WEBP state thumb' };
const png = (filename, extra = {}) => ({ kind: 'image', filename, mimetype: 'image/png', size: 12, previews: thumbOnly, ...extra });
addFile('spend', png('pending.png', { safety: { state: 'pending', reason: null } }));
addFile('spendpw', png('pending-pw.png', { visibility: 'password', accessVersion: 1, safety: { state: 'pending', reason: null } }));
addFile('spendpriv', png('pending-priv.png', { visibility: 'private', safety: { state: 'pending', reason: null } }));
addFile('shid', png('hidden.png', { safety: { state: 'hidden', reason: 'review' } }));
addFile('shidpw', png('hidden-pw.png', { visibility: 'password', accessVersion: 2, safety: { state: 'hidden', reason: 'review' } }));
addFile('shidpriv', png('hidden-priv.png', { visibility: 'private', safety: { state: 'hidden', reason: 'review' } }));
addFile('srem', png('removed.png', { safety: { state: 'removed', reason: 'copyright' } }));
addFile('sremmal', png('malware.exe.png', { safety: { state: 'removed', reason: 'malware' } }));
addFile('sremx', png('removed-x.png', { safety: { state: 'removed', reason: 'not-a-reason' } }));
addFile('sblk', png('blocked.png', { safety: { state: 'blocked', reason: null } }));
addFile('sblkpw', png('blocked-pw.png', { visibility: 'password', safety: { state: 'blocked', reason: null } }));
addFile('scsam', png('never-shown.png', { csam: true, safety: { state: 'blocked', reason: null } }));
addFile('snosafety', png('no-safety.png', { safety: null }));
addFile('sflagged', png('flagged-state.png', { safety: { state: 'flagged', reason: null } }));
addFile('snsfw', png('sensitive.png', { nsfw: true, width: 800, height: 600 }));
addFile('snsfwvid', { kind: 'video', filename: 'sensitive.mp4', mimetype: 'video/mp4', size: 12, nsfw: true, previews: { poster } });
addFile('sraw', png('undecodable.png', { serveInline: false, previews: { thumb: 'WEBP raw thumb', display: 'WEBP raw display' } }));
addFile('srawvid', { kind: 'video', filename: 'undecodable.mp4', mimetype: 'video/mp4', size: 12, serveInline: false, previews: { poster } });
addFile('srawnone', png('no-serve-inline.png', { serveInline: null }));
addFile('sstaff', png('staff-only.png', { visibility: 'private', accessVersion: 3 }));
for (const vanity of ['spend', 'shid', 'srem', 'sblk', 'snsfw', 'sraw']) {
  files[vanity].file.thumbnail = { url: files[vanity].file.assets.thumb.url, type: 'thumb' };
}
files.snsfwvid.file.thumbnail = { url: files.snsfwvid.file.assets.poster.url, type: 'poster', width: 1280, height: 720 };

addAlbum('amix', { items: ['img1', 'spend', 'shid', 'sblk', 'spendpriv'], title: 'Mixed', collage: true });
addAlbum('apend', { items: ['spend'], title: 'Pending only', collage: true });
addAlbum('apendpw', { visibility: 'password', accessVersion: 1, items: ['spendpw'], title: 'Pending locked' });
addAlbum('apendpriv', { visibility: 'private', items: ['spend'], title: 'Pending private' });
addAlbum('arem', { items: ['img1'], title: 'Removed album', collage: true, safety: { state: 'removed', reason: 'terms' } });
addAlbum('ahid', { items: ['img1'], title: 'Hidden album', collage: true, safety: { state: 'hidden', reason: null } });
addAlbum('ahidpw', { visibility: 'password', accessVersion: 5, items: ['pwalb'], title: 'Hidden locked', collage: true, safety: { state: 'hidden', reason: 'review' } });
addAlbum('aremhid', { items: ['spend'], title: 'Removed and pending', safety: { state: 'removed', reason: 'copyright' } });
addAlbum('anosafety', { items: ['img1'], title: 'No safety', collage: true, safety: null });
addAlbum('ansfwitem', { items: ['img1', 'snsfw'], title: 'Has NSFW', collage: true });
addAlbum('amarked', { items: ['img1'], title: 'Marked', collage: true, nsfw: true });

// Milestone 6 (milestone-6.md §8.8, §10.6, §16.10): domain-only, other owners, anonymous files
// and pending deletions, each with a preview.
addFile('dolink', png('domain-only.png', { servedOn: 'custom' }));
addFile('dopw', png('domain-only-pw.png', { visibility: 'password', accessVersion: 2, servedOn: 'custom' }));
addFile('dopriv', png('domain-only-priv.png', { visibility: 'private', accessVersion: 1, servedOn: 'custom' }));
addFile('dopaused', png('paused.png', { servedOn: 'files.gg' }));
addFile('dounknown', png('served-on-unknown.png', { servedOn: 'somewhere' }));
addFile('upw', png('u-password.png', { visibility: 'password', accessVersion: 3 }));
addFile('vlink', png('v.png', { owner: USER_V }));
addFile('vpw', png('v-password.png', { owner: USER_V, visibility: 'password', accessVersion: 1 }));
addFile('anonlink', png('anonymous.png', { owner: null }));
addFile('pdlink', png('pending-deletion.png', { owner: USER_P, ownerState: 'pending_deletion' }));
addFile('pdpw', png('pending-deletion-pw.png', { owner: USER_P, ownerState: 'pending_deletion', visibility: 'password', accessVersion: 1 }));
addFile('pdweird', png('owner-state-unknown.png', { owner: USER_P, ownerState: 'frozen' }));
addFile('pdu', png('u-pending.png', { ownerState: 'pending_deletion' }));
addFile('pdnull', png('owner-state-null.png', { ownerState: null }));
addFile('ulink', { kind: 'image', filename: 'u.png', mimetype: 'image/png', size: 12, width: 640, height: 480 });
for (const vanity of ['dolink', 'vlink', 'pdlink']) {
  files[vanity].file.thumbnail = { url: files[vanity].file.assets.thumb.url, type: 'thumb' };
}
// Milestone 6 §19: view limits, each with a preview (and a thumbnail an embed would use).
addFile('vl3', png('limited.png', { width: 640, height: 480, viewLimit: { limit: 3, used: 1, action: 'expire' } }));
addFile('vlpw', png('limited-pw.png', { visibility: 'password', accessVersion: 2, show_name_when_locked: true, viewLimit: { limit: 2, used: 0, action: 'private' } }));
addFile('vldone', png('used-up.png', { accessVersion: 1, viewLimit: { limit: 2, used: 2, action: 'expire' } }));
addFile('vlbad', png('malformed-limit.png', { viewLimit: { limit: 'many' } }));
addFile('vlvid', { kind: 'video', filename: 'limited.mp4', mimetype: 'video/mp4', size: 12, previews: { poster }, viewLimit: { limit: 5, used: 0, action: 'expire' } });
addFile('vlv', png('limited-v.png', { owner: USER_V, viewLimit: { limit: 5, used: 0, action: 'expire' } }));
for (const vanity of ['vl3', 'vldone']) {
  files[vanity].file.thumbnail = { url: files[vanity].file.assets.thumb.url, type: 'thumb' };
}
files.vlvid.file.thumbnail = { url: files.vlvid.file.assets.poster.url, type: 'poster', width: 1280, height: 720 };
addAlbum('adolink', { items: ['dolink'], title: 'Domain only', collage: true, servedOn: 'custom' });
addAlbum('adopw', { visibility: 'password', accessVersion: 4, items: ['dolink'], title: 'Domain only locked', collage: true, servedOn: 'custom' });
addAlbum('avlink', { items: ['vlink'], title: 'V album', collage: true, owner: USER_V });
addAlbum('aanon', { items: ['anonlink'], title: 'Anonymous album', collage: true, owner: null });
addAlbum('apdlink', { items: ['pdlink'], title: 'Pending deletion', collage: true, owner: USER_P, ownerState: 'pending_deletion' });

// Milestone 7 §11.2: adult content and the regional rule. An NSFW file with every preview kind, a
// locked one, a removed one, a clean one, and albums made NSFW by an item or by the mark.
export const REGION_PREVIEW_KINDS = Object.freeze(['thumb', 'thumb-2x', 'display', 'poster', 'cover', 'waveform', 'peaks', 'hover', 'document']);
addFile('rnsfw', {
  kind: 'video', filename: 'adult-secret-name.mp4', mimetype: 'video/mp4', size: 12, nsfw: true,
  previews: Object.fromEntries(REGION_PREVIEW_KINDS.map((kind) => [kind, `adult ${kind} bytes`])),
});
files.rnsfw.file.thumbnail = { url: files.rnsfw.file.assets.poster.url, type: 'poster' };
addFile('rnsfwpw', png('adult-locked-name.png', { visibility: 'password', accessVersion: 2, nsfw: true, show_name_when_locked: true }));
addFile('rnsfwrem', png('adult-removed-name.png', { nsfw: true, safety: { state: 'removed', reason: 'terms' } }));
addFile('rclean', png('clean-name.png'));
addAlbum('rnsfwalb', { items: ['rclean', 'rnsfw'], title: 'Adult album title', description: 'Adult album description', collage: true });
addAlbum('rmarked', { items: ['rclean'], title: 'Marked album title', collage: true, nsfw: true });
addAlbum('rnsfwalbpw', { visibility: 'password', accessVersion: 3, items: ['rnsfwpw'], title: 'Locked adult title', collage: true });
addAlbum('rcleanalb', { items: ['rclean'], title: 'Clean album title', collage: true });

// The domain lookup (milestone-6.md §10.7), by hostname: { domain } as the API answers it.
// `lookupHostname` makes the payload name another hostname (a lookup that doesn't match).
const domains = {};
let nextDomainId = 9000000000000000000n;
function addDomain(hostname, { user = USER_U, scope = 'own', serving = true, lookupHostname = hostname } = {}) {
  domains[hostname] = { domain: { id: String(nextDomainId++), hostname: lookupHostname, user_id: user, scope, serving } };
  return domains[hostname];
}
addDomain('i.example.com');
addDomain('any.example.com', { scope: 'any' });
addDomain('failing.example.com');
addDomain('weird.example.com', { scope: 'everything' });
addDomain('v.example.com', { user: USER_V });
addDomain('pending.example.com', { serving: false });
addDomain('paused.example.com', { serving: false });
addDomain('disabled.example.com', { serving: false });
addDomain('gone.example.com', { user: USER_P, serving: false });
addDomain('nostr.example.com', { serving: 'true' });
addDomain('mismatch.example.com', { lookupHostname: 'i.example.com' });
// For the HTTP DCV passthrough test: a "custom hostname" that is the mock upstream itself.
addDomain('127.0.0.1');

export const FILES = files;
export const ALBUMS = albums;
export const OBJECTS = objects;
export const DOMAINS = domains;

// The session cookie tokens (milestone-6.md §16.11).
export const SESSION_TOKEN = 'fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC';
export const SESSION_SET_COOKIE = `__Host-filesgg_session=${SESSION_TOKEN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000`;
export const SESSION_CLEAR_COOKIE = '__Host-filesgg_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
export const LOCAL_SET_COOKIE = `filesgg_session=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000`;
// Every other cookie an upstream might set; none of them may ever reach the browser.
export const FOREIGN_SET_COOKIES = Object.freeze([
  '__cf_bm=abc; Path=/; Domain=files.gg; HttpOnly',
  'tracker=1; Path=/',
  '__Host-filesgg_session_x=evil; Path=/; Secure',
  '__host-filesgg_session=evil; Path=/; Secure',
  'session=evil; Domain=files.gg; Path=/',
]);


// --- Signed URLs, as the API writes them (contract §3) ---------------------------------------

// A staff URL (milestone-4.md §10.3) for one of a file's paths: `staff=<staff id>`, signed with
// `staff:<staff id>:<file id>`, valid for `ttl` seconds (10 minutes at most).
export const STAFF_ID = '555555555555555555';
export function signedForStaff(vanity, path, { staffId = STAFF_ID, ttl = 600, fileId, grantStaffId, ...options } = {}) {
  const url = new URL(path, 'https://cdn.files.gg');
  url.searchParams.set('staff', staffId);
  const grant = `staff:${grantStaffId ?? staffId}:${fileId ?? files[vanity].file.id}`;
  return signUrl(url.pathname + url.search, grant, { expires: NOW_S() + ttl, ...options });
}

// A URL for one of a file's paths, signed with the file's current grant (or `version`).
export function signedForFile(vanity, path, { version, ...options } = {}) {
  const { file, access } = files[vanity];
  return signUrl(path, fileGrant(file.id, version ?? access.access_version), options);
}

// A URL for an item path of an album, with `album=<vanity>` and the album's grant (or `version`).
export function signedThroughAlbum(albumVanity, path, { version, ...options } = {}) {
  const { album, access } = albums[albumVanity];
  const url = new URL(path, 'https://cdn.files.gg');
  url.searchParams.set('album', albumVanity);
  return signUrl(url.pathname + url.search, albumGrant(album.id, version ?? access.access_version), options);
}

// An album's own collage or ZIP path, signed with its grant (or `version`), without `album=`.
export function signedForAlbum(albumVanity, path, { version, ...options } = {}) {
  const { album, access } = albums[albumVanity];
  return signUrl(path, albumGrant(album.id, version ?? access.access_version), options);
}

export const previewPath = (vanity, kind) => `/previews/${kind}/${vanity}.${previewExt(kind)}`;


// --- Mock servers --------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolveBody) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => resolveBody(body));
  });
}

function send(res, status, type, payload, headers = {}) {
  res.writeHead(status, { ...(type ? { 'content-type': type } : {}), ...headers });
  res.end(payload);
}

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(`http://127.0.0.1:${server.address().port}`)));
}

// Serves `body` honouring Range and If-None-Match, like S3 does.
function sendObject(req, res, body, type, extraHeaders = {}) {
  const etag = `"${Buffer.from(body).toString('hex').slice(0, 16)}"`;
  const headers = { etag, 'accept-ranges': 'bytes', 'last-modified': 'Tue, 01 Sep 2026 00:00:00 GMT', ...extraHeaders };
  if (req.headers['if-none-match'] === etag) {
    return send(res, 304, null, undefined, headers);
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
    if (start >= body.length) {
      return send(res, 416, 'application/xml', '<Error>InvalidRange</Error>', { 'content-range': `bytes */${body.length}` });
    }
    return send(res, 206, type, req.method === 'HEAD' ? undefined : body.slice(start, end + 1), {
      ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1,
    });
  }
  return send(res, 200, type, req.method === 'HEAD' ? undefined : body, { ...headers, 'content-length': body.length });
}


// The API, on one server. Every request is recorded, whatever its path.
export async function startUpstream() {
  const state = { requests: [], failLookups: new Set() };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://upstream');
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });

    // API: the domain lookup by hostname (milestone-6.md §10.7), with both headers, like the others.
    const domainLookup = /^\/internal\/domains\/([^/]+)$/.exec(url.pathname);
    if (domainLookup) {
      const hostname = decodeURIComponent(domainLookup[1]);
      if (state.failLookups.has(hostname)) {
        return send(res, 502, 'text/html', 'Bad Gateway');
      }
      if (req.headers['x-filesgg-origin-secret'] !== SECRETS.ORIGIN_SHARED_SECRET
          || req.headers['x-filesgg-internal-lookup'] !== '1') {
        return send(res, 404, 'application/json', '{"code":"UNKNOWN_DOMAIN"}');
      }
      const found = Object.hasOwn(domains, hostname) ? domains[hostname] : null;
      if (!found) {
        return send(res, 404, 'application/json', '{"code":"UNKNOWN_DOMAIN"}', { 'cache-control': 'no-store' });
      }
      return send(res, 200, 'application/json', JSON.stringify(found), { 'cache-control': 'no-store' });
    }
    // API: internal lookups by vanity (contract §5). Wrong or missing secret: 404, like an
    // unknown vanity. There are no lookups by id.
    const internal = /^\/internal\/(files|albums)\/(.+)$/.exec(url.pathname);
    if (internal) {
      const [, kind, raw] = internal;
      const vanity = raw.split('/').map(decodeURIComponent).join('/');
      if (state.failLookups.has(vanity)) {
        return send(res, 502, 'text/html', 'Bad Gateway');
      }
      // As the API: the secret alone (every forwarded client request has it) is not a lookup.
      if (req.headers['x-filesgg-origin-secret'] !== SECRETS.ORIGIN_SHARED_SECRET
          || req.headers['x-filesgg-internal-lookup'] !== '1') {
        return send(res, 404, 'application/json', '{"code":"UNKNOWN_FILE"}');
      }
      const table = (kind === 'files') ? files : albums;
      const found = Object.hasOwn(table, vanity) ? table[vanity] : null;
      // milestone-4.md §6.3: hash-matched CSAM answers exactly like an unknown vanity.
      if (!found || found.csam) {
        return send(res, 404, 'application/json', `{"code":"${kind === 'files' ? 'UNKNOWN_FILE' : 'UNKNOWN_ALBUM'}"}`, { 'cache-control': 'no-store' });
      }
      const { bytes, csam, ...payload } = found;
      return send(res, 200, 'application/json', JSON.stringify(payload), { 'cache-control': 'no-store' });
    }
    if (url.pathname.startsWith('/internal/')) {
      return send(res, 404, 'application/json', '{"code":"NOT_FOUND"}');
    }
    // API: sign-in and sign-out set and clear the session cookie (milestone-6.md §3.2), both the
    // production and the local name, among cookies nobody may ever pass on.
    if (url.pathname === '/auth/login' || url.pathname === '/auth/logout') {
      const session = (url.pathname === '/auth/login') ? [SESSION_SET_COOKIE, LOCAL_SET_COOKIE] : [SESSION_CLEAR_COOKIE];
      res.setHeader('set-cookie', [...FOREIGN_SET_COOKIES.slice(0, 2), ...session, ...FOREIGN_SET_COOKIES.slice(2)]);
      return send(res, 200, 'application/json', JSON.stringify({ path: url.pathname, method: req.method }), {
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true',
      });
    }
    // Cloudflare's validation paths on a custom hostname (milestone-6.md §10.8 step 1): the origin
    // answers them, never the Worker.
    if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
      return send(res, 200, 'text/plain', `dcv ${url.pathname.split('/').pop()}`, { 'set-cookie': 'dcv=1; Path=/' });
    }
    // API: anything else echoes, with the API's own (too loose) CORS headers.
    if (url.pathname.startsWith('/users/')) {
      return send(res, 200, 'application/json', JSON.stringify({ path: url.pathname, method: req.method }), {
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true',
      });
    }
    return send(res, 404, 'text/plain', 'Not Found');
  });
  state.origin = await listen(server);
  state.close = () => new Promise((resolveClose) => server.close(resolveClose));
  return state;
}


const AUTHORIZATION = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/;

// B2's S3 API, path-style. Every request must carry a valid SigV4 Authorization header for the
// read-only key; the mock recomputes the signature with aws4fetch's signer to check it.
export async function startS3() {
  const state = { requests: [], rejected: [] };
  const server = http.createServer(async (req, res) => {
    await readBody(req);
    const url = new URL(req.url, 'http://s3');
    const entry = { method: req.method, path: url.pathname, headers: req.headers };
    state.requests.push(entry);

    const reject = (why) => {
      state.rejected.push({ ...entry, why });
      send(res, 403, 'application/xml', `<Error><Code>SignatureDoesNotMatch</Code><Message>${why}</Message></Error>`);
    };
    const match = AUTHORIZATION.exec(req.headers.authorization || '');
    if (!match) {
      return reject('malformed Authorization header');
    }
    const [, keyId, date, region, signedList] = match;
    const signed = signedList.split(';');
    const amzDate = req.headers['x-amz-date'] || '';
    if (keyId !== SECRETS.S3_READ_ACCESS_KEY_ID || region !== S3_REGION || !amzDate.startsWith(date)) {
      return reject('wrong key, region or date');
    }
    for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) {
      if (!signed.includes(required)) {
        return reject(`${required} is not signed`);
      }
    }
    const headers = {};
    for (const name of signed) {
      headers[name] = req.headers[name];
    }
    const signer = new AwsV4Signer({
      method: req.method, url: `http://${req.headers.host}${req.url}`, headers,
      accessKeyId: SECRETS.S3_READ_ACCESS_KEY_ID, secretAccessKey: SECRETS.S3_READ_SECRET_ACCESS_KEY,
      service: 's3', region: S3_REGION, datetime: amzDate,
    });
    if ((await signer.authHeader()) !== req.headers.authorization) {
      return reject('signature mismatch');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reject('read-only key');
    }

    const prefix = `/${S3_BUCKET}/`;
    const key = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    const blob = (key !== null && Object.hasOwn(objects, key)) ? objects[key] : null;
    if (!blob || !blob.s3) {
      return send(res, 404, 'application/xml', '<Error><Code>NoSuchKey</Code></Error>');
    }
    return sendObject(req, res, blob.body, 'application/octet-stream', { 'x-amz-request-id': 'r1', 'x-bz-file-id': 'f1' });
  });
  state.origin = await listen(server);
  state.close = () => new Promise((resolveClose) => server.close(resolveClose));
  return state;
}


// wrangler.toml, with absolute paths and the assets directory pointed at WEB_DIST.
function testConfigPath() {
  const { rawConfig } = experimental_readRawConfig({ config: join(ROOT, 'wrangler.toml') });
  const config = {
    ...rawConfig,
    main: join(ROOT, rawConfig.main),
    assets: { ...rawConfig.assets, directory: WEB_DIST },
  };
  delete config.routes;
  const dir = mkdtempSync(join(tmpdir(), 'filesgg-worker-test-'));
  const path = join(dir, 'wrangler.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}


export async function startWorker({ upstream, s3 }, { secrets = SECRETS, vars = {} } = {}) {
  const config = testConfigPath();
  const harness = createTestHarness({
    workers: [{
      configPath: config.path,
      vars: {
        API_ORIGIN: upstream.origin,
        S3_ENDPOINT: s3 ? s3.origin : '',
        S3_REGION,
        S3_BUCKET_FILES: S3_BUCKET,
        ...vars,
      },
      secrets,
    }],
  });
  const { url } = await harness.listen();

  // Raw HTTP so the test controls every request header (fetch() would add Accept,
  // Accept-Language and User-Agent, which the bot routing looks at). Host picks the domain.
  const request = (target, { method = 'GET', headers = {}, body } = {}) => new Promise((resolveRequest, reject) => {
    const parsed = new URL(target);
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method,
      path: parsed.pathname + parsed.search,
      headers: { host: parsed.host, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolveRequest({ status: res.statusCode, headers: res.headers, text: buffer.toString('utf8'), buffer });
      });
    });
    req.on('error', reject);
    req.end(body);
  });

  const close = async () => {
    await harness.close();
    config.cleanup();
  };
  return { harness, request, close, url };
}
