// End-to-end tests of the real Worker: wrangler.toml, bundled by wrangler, running in workerd.
// The API and storage are a local mock (test/support/worker.js).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cases, headersFor, mithril, withOgProperty } from '../support/fixtures.js';
import { startUpstream, startWorker } from '../support/worker.js';


const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://files.gg";

function assertCdnHeaders(headers) {
  assert.equal(headers['content-security-policy'], SANDBOX);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(headers['access-control-allow-origin'], '*');
  assert.equal(headers['access-control-allow-credentials'], undefined);
  assert.equal(headers['access-control-expose-headers'], 'Accept-Ranges, Content-Disposition, Content-Length, Content-Range');
}


let upstream;
let worker;
const lastUpstream = () => upstream.requests.at(-1);

before(async () => {
  upstream = await startUpstream();
  worker = await startWorker(upstream, {
    secrets: { ORIGIN_SHARED_SECRET: 'origin-secret' },
    vars: { CORS_ALLOWED_ORIGINS: 'https://files.gg, https://beta.files.gg' },
  });
});

after(async () => {
  await worker?.close();
  await upstream?.close();
});


describe('files.gg pages match the old Mithril worker', () => {
  for (const request of cases.requests) {
    const expected = mithril[request.name];
    it(`${request.name}: ${request.method || 'GET'} ${request.path} -> ${expected.status}`, async () => {
      upstream.noManifest = !!request.noManifest;
      const response = await worker.request('https://files.gg' + request.path, {
        method: request.method || 'GET',
        headers: headersFor(request),
      });
      upstream.noManifest = false;

      assert.equal(response.status, expected.status);
      assert.equal(response.headers.location ?? null, expected.location);
      assert.equal(response.headers['content-type'], expected.contentType);
      if (expected.body !== null && request.method !== 'HEAD') {
        assert.equal(response.text, withOgProperty(expected.body));
      }
    });
  }

  it('a bot gets the embed page, ShareX gets the bytes', async () => {
    const bot = await worker.request('https://files.gg/vid1.mp4', { headers: { 'user-agent': 'Twitterbot/1.0' } });
    assert.equal(bot.status, 200);
    assert.match(bot.text, /<meta property="og:video" content="https:\/\/cdn.files.gg\/files\/vid1.mp4">/);

    const sharex = await worker.request('https://files.gg/vid1.mp4', { headers: { 'user-agent': 'ShareX/15.0' } });
    assert.equal(sharex.status, 302);
    assert.equal(sharex.headers.location, 'https://cdn.files.gg/files/vid1.mp4');
  });

  it('serves assets and the favicon from storage', async () => {
    const css = await worker.request('https://files.gg/assets/main.css');
    assert.equal(css.status, 200);
    assert.equal(css.text, 'body{}');
    assert.equal(lastUpstream().path, '/assets/stable/main.css');

    const favicon = await worker.request('https://files.gg/favicon.ico');
    assert.equal(favicon.status, 200);
    assert.equal(lastUpstream().path, '/assets/stable/favicon.ico');
    assert.equal(favicon.headers['x-goog-generation'], undefined);
  });
});


