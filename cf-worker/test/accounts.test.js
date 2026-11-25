// Milestone 6 (docs/redesign/contracts/milestone-6.md) in the Worker's pure modules: the session
// cookie rules (§3, §12), the auth redirects and reserved segments (§6), owner state and
// domain-only (§8.8, §10.6), custom-domain routing and rehosting (§10.8, §10.9, §16.5), the CSPs
// (§10.10, §10.11) and the challenge frame's parameters.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SESSION_COOKIE_NAME,
  filterSetCookies,
  sessionCookieHeader,
  sessionCookieName,
  setCookieName,
} from '../worker/utils/cookies.js';
import {
  classifyCustomPath,
  isCustomHostname,
  isDcvPath,
  isOwnHost,
  minimalPage,
  NOT_CONNECTED_MESSAGE,
  CHALLENGE_ACTIONS,
  parseChallengeQuery,
  rehost,
  rehostDeep,
  rehostSources,
} from '../worker/utils/domains.js';
import { DEFAULT_HOSTS, getHosts, publicOrigins } from '../worker/utils/hosts.js';
import { domainAllows, domainServing, ownerPendingDeletion, servedOnCustom } from '../worker/utils/owners.js';
import { INTERNAL_LOOKUP_HEADER, originRequestHeaders, VIA_HEADER } from '../worker/utils/security.js';
import { verifySignedUrl, verifyStaffUrl } from '../worker/utils/signing.js';
import {
  AUTH_REDIRECTS,
  challengeCsp,
  classifyStablePath,
  appCsp,
  customViewerCsp,
  decideAlbumShell,
  decideFileShell,
  hasReservedSegment,
  RESERVED_SEGMENTS,
} from '../worker/utils/viewer.js';


const TOKEN = 'fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC';
const NAME = '__Host-filesgg_session';

describe('the session cookie name (SESSION_COOKIE_NAME, §3.2, §12 item 9)', () => {
  it('defaults to __Host-filesgg_session', () => {
    assert.equal(DEFAULT_SESSION_COOKIE_NAME, NAME);
    assert.equal(sessionCookieName({}), NAME);
    assert.equal(sessionCookieName(undefined), NAME);
    assert.equal(sessionCookieName({ SESSION_COOKIE_NAME: '' }), NAME);
    assert.equal(sessionCookieName({ SESSION_COOKIE_NAME: '   ' }), NAME);
  });

  it('reads the local stack name', () => {
    assert.equal(sessionCookieName({ SESSION_COOKIE_NAME: 'filesgg_session' }), 'filesgg_session');
    assert.equal(sessionCookieName({ SESSION_COOKIE_NAME: ' filesgg_session ' }), 'filesgg_session');
  });

  it('refuses anything that is not a cookie name', () => {
    for (const bad of ['a b', 'a;b', 'a=b', 'sess,ion', '"x"', 'x\ty']) {
      assert.throws(() => sessionCookieName({ SESSION_COOKIE_NAME: bad }), /SESSION_COOKIE_NAME must be a cookie name/, bad);
    }
  });
});

describe('sessionCookieHeader (only the session cookie goes to files.gg/api)', () => {
  it('keeps the session cookie and drops every other one (§16.11)', () => {
    assert.equal(sessionCookieHeader(`${NAME}=${TOKEN}; __cf_bm=x`, NAME), `${NAME}=${TOKEN}`);
    assert.equal(sessionCookieHeader(`a=1; ${NAME}=${TOKEN}; b=2`, NAME), `${NAME}=${TOKEN}`);
    assert.equal(sessionCookieHeader(`${NAME}=${TOKEN}`, NAME), `${NAME}=${TOKEN}`);
    assert.equal(sessionCookieHeader(`  ${NAME} = ${TOKEN} ;`, NAME), `${NAME}=${TOKEN}`);
  });

  it('matches the name exactly', () => {
    for (const header of [`__host-filesgg_session=${TOKEN}`, `${NAME}_x=${TOKEN}`, `x${NAME}=${TOKEN}`, `filesgg_session=${TOKEN}`]) {
      assert.equal(sessionCookieHeader(header, NAME), null, header);
    }
    assert.equal(sessionCookieHeader(`${NAME}=a; filesgg_session=${TOKEN}`, 'filesgg_session'), `filesgg_session=${TOKEN}`);
  });

  it('forwards nothing when there is no usable session cookie', () => {
    for (const header of [undefined, null, '', 'a=1', `${NAME}=`, `${NAME}`, `${NAME}="${TOKEN}"`, `${NAME}=a b`, `${NAME}=a, b=c`]) {
      assert.equal(sessionCookieHeader(header, NAME), null, String(header));
    }
  });

  it('forwards nothing when two different values claim the name (a tossed cookie)', () => {
    assert.equal(sessionCookieHeader(`${NAME}=attacker; ${NAME}=${TOKEN}`, NAME), null);
    assert.equal(sessionCookieHeader(`${NAME}=${TOKEN}; ${NAME}=${TOKEN}`, NAME), `${NAME}=${TOKEN}`);
  });
});

