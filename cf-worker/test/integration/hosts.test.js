// The Worker on configurable hosts (MAIN_HOST, CDN_HOST, API_HOST), as the local e2e
// stack runs it under wrangler dev: routing, the CSPs, CORS and the generated URLs follow the vars,
// and the production hostnames no longer route.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { signedForFile, startS3, startUpstream, startWorker } from '../support/worker.js';


const HOSTS = {
  MAIN_HOST: 'files.localhost',
  CDN_HOST: 'cdn.files.localhost',
  API_HOST: 'api.files.localhost',
};
const MAIN = 'http://files.localhost:8787';
const browser = { 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en' };

let upstream;
let s3;
let worker;

before(async () => {
  upstream = await startUpstream();
  s3 = await startS3();
  // As e2e/ runs it: the local session cookie name.
  worker = await startWorker({ upstream, s3 }, { vars: { ...HOSTS, SESSION_COOKIE_NAME: 'filesgg_session' } });
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
    const response = await worker.request(`${MAIN}/txt1.txt`, { headers: browser });
    assert.equal(response.status, 200);
    assert.match(response.text, /<meta property="og:image" content="http:\/\/files\.localhost:8787\/og-image\.png">/);
  });

  it('serves bytes on CDN_HOST, sandboxed and framable only by MAIN_HOST', async () => {
    const response = await worker.request('http://cdn.files.localhost:8787/files/img1.png');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-security-policy'], /^sandbox; .*frame-ancestors http:\/\/files\.localhost:8787$/);
    assert.equal(response.headers['access-control-allow-origin'], '*');
  });

  it('checks signed URLs on CDN_HOST (the signature covers the path, not the host)', async () => {
    assert.equal((await worker.request('http://cdn.files.localhost:8787/files/pw1.png')).status, 401);
    assert.equal((await worker.request(`http://cdn.files.localhost:8787${signedForFile('pw1', '/files/pw1.png')}`)).status, 200);
  });

  it('passes API_HOST through with `*` CORS and no cookie', async () => {
    const response = await worker.request('http://api.files.localhost:8787/users/@me', {
      headers: { origin: MAIN, cookie: 'filesgg_session=fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC' },
    });
    assert.equal(response.status, 200);
    const sent = upstream.requests.at(-1);
    assert.equal(sent.path, '/users/@me');
    assert.equal(sent.headers.cookie, undefined);
    assert.equal(sent.headers['x-filesgg-via'], undefined);
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  });

  it('forwards the SESSION_COOKIE_NAME cookie on MAIN_HOST/api/* only, never as credentialed CORS', async () => {
    const response = await worker.request(`${MAIN}/api/users/@me`, {
      headers: { origin: MAIN, cookie: '__Host-filesgg_session=prod; filesgg_session=fgs_local; other=1' },
    });
    assert.equal(response.status, 200);
    const sent = upstream.requests.at(-1);
    assert.equal(sent.headers.cookie, 'filesgg_session=fgs_local');
    assert.equal(sent.headers['x-filesgg-via'], 'main');
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  });

  it('no longer routes the production hostnames', async () => {
    for (const url of ['https://files.gg/img1.png', 'https://cdn.files.gg/files/img1.png', 'https://api.files.gg/users/@me']) {
      const response = await worker.request(url, { headers: browser });
      assert.equal(response.status, 404, url);
    }
  });
});
