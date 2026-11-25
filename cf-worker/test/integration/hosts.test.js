// The Worker on configurable hosts (MAIN_HOST, CDN_HOST, API_HOST, PROXY_HOST), as the local e2e
// stack runs it under wrangler dev: routing, the CSPs, CORS and the generated URLs follow the vars,
// and the production hostnames no longer route.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { signToken } from '../../worker/utils/token.js';
import { FILES, NOW_S, SECRETS, startS3, startUpstream, startWorker } from '../support/worker.js';


const HOSTS = {
  MAIN_HOST: 'files.localhost',
  CDN_HOST: 'cdn.files.localhost',
  API_HOST: 'api.files.localhost',
  PROXY_HOST: 'proxy.files.localhost',
};
const MAIN = 'http://files.localhost:8787';
const browser = { 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en' };

let upstream;
let s3;
let worker;

before(async () => {
  upstream = await startUpstream();
  s3 = await startS3();
  // CORS_ALLOWED_ORIGINS empty: the default is the MAIN_HOST origin.
  worker = await startWorker({ upstream, s3 }, { vars: { ...HOSTS, CORS_ALLOWED_ORIGINS: '' } });
});

after(async () => {
  await worker?.close();
  await s3?.close();
  await upstream?.close();
});


describe('configurable hosts', () => {
  it('serves the viewer shell on MAIN_HOST, with a CSP for the configured CDN and API', async () => {
    const response = await worker.request(`${MAIN}/img1.png`, { headers: browser });
    assert.equal(response.status, 200);
    assert.match(response.text, /<div id="root" data-page="file" data-state="file"><\/div><script id="file-data"/);
    const csp = response.headers['content-security-policy'];
    assert.match(csp, /connect-src 'self' http:\/\/cdn\.files\.localhost:8787 http:\/\/api\.files\.localhost:8787;/);
    assert.match(csp, /img-src 'self' http:\/\/cdn\.files\.localhost:8787 blob: data:/);
    assert.match(csp, /media-src 'self' http:\/\/cdn\.files\.localhost:8787 blob: data:/);
    assert.doesNotMatch(csp, /files\.gg/);
  });

  it('uses the MAIN_HOST origin for the default og:image', async () => {
    const response = await worker.request(`${MAIN}/gcsonly.txt`, { headers: browser });
    assert.equal(response.status, 200);
    assert.match(response.text, /<meta property="og:image" content="http:\/\/files\.localhost:8787\/og-image\.png">/);
  });

  it('serves bytes on CDN_HOST, sandboxed and framable only by MAIN_HOST', async () => {
    const response = await worker.request('http://cdn.files.localhost:8787/files/img1.png');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-security-policy'], /^sandbox; .*frame-ancestors http:\/\/files\.localhost:8787$/);
    assert.equal(response.headers['access-control-allow-origin'], '*');
  });

  it('checks tokens on CDN_HOST', async () => {
    const { file, access } = FILES.pw1;
    assert.equal((await worker.request('http://cdn.files.localhost:8787/files/pw1.png')).status, 401);
    const token = await signToken({ k: 'file', t: file.id, s: 'unlock', v: access.access_version, u: NOW_S(), e: NOW_S() + 60 }, SECRETS.CDN_TOKEN_SECRET);
    assert.equal((await worker.request(`http://cdn.files.localhost:8787/files/pw1.png?t=${token}`)).status, 200);
  });

  it('passes API_HOST through with credentialed CORS for the MAIN_HOST origin', async () => {
    const response = await worker.request('http://api.files.localhost:8787/users/@me', { headers: { origin: MAIN } });
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.at(-1).path, '/users/@me');
    assert.equal(response.headers['access-control-allow-origin'], MAIN);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');

    const evil = await worker.request('http://api.files.localhost:8787/users/@me', { headers: { origin: 'https://files.gg' } });
    assert.equal(evil.headers['access-control-allow-origin'], '*');
    assert.equal(evil.headers['access-control-allow-credentials'], undefined);
  });

  it('passes MAIN_HOST/api/* through as a credentialed route', async () => {
    const response = await worker.request(`${MAIN}/api/users/@me`, { headers: { origin: MAIN } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
  });

  it('answers PROXY_HOST, still behind the proxy secret', async () => {
    const response = await worker.request('http://proxy.files.localhost:8787/download/https%3A%2F%2Fexample.com');
    assert.equal(response.status, 403);
  });

  it('no longer routes the production hostnames', async () => {
    for (const url of ['https://files.gg/img1.png', 'https://cdn.files.gg/files/img1.png', 'https://api.files.gg/users/@me']) {
      const response = await worker.request(url, { headers: browser });
      assert.equal(response.status, 404, url);
    }
  });
});