describe('filterSetCookies (Set-Cookie only for the session cookie, only on files.gg/api)', () => {
  const upstream = () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const value of [
      '__cf_bm=abc; Path=/; Domain=files.gg', `${NAME}=${TOKEN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000`,
      `__host-filesgg_session=evil; Path=/`, `${NAME}_x=evil; Path=/`, `${NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]) {
      headers.append('set-cookie', value);
    }
    return headers;
  };

  it('keeps setting and clearing the session cookie, and nothing else', () => {
    const headers = upstream();
    const kept = filterSetCookies(headers, NAME);
    assert.deepEqual(kept, [
      `${NAME}=${TOKEN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000`,
      `${NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    assert.deepEqual(headers.getSetCookie(), kept);
    assert.equal(headers.get('content-type'), 'application/json');
  });

  it('removes them all everywhere else', () => {
    const headers = upstream();
    assert.deepEqual(filterSetCookies(headers, null), []);
    assert.equal(headers.has('set-cookie'), false);
    const none = new Headers();
    assert.deepEqual(filterSetCookies(none, NAME), []);
  });

  it('reads the cookie name a Set-Cookie sets', () => {
    assert.equal(setCookieName(`${NAME}=x; Path=/`), NAME);
    assert.equal(setCookieName(' a =1'), 'a');
    assert.equal(setCookieName('=x'), null);
    assert.equal(setCookieName('novalue'), null);
  });
});

describe('originRequestHeaders and the session cookie (§3.4, §12 item 1)', () => {
  const incoming = () => new Headers({
    cookie: `${NAME}=${TOKEN}; __cf_bm=x`,
    'x-filesgg-via': 'main',
    'X-Filesgg-Internal-Lookup': '1',
    'cf-connecting-ip': '203.0.113.5',
  });

  it('never forwards the client\'s Cookie or X-Filesgg-Via (api.files.gg)', () => {
    const { headers } = originRequestHeaders(incoming(), 's3cret');
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has(VIA_HEADER), false);
    assert.equal(headers.has(INTERNAL_LOOKUP_HEADER), false);
  });

  it('marks files.gg/api requests and gives them only the session cookie', () => {
    const { headers } = originRequestHeaders(incoming(), 's3cret', undefined, { main: true, sessionCookie: `${NAME}=${TOKEN}` });
    assert.equal(headers.get('cookie'), `${NAME}=${TOKEN}`);
    assert.equal(headers.get(VIA_HEADER), 'main');
    assert.equal(headers.has(INTERNAL_LOOKUP_HEADER), false);
  });

  it('marks files.gg/api requests without a session cookie too, with no Cookie at all', () => {
    const { headers } = originRequestHeaders(incoming(), 's3cret', undefined, { main: true, sessionCookie: null });
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.get(VIA_HEADER), 'main');
  });

  it('sends neither the cookie nor the marker without the origin secret', () => {
    const { headers, trusted } = originRequestHeaders(incoming(), '', undefined, { main: true, sessionCookie: `${NAME}=${TOKEN}` });
    assert.equal(trusted, false);
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has(VIA_HEADER), false);
  });
});


