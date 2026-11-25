// files.gg on the real Worker (workerd): web/dist static assets and routing order, the viewer
// shell in every state (web/README.md "Worker contract", contract §4), bot routing and the legacy
// pages. The API, GCS and B2 are local mocks; web/dist is test/fixtures/web-dist (or $WEB_DIST).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cases, headersFor, mithril, withOgProperty } from '../support/fixtures.js';
import { ALBUMS, FILES, WEB_DIST, startS3, startUpstream, startWorker } from '../support/worker.js';


const browser = { ...cases.browser };
const VIEWER_HTML = readFileSync(join(WEB_DIST, 'viewer.html'), 'utf8');
// Real asset names, so the tests also run against a real build (WEB_DIST).
const ASSET_FILES = readdirSync(join(WEB_DIST, 'assets'), { recursive: true }).map((name) => '/assets/' + String(name).replace(/\\/g, '/'));
const findAsset = (pattern) => ASSET_FILES.find((name) => pattern.test(name));
const VIEWER_SCRIPT = /<script type="module" crossorigin src="[^"]+"><\/script>/.exec(VIEWER_HTML)[0];
const DEFAULT_META = VIEWER_HTML.slice(VIEWER_HTML.indexOf('-->', VIEWER_HTML.indexOf('filesgg:meta:start')) + 3, VIEWER_HTML.indexOf('<!-- filesgg:meta:end'));

let upstream;
let s3;
let worker;
const page = (path, options = {}) => worker.request('https://files.gg' + path, { headers: browser, ...options });
const lookups = (kind, vanity) => upstream.requests.filter((r) => r.path === `/internal/${kind}/${vanity}`).length;

before(async () => {
  upstream = await startUpstream();
  s3 = await startS3();
  worker = await startWorker({ upstream, s3 });
});

after(async () => {
  await worker?.close();
  await s3?.close();
  await upstream?.close();
});


