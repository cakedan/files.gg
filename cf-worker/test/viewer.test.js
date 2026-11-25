import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCKED_FILE_TITLE,
  VIEWER_CSP,
  albumMetaTags,
  classifyStablePath,
  decideAlbumShell,
  decideFileShell,
  escapeJsonForHtml,
  fileMetaTags,
  isExpired,
  LEGAL_REDIRECTS,
  PUBLIC_PAGE_PATHS,
  publicPageHead,
  visibleAlbumItems,
} from '../worker/utils/viewer.js';


const NOW = Date.UTC(2026, 10, 24, 12);
const NOW_S = NOW / 1000;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const browser = new Headers({ 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en' });

const imageFile = {
  id: '1111', vanity: 'img1', kind: 'image', filename: 'cat.png', mimetype: 'image/png', extension: 'png',
  size: 123456, width: 800, height: 600, cdn_url: 'https://cdn.files.gg/files/img1.png', url: 'https://files.gg/img1.png',
  uploaded_at: NOW_S - 1, expires_at: null,
};
const OK = { state: 'ok', reason: null };
const found = (file, access = {}, extra = {}) => ({
  status: 'found',
  data: {
    file, access: { visibility: 'link', access_version: 0, unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: false, ...access },
    safety: OK, serve_inline: true, ...extra,
  },
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
    for (const file of [{ ...imageFile, expires_at: NOW_S }, { ...imageFile, expires_at: NOW_S - 1 }]) {
      assert.equal(decideFileShell({ lookup: found(file), vanity: 'img1', headers: browser, nowMs: NOW }).state, 'missing');
    }
    assert.equal(decideFileShell({ lookup: found({ ...imageFile, expires_at: NOW_S + 1 }), vanity: 'img1', headers: browser, nowMs: NOW }).state, 'file');
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
      assert.deepEqual(shell, { redirect: imageFile.cdn_url }, headers.get('user-agent'));
    }
  });

  it('redirects to cdn_url only: an old camelCase cdnUrl is ignored', () => {
    const headers = new Headers({ 'user-agent': 'ShareX/15.0' });
    const old = { ...imageFile, cdn_url: undefined, cdnUrl: 'https://cdn.files.gg/files/img1.png' };
    const shell = decideFileShell({ lookup: found(old), vanity: 'img1', headers, nowMs: NOW });
    assert.equal(shell.redirect, undefined);
    assert.equal(shell.state, 'file');
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
    const video = { ...imageFile, kind: 'video', mimetype: 'video/mp4', filename: 'clip.mp4', cdn_url: 'https://cdn.files.gg/files/v.mp4' };
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
    items: [{ ...imageFile, id: '1', visibility: 'link', position: 0, caption: '' }, { ...imageFile, id: '2', visibility: 'link', position: 1, caption: '' }],
  };
  const lookup = (access, itemsAccess = {}, overrides = {}, extra = {}) => ({
    status: 'found',
    data: {
      album: { ...album, ...overrides }, access: { visibility: 'link', access_version: 0, show_name_when_locked: false, ...access }, items_access: itemsAccess,
      safety: OK, pending_count: 0, ...extra,
    },
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

  it('milestone 3 §4: a link album shows only link items (password ones too are hidden)', () => {
    const shell = decideAlbumShell({ lookup: lookup({}, { 1: { visibility: 'password', access_version: 0 } }), vanity: 'alb1', nowMs: NOW });
    assert.deepEqual(shell.data.items.map((item) => item.id), ['2']);
    assert.match(shell.meta, /Trip · 1 file"/);
    const byPayload = decideAlbumShell({ lookup: lookup({}, {}, { items: [{ ...album.items[0], visibility: 'private' }] }), vanity: 'alb1', nowMs: NOW });
    assert.equal(byPayload.state, 'missing');
  });

  it('an item whose visibility is unknown fails closed in a link album', () => {
    const items = album.items.map(({ visibility, ...item }) => item);
    assert.equal(decideAlbumShell({ lookup: lookup({}, {}, { items }), vanity: 'alb1', nowMs: NOW }).state, 'missing');
  });

  it('expired items drop out, and items keep album order', () => {
    const items = [
      { ...album.items[0], id: '3', position: 2 },
      { ...album.items[1], expires_at: NOW_S - 1 },
      { ...album.items[0], position: 0 },
    ];
    const shell = decideAlbumShell({ lookup: lookup({}, {}, { items }), vanity: 'alb1', nowMs: NOW });
    assert.deepEqual(visibleAlbumItems({ album: { items }, access: { visibility: 'link' } }, NOW).map((item) => item.id), ['1', '3']);
    assert.equal(shell.data.items.length, 2);
  });

  it('a protected album shows every item (the locked shell never inlines them)', () => {
    const items = [{ ...album.items[0], visibility: 'private' }, { ...album.items[1], visibility: 'password' }];
    assert.equal(visibleAlbumItems({ album: { items }, access: { visibility: 'password' } }, NOW).length, 2);
    const shell = decideAlbumShell({ lookup: lookup({ visibility: 'password' }, {}, { items }), vanity: 'alb1', nowMs: NOW });
    assert.equal(shell.state, 'locked');
    assert.equal(shell.data.items, undefined);
    assert.doesNotMatch(shell.meta, /og:image|Trip/);
  });
});


describe('albumMetaTags (milestone 3 embeds)', () => {
  const collage = { url: 'https://cdn.files.gg/albums/collage/alb1.webp?v=5', width: 1200, height: 630 };
  const cover = { url: 'https://cdn.files.gg/previews/cover/song1.webp?v=6', type: 'cover', width: 1200, height: 1200 };
  const image = { ...imageFile, kind: 'image' };
  const song = { kind: 'audio', filename: 'a.mp3', media: { tags: { album: 'Greatest Hits' } } };

  it('og:title is "Title · N files" and og:image the collage, with its dimensions', () => {
    const meta = albumMetaTags({ title: 'Trip', url: 'https://files.gg/a/x', collage, cover }, 3, [image, image]);
    assert.match(meta, /<meta property="og:title" content="Trip · 3 files">/);
    assert.ok(meta.includes(`<meta property="og:image" content="${collage.url}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`));
    assert.match(meta, /<meta name="twitter:card" content="summary_large_image">/);
    assert.doesNotMatch(meta, /cover\.webp/);
  });

  it('without a collage, the cover; with neither, no image', () => {
    assert.ok(albumMetaTags({ title: 'T', cover }, 1, [image]).includes(`content="${cover.url}"`));
    const none = albumMetaTags({ title: 'T' }, 1, [image]);
    assert.doesNotMatch(none, /og:image/);
    assert.match(none, /twitter:card" content="summary"/);
  });

  it('an audio album uses its cover art, and an empty title falls back to the album tag', () => {
    const meta = albumMetaTags({ title: '', collage, cover }, 2, [song, song]);
    assert.ok(meta.includes(`<meta property="og:image" content="${cover.url}">`));
    assert.doesNotMatch(meta, /collage\.webp/);
    assert.match(meta, /og:title" content="Greatest Hits · 2 files"/);
    assert.match(meta, /og:type" content="music.album"/);
  });

  it('NSFW (the album or any item) gets no image', () => {
    assert.doesNotMatch(albumMetaTags({ title: 'T', nsfw: true, collage, cover }, 1, [image]), /og:image|twitter:image/);
    assert.doesNotMatch(albumMetaTags({ title: 'T', collage }, 1, [{ ...image, nsfw: true }]), /og:image|twitter:image/);
  });

  it('escapes the title', () => {
    assert.match(albumMetaTags({ title: '<b>"x"</b>' }, 1, [image]), /content="&lt;b&gt;&quot;x&quot;&lt;\/b&gt; · 1 file"/);
  });
});


describe('fileMetaTags (milestone 3 embeds)', () => {
  // As the API writes them (contract §3): ready to use, signed or not.
  const v = (vanity, kind) => `https://cdn.files.gg/previews/${kind}/${vanity}.${kind === 'peaks' ? 'json' : kind === 'hover' ? 'mp4' : 'webp'}?v=1795600000`;
  const video = {
    ...imageFile, id: '100000000000000001', kind: 'video', filename: 'clip.mp4', mimetype: 'video/mp4', width: 1920, height: 1080,
    cdn_url: 'https://cdn.files.gg/files/vid.mp4',
    assets: { poster: { url: v('vid', 'poster'), width: 1280, height: 720 }, thumb: { url: v('vid', 'thumb') }, hover: { url: v('vid', 'hover') } },
    thumbnail: { url: v('vid', 'poster'), type: 'poster', width: 1280, height: 720 },
    hover_url: v('vid', 'hover'),
  };

  it('video: og:image is the poster with its dimensions, plus og:video with the video\'s', () => {
    const meta = fileMetaTags(video);
    assert.ok(meta.includes(`<meta property="og:image" content="${v('vid', 'poster')}"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="720">`));
    assert.doesNotMatch(meta, /hover/);
    assert.ok(meta.includes('<meta property="og:video" content="https://cdn.files.gg/files/vid.mp4"><meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1920"><meta property="og:video:height" content="1080">'));
  });

  it('video that can\'t play in browsers: the poster, no og:video', () => {
    const meta = fileMetaTags({ ...video, media: { playable: false } });
    assert.match(meta, /og:image" content="[^"]+\/previews\/poster\/vid\.webp/);
    assert.doesNotMatch(meta, /og:video|twitter:player/);
  });

  it('audio: the cover, else the waveform', () => {
    const audio = { ...imageFile, kind: 'audio', filename: 'a.mp3', mimetype: 'audio/mpeg' };
    const withCover = fileMetaTags({ ...audio, assets: { cover: { url: v('a', 'cover'), width: 1200, height: 1200 }, waveform: { url: v('a', 'waveform') } } });
    assert.ok(withCover.includes(`og:image" content="${v('a', 'cover')}"><meta property="og:image:width" content="1200">`));
    assert.ok(withCover.includes('og:audio" content="https://cdn.files.gg/files/img1.png"'));
    const wave = fileMetaTags({ ...audio, assets: { waveform: { url: v('a', 'waveform'), width: 1600, height: 240 } } });
    assert.ok(wave.includes(`og:image" content="${v('a', 'waveform')}"><meta property="og:image:width" content="1600"><meta property="og:image:height" content="240">`));
  });

  it('a non-browser image embeds its display preview, never the original', () => {
    const heic = { ...imageFile, kind: 'image', filename: 'p.heic', mimetype: 'image/heic', cdn_url: 'https://cdn.files.gg/files/p.heic',
      assets: { display: { url: v('p', 'display'), width: 4032, height: 3024 } } };
    const meta = fileMetaTags(heic);
    assert.ok(meta.includes(`<meta property="og:image" content="${v('p', 'display')}"><meta property="og:image:type" content="image/webp"><meta property="og:image:width" content="4032">`));
    assert.doesNotMatch(meta, /files\/p\.heic|image\/heic/);
  });

  it('a browser image still embeds itself', () => {
    assert.match(fileMetaTags({ ...imageFile, assets: { thumb: { url: v('img1', 'thumb') } } }), /og:image" content="https:\/\/cdn.files.gg\/files\/img1.png"/);
  });

  it('a PDF embeds its first-page thumb (the larger one when there is one)', () => {
    const pdf = { ...imageFile, kind: 'pdf', filename: 'd.pdf', mimetype: 'application/pdf',
      assets: { thumb: { url: v('d', 'thumb'), width: 248, height: 320 }, 'thumb-2x': { url: v('d', 'thumb-2x'), width: 495, height: 640 } } };
    assert.ok(fileMetaTags(pdf).includes(`<meta property="og:image" content="${v('d', 'thumb-2x')}"><meta property="og:image:width" content="495">`));
    const small = fileMetaTags({ ...pdf, assets: { thumb: pdf.assets.thumb } });
    assert.ok(small.includes(`content="${v('d', 'thumb')}"`));
    assert.doesNotMatch(fileMetaTags({ ...pdf, assets: {} }), /previews\//);
  });

  it('nsfw: true gets no image, video or audio', () => {
    for (const file of [{ ...video, nsfw: true }, { ...imageFile, nsfw: true }]) {
      const meta = fileMetaTags(file);
      assert.doesNotMatch(meta, /og:image|og:video|og:audio|twitter:image|twitter:player/);
      assert.match(meta, /Sensitive content/);
    }
  });
});


describe('classifyStablePath (web/README.md §1 order)', () => {
  const cases = {
    '/favicon.ico': 'root-file', '/og-image.png': 'root-file', '/apple-touch-icon.png': 'root-file',
    '/assets/viewer-abc.js': 'asset', '/assets/pdfjs/6.5.438/wasm/openjpeg.wasm': 'asset',
    '/app': 'app', '/app/files': 'app', '/': 'home', '/convert': 'page',
    '/a/Ab3dE6gH': 'album', '/a/Ab3dE6gH/': 'album',
    // milestone-6.md §20.2: the album item is `?item=<n>`; nothing comes after an album's vanity.
    '/a/Ab3dE6gH/3': 'missing', '/a/Ab3dE6gH/3/': 'missing',
    '/api/users/@me': 'api',
    // The old frontend's pages are gone (milestone-3.md §0): these are vanities now.
    '/auth/session': 'file', '/dashboard/uploads': 'file', '/options': 'file', '/details/1': 'file',
    // milestone-5.md §19.1: the changelog and legal pages; /legal redirects to the Terms.
    '/changelog': 'page', '/changelog/': 'page', '/legal/terms': 'page', '/legal/privacy/': 'page', '/legal': 'redirect',
    '/legal/other': 'missing', '/changelog/x': 'missing', '/x/changelog.png': 'missing', '/convert/x': 'missing',
    // milestone-7.md §7: the link warnings help page; `help` is reserved, so nothing else under it is a vanity.
    '/help/link-warnings': 'page', '/help/link-warnings/': 'page', '/help': 'missing', '/help/other': 'missing', '/x/help.png': 'missing',
    // ...except where they contain a reserved segment (milestone-6.md §6.3): never looked up.
    '/auth/login': 'missing', '/dashboard/files': 'missing',
    '/img1': 'file', '/img1.png': 'file', '/abcd/xyz.png': 'file', '/favicon': 'file', '/apple': 'file',
  };
  for (const [path, route] of Object.entries(cases)) {
    it(`${path} -> ${route}`, () => assert.equal(classifyStablePath(path).route, route));
  }

  it('parses vanities like the old router', () => {
    assert.equal(classifyStablePath('/abcd/xyz.png.zip').vanity, 'abcd/xyz');
    assert.equal(classifyStablePath('/img1/').vanity, 'img1');
    assert.equal(classifyStablePath('/a/Ab3dE6gH/').vanity, 'Ab3dE6gH');
    assert.equal(classifyStablePath('/a/caf%C3%A9').vanity, 'café');
    assert.equal(classifyStablePath('/api/files?x').path, '/files?x');
  });
});


describe('the public app pages: Convert, changelog, Terms, Privacy and link warnings (milestone-5.md §11, §19.1, milestone-7.md §7)', () => {
  it('maps each path to its page, and /legal to a 302 to the Terms', () => {
    assert.deepEqual(PUBLIC_PAGE_PATHS, {
      '/convert': 'convert', '/convert/': 'convert',
      '/changelog': 'changelog', '/changelog/': 'changelog',
      '/legal/terms': 'terms', '/legal/terms/': 'terms',
      '/legal/privacy': 'privacy', '/legal/privacy/': 'privacy',
      '/help/link-warnings': 'link-warnings', '/help/link-warnings/': 'link-warnings',
    });
    for (const [path, page] of Object.entries(PUBLIC_PAGE_PATHS)) {
      assert.deepEqual(classifyStablePath(path), { route: 'page', page }, path);
    }
    for (const path of Object.keys(LEGAL_REDIRECTS)) {
      assert.deepEqual(classifyStablePath(path), { route: 'redirect', location: '/legal/terms', status: 302 }, path);
    }
  });

  it('gives each page its own title and description', () => {
    const titles = {
      convert: 'Convert · files.gg', changelog: 'Changelog · files.gg', terms: 'Terms of Service · files.gg', privacy: 'Privacy Policy · files.gg',
      'link-warnings': 'Link warnings · files.gg',
    };
    const descriptions = new Set();
    for (const [page, title] of Object.entries(titles)) {
      const head = publicPageHead(page);
      assert.equal(head.title, title);
      assert.match(head.meta, new RegExp(`<meta property="og:title" content="${title}">`));
      assert.match(head.meta, /<meta property="og:image" content="https:\/\/files.gg\/og-image.png">/);
      assert.doesNotMatch(head.meta, /robots/);
      const description = /<meta name="description" content="([^"]+)">/.exec(head.meta)[1];
      assert.match(head.meta, new RegExp(`<meta property="og:description" content="${description}">`));
      descriptions.add(description);
    }
    assert.equal(descriptions.size, Object.keys(titles).length);
    assert.match(publicPageHead('terms', { mainOrigin: 'http://files.localhost:8787' }).meta, /content="http:\/\/files.localhost:8787\/og-image.png"/);
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
  it('reads expires_at as epoch seconds, and null as never; camelCase is gone', () => {
    assert.equal(isExpired({ expires_at: NOW_S - 1 }, NOW), true);
    assert.equal(isExpired({ expires_at: NOW_S + 1 }, NOW), false);
    assert.equal(isExpired({ expires_at: new Date(NOW - 1).toISOString() }, NOW), true);
    assert.equal(isExpired({ expires_at: null }, NOW), false);
    assert.equal(isExpired({ expiresAt: NOW - 1 }, NOW), false);
    assert.equal(isExpired({}, NOW), false);
  });
});