describe('files.gg routing (§6.2, §6.3)', () => {
  it('redirects the old auth paths to the dashboard', () => {
    assert.deepEqual(AUTH_REDIRECTS, {
      '/login': '/app/login', '/login/': '/app/login',
      '/register': '/app/register', '/register/': '/app/register',
      '/signup': '/app/register', '/signup/': '/app/register',
    });
    for (const [path, location] of Object.entries(AUTH_REDIRECTS)) {
      assert.deepEqual(classifyStablePath(path), { route: 'redirect', location, status: 308 }, path);
    }
  });

  it('routes /challenge, and only that exact path', () => {
    assert.deepEqual(classifyStablePath('/challenge'), { route: 'challenge' });
    assert.equal(classifyStablePath('/challenge/').route, 'missing');
    assert.equal(classifyStablePath('/challenge.html').route, 'missing');
  });

  it('reserves login, register, signup, challenge, files, previews, albums, convert, legal, changelog and help', () => {
    assert.deepEqual([...RESERVED_SEGMENTS], [
      'report', 'login', 'register', 'signup', 'challenge', 'files', 'previews', 'albums', 'convert', 'legal', 'changelog', 'help',
    ]);
    for (const segment of RESERVED_SEGMENTS) {
      assert.ok(hasReservedSegment(segment), segment);
      assert.ok(hasReservedSegment(segment.toUpperCase()), segment);
      assert.ok(hasReservedSegment(`abc/${segment}/x`), segment);
    }
    for (const vanity of ['logins', 'filesx', 'xalbums', 'preview', 'album', 'file', 'abc123']) {
      assert.equal(hasReservedSegment(vanity), false, vanity);
    }
  });

  it('never looks up a vanity with a reserved segment', () => {
    for (const path of ['/files/abc123.png', '/previews/thumb/abc.webp', '/albums/collage/x.webp', '/Login.png', '/x/register', '/SIGNUP', '/challenge.png']) {
      assert.equal(classifyStablePath(path).route, 'missing', path);
    }
    assert.equal(classifyStablePath('/abc123.png').route, 'file');
  });

  it('keeps the routes that come first', () => {
    assert.equal(classifyStablePath('/app/login').route, 'app');
    assert.equal(classifyStablePath('/api/auth/login').route, 'api');
    assert.deepEqual(classifyStablePath('/report/login'), { route: 'report', data: { type: 'file', vanity: 'login' } });
    assert.equal(classifyStablePath('/login/report').route, 'missing');
  });
});


