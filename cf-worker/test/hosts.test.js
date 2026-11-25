import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_HOSTS, getHosts, hostPattern, isMainHost, originFor, publicOrigins } from '../worker/utils/hosts.js';
import { CDN_CONTENT_SECURITY_POLICY, cdnContentSecurityPolicy } from '../worker/utils/security.js';
import { VIEWER_CSP, fileMetaTags, viewerCsp } from '../worker/utils/viewer.js';
import { apiOrigin } from '../worker/utils/env.js';


const LOCAL = { MAIN_HOST: 'files.localhost', CDN_HOST: 'cdn.files.localhost', API_HOST: 'api.files.localhost' };

describe('configurable hosts', () => {
  it("defaults to today's hosts", () => {
    assert.deepEqual({ ...getHosts({}) }, { main: 'files.gg', cdn: 'cdn.files.gg', api: 'api.files.gg' });
    assert.deepEqual({ ...getHosts({ MAIN_HOST: '', CDN_HOST: '  ' }) }, { ...DEFAULT_HOSTS });
    assert.equal(apiOrigin({}), 'https://api.files.gg');
  });

  it('reads MAIN_HOST, CDN_HOST and API_HOST', () => {
    assert.deepEqual({ ...getHosts({ ...LOCAL, MAIN_HOST: 'Files.Localhost.' }) },
      { main: 'files.localhost', cdn: 'cdn.files.localhost', api: 'api.files.localhost' });
    assert.equal(apiOrigin({ API_HOST: 'api.staging.example' }), 'https://api.staging.example');
    assert.equal(apiOrigin({ API_HOST: 'api.staging.example', API_ORIGIN: 'http://127.0.0.1:8080' }), 'http://127.0.0.1:8080');
  });

  it('refuses anything but a bare hostname', () => {
    for (const bad of ['https://files.gg', 'files.gg:8787', 'files.gg/x', 'a b', '*.files.gg']) {
      assert.throws(() => getHosts({ MAIN_HOST: bad }), /MAIN_HOST must be a bare hostname/);
    }
  });

  it('builds router patterns the router cannot misread', () => {
    assert.equal(hostPattern('files.gg', { www: true }), '(?:[w]{3}\\.)?files\\.gg');
    const pattern = new RegExp(`^${hostPattern('files.localhost', { www: true })}/`);
    assert.ok(pattern.test('files.localhost/x') && pattern.test('www.files.localhost/x'));
    assert.ok(!pattern.test('cdn.files.localhost/x') && !pattern.test('filesXlocalhost/x'));
  });

  it('matches the main host and its www. name only', () => {
    assert.ok(isMainHost('files.gg') && isMainHost('www.files.gg'));
    assert.ok(!isMainHost('cdn.files.gg'));
    const local = getHosts(LOCAL);
    assert.ok(isMainHost('files.localhost', local) && !isMainHost('files.gg', local));
  });

  it('links over https, except for plain-http loopback dev requests', () => {
    assert.equal(originFor('files.gg', new URL('https://files.gg/x')), 'https://files.gg');
    assert.equal(originFor('files.gg', new URL('http://files.gg/x')), 'https://files.gg');
    assert.equal(originFor('cdn.staging.example', new URL('http://staging.example:8080/')), 'https://cdn.staging.example');
    assert.equal(originFor('cdn.files.localhost', new URL('http://files.localhost:8787/x')), 'http://cdn.files.localhost:8787');
    assert.equal(originFor('cdn.files.localhost', new URL('http://127.0.0.1:8787/x')), 'http://cdn.files.localhost:8787');
    assert.equal(originFor('files.gg', null), 'https://files.gg');
  });

  it('keeps the default CSPs byte-identical', () => {
    assert.equal(viewerCsp(), VIEWER_CSP);
    assert.equal(viewerCsp(publicOrigins(DEFAULT_HOSTS, new URL('https://files.gg/'))), VIEWER_CSP);
    assert.match(VIEWER_CSP, /connect-src 'self' https:\/\/cdn\.files\.gg https:\/\/api\.files\.gg;/);
    assert.equal(cdnContentSecurityPolicy(), CDN_CONTENT_SECURITY_POLICY);
    assert.match(CDN_CONTENT_SECURITY_POLICY, /frame-ancestors https:\/\/files\.gg$/);
  });

  it('uses the configured hosts for the CSPs and og:image', () => {
    const hosts = getHosts(LOCAL);
    const origins = publicOrigins(hosts, new URL('http://files.localhost:8787/abc'));
    const csp = viewerCsp(origins);
    assert.match(csp, /connect-src 'self' http:\/\/cdn\.files\.localhost:8787 http:\/\/api\.files\.localhost:8787;/);
    assert.match(csp, /img-src 'self' http:\/\/cdn\.files\.localhost:8787 blob: data:/);
    assert.match(cdnContentSecurityPolicy(origins.main), /frame-ancestors http:\/\/files\.localhost:8787$/);
    assert.match(fileMetaTags({ kind: 'file', filename: 'a.zip', size: 1, mimetype: 'application/zip' }, { mainOrigin: origins.main }),
      /content="http:\/\/files\.localhost:8787\/og-image\.png"/);
  });
});