// Reads the shell's #root attributes, boot JSON and meta block.
function parseShell(html) {
  const root = /<div id="root"([^>]*)><\/div>/.exec(html);
  assert.ok(root, 'has #root');
  const attributes = Object.fromEntries([...root[1].matchAll(/ (data-[a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const script = /<div id="root"[^>]*><\/div><script id="(file-data|album-data)" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const start = html.indexOf('-->', html.indexOf('filesgg:meta:start')) + 3;
  const meta = html.slice(start, html.indexOf('<!-- filesgg:meta:end'));
  return {
    page: attributes['data-page'],
    state: attributes['data-state'],
    dataId: script ? script[1] : undefined,
    rawData: script ? script[2] : undefined,
    data: script ? JSON.parse(script[2]) : undefined,
    meta,
  };
}

function assertShellHeaders(response, cacheControl = 'no-cache') {
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['cache-control'], cacheControl);
  const csp = response.headers['content-security-policy'];
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /connect-src 'self' https:\/\/cdn\.files\.gg/);
  assert.match(csp, /img-src 'self' https:\/\/cdn\.files\.gg blob: data:/);
  assert.match(csp, /media-src 'self' https:\/\/cdn\.files\.gg blob: data:/);
  assert.match(csp, /frame-ancestors 'none'/);
}


describe('static files from web/dist (routed before any vanity lookup)', () => {
  it('serves every root file without touching the vanity lookup', async () => {
    for (const name of ['favicon.ico', 'favicon.svg', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og-image.png']) {
      const response = await page('/' + name);
      assert.equal(response.status, 200, name);
      assert.equal(response.text, readFileSync(join(WEB_DIST, name), 'utf8'), name);
      assert.equal(response.headers['cache-control'], 'public, max-age=86400', name);
      assert.equal(lookups('files', name.split('.')[0]), 0, name);
    }
  });

  it('serves hashed assets as immutable, .mjs as JavaScript and .wasm as wasm', async () => {
    const js = await page(findAsset(/^\/assets\/viewer-[^/]+\.js$/));
    assert.equal(js.status, 200);
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(js.headers['content-type'], 'text/javascript');

    const pdfWorker = await page(findAsset(/^\/assets\/pdf\.worker\.min-[^/]+\.mjs$/));
    assert.equal(pdfWorker.status, 200);
    assert.equal(pdfWorker.headers['content-type'], 'text/javascript');

    const wasm = await page(findAsset(/\/wasm\/[^/]+\.wasm$/));
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers['content-type'], 'application/wasm');
    assert.equal(wasm.headers['cache-control'], 'public, max-age=31536000, immutable');

    const svg = await page(findAsset(/^\/assets\/brand\/[^/]+\.svg$/));
    assert.equal(svg.status, 200);
    assert.equal(svg.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  it('falls back to the old frontend\'s assets in GCS', async () => {
    const response = await page('/assets/old-app.js');
    assert.equal(response.status, 200);
    assert.equal(response.text, 'old()');
    assert.equal(upstream.requests.at(-1).path, '/assets/stable/old-app.js');
  });

  it('serves app.html for /app and /app/*', async () => {
    for (const path of ['/app', '/app/', '/app/files', '/app/settings/deep']) {
      const response = await page(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.text, readFileSync(join(WEB_DIST, 'app.html'), 'utf8'), path);
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(response.headers['cache-control'], 'no-cache');
    }
  });

  it('never serves viewer.html or app.html by their own path', async () => {
    const response = await page('/viewer.html');
    assert.equal(response.status, 404);
    assert.equal(parseShell(response.text).state, 'missing');
  });
});


describe('viewer shell states', () => {
  it('/ is home: no state, no data, the default meta tags', async () => {
    const response = await page('/');
    assert.equal(response.status, 200);
    assertShellHeaders(response);
    const shell = parseShell(response.text);
    assert.equal(shell.page, 'home');
    assert.equal(shell.state, undefined);
    assert.equal(shell.dataId, undefined);
    assert.equal(shell.meta, DEFAULT_META);
    assert.equal(lookups('files', ''), 0);
  });

  it('/convert', async () => {
    const response = await page('/convert');
    assert.equal(response.status, 200);
    assert.deepEqual([parseShell(response.text).page, parseShell(response.text).state], ['convert', undefined]);
  });

  it('a link file: file state, the payload, and its own meta tags', async () => {
    const response = await page('/img1.png');
    assert.equal(response.status, 200);
    assertShellHeaders(response);
    const shell = parseShell(response.text);
    assert.equal(shell.page, 'file');
    assert.equal(shell.state, 'file');
    assert.equal(shell.dataId, 'file-data');
    assert.deepEqual(shell.data, FILES.img1.file);
    assert.match(shell.meta, /<meta property="og:image" content="https:\/\/cdn.files.gg\/files\/img1.png">/);
    assert.match(shell.meta, /<meta property="og:image:width" content="800"><meta property="og:image:height" content="600">/);
    assert.doesNotMatch(shell.meta, /name="og:|Simple, fast file hosting/);
    // Everything outside the meta block is untouched.
    assert.ok(response.text.includes(VIEWER_SCRIPT));
  });

  it('a missing file: null payload and 404', async () => {
    const response = await page('/nope.png');
    assert.equal(response.status, 404);
    const shell = parseShell(response.text);
    assert.deepEqual([shell.page, shell.state, shell.dataId, shell.rawData], ['file', 'missing', 'file-data', 'null']);
    assert.equal(shell.meta, DEFAULT_META);
  });

  it('an expired file is missing', async () => {
    const response = await page('/expired1.png');
    assert.equal(response.status, 404);
    assert.equal(parseShell(response.text).state, 'missing');
  });

  it('API down: unavailable, 503, no payload, not cached', async () => {
    upstream.failLookups.add('down1');
    const response = await page('/down1.png');
    upstream.failLookups.delete('down1');
    assert.equal(response.status, 503);
    assertShellHeaders(response, 'private, no-store');
    const shell = parseShell(response.text);
    assert.deepEqual([shell.page, shell.state, shell.dataId], ['file', 'unavailable', undefined]);
    assert.equal((await page('/down1.png')).status, 404);
  });

  it('a password file: locked, nothing but the vanity, generic meta and no media', async () => {
    const response = await page('/pw1.png');
    assert.equal(response.status, 200);
    const shell = parseShell(response.text);
    assert.deepEqual([shell.page, shell.state], ['file', 'locked']);
    assert.deepEqual(shell.data, { vanity: 'pw1', protected: 'password' });
    assert.match(shell.meta, /<meta property="og:title" content="Password-protected file · files.gg">/);
    assert.doesNotMatch(response.text, /secret\.png|cdn\.files\.gg\/files|og:image|og:video/);
  });

  it('a password file with "show name when locked"', async () => {
    const shell = parseShell((await page('/pwname')).text);
    assert.deepEqual(shell.data, { vanity: 'pwname', protected: 'password', filename: 'named.png' });
    assert.doesNotMatch(shell.meta, /named\.png/);
  });

  it('a password file whose password expired', async () => {
    assert.deepEqual(parseShell((await page('/pwexp')).text).data, { vanity: 'pwexp', protected: 'password', password_expired: true });
  });

  it('a private file: missing, 404, nothing leaked', async () => {
    const response = await page('/priv1.png');
    assert.equal(response.status, 404);
    const shell = parseShell(response.text);
    assert.deepEqual([shell.state, shell.rawData], ['missing', 'null']);
    assert.doesNotMatch(response.text, /mine\.png/);
  });

  it('escapes a hostile filename so it cannot close the script tag', async () => {
    const response = await page('/hostile.png');
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.text, /<\/script><script>alert/);
    const shell = parseShell(response.text);
    assert.ok(shell.rawData.includes('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e.png'));
    assert.equal(shell.data.filename, '</script><script>alert(1)</script>.png');
    assert.match(shell.meta, /content="&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;.png"/);
  });

  it('HEAD: same status and headers, no body', async () => {
    const response = await page('/img1.png', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.text, '');
    assertShellHeaders(response);
  });

  it('caches lookups for 30 s, negative ones too', async () => {
    await page('/cached1');
    await page('/cached1.png');
    assert.equal(lookups('files', 'cached1'), 1);
    await page('/not-here-either');
    await page('/not-here-either');
    assert.equal(lookups('files', 'not-here-either'), 1);
  });
});


describe('albums', () => {
  it('/a/<vanity> and /a/<vanity>/<n>: album state with only visible items', async () => {
    for (const path of ['/a/alb1', '/a/alb1/2']) {
      const response = await page(path);
      assert.equal(response.status, 200, path);
      assertShellHeaders(response);
      const shell = parseShell(response.text);
      assert.deepEqual([shell.page, shell.state, shell.dataId], ['album', 'album', 'album-data']);
      assert.deepEqual(shell.data.items.map((item) => item.vanity), ['img1', 'vid1']);
      assert.match(shell.meta, /<meta property="og:title" content="Trip · 2 files">/);
    }
  });

  it('a password album is locked', async () => {
    const response = await page('/a/albpw');
    assert.equal(response.status, 200);
    const shell = parseShell(response.text);
    assert.deepEqual([shell.page, shell.state], ['album', 'locked']);
    assert.deepEqual(shell.data, { vanity: 'albpw', protected: 'password' });
    assert.match(shell.meta, /Password-protected album/);
  });

  it('missing, or with no visible items: 404, no payload', async () => {
    for (const path of ['/a/nope', '/a/albempty']) {
      const response = await page(path);
      assert.equal(response.status, 404, path);
      const shell = parseShell(response.text);
      assert.deepEqual([shell.page, shell.state, shell.dataId], ['album', 'missing', undefined], path);
    }
  });

  it('API down: unavailable, 503', async () => {
    upstream.failLookups.add('albdown');
    const response = await page('/a/albdown');
    upstream.failLookups.delete('albdown');
    assert.equal(response.status, 503);
    assert.deepEqual([parseShell(response.text).page, parseShell(response.text).state], ['album', 'unavailable']);
  });

  it('looks the album up by vanity', () => {
    assert.ok(lookups('albums', 'alb1') >= 1);
    assert.ok(ALBUMS.alb1);
  });
});


describe('bots and embeds (PLAN.md §1.4 item 3, contract §4)', () => {
  const bots = {
    sharex: { 'user-agent': 'ShareX/15.0' },
    telegram: { 'user-agent': 'TelegramBot (like TwitterBot)' },
    'no accept-language': { 'user-agent': 'Mozilla/5.0', accept: 'text/html' },
    'accept image/*': { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', accept: 'image/*' },
  };

  it('redirect link files to the CDN', async () => {
    for (const [name, headers] of Object.entries(bots)) {
      const response = await page('/img1.png', { headers });
      assert.equal(response.status, 302, name);
      assert.equal(response.headers.location, 'https://cdn.files.gg/files/img1.png', name);
    }
  });

  it('never redirect password or private files', async () => {
    for (const [name, headers] of Object.entries(bots)) {
      const locked = await page('/pw1.png', { headers });
      assert.equal(locked.status, 200, name);
      assert.equal(parseShell(locked.text).state, 'locked', name);
      const hidden = await page('/priv1.png', { headers });
      assert.equal(hidden.status, 404, name);
      assert.equal(hidden.headers.location, undefined, name);
    }
  });

  it('other bots get the embed page', async () => {
    const response = await page('/vid1.mp4', { headers: { 'user-agent': 'Twitterbot/1.0' } });
    assert.equal(response.status, 200);
    assert.match(parseShell(response.text).meta, /<meta property="og:video" content="https:\/\/cdn.files.gg\/files\/vid1.mp4">/);
  });

  // The old worker's page fixtures: every redirect still happens with the same Location, and every
  // page that rendered before still renders (now as the viewer shell).
  for (const request of cases.requests) {
    const expected = mithril[request.name];
    const isFile = request.path !== '/' && !/^\/(auth|dashboard|details|legal|options)(\/|$)/.test(request.path);
    if (!isFile) {
      continue;
    }
    const missing = request.path.startsWith('/nope');
    it(`${request.name}: ${expected.status === 302 ? 'redirect' : (missing ? 'missing' : 'page')}`, async () => {
      const response = await page(request.path, { method: request.method || 'GET', headers: headersFor(request) });
      if (expected.status === 302) {
        assert.equal(response.status, 302);
        assert.equal(response.headers.location, expected.location);
      } else if (missing) {
        // Deliberate: the old worker answered 200 with "404, file not found" in the meta tags.
        assert.equal(response.status, 404);
      } else {
        assert.equal(response.status, 200);
        assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
      }
    });
  }
});


describe('legacy pages (the old frontend) match the old Mithril worker', () => {
  for (const request of cases.requests) {
    if (!/^\/(auth|dashboard|details|legal|options)(\/|$)/.test(request.path)) {
      continue;
    }
    it(`${request.name}: ${request.path}`, async () => {
      const response = await page(request.path, { headers: headersFor(request) });
      const expected = mithril[request.name];
      assert.equal(response.status, expected.status);
      assert.equal(response.headers['content-type'], expected.contentType);
      let body = withOgProperty(expected.body);
      if (request.path === '/auth' || request.path === '/legal') {
        body = body.replace('content="404, file not found"', 'content="??"');
      }
      assert.equal(response.text, body);
      assert.equal(lookups('files', request.path.slice(1).split('/')[0]), 0);
    });
  }

  it('without the old manifest, the old "script unavailable" body', async () => {
    upstream.noManifest = true;
    const response = await page('/auth/login');
    upstream.noManifest = false;
    assert.match(response.text, /<span>script unavailable srry bro<\/span>/);
  });
});