describe('owner state, domain-only and scope (§8.8, §10.6, §10.8)', () => {
  it('reads owner_state, failing closed on unknown values', () => {
    assert.equal(ownerPendingDeletion({ owner_state: 'pending_deletion' }), true);
    assert.equal(ownerPendingDeletion({ owner_state: 'frozen' }), true);
    assert.equal(ownerPendingDeletion({ owner_state: '' }), true);
    for (const data of [{ owner_state: 'active' }, { owner_state: null }, {}, null]) {
      assert.equal(ownerPendingDeletion(data), false, JSON.stringify(data));
    }
  });

  it('reads served_on: only "custom" hides content on files.gg', () => {
    assert.equal(servedOnCustom({ served_on: 'custom' }), true);
    for (const data of [{ served_on: 'files.gg' }, { served_on: 'somewhere' }, {}, null]) {
      assert.equal(servedOnCustom(data), false, JSON.stringify(data));
    }
  });

  it('serves a domain only with serving: true exactly', () => {
    assert.equal(domainServing({ serving: true }), true);
    for (const domain of [{ serving: 'true' }, { serving: 1 }, { serving: false }, {}, null]) {
      assert.equal(domainServing(domain), false, JSON.stringify(domain));
    }
  });

  it('allows the owner\'s content on `own`, anyone\'s on `any`, and treats unknown scopes as `own`', () => {
    const own = { user_id: '42', scope: 'own' };
    assert.equal(domainAllows(own, { owner_user_id: '42' }), true);
    assert.equal(domainAllows(own, { owner_user_id: 42 }), true);
    assert.equal(domainAllows(own, { owner_user_id: '77' }), false);
    assert.equal(domainAllows(own, { owner_user_id: null }), false);
    assert.equal(domainAllows(own, {}), false);
    assert.equal(domainAllows({ user_id: null, scope: 'own' }, { owner_user_id: null }), false);
    assert.equal(domainAllows({ user_id: '42', scope: 'everything' }, { owner_user_id: '77' }), false);
    assert.equal(domainAllows({ user_id: '42', scope: 'any' }, { owner_user_id: '77' }), true);
    assert.equal(domainAllows({ user_id: '42', scope: 'any' }, { owner_user_id: null }), true);
    assert.equal(domainAllows(null, { owner_user_id: '42' }), false);
  });

  const file = (extra = {}, access = { visibility: 'link', access_version: 0 }) => ({
    status: 'found',
    data: {
      file: { id: '1', vanity: 'abc', kind: 'file', filename: 'a.zip', mimetype: 'application/zip', size: 1, cdn_url: 'https://cdn.files.gg/files/abc.zip', url: 'https://files.gg/abc' },
      access, safety: { state: 'ok', reason: null }, serve_inline: true, owner_user_id: '42', served_on: 'files.gg', owner_state: 'active',
      ...extra,
    },
  });
  const decide = (lookup, domain = null) => decideFileShell({ lookup, vanity: 'abc', headers: new Headers({ 'accept-language': 'en', accept: 'text/html' }), domain });
  const state = (shell) => shell.state;

  it('files.gg: a pending deletion or domain-only is missing, never removed (§10.8)', () => {
    assert.equal(state(decide(file())), 'file');
    assert.equal(state(decide(file({ served_on: 'custom' }))), 'missing');
    assert.equal(decide(file({ served_on: 'custom' })).status, 404);
    assert.equal(state(decide(file({ owner_state: 'pending_deletion' }))), 'missing');
    assert.equal(state(decide(file({ owner_state: 'pending_deletion', safety: { state: 'removed', reason: 'terms' } }))), 'missing');
    assert.equal(state(decide(file({ served_on: 'custom', safety: { state: 'pending', reason: null } }))), 'missing');
    assert.equal(state(decide(file({ served_on: 'custom' }, { visibility: 'password', access_version: 0 }))), 'missing');
    assert.equal(state(decide(file({}, { visibility: 'password', access_version: 0 }))), 'locked');
  });

  it('a custom domain: scope first, served_on ignored, pending deletion missing', () => {
    const own = { user_id: '42', scope: 'own', serving: true };
    const any = { user_id: '42', scope: 'any', serving: true };
    assert.equal(state(decide(file({ served_on: 'custom' }), own)), 'file');
    assert.equal(state(decide(file({ owner_user_id: '77' }), own)), 'missing');
    assert.equal(state(decide(file({ owner_user_id: '77' }), any)), 'file');
    assert.equal(state(decide(file({ owner_user_id: null }), own)), 'missing');
    assert.equal(state(decide(file({ owner_user_id: null }), any)), 'file');
    assert.equal(state(decide(file({ owner_state: 'pending_deletion' }), own)), 'missing');
    assert.equal(state(decide(file({ owner_user_id: '77', owner_state: 'pending_deletion' }), any)), 'missing');
    assert.equal(state(decide(file({}, { visibility: 'private', access_version: 0 }), own)), 'missing');
    assert.equal(state(decide(file({}, { visibility: 'password', access_version: 0 }), own)), 'locked');
    // Another owner's removed file on an `own` domain says nothing about its state.
    assert.equal(state(decide(file({ owner_user_id: '77', safety: { state: 'removed', reason: 'terms' } }), own)), 'missing');
  });

  const album = (extra = {}) => ({
    status: 'found',
    data: {
      album: { id: '5', vanity: 'alb', title: 'T', items: [{ id: '1', vanity: 'abc', kind: 'file', filename: 'a', visibility: 'link' }], count: 1 },
      access: { visibility: 'link', access_version: 0 },
      items_access: { 1: { visibility: 'link', access_version: 0, safety: { state: 'ok' } } },
      safety: { state: 'ok', reason: null }, pending_count: 0, owner_user_id: '42', served_on: 'files.gg', owner_state: 'active',
      ...extra,
    },
  });

  it('albums follow the same rules', () => {
    const own = { user_id: '42', scope: 'own', serving: true };
    assert.equal(decideAlbumShell({ lookup: album(), vanity: 'alb' }).state, 'album');
    assert.equal(decideAlbumShell({ lookup: album({ served_on: 'custom' }), vanity: 'alb' }).state, 'missing');
    assert.equal(decideAlbumShell({ lookup: album({ owner_state: 'pending_deletion' }), vanity: 'alb' }).state, 'missing');
    assert.equal(decideAlbumShell({ lookup: album({ served_on: 'custom' }), vanity: 'alb', domain: own }).state, 'album');
    assert.equal(decideAlbumShell({ lookup: album({ owner_user_id: '77' }), vanity: 'alb', domain: own }).state, 'missing');
    assert.equal(decideAlbumShell({ lookup: album({ owner_state: 'pending_deletion' }), vanity: 'alb', domain: own }).state, 'missing');
    assert.equal(decideAlbumShell({ lookup: album({ safety: { state: 'removed', reason: 'terms' }, owner_state: 'pending_deletion' }), vanity: 'alb' }).state, 'missing');
  });
});