describe('cdn.files.gg', () => {
  const cdn = (path, options) => worker.request('https://cdn.files.gg' + path, options);

  it('serves a PNG inline with the sandbox headers', async () => {
    const response = await cdn('/files/img1.png');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['content-disposition'],
      `inline; filename="cat <photo> & \\"friends\\".png"; filename*=UTF-8''cat%20%3Cphoto%3E%20%26%20%22friends%22.png`);
    assert.equal(response.text, 'bytes of cat <photo> & "friends".png');
    assert.equal(response.headers['x-goog-generation'], undefined);
    assertCdnHeaders(response.headers);
  });

  it('forces HTML and SVG to text/plain', async () => {
    for (const path of ['/files/html1.html', '/files/svg1.svg', '/files/svg1']) {
      const response = await cdn(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers['content-type'], 'text/plain', path);
      assert.match(response.headers['content-disposition'], /^inline;/, path);
      assertCdnHeaders(response.headers);
    }
  });

  it('forces markup from the raw storage route to text/plain too', async () => {
    const response = await cdn('/assets/stable/evil.html');
    assert.equal(response.headers['content-type'], 'text/plain');
    assertCdnHeaders(response.headers);
  });

  it('downloads PDFs as attachments', async () => {
    const response = await cdn('/files/pdf1.pdf');
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['content-disposition'], `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    assertCdnHeaders(response.headers);
  });

  it('keeps ?download and ?force-text', async () => {
    const download = await cdn('/files/vid1.mp4?download=true');
    assert.match(download.headers['content-disposition'], /^attachment;/);
    const text = await cdn('/files/pdf1.pdf?force-text=true');
    assert.equal(text.headers['content-type'], 'text/plain');
    assert.match(text.headers['content-disposition'], /^inline;/);
  });

  it('resolves multi-segment vanities with and without an extension', async () => {
    for (const path of ['/files/abcd/xyz.jpg', '/files/abcd/xyz', '/files/abcd/xyz.anything.else']) {
      const response = await cdn(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers['content-type'], 'image/jpeg', path);
    }
    assert.ok(upstream.requests.some((r) => r.path === '/files/abcd/xyz'));
  });

  it('turns a storage 403 into a 404, still sandboxed', async () => {
    const response = await cdn('/nothing/here');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
  });

  it('passes an unknown file 404 through, sandboxed', async () => {
    const response = await cdn('/files/nope.png');
    assert.equal(response.status, 404);
    assertCdnHeaders(response.headers);
  });

  it('sandboxes the router 405 too', async () => {
    const response = await cdn('/files/img1.png', { method: 'POST', body: 'x' });
    assert.equal(response.status, 405);
    assertCdnHeaders(response.headers);
  });

  it('serves the favicon with the CDN headers', async () => {
    const response = await cdn('/favicon.ico');
    assert.equal(response.status, 200);
    assert.equal(lastUpstream().path, '/assets/stable/favicon.ico');
    assertCdnHeaders(response.headers);
  });
});


describe('API passthrough', () => {
  const spoofed = {
    'cf-connecting-ip': '203.0.113.9',
    'x-filesgg-client-ip': '6.6.6.6',
    'x-filesgg-origin-secret': 'guessed',
  };

  it('vouches for the client IP with the origin secret and strips client copies', async () => {
    const response = await worker.request('https://api.files.gg/users/@me?expand=1', {
      headers: { ...spoofed, authorization: 'token-1' },
    });
    assert.equal(response.status, 200);
    const sent = lastUpstream();
    assert.equal(sent.path, '/users/@me');
    assert.equal(sent.search, '?expand=1');
    assert.equal(sent.headers['x-filesgg-origin-secret'], 'origin-secret');
    assert.equal(sent.headers['x-filesgg-client-ip'], '203.0.113.9');
    assert.equal(sent.headers.authorization, 'token-1');
  });

  it('sends the secret on the worker\'s own API lookups too', async () => {
    await worker.request('https://cdn.files.gg/files/img1.png', { headers: spoofed });
    const lookup = upstream.requests.findLast((r) => r.path === '/files/img1');
    assert.equal(lookup.headers['x-filesgg-origin-secret'], 'origin-secret');
    assert.equal(lookup.headers['x-filesgg-client-ip'], '203.0.113.9');
  });

  it('passes the request body and method through', async () => {
    await worker.request('https://api.files.gg/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a@b.c"}',
    });
    assert.equal(lastUpstream().method, 'POST');
    assert.equal(lastUpstream().body, '{"email":"a@b.c"}');
  });

  it('gives files.gg credentialed CORS', async () => {
    const response = await worker.request('https://api.files.gg/users/@me', { headers: { origin: 'https://files.gg' } });
    assert.equal(response.headers['access-control-allow-origin'], 'https://files.gg');
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.match(response.headers.vary, /Origin/);
  });

  it('gives a foreign origin `*` and drops the API\'s allow-credentials', async () => {
    const response = await worker.request('https://api.files.gg/users/@me', { headers: { origin: 'https://evil.example' } });
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  });

  it('answers a preflight', async () => {
    const response = await worker.request('https://api.files.gg/users/@me', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://files.gg',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], 'https://files.gg');
    assert.equal(response.headers['access-control-allow-headers'], 'Authorization, Content-Type, X-Fingerprint');
    assert.match(response.headers['access-control-allow-methods'], /PATCH/);
  });

  // (Miniflare rewrites a same-host Origin, so this uses the second allowlisted origin from the
  // CORS_ALLOWED_ORIGINS var; it also checks that the var is read.)
  it('treats files.gg/api/* the same way', async () => {
    const response = await worker.request('https://files.gg/api/users/@me', {
      headers: { ...spoofed, origin: 'https://beta.files.gg' },
    });
    assert.equal(response.status, 200);
    assert.equal(lastUpstream().path, '/users/@me');
    assert.equal(lastUpstream().headers['x-filesgg-origin-secret'], 'origin-secret');
    assert.equal(response.headers['access-control-allow-origin'], 'https://beta.files.gg');
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
  });
});


describe('proxy.files.gg', () => {
  const target = () => encodeURIComponent(`${upstream.origin}/remote/img.png`);

  it('is 403 without a PROXY_SECRET binding, whatever the token', async () => {
    for (const token of [undefined, 'lol', '']) {
      const headers = (token === undefined) ? {} : { 'x-proxy-token': token };
      const response = await worker.request(`https://proxy.files.gg/download/${target()}`, { headers });
      assert.equal(response.status, 403);
    }
    assert.ok(!upstream.requests.some((r) => r.path.startsWith('/remote/')));
  });

  it('with the secret, accepts only the right token and never forwards it', async () => {
    const proxied = await startWorker(upstream, { secrets: { PROXY_SECRET: 'proxy-secret' } });
    try {
      const wrong = await proxied.request(`https://proxy.files.gg/download/${target()}`, { headers: { 'x-proxy-token': 'lol' } });
      assert.equal(wrong.status, 403);

      const right = await proxied.request(`https://proxy.files.gg/download/${target()}`, { headers: { 'x-proxy-token': 'proxy-secret' } });
      assert.equal(right.status, 200);
      assert.equal(right.text, 'PNG');
      assert.equal(lastUpstream().path, '/remote/img.png');
      assert.equal(lastUpstream().headers['x-proxy-token'], undefined);

      const unfurl = await proxied.request(`https://proxy.files.gg/unfurl/${encodeURIComponent(`${upstream.origin}/remote/page.html`)}`, {
        headers: { 'x-proxy-token': 'proxy-secret' },
      });
      assert.equal(unfurl.status, 200);
      assert.equal(JSON.parse(unfurl.text).imageUrl, `${upstream.origin}/img.png`);
    } finally {
      await proxied.close();
    }
  });
});
