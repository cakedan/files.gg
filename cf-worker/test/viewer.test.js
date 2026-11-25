import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCKED_FILE_TITLE,
  VIEWER_CSP,
  classifyStablePath,
  decideAlbumShell,
  decideFileShell,
  escapeJsonForHtml,
  fileMetaTags,
  isExpired,
} from '../worker/utils/viewer.js';


const NOW = Date.UTC(2026, 10, 24, 12);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const browser = new Headers({ 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en' });

const imageFile = {
  id: '1111', vanity: 'img1', kind: 'image', filename: 'cat.png', mimetype: 'image/png', extension: 'png',
  size: 123456, width: 800, height: 600, cdnUrl: 'https://cdn.files.gg/files/img1.png', url: 'https://files.gg/img1.png',
  uploadedAt: NOW - 1000, expiresAt: null,
};
const found = (file, access = {}) => ({
  status: 'found',
  data: { file, access: { visibility: 'link', access_version: 0, unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: false, ...access } },
});


describe('escapeJsonForHtml', () => {
  it('cannot close the script tag and stays valid JSON', () => {
    const value = { filename: `</script><script>alert(1)</script>&${LS}${PS}.png` };
    const escaped = escapeJsonForHtml(value);
    assert.doesNotMatch(escaped, /[<>&]/);
    assert.equal(escaped.includes(LS) || escaped.includes(PS), false);
    assert.ok(escaped.includes('\\u003c/script\\u003e'));
    assert.ok(escaped.includes('\\u0026'));
    assert.ok(escaped.includes('\\u2028') && escaped.includes('\\u2029'));
    assert.deepEqual(JSON.parse(escaped), value);
  });

  it('renders null for a missing payload', () => {
    assert.equal(escapeJsonForHtml(null), 'null');
    assert.equal(escapeJsonForHtml(undefined), 'null');
  });
});


describe('decideFileShell', () => {
  it('link file: file state, the payload as-is, 200 and its own meta tags', () => {
    const shell = decideFileShell({ lookup: found(imageFile), vanity: 'img1', headers: browser, nowMs: NOW });
    assert.equal(shell.page, 'file');
    assert.equal(shell.state, 'file');
    assert.equal(shell.dataId, 'file-data');
    assert.deepEqual(shell.data, imageFile);
    assert.equal(shell.status, 200);
    assert.match(shell.meta, /<meta property="og:image" content="https:\/\/cdn.files.gg\/files\/img1.png">/);
  });

  it('missing: null payload and 404', () => {
    const shell = decideFileShell({ lookup: { status: 'missing' }, vanity: 'x', headers: browser, nowMs: NOW });
    assert.deepEqual(shell, { page: 'file', state: 'missing', dataId: 'file-data', data: null, status: 404 });
  });

  it('expired (even while the lookup is cached): missing', () => {
    for (const file of [{ ...imageFile, expiresAt: NOW }, { ...imageFile, expiresAt: undefined, expires_at: NOW / 1000 - 1 }]) {
      assert.equal(decideFileShell({ lookup: found(file), vanity: 'img1', headers: browser, nowMs: NOW }).state, 'missing');
    }
    assert.equal(decideFileShell({ lookup: found({ ...imageFile, expiresAt: NOW + 1 }), vanity: 'img1', headers: browser, nowMs: NOW }).state, 'file');
  });

  it('unavailable: no payload, 503, never cached', () => {
    const shell = decideFileShell({ lookup: { status: 'unavailable' }, vanity: 'x', headers: browser, nowMs: NOW });
    assert.deepEqual(shell, { page: 'file', state: 'unavailable', status: 503, cacheControl: 'private, no-store' });
  });

  it('password: locked, only vanity and protected, generic meta with no media', () => {
    const shell = decideFileShell({ lookup: found(imageFile, { visibility: 'password' }), vanity: 'img1', headers: browser, nowMs: NOW });
    assert.equal(shell.state, 'locked');
    assert.equal(shell.status, 200);
    assert.deepEqual(shell.data, { vanity: 'img1', protected: 'password' });
    assert.ok(shell.meta.includes(`<meta property="og:title" content="${LOCKED_FILE_TITLE}">`));
    assert.doesNotMatch(shell.meta, /og:image|og:video|og:audio|cat\.png|cdn\.files\.gg/);
  });

  it('password with show_name_when_locked: the filename is included', () => {
    const shell = decideFileShell({ lookup: found(imageFile, { visibility: 'password', show_name_when_locked: true }), vanity: 'img1', headers: browser, nowMs: NOW });
    assert.deepEqual(shell.data, { vanity: 'img1', protected: 'password', filename: 'cat.png' });
    assert.doesNotMatch(shell.meta, /cat\.png/);
  });

  it('password that has expired: password_expired', () => {
    const shell = decideFileShell({ lookup: found(imageFile, { visibility: 'password', password_expires_at: NOW / 1000 }), vanity: 'img1', headers: browser, nowMs: NOW });
    assert.deepEqual(shell.data, { vanity: 'img1', protected: 'password', password_expired: true });
  });

  it('private (and unknown visibilities): missing, 404', () => {
    for (const visibility of ['private', 'people', undefined]) {
      const shell = decideFileShell({ lookup: found(imageFile, { visibility }), vanity: 'img1', headers: browser, nowMs: NOW });
      assert.equal(shell.state, 'missing', String(visibility));
      assert.equal(shell.data, null);
      assert.equal(shell.status, 404);
    }
  });

  it('bots and embeds of link files are redirected to the CDN', () => {
    for (const headers of [
      new Headers({ 'user-agent': 'ShareX/15.0' }),
      new Headers({ 'user-agent': 'TelegramBot (like TwitterBot)' }),
      new Headers({ 'user-agent': 'Mozilla/5.0', accept: 'text/html' }),
      new Headers({ 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', accept: 'image/*' }),
    ]) {
      const shell = decideFileShell({ lookup: found(imageFile), vanity: 'img1', headers, nowMs: NOW });
      assert.deepEqual(shell, { redirect: imageFile.cdnUrl }, headers.get('user-agent'));
    }
  });

  it('never redirects protected files, whoever asks', () => {
    for (const visibility of ['password', 'private']) {
      for (const agent of ['ShareX/15.0', 'TelegramBot (like TwitterBot)', 'Discordbot/2.0']) {
        const headers = new Headers({ 'user-agent': agent, accept: 'image/*' });
        const shell = decideFileShell({ lookup: found(imageFile, { visibility }), vanity: 'img1', headers, nowMs: NOW });
        assert.equal(shell.redirect, undefined, `${visibility} ${agent}`);
        assert.equal(shell.state, visibility === 'password' ? 'locked' : 'missing');
      }
    }
  });
});


describe('meta tags', () => {
  it('use property= for og:* and escape the filename', () => {
    const meta = fileMetaTags({ ...imageFile, filename: '"><script>x</script>.png' });
    assert.doesNotMatch(meta, /name="og:/);
    assert.doesNotMatch(meta, /<script>/);
    assert.match(meta, /<meta property="og:title" content="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;.png">/);
    assert.match(meta, /<meta property="og:image:width" content="800">/);
    assert.match(meta, /<meta name="twitter:card" content="summary_large_image">/);
  });

  it('video gets og:video with its size, unplayable video does not', () => {
    const video = { ...imageFile, kind: 'video', mimetype: 'video/mp4', filename: 'clip.mp4', cdnUrl: 'https://cdn.files.gg/files/v.mp4' };
    assert.match(fileMetaTags(video), /<meta property="og:video" content="https:\/\/cdn.files.gg\/files\/v.mp4"><meta property="og:video:type" content="video\/mp4"><meta property="og:video:width" content="800"><meta property="og:video:height" content="600">/);
    assert.doesNotMatch(fileMetaTags({ ...video, media: { playable: false } }), /og:video"/);
  });

  it('other kinds get the default files.gg image', () => {
    const zip = { ...imageFile, kind: 'file', mimetype: 'application/zip', filename: 'a.zip' };
    assert.match(fileMetaTags(zip), /<meta property="og:image" content="https:\/\/files.gg\/og-image.png">/);
  });
});


describe('decideAlbumShell', () => {
  const album = {
    id: '900', vanity: 'alb1', title: 'Trip', url: 'https://files.gg/a/alb1',
    items: [{ ...imageFile, id: '1', position: 0, caption: '' }, { ...imageFile, id: '2', position: 1, caption: '' }],
  };
  const lookup = (access, itemsAccess = {}, overrides = {}) => ({
    status: 'found',
    data: { album: { ...album, ...overrides }, access: { visibility: 'link', access_version: 0, show_name_when_locked: false, ...access }, items_access: itemsAccess },
  });

  it('link album: album-data and "Title · N files"', () => {
    const shell = decideAlbumShell({ lookup: lookup({}), vanity: 'alb1', nowMs: NOW });
    assert.equal(shell.state, 'album');
    assert.equal(shell.dataId, 'album-data');
    assert.equal(shell.data.items.length, 2);
    assert.match(shell.meta, /<meta property="og:title" content="Trip · 2 files">/);
  });

  it('drops private items; an album with no visible items is missing', () => {
    const one = decideAlbumShell({ lookup: lookup({}, { 2: { visibility: 'private', access_version: 0 } }), vanity: 'alb1', nowMs: NOW });
    assert.deepEqual(one.data.items.map((item) => item.id), ['1']);
    const none = decideAlbumShell({ lookup: lookup({}, {}, { items: [] }), vanity: 'alb1', nowMs: NOW });
    assert.deepEqual(none, { page: 'album', state: 'missing', status: 404 });
  });

  it('password album: locked, with the title only when allowed', () => {
    assert.deepEqual(decideAlbumShell({ lookup: lookup({ visibility: 'password' }), vanity: 'alb1', nowMs: NOW }).data, { vanity: 'alb1', protected: 'password' });
    assert.deepEqual(
      decideAlbumShell({ lookup: lookup({ visibility: 'password', show_name_when_locked: true }), vanity: 'alb1', nowMs: NOW }).data,
      { vanity: 'alb1', protected: 'password', title: 'Trip' },
    );
  });

  it('private, missing and unavailable', () => {
    assert.equal(decideAlbumShell({ lookup: lookup({ visibility: 'private' }), vanity: 'alb1', nowMs: NOW }).status, 404);
    assert.equal(decideAlbumShell({ lookup: { status: 'missing' }, vanity: 'alb1', nowMs: NOW }).state, 'missing');
    assert.equal(decideAlbumShell({ lookup: { status: 'unavailable' }, vanity: 'alb1', nowMs: NOW }).status, 503);
  });

  it('NSFW albums get no image', () => {
    const shell = decideAlbumShell({ lookup: lookup({}, {}, { nsfw: true, cover: { url: 'https://cdn.files.gg/c.webp' } }), vanity: 'alb1', nowMs: NOW });
    assert.doesNotMatch(shell.meta, /og:image/);
  });
});


describe('classifyStablePath (web/README.md §1 order)', () => {
  const cases = {
    '/favicon.ico': 'root-file', '/og-image.png': 'root-file', '/apple-touch-icon.png': 'root-file',
    '/assets/viewer-abc.js': 'asset', '/assets/pdfjs/6.5.438/wasm/openjpeg.wasm': 'asset',
    '/app': 'app', '/app/files': 'app', '/': 'home', '/convert': 'convert',
    '/a/Ab3dE6gH': 'album', '/a/Ab3dE6gH/3': 'album',
    '/api/users/@me': 'api', '/auth/login': 'legacy', '/dashboard/files': 'legacy',
    '/img1': 'file', '/img1.png': 'file', '/abcd/xyz.png': 'file', '/favicon': 'file', '/apple': 'file',
  };
  for (const [path, route] of Object.entries(cases)) {
    it(`${path} -> ${route}`, () => assert.equal(classifyStablePath(path).route, route));
  }

  it('parses vanities like the old router', () => {
    assert.equal(classifyStablePath('/abcd/xyz.png.zip').vanity, 'abcd/xyz');
    assert.equal(classifyStablePath('/img1/').vanity, 'img1');
    assert.equal(classifyStablePath('/a/Ab3dE6gH/12').vanity, 'Ab3dE6gH');
    assert.equal(classifyStablePath('/api/files?x').path, '/files?x');
  });
});


describe('viewer CSP (web/README.md §6)', () => {
  const directives = Object.fromEntries(VIEWER_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
  it('allows what pdf.js and the media need, and nothing inline for scripts', () => {
    assert.deepEqual(directives['worker-src'], ["'self'"]);
    assert.ok(directives['script-src'].includes("'self'") && directives['script-src'].includes("'wasm-unsafe-eval'"));
    assert.ok(!directives['script-src'].includes("'unsafe-inline'") && !directives['script-src'].includes("'unsafe-eval'"));
    for (const name of ['img-src', 'media-src']) {
      for (const source of ['https://cdn.files.gg', 'blob:', 'data:']) {
        assert.ok(directives[name].includes(source), `${name} ${source}`);
      }
    }
    assert.ok(directives['connect-src'].includes("'self'") && directives['connect-src'].includes('https://cdn.files.gg'));
    assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  });
});


describe('isExpired', () => {
  it('reads expiresAt as ms and expires_at as seconds, and null as never', () => {
    assert.equal(isExpired({ expiresAt: NOW - 1 }, NOW), true);
    assert.equal(isExpired({ expires_at: Math.floor(NOW / 1000) - 1 }, NOW), true);
    assert.equal(isExpired({ expires_at: new Date(NOW - 1).toISOString() }, NOW), true);
    assert.equal(isExpired({ expiresAt: null }, NOW), false);
    assert.equal(isExpired({}, NOW), false);
  });
});