describe('custom-domain routing (§10.8)', () => {
  it('answers only hostnames that could be a customer\'s', () => {
    for (const host of ['i.example.com', 'files.example.co.uk', 'xn--bcher-kva.example.com', 'cdn.files.gg.evil.example', 'files.ggx.com']) {
      assert.equal(isCustomHostname(host), true, host);
    }
    for (const host of ['files.gg', 'www.files.gg', 'cdn.files.gg', 'api.files.gg', 'domains.files.gg', 'x.files.gg', 'localhost', '', 'a_b.example.com', '-a.example.com', 'a..b']) {
      assert.equal(isCustomHostname(host), false, host);
    }
    const local = getHosts({ MAIN_HOST: 'files.localhost', CDN_HOST: 'cdn.files.localhost', API_HOST: 'api.files.localhost' });
    assert.equal(isCustomHostname('files.gg', local), true);
    assert.equal(isCustomHostname('i.files.localhost', local), false);
    assert.equal(isCustomHostname('custom.localhost', local), true);
    assert.ok(isOwnHost('www.files.localhost', local) && !isOwnHost('files.gg', local));
  });

  it('passes only Cloudflare\'s validation paths straight through', () => {
    for (const path of ['/.well-known/acme-challenge/tok', '/.well-known/pki-validation/x.txt', '/.well-known/cf-custom-hostname-challenge/id']) {
      assert.equal(isDcvPath(path), true, path);
      assert.equal(classifyCustomPath(path).route, 'dcv', path);
    }
    for (const path of ['/.well-known/acme-challenge/', '/.well-known/security.txt', '/.well-known/acme-challengex/y', '/x/.well-known/acme-challenge/y']) {
      assert.equal(isDcvPath(path), false, path);
    }
  });

  it('classifies every path in the table', () => {
    const cases = {
      '/': 'home',
      '/favicon.ico': 'root-file', '/og-image.png': 'root-file',
      '/assets/viewer-x.js': 'asset',
      '/abc123': 'file', '/abc123.png': 'file', '/abcd/xyz.png': 'file',
      '/a/Ab3dE6gH': 'album', '/a/Ab3dE6gH/3': 'missing',
      '/report': 'report', '/report/abc123': 'report', '/report/a/Ab3dE6gH': 'report',
      '/abc123/report': 'missing', '/a/Ab3dE6gH/report': 'missing', '/unlock/view': 'file',
      '/files/abc123.png': 'cdn', '/previews/thumb/abc123.webp': 'cdn', '/albums/collage/x.webp': 'cdn', '/albums/download/x.zip': 'cdn',
      '/files/': 'cdn', '/files/x': 'cdn', '/previews/nope/x.webp': 'cdn',
      '/app': 'not-found', '/app/login': 'not-found', '/api': 'not-found', '/api/users/@me': 'not-found', '/convert': 'not-found',
      // milestone-5.md §19.1: the changelog and legal pages are files.gg's only.
      '/changelog': 'not-found', '/legal': 'not-found', '/legal/terms': 'not-found', '/legal/privacy': 'not-found',
      // milestone-7.md §7: so is the link warnings help page.
      '/help': 'not-found', '/help/link-warnings': 'not-found',
      '/.well-known/security.txt': 'not-found', '/.well-known/x': 'not-found',
      '/login': 'missing', '/register': 'missing', '/signup': 'missing', '/challenge': 'missing', '/files': 'cdn',
    };
    for (const [path, route] of Object.entries(cases)) {
      assert.equal(classifyCustomPath(path).route, route, path);
    }
    assert.deepEqual(classifyCustomPath('/files/abc123.png'), { route: 'cdn', kind: 'file', parsed: { vanity: 'abc123' } });
    assert.equal(classifyCustomPath('/files/').kind, null);
    assert.equal(classifyCustomPath('/albums/other/x.webp').kind, null);
  });
});


