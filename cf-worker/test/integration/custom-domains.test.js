// Custom domains on the real Worker (workerd), against the mock API and B2 (milestone-6.md §10.7-
// §10.11): unknown and non-serving hostnames, the landing card, the serving matrix of §16.10
// (domain-only, scope, private, pending deletion), rehosting with valid signatures (§16.5), staff
// URLs refused off the CDN, the security headers and HSTS, and Cloudflare's validation paths.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALBUMS,
  DOMAINS,
  FILES,
  PREVIEWS_VERSION,
  previewPath,
  signedForAlbum,
  signedForFile,
  signedForStaff,
  signedThroughAlbum,
  startS3,
  startUpstream,
  startWorker,
} from '../support/worker.js';


const browser = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://files.gg";
const CUSTOM_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://api.files.gg https://cdn.files.gg; img-src 'self' https://cdn.files.gg blob: data:; media-src 'self' https://cdn.files.gg blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src https://files.gg; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const NOT_CONNECTED = /<p>This domain isn't connected to files\.gg right now\.<\/p>/;

let upstream;
let s3;
let worker;
const at = (host, path, options = {}) => worker.request(`https://${host}${path}`, { headers: browser, ...options });
const lookups = (kind, key) => upstream.requests.filter((r) => r.path === `/internal/${kind}/${key}`).length;

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


