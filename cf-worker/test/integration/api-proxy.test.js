// The API passthrough and proxy.files.gg, on the real Worker (workerd) against local mocks.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SECRETS, startS3, startUpstream, startWorker } from '../support/worker.js';


let upstream;
let s3;
let worker;
const lastUpstream = () => upstream.requests.at(-1);

before(async () => {
  upstream = await startUpstream();
  s3 = await startS3();
  worker = await startWorker({ upstream, s3 }, {
    vars: { CORS_ALLOWED_ORIGINS: 'https://files.gg, https://beta.files.gg' },
  });
});

after(async () => {
  await worker?.close();
  await s3?.close();
  await upstream?.close();
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
    assert.equal(sent.headers['x-filesgg-origin-secret'], SECRETS.ORIGIN_SHARED_SECRET);
    assert.equal(sent.headers['x-filesgg-client-ip'], '203.0.113.9');
    assert.equal(sent.headers.authorization, 'token-1');
  });

  it('sends the secret on the internal lookups, and nothing the client sent', async () => {
    await worker.request('https://cdn.files.gg/files/img1.png', { headers: spoofed });
    const lookup = upstream.requests.findLast((r) => r.path === '/internal/files/img1');
    assert.equal(lookup.headers['x-filesgg-origin-secret'], SECRETS.ORIGIN_SHARED_SECRET);
    // Lookups are cached per vanity, so they carry no per-client headers.
    assert.equal(lookup.headers['x-filesgg-client-ip'], undefined);
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
    assert.equal(response.headers['access-control-allow-headers'], 'Authorization, Content-Type, X-Fingerprint, X-Filesgg-Access');
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
    assert.equal(lastUpstream().headers['x-filesgg-origin-secret'], SECRETS.ORIGIN_SHARED_SECRET);
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
    const proxied = await startWorker({ upstream, s3 }, { secrets: { ...SECRETS, PROXY_SECRET: 'proxy-secret' } });
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