describe('rehosting (§10.9, §16.5)', () => {
  const from = rehostSources(DEFAULT_HOSTS);
  const host = 'https://i.example.com';
  const VECTORS = [
    ['https://cdn.files.gg/files/abc123.png', 'https://i.example.com/files/abc123.png'],
    ['https://cdn.files.gg/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8', 'https://i.example.com/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8'],
    ['https://cdn.files.gg/previews/thumb/abc123.webp?v=5', 'https://i.example.com/previews/thumb/abc123.webp?v=5'],
    ['https://files.gg/abc123', 'https://i.example.com/abc123'],
    ['https://files.gg/a/Ab3dE6gH#pw=amber-tunnel-oxide-violet', 'https://i.example.com/a/Ab3dE6gH#pw=amber-tunnel-oxide-violet'],
    ['https://cdn.discordapp.com/avatars/1/a.png', 'https://cdn.discordapp.com/avatars/1/a.png'],
    ['https://cdn.files.gg.evil.example/files/x.png', 'https://cdn.files.gg.evil.example/files/x.png'],
    ['https://cdn.files.gg/files/abc123.png?staff=555555555555555555&expires=1795603600&sig=xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk', 'https://i.example.com/files/abc123.png?staff=555555555555555555&expires=1795603600&sig=xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk'],
  ];
  VECTORS.forEach(([input, output], i) => {
    it(`vector ${i + 1}: ${input}`, () => assert.equal(rehost(input, from, host), output));
  });

  it('compares origins exactly, never a prefix of the host', () => {
    for (const url of ['https://files.ggx/abc', 'https://cdn.files.gg@evil.example/x', 'https://cdn.files.gg:443/x', 'http://cdn.files.gg/x', 'https://CDN.files.gg/x', 'cdn.files.gg/x', '/files/x.png', 'https://api.files.gg/files/x']) {
      assert.equal(rehost(url, from, host), url, url);
    }
    assert.equal(rehost('https://files.gg', from, host), host);
    assert.equal(rehost('https://files.gg?x', from, host), host + '?x');
    for (const value of [null, undefined, 5, true]) {
      assert.equal(rehost(value, from, host), value);
    }
  });

  it('keeps a signature valid: the rehosted path is byte-identical (milestone-3 §3 vector 1)', async () => {
    const url = new URL(rehost(VECTORS[1][0], from, host));
    assert.equal(url.host, 'i.example.com');
    assert.equal(await verifySignedUrl({
      secret: 'test-cdn-signing-secret', path: url.pathname, query: url.searchParams, grant: 'file:1234567890123456789:0', now: 1795600000,
    }), true);
  });

  it('the staff vector stays valid as a signature (the router, not the signature, refuses it off the CDN)', async () => {
    const url = new URL(VECTORS[7][1]);
    assert.equal(await verifyStaffUrl({
      secret: 'test-cdn-signing-secret', path: url.pathname, query: url.searchParams, fileId: '1234567890123456789', now: 1795603000,
    }), true);
  });

  it('rehosts every string in a payload, keys untouched', () => {
    const payload = {
      file: { url: 'https://files.gg/abc', cdn_url: 'https://cdn.files.gg/files/abc.png', 'https://files.gg/key': 'https://files.gg/x', n: 3, ok: true, none: null },
      assets: [{ url: 'https://cdn.files.gg/previews/thumb/abc.webp?v=1' }, 'https://example.com/x'],
    };
    assert.deepEqual(rehostDeep(payload, from, host), {
      file: { url: 'https://i.example.com/abc', cdn_url: 'https://i.example.com/files/abc.png', 'https://files.gg/key': 'https://i.example.com/x', n: 3, ok: true, none: null },
      assets: [{ url: 'https://i.example.com/previews/thumb/abc.webp?v=1' }, 'https://example.com/x'],
    });
    assert.equal(payload.file.url, 'https://files.gg/abc');
  });

  it('also rehosts the local stack\'s own origins', () => {
    const local = getHosts({ MAIN_HOST: 'files.localhost', CDN_HOST: 'cdn.files.localhost', API_HOST: 'api.files.localhost' });
    const sources = rehostSources(local, publicOrigins(local, new URL('http://custom.localhost:8787/x')));
    assert.deepEqual(sources, ['https://cdn.files.localhost', 'https://files.localhost', 'http://cdn.files.localhost:8787', 'http://files.localhost:8787']);
    assert.equal(rehost('http://cdn.files.localhost:8787/files/a.png', sources, 'http://custom.localhost:8787'), 'http://custom.localhost:8787/files/a.png');
  });
});