function shellOf(html) {
  const root = /<div id="root"([^>]*)><\/div>/.exec(html);
  assert.ok(root, 'has #root');
  const attributes = Object.fromEntries([...root[1].matchAll(/ (data-[a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const script = (id) => {
    const match = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
    return match ? JSON.parse(match[1]) : undefined;
  };
  return {
    page: attributes['data-page'], state: attributes['data-state'], host: attributes['data-host'],
    file: script('file-data'), album: script('album-data'), report: script('report-data'), hostData: script('host-data'),
  };
}

function assertCustomPage(response, host = 'i.example.com') {
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['content-security-policy'], CUSTOM_CSP);
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(response.headers['set-cookie'], undefined);
  const shell = shellOf(response.text);
  assert.equal(shell.host, 'custom');
  assert.deepEqual(shell.hostData, { host, main_origin: 'https://files.gg', api_origin: 'https://api.files.gg' });
  return shell;
}

function assertCustomBytesHeaders(headers) {
  assert.equal(headers['content-security-policy'], SANDBOX);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(headers['access-control-allow-origin'], '*');
  assert.equal(headers['access-control-allow-credentials'], undefined);
  assert.equal(headers['access-control-expose-headers'], 'Accept-Ranges, Content-Disposition, Content-Length, Content-Range');
  assert.equal(headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(headers['set-cookie'], undefined);
}

// On a byte path the page gets the byte paths' sandbox instead of its own (stricter) CSP.
function assertNotConnected(response, label) {
  assert.equal(response.status, 404, label);
  assert.equal(response.headers['cache-control'], 'no-cache', label);
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000', label);
  assert.equal(response.headers['set-cookie'], undefined, label);
  const csp = response.headers['content-security-policy'];
  assert.ok(csp === "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" || csp === SANDBOX, `${label}: ${csp}`);
  assert.match(response.text, NOT_CONNECTED, label);
}


describe('hostnames that are not a serving domain (§10.8 step 2)', () => {
  it('unknown hostnames get the clean "isn\'t connected" 404, whatever the path or method', async () => {
    for (const path of ['/', '/img1', '/img1.png', '/files/img1.png', '/a/alb1', '/assets/viewer-Pi5NcSEC.js', '/app', '/api/users/@me']) {
      assertNotConnected(await at('unknown.example.com', path), path);
    }
    assertNotConnected(await at('unknown.example.com', '/img1', { method: 'POST' }), 'POST');
    const head = await at('unknown.example.com', '/', { method: 'HEAD' });
    assert.equal(head.status, 404);
    assert.equal(head.text, '');
    // A lookalike of our own hosts is just another unknown hostname.
    assertNotConnected(await at('cdn.files.gg.evil.example', '/files/img1.png'), 'lookalike');
  });

  it('never serves pending, paused, disabled or failed domains, or an owner pending deletion', async () => {
    for (const host of ['pending.example.com', 'paused.example.com', 'disabled.example.com', 'gone.example.com', 'nostr.example.com', 'mismatch.example.com']) {
      for (const path of ['/', '/ulink', '/files/ulink.png', '/pdlink', '/files/pdlink.png']) {
        assertNotConnected(await at(host, path), `${host}${path}`);
      }
    }
  });

  it('never looks up a name under MAIN_HOST', async () => {
    const before = upstream.requests.length;
    assertNotConnected(await at('x.files.gg', '/img1'), 'x.files.gg');
    assertNotConnected(await at('domains.files.gg', '/'), 'domains.files.gg');
    assert.equal(upstream.requests.length, before);
  });

  it('caches the domain lookup (5 s), negative entries too', async () => {
    await at('cache.example.com', '/');
    await at('cache.example.com', '/x');
    assert.equal(lookups('domains', 'cache.example.com'), 1);
    await at('any.example.com', '/');
    await at('any.example.com', '/');
    assert.equal(lookups('domains', 'any.example.com'), 1);
  });

  it('says "unavailable" (503) while the API is down', async () => {
    upstream.failLookups.add('down.example.com');
    try {
      const response = await at('down.example.com', '/ulink');
      assert.equal(response.status, 503);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.doesNotMatch(response.text, NOT_CONNECTED);
    } finally {
      upstream.failLookups.delete('down.example.com');
    }
  });
});


describe('pages on a custom domain (§10.8, §13.4)', () => {
  it('/ is the landing card, with the default meta tags rehosted', async () => {
    const response = await at('i.example.com', '/');
    assert.equal(response.status, 200);
    const shell = assertCustomPage(response);
    assert.equal(shell.page, 'domain-home');
    assert.equal(shell.state, undefined);
    assert.match(response.text, /<meta property="og:image" content="https:\/\/i\.example\.com\/og-image\.png"/);
    assert.doesNotMatch(response.text, /https:\/\/files\.gg\/og-image/);
  });

  it('report pages at milestone-6.md §20.2 paths, with their data and the host data', async () => {
    const cases = {
      '/report': { type: 'any' },
      '/report/ulink': { type: 'file', vanity: 'ulink' },
      '/report/ulink.png': { type: 'file', vanity: 'ulink' },
      '/report/abcd/xyz': { type: 'file', vanity: 'abcd/xyz' },
      '/report/a/adolink': { type: 'album', vanity: 'adolink' },
    };
    for (const [path, data] of Object.entries(cases)) {
      const before = upstream.requests.length;
      const response = await at('i.example.com', path);
      assert.equal(response.status, 200, path);
      const shell = assertCustomPage(response);
      assert.equal(shell.page, 'report', path);
      assert.deepEqual(shell.report, data, path);
      assert.ok(upstream.requests.slice(before).every((r) => !r.path.startsWith('/internal/files') && !r.path.startsWith('/internal/albums')), path);
    }
  });

  it('the old report and album item paths are gone (404, no lookup)', async () => {
    for (const path of ['/ulink/report', '/a/adolink/report', '/a/adolink/2']) {
      const before = upstream.requests.filter((r) => r.path.startsWith('/internal/files') || r.path.startsWith('/internal/albums')).length;
      const response = await at('i.example.com', path);
      assert.equal(response.status, 404, path);
      assert.equal(upstream.requests.filter((r) => r.path.startsWith('/internal/files') || r.path.startsWith('/internal/albums')).length, before, path);
    }
    // `<vanity>.<anything>` keeps its meaning: the file's page, never the report page
    const file = await at('i.example.com', '/ulink.png/report');
    assert.equal(file.status, 200);
    assert.deepEqual([shellOf(file.text).page, shellOf(file.text).state], ['file', 'file']);
  });

  it('an album item is `?item=<n>`: the same album shell for any item', async () => {
    const plain = shellOf((await at('i.example.com', '/a/adolink')).text);
    for (const search of ['?item=2', '?item=1', '?item=999', '?item=x']) {
      const response = await at('i.example.com', `/a/adolink${search}`);
      assert.equal(response.status, 200, search);
      const shell = shellOf(response.text);
      assert.deepEqual([shell.page, shell.state, shell.album], [plain.page, plain.state, plain.album], search);
    }
  });

  it('web/dist assets and root files, as on files.gg', async () => {
    const asset = await at('i.example.com', '/assets/viewer-Pi5NcSEC.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(asset.headers['content-type'], 'text/javascript');
    assert.equal(asset.headers['strict-transport-security'], 'max-age=31536000');
    const icon = await at('i.example.com', '/favicon.ico');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['cache-control'], 'public, max-age=86400');
    assert.equal((await at('i.example.com', '/assets/nope.js')).status, 404);
  });

  it('nothing else: no dashboard, API, converter, changelog, legal and help pages, challenge, auth pages or security.txt', async () => {
    for (const path of [
      '/app', '/app/login', '/api', '/api/users/@me', '/api/auth/session', '/convert', '/.well-known/security.txt', '/challenge', '/login', '/register', '/signup',
      '/changelog', '/legal', '/legal/terms', '/legal/privacy', '/help/link-warnings',
    ]) {
      const before = upstream.requests.length;
      const response = await at('i.example.com', path, { headers: { ...browser, cookie: '__Host-filesgg_session=fgs_x' } });
      assert.equal(response.status, 404, path);
      assert.equal(response.headers['strict-transport-security'], 'max-age=31536000', path);
      assert.ok(response.headers['content-security-policy'], path);
      // Nothing reaches the API but the domain lookup.
      assert.ok(upstream.requests.slice(before).every((r) => r.path.startsWith('/internal/domains/')), path);
    }
  });

  it('only GET and HEAD for pages; GET, HEAD and OPTIONS for bytes', async () => {
    assert.equal((await at('i.example.com', '/ulink', { method: 'POST' })).status, 405);
    assert.equal((await at('i.example.com', '/', { method: 'DELETE' })).status, 405);
    const post = await at('i.example.com', '/files/ulink.png', { method: 'POST' });
    assert.equal(post.status, 405);
    assertCustomBytesHeaders(post.headers);
    const options = await at('i.example.com', '/files/ulink.png', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(options.status, 204);
    assertCustomBytesHeaders(options.headers);
    const head = await at('i.example.com', '/ulink', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  });

  it('bots and embeds of link files go to the bytes on the same domain', async () => {
    const response = await at('i.example.com', '/ulink', { headers: { 'user-agent': 'ShareX/17.0' } });
    assert.equal(response.status, 302);
    // (Miniflare rewrites a Location on the request's own host to the request's scheme, http here;
    // the Worker writes https://i.example.com/files/ulink.png.)
    assert.match(response.headers.location, /^https?:\/\/i\.example\.com\/files\/ulink\.png$/);
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
  });

  it('a failing domain still serves; an unknown scope means `own`', async () => {
    assert.equal(shellOf((await at('failing.example.com', '/ulink')).text).state, 'file');
    assert.equal((await at('weird.example.com', '/ulink')).status, 200);
    const other = await at('weird.example.com', '/vlink');
    assert.equal(other.status, 404);
    assert.equal(shellOf(other.text).state, 'missing');
    assert.equal((await at('weird.example.com', '/files/vlink.png')).status, 404);
  });
});


describe('rehosting (§10.9, §16.5)', () => {
  it('rehosts every URL in the boot data and the meta tags', async () => {
    const response = await at('i.example.com', '/dolink');
    assert.equal(response.status, 200);
    const shell = assertCustomPage(response);
    assert.equal(shell.state, 'file');
    assert.equal(shell.file.url, 'https://i.example.com/dolink.png');
    assert.equal(shell.file.cdn_url, 'https://i.example.com/files/dolink.png');
    assert.equal(shell.file.assets.thumb.url, `https://i.example.com/previews/thumb/dolink.webp?v=${PREVIEWS_VERSION}`);
    assert.equal(shell.file.thumbnail.url, shell.file.assets.thumb.url);
    assert.match(response.text, /<meta property="og:url" content="https:\/\/i\.example\.com\/dolink\.png">/);
    assert.match(response.text, /<meta property="og:image" content="https:\/\/i\.example\.com\/files\/dolink\.png">/);
    // The only files.gg URLs left are the host data's origins.
    assert.doesNotMatch(response.text, /cdn\.files\.gg/);
    assert.equal(response.text.match(/https:\/\/files\.gg/g).length, 1);
    // files.gg itself is untouched.
    const main = shellOf((await at('files.gg', '/ulink')).text);
    assert.equal(main.file.cdn_url, 'https://cdn.files.gg/files/ulink.png');
    assert.equal(main.host, undefined);
    assert.equal(main.hostData, undefined);
  });

  it('rehosts album pages', async () => {
    const response = await at('i.example.com', '/a/adolink');
    assert.equal(response.status, 200);
    const shell = assertCustomPage(response);
    assert.equal(shell.state, 'album');
    assert.equal(shell.album.url, 'https://i.example.com/a/adolink');
    assert.equal(shell.album.download_url, 'https://i.example.com/albums/download/adolink.zip');
    assert.match(shell.album.collage.url, /^https:\/\/i\.example\.com\/albums\/collage\/adolink\.webp\?v=\d+$/);
    assert.equal(shell.album.items[0].cdn_url, 'https://i.example.com/files/dolink.png');
    assert.doesNotMatch(response.text, /cdn\.files\.gg/);
  });

  it('a signed URL is valid on both hosts, because it signs the path only', async () => {
    for (const [vanity, path] of [['dopw', '/files/dopw.png'], ['dopw', previewPath('dopw', 'thumb')], ['priv1', '/files/priv1.png'], ['mpw', previewPath('mpw', 'poster')]]) {
      const signed = signedForFile(vanity, path);
      assert.equal((await at('cdn.files.gg', signed)).status, 200, `cdn ${signed}`);
      if (vanity !== 'mpw') {
        const custom = await at('i.example.com', signed);
        assert.equal(custom.status, 200, `custom ${signed}`);
        assert.equal(custom.headers['cache-control'], 'private, no-store');
        assertCustomBytesHeaders(custom.headers);
      }
    }
    // A signature for one path never opens another.
    const signed = signedForFile('dopw', '/files/dopw.png');
    assert.equal((await at('i.example.com', signed.replace('/files/dopw.png', '/files/upw.png'))).status, 401);
  });

  it('album grants work through rehosted URLs too', async () => {
    assert.equal((await at('i.example.com', signedForAlbum('adopw', '/albums/collage/adopw.webp'))).status, 200);
    assert.equal((await at('i.example.com', '/albums/collage/adopw.webp')).status, 401);
    assert.equal((await at('i.example.com', signedThroughAlbum('albpw', '/files/pwalb.png'))).status, 200);
  });
});


describe('the serving matrix (§16.10): U owns i.example.com (own scope)', () => {
  // [files.gg/<v> shell state and status, cdn.files.gg/files/<v>.png unsigned, signed,
  //  i.example.com/<v> state and status, i.example.com/files/<v>.png unsigned, signed]
  const ROWS = {
    "U's link, domain-only off": ['ulink', ['file', 200], 200, 200, ['file', 200], 200, 200],
    "U's link, domain-only on": ['dolink', ['missing', 404], 404, 200, ['file', 200], 200, 200],
    "U's link, domain-only paused": ['dopaused', ['file', 200], 200, 200, ['file', 200], 200, 200],
    "U's link, an unknown served_on": ['dounknown', ['file', 200], 200, 200, ['file', 200], 200, 200],
    "U's password, domain-only on": ['dopw', ['missing', 404], 401, 200, ['locked', 200], 401, 200],
    "U's password, domain-only off": ['upw', ['locked', 200], 401, 200, ['locked', 200], 401, 200],
    "U's private": ['priv1', ['missing', 404], 404, 200, ['missing', 404], 404, 200],
    "U's private, domain-only on": ['dopriv', ['missing', 404], 404, 200, ['missing', 404], 404, 200],
    "V's link": ['vlink', ['file', 200], 200, 200, ['missing', 404], 404, 404],
    "V's password": ['vpw', ['locked', 200], 401, 200, ['missing', 404], 404, 404],
    'anonymous link': ['anonlink', ['file', 200], 200, 200, ['missing', 404], 404, 404],
  };

  for (const [label, [vanity, main, cdnUnsigned, cdnSigned, custom, customUnsigned, customSigned]] of Object.entries(ROWS)) {
    it(label, async () => {
      const page = await at('files.gg', `/${vanity}`);
      assert.deepEqual([shellOf(page.text).state, page.status], main, 'files.gg');
      const bytes = `/files/${vanity}.png`;
      assert.equal((await at('cdn.files.gg', bytes)).status, cdnUnsigned, 'cdn unsigned');
      assert.equal((await at('cdn.files.gg', signedForFile(vanity, bytes))).status, cdnSigned, 'cdn signed');
      const customPage = await at('i.example.com', `/${vanity}`);
      assert.deepEqual([shellOf(customPage.text).state, customPage.status], custom, 'custom page');
      const unsigned = await at('i.example.com', bytes);
      assert.equal(unsigned.status, customUnsigned, 'custom unsigned');
      assertCustomBytesHeaders(unsigned.headers);
      assert.equal((await at('i.example.com', signedForFile(vanity, bytes))).status, customSigned, 'custom signed');
    });
  }

  it("with scope `any`, V's and anonymous link files are served", async () => {
    for (const vanity of ['vlink', 'anonlink']) {
      const page = await at('any.example.com', `/${vanity}`);
      assert.equal(page.status, 200, vanity);
      assert.equal(assertCustomPage(page, 'any.example.com').state, 'file', vanity);
      assert.equal((await at('any.example.com', `/files/${vanity}.png`)).status, 200, vanity);
      assert.equal((await at('any.example.com', previewPath(vanity, 'thumb'))).status, 200, vanity);
    }
    const locked = await at('any.example.com', '/vpw');
    assert.equal(shellOf(locked.text).state, 'locked');
    assert.equal((await at('any.example.com', '/files/vpw.png')).status, 401);
    assert.equal((await at('any.example.com', signedForFile('vpw', '/files/vpw.png'))).status, 200);
  });

  it("V's own domain never shows U's files", async () => {
    assert.equal((await at('v.example.com', '/vlink')).status, 200);
    for (const path of ['/ulink', '/files/ulink.png', previewPath('dolink', 'thumb'), '/a/adolink', '/albums/collage/adolink.webp']) {
      assert.equal((await at('v.example.com', path)).status, 404, path);
    }
  });

  it('domain-only: previews on the CDN need a signature (file or album grant), never on the domain', async () => {
    const thumb = previewPath('dolink', 'thumb');
    assert.equal((await at('cdn.files.gg', thumb)).status, 404);
    assert.equal((await at('cdn.files.gg', thumb + `?v=${PREVIEWS_VERSION}`)).status, 404);
    const signed = await at('cdn.files.gg', signedForFile('dolink', thumb));
    assert.equal(signed.status, 200);
    assert.equal(signed.headers['cache-control'], 'private, no-store');
    assert.equal((await at('cdn.files.gg', signedThroughAlbum('adolink', '/files/dolink.png'))).status, 200);
    // A signature for another grant isn't one.
    assert.equal((await at('cdn.files.gg', signedForFile('dolink', '/files/dolink.png', { version: 9 }))).status, 404);
    assert.equal((await at('i.example.com', thumb)).status, 200);
    // The refusal is never cached.
    assert.equal((await at('cdn.files.gg', '/files/dolink.png')).headers['cache-control'], 'private, no-store');
  });

  it('domain-only: albums are missing on files.gg, and need the album grant on the CDN', async () => {
    const page = await at('files.gg', '/a/adolink');
    assert.deepEqual([shellOf(page.text).state, page.status], ['missing', 404]);
    for (const path of ['/albums/collage/adolink.webp', '/albums/download/adolink.zip']) {
      assert.equal((await at('cdn.files.gg', path)).status, 404, path);
      const signed = await at('cdn.files.gg', signedForAlbum('adolink', path));
      assert.equal(signed.status, 200, path);
      assert.equal(signed.headers['cache-control'], 'private, no-store', path);
      assert.equal((await at('i.example.com', path)).status, 200, path);
    }
    // A protected domain-only album: 401 unsigned on the CDN, like the file row.
    assert.equal((await at('cdn.files.gg', '/albums/collage/adopw.webp')).status, 401);
    assert.equal((await at('files.gg', '/a/adopw')).status, 404);
    assert.equal(shellOf((await at('i.example.com', '/a/adopw')).text).state, 'locked');
  });

  it("other owners' albums follow the scope", async () => {
    for (const vanity of ['avlink', 'aanon']) {
      assert.equal((await at('i.example.com', `/a/${vanity}`)).status, 404, vanity);
      assert.equal((await at('i.example.com', `/albums/collage/${vanity}.webp`)).status, 404, vanity);
      assert.equal((await at('i.example.com', `/albums/download/${vanity}.zip`)).status, 404, vanity);
      assert.equal((await at('any.example.com', `/a/${vanity}`)).status, 200, vanity);
      assert.equal((await at('any.example.com', `/albums/collage/${vanity}.webp`)).status, 200, vanity);
    }
  });

  it('bytes on a custom domain get every CDN rule: forced text, dispositions, safety states', async () => {
    const html = await at('i.example.com', '/files/html1.html');
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-type'], 'text/plain');
    assertCustomBytesHeaders(html.headers);
    const svg = await at('i.example.com', '/files/svg1.svg');
    assert.equal(svg.headers['content-type'], 'text/plain');
    assert.match((await at('i.example.com', '/files/pdf1.pdf')).headers['content-disposition'], /^attachment;/);
    assert.match((await at('i.example.com', '/files/ulink.png')).headers['content-disposition'], /^inline;/);
    assert.equal((await at('i.example.com', '/files/ulink.png')).headers['cache-control'], 'public, max-age=3600');
    assert.equal((await at('i.example.com', '/files/shid.png')).status, 410);
    assert.equal((await at('i.example.com', '/files/spend.png')).status, 404);
    assert.equal((await at('i.example.com', '/files/sblk.png')).status, 404);
    const range = await at('i.example.com', '/files/ranged.mp4', { headers: { range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.text, 'cdef');
    assert.equal(shellOf((await at('i.example.com', '/srem')).text).state, 'removed');
  });
});


describe('pending deletion (§8.8): missing everywhere, except a staff grant on the CDN', () => {
  it('files: missing on files.gg, 404 on the CDN even signed, missing on every domain', async () => {
    for (const vanity of ['pdlink', 'pdpw', 'pdweird']) {
      const page = await at('files.gg', `/${vanity}`);
      assert.deepEqual([shellOf(page.text).state, page.status], ['missing', 404], vanity);
      for (const path of [`/files/${vanity}.png`, previewPath(vanity, 'thumb')]) {
        for (const url of [path, signedForFile(vanity, path)]) {
          const cdn = await at('cdn.files.gg', url);
          assert.equal(cdn.status, 404, `cdn ${url}`);
          assert.equal(cdn.headers['cache-control'], 'private, no-store', `cdn ${url}`);
          assert.equal((await at('any.example.com', url)).status, 404, `any ${url}`);
        }
      }
      const custom = await at('any.example.com', `/${vanity}`);
      assert.deepEqual([shellOf(custom.text).state, custom.status], ['missing', 404], vanity);
    }
    // The owner's own domain isn't serving at all.
    assertNotConnected(await at('gone.example.com', '/pdlink'), 'gone page');
    assertNotConnected(await at('gone.example.com', '/files/pdlink.png'), 'gone bytes');
    // Defense in depth: a pending owner on a domain the lookup still calls serving.
    assert.equal((await at('i.example.com', '/pdu')).status, 404);
    assert.equal((await at('i.example.com', '/files/pdu.png')).status, 404);
    // owner_state: null is an active owner.
    assert.equal((await at('files.gg', '/pdnull')).status, 200);
  });

  it('staff still see it on the CDN, and only there', async () => {
    for (const path of ['/files/pdlink.png', previewPath('pdlink', 'thumb')]) {
      const staff = await at('cdn.files.gg', signedForStaff('pdlink', path));
      assert.equal(staff.status, 200, path);
      assert.equal(staff.headers['cache-control'], 'private, no-store', path);
      assert.equal((await at('any.example.com', signedForStaff('pdlink', path))).status, 404, path);
    }
  });

  it('albums: missing on files.gg and every domain, 404 on the CDN even signed', async () => {
    const page = await at('files.gg', '/a/apdlink');
    assert.deepEqual([shellOf(page.text).state, page.status], ['missing', 404]);
    for (const path of ['/albums/collage/apdlink.webp', '/albums/download/apdlink.zip']) {
      assert.equal((await at('cdn.files.gg', path)).status, 404, path);
      assert.equal((await at('cdn.files.gg', signedForAlbum('apdlink', path))).status, 404, path);
      assert.equal((await at('any.example.com', path)).status, 404, path);
    }
    assert.equal((await at('any.example.com', '/a/apdlink')).status, 404);
  });
});


describe('staff URLs only on cdn.files.gg (§10.9, §16.5)', () => {
  const CASES = [
    // [vanity, the CDN's answer, the custom domain's]
    ['sstaff', 200, 404], // private
    ['upw', 200, 401], // password
    ['ulink', 200, 404], // link: refused, not served as a plain link
    ['shid', 200, 404], // hidden: never 410 or the bytes
  ];

  for (const [vanity, cdn, custom] of CASES) {
    it(`${vanity}: ${cdn} on the CDN, ${custom} on i.example.com`, async () => {
      for (const path of [`/files/${vanity}.png`, ...(FILES[vanity].previews.thumb ? [previewPath(vanity, 'thumb')] : [])]) {
        const signed = signedForStaff(vanity, path);
        assert.equal((await at('cdn.files.gg', signed)).status, cdn, `cdn ${signed}`);
        const response = await at('i.example.com', signed);
        assert.equal(response.status, custom, `custom ${signed}`);
        assert.equal(response.headers['cache-control'], 'private, no-store', signed);
        assertCustomBytesHeaders(response.headers);
      }
    });
  }

  it('a staff= parameter on an otherwise valid signed URL is still refused off the CDN', async () => {
    const signed = new URL(signedForFile('upw', '/files/upw.png'), 'https://x');
    signed.searchParams.set('staff', '555555555555555555');
    assert.equal((await at('i.example.com', signed.pathname + signed.search)).status, 401);
    assert.equal((await at('i.example.com', '/files/ulink.png?staff=1')).status, 404);
    assert.equal((await at('i.example.com', '/albums/collage/adolink.webp?staff=1')).status, 404);
  });
});


describe("Cloudflare's validation paths (§10.8 step 1)", () => {
  it('go straight to the origin, without the cookie or a lookup, and set nothing', async () => {
    // The mock upstream stands in for the origin: the request's own host is where fetch() goes.
    const port = new URL(upstream.origin).port;
    const before = upstream.requests.length;
    const response = await worker.request(`http://127.0.0.1:${port}/.well-known/acme-challenge/tok123`, {
      headers: { cookie: '__Host-filesgg_session=fgs_x; a=1' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, 'dcv tok123');
    assert.equal(response.headers['set-cookie'], undefined);
    const sent = upstream.requests.slice(before);
    assert.deepEqual(sent.map((r) => r.path), ['/.well-known/acme-challenge/tok123']);
    assert.equal(sent[0].headers.cookie, undefined);
  });
});


describe('fixtures', () => {
  it('have the domains the tests use', () => {
    assert.equal(DOMAINS['i.example.com'].domain.user_id, FILES.ulink.owner_user_id);
    assert.equal(ALBUMS.adolink.served_on, 'custom');
  });
});