describe('the dashboard and public pages CSP (milestone-7: PLAN.md hardening)', () => {
  it('is the viewer\'s strict policy plus Discord avatars', () => {
    assert.equal(appCsp(), "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; worker-src 'self'; connect-src 'self' https://cdn.files.gg https://api.files.gg; img-src 'self' https://cdn.files.gg https://cdn.discordapp.com blob: data:; media-src 'self' https://cdn.files.gg blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  });
});


describe('CSPs and pages for custom domains (§10.8, §10.10, §10.11)', () => {
  it('the custom-host viewer CSP is exactly the contract\'s', () => {
    assert.equal(customViewerCsp(), "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://api.files.gg https://cdn.files.gg; img-src 'self' https://cdn.files.gg blob: data:; media-src 'self' https://cdn.files.gg blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src https://files.gg; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  });

  it('the challenge CSP is framable by the custom origin only', () => {
    assert.equal(challengeCsp('https://i.example.com'), "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors https://i.example.com");
  });

  it('parses the challenge query', () => {
    const parse = (query) => parseChallengeQuery(new URLSearchParams(query));
    assert.deepEqual(parse('host=i.example.com&action=unlock'), { host: 'i.example.com', action: 'unlock' });
    assert.deepEqual(parse('host=i.example.com&action=report'), { host: 'i.example.com', action: 'report' });
    // milestone-6.md §19.7: opening a view-limited file on a custom domain
    assert.deepEqual(parse('host=i.example.com&action=view'), { host: 'i.example.com', action: 'view' });
    assert.deepEqual([...CHALLENGE_ACTIONS], ['unlock', 'report', 'view']);
    for (const query of [
      'host=i.example.com&action=open', 'host=i.example.com&action=VIEW', 'host=i.example.com&action=refresh',
      'host=i.example.com', 'action=unlock', 'host=i.example.com&action=login', 'host=I.Example.com&action=unlock',
      'host=files.gg&action=unlock', 'host=cdn.files.gg&action=unlock', 'host=x.files.gg&action=unlock',
      'host=https://i.example.com&action=unlock', 'host=i.example.com:8443&action=unlock', 'host=i.example.com/x&action=unlock',
      'host=i.example.com%20frame-ancestors%20*&action=unlock', "host=i.example.com;script-src%20'unsafe-inline'&action=unlock",
    ]) {
      assert.equal(parse(query), null, query);
    }
  });

  it('the "isn\'t connected" page has the sentence and no other branding', () => {
    const html = minimalPage(NOT_CONNECTED_MESSAGE);
    assert.match(html, /<p>This domain isn't connected to files\.gg right now\.<\/p>/);
    assert.doesNotMatch(html, /<script|<img|<link|href=|src=/);
  });
});
