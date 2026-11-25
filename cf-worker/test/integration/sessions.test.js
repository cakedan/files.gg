// Milestone 6 on the real Worker (workerd), against the mock API: the session cookie's routing on
// every host and path (milestone-6.md §3, §12, §16.11), X-Filesgg-Via, CORS without credentials,
// /internal still blocked, the auth redirects, the new reserved segments, and files.gg/challenge.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALBUMS,
  FILES,
  LOCAL_SET_COOKIE,
  SECRETS,
  SESSION_CLEAR_COOKIE,
  SESSION_SET_COOKIE,
  SESSION_TOKEN,
  startS3,
  startUpstream,
  startWorker,
} from '../support/worker.js';


const NAME = '__Host-filesgg_session';
const COOKIE = `${NAME}=${SESSION_TOKEN}; __cf_bm=x; filesgg_session=local; other=1`;
const browser = {
  'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en',
};
const CHALLENGE_CSP = (origin) => `default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors ${origin}`;

let upstream;
let s3;
let worker;

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

// Every request the API mock and the B2 mock saw while `run` ran.
async function sentDuring(run) {
  const [apiBefore, s3Before] = [upstream.requests.length, s3.requests.length];
  const response = await run();
  return { response, api: upstream.requests.slice(apiBefore), s3: s3.requests.slice(s3Before) };
}

const setCookies = (response) => {
  const value = response.headers['set-cookie'];
  return (value === undefined) ? [] : [].concat(value);
};

function assertNoCookieUpstream({ api, s3: storage }, label) {
  for (const request of [...api, ...storage]) {
    assert.equal(request.headers.cookie, undefined, `${label}: ${request.path} got a cookie`);
    assert.equal(request.headers['x-filesgg-via'], undefined, `${label}: ${request.path} got X-Filesgg-Via`);
  }
}


describe('files.gg/api: the only place the session cookie goes (§12 item 1, §16.11)', () => {
  it('forwards the session cookie alone, marked X-Filesgg-Via: main', async () => {
    const { response, api } = await sentDuring(() => worker.request('https://files.gg/api/users/@me', { headers: { cookie: COOKIE } }));
    assert.equal(response.status, 200);
    assert.equal(api.length, 1);
    assert.equal(api[0].path, '/users/@me');
    assert.equal(api[0].headers.cookie, `${NAME}=${SESSION_TOKEN}`);
    assert.equal(api[0].headers['x-filesgg-via'], 'main');
    assert.equal(api[0].headers['x-filesgg-origin-secret'], SECRETS.ORIGIN_SHARED_SECRET);
    assert.equal(api[0].headers['x-filesgg-internal-lookup'], undefined);
  });

  it('marks requests without a session cookie too, and sends no Cookie at all', async () => {
    for (const cookie of [undefined, '__cf_bm=x; other=1', `${NAME}=attacker; ${NAME}=${SESSION_TOKEN}`, `${NAME}="${SESSION_TOKEN}"`]) {
      const headers = (cookie === undefined) ? {} : { cookie };
      const { api } = await sentDuring(() => worker.request('https://files.gg/api/users/@me', { headers }));
      assert.equal(api[0].headers.cookie, undefined, String(cookie));
      assert.equal(api[0].headers['x-filesgg-via'], 'main', String(cookie));
    }
  });

  it('replaces a client-sent X-Filesgg-Via', async () => {
    const { api } = await sentDuring(() => worker.request('https://files.gg/api/users/@me', { headers: { 'x-filesgg-via': 'other' } }));
    assert.equal(api[0].headers['x-filesgg-via'], 'main');
  });

  it('passes back only the Set-Cookie that sets or clears the session cookie', async () => {
    const login = await worker.request('https://files.gg/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(login.status, 200);
    assert.deepEqual(setCookies(login), [SESSION_SET_COOKIE]);
    const logout = await worker.request('https://files.gg/api/auth/logout', { method: 'POST', headers: { cookie: COOKIE } });
    assert.deepEqual(setCookies(logout), [SESSION_CLEAR_COOKIE]);
  });

  it('never approves a credentialed cross-origin call', async () => {
    const response = await worker.request('https://files.gg/api/users/@me', { headers: { origin: 'https://evil.example', cookie: COOKIE } });
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
    const preflight = await worker.request('https://files.gg/api/users/@me', {
      method: 'OPTIONS',
      headers: { origin: 'https://cdn.files.gg', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'x-filesgg-csrf' },
    });
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  });

  it('keeps /internal unreachable, with a cookie and a forged marker', async () => {
    for (const base of ['https://files.gg/api', 'https://api.files.gg']) {
      for (const path of ['/internal/domains/i.example.com', '/internal/files/img1', '/%69nternal/domains/i.example.com', '//internal/albums/alb1']) {
        const { response, api } = await sentDuring(() => worker.request(base + path, {
          headers: { cookie: COOKIE, 'x-filesgg-via': 'main', 'x-filesgg-internal-lookup': '1' },
        }));
        assert.equal(response.status, 404, base + path);
        assert.deepEqual(api.filter((r) => r.path.toLowerCase().includes('internal')), [], base + path);
      }
    }
  });
});


describe('the access routes pass through as they are (milestone-6.md §20.1)', () => {
  it('files.gg/api/access/... and api.files.gg/access/... reach the API at /access/<action>/<kind>/<vanity>', async () => {
    const cases = [
      ['POST', 'unlock/files/abcd/xyz'], ['POST', 'refresh/files/abc'], ['GET', 'view/files/unlock/view'], ['POST', 'open/files/report/x'],
      ['POST', 'unlock/albums/Ab3'], ['POST', 'refresh/albums/Ab3'], ['GET', 'view/albums/Ab3'],
    ];
    for (const base of ['https://files.gg/api', 'https://api.files.gg']) {
      for (const [method, rest] of cases) {
        const { api } = await sentDuring(() => worker.request(`${base}/access/${rest}`, {
          method, headers: { 'content-type': 'application/json', 'x-filesgg-access': 'tok' }, ...(method === 'POST' ? { body: '{}' } : {}),
        }));
        assert.deepEqual(api.map((r) => [r.method, r.path]), [[method, `/access/${rest}`]], `${base} ${rest}`);
        assert.equal(api[0].headers['x-filesgg-access'], 'tok', `${base} ${rest}`);
      }
    }
  });
});


describe('everywhere else: no Cookie upstream, no Set-Cookie back (§12 item 1, §16.11)', () => {
  it('api.files.gg: no cookie and no X-Filesgg-Via, even when the client sends them', async () => {
    const { response, api } = await sentDuring(() => worker.request('https://api.files.gg/users/@me', {
      headers: { cookie: COOKIE, 'x-filesgg-via': 'main', authorization: 'Key fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V' },
    }));
    assert.equal(response.status, 200);
    assert.equal(api[0].headers.cookie, undefined);
    assert.equal(api[0].headers['x-filesgg-via'], undefined);
    // Upload keys go to api.files.gg in the header (§7.4).
    assert.equal(api[0].headers.authorization, 'Key fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V');
  });

  it('api.files.gg: drops every Set-Cookie, the session cookie included', async () => {
    for (const path of ['/auth/login', '/auth/logout']) {
      const response = await worker.request('https://api.files.gg' + path, { method: 'POST', headers: { cookie: COOKIE } });
      assert.equal(response.status, 200, path);
      assert.deepEqual(setCookies(response), [], path);
      assert.equal(response.headers['access-control-allow-credentials'], undefined, path);
    }
  });

  it('files.gg pages and assets: nothing upstream carries the cookie', async () => {
    for (const path of ['/', '/img1.png', '/a/alb1', '/pw1', '/app', '/app/login', '/favicon.ico', '/report', '/img1/report', '/convert', '/.well-known/security.txt']) {
      const sent = await sentDuring(() => worker.request('https://files.gg' + path, { headers: { ...browser, cookie: COOKIE } }));
      assert.ok(sent.response.status < 500, path);
      assertNoCookieUpstream(sent, path);
      assert.deepEqual(setCookies(sent.response), [], path);
    }
  });

  it('cdn.files.gg: nothing upstream carries the cookie, nothing sets one', async () => {
    for (const path of ['/files/img1.png', '/files/pw1.png', '/previews/thumb/mvid.webp', '/albums/collage/albmedia.webp', '/albums/download/alb1.zip', '/files/nope.png']) {
      const sent = await sentDuring(() => worker.request('https://cdn.files.gg' + path, { headers: { cookie: COOKIE, 'x-filesgg-via': 'main' } }));
      assertNoCookieUpstream(sent, path);
      assert.deepEqual(setCookies(sent.response), [], path);
    }
  });

  it('custom domains: nothing upstream carries the cookie, nothing sets one', async () => {
    for (const path of ['/', '/img1', '/files/img1.png', '/a/alb1', '/report', '/favicon.ico', '/nope']) {
      const sent = await sentDuring(() => worker.request('https://i.example.com' + path, { headers: { ...browser, cookie: COOKIE, 'x-filesgg-via': 'main' } }));
      assert.ok(sent.response.status < 500, path);
      assertNoCookieUpstream(sent, path);
      assert.deepEqual(setCookies(sent.response), [], path);
    }
  });

  it('the internal lookups never carry a client header', async () => {
    const sent = await sentDuring(() => worker.request('https://i.example.com/ulink', { headers: { ...browser, cookie: COOKIE, 'x-filesgg-via': 'main' } }));
    const lookups = sent.api.filter((r) => r.path.startsWith('/internal/'));
    assert.ok(lookups.length >= 1);
    for (const lookup of lookups) {
      assert.equal(lookup.headers['x-filesgg-origin-secret'], SECRETS.ORIGIN_SHARED_SECRET);
      assert.equal(lookup.headers['x-filesgg-internal-lookup'], '1');
      assert.equal(lookup.headers.cookie, undefined);
      assert.equal(lookup.headers['x-filesgg-via'], undefined);
    }
  });
});


describe('the local session cookie name (SESSION_COOKIE_NAME)', () => {
  let local;
  before(async () => {
    local = await startWorker({ upstream, s3 }, { vars: { SESSION_COOKIE_NAME: 'filesgg_session' } });
  });
  after(async () => {
    await local?.close();
  });

  it('forwards and passes back the configured name only', async () => {
    const { api } = await sentDuring(() => local.request('https://files.gg/api/users/@me', { headers: { cookie: `${NAME}=prod; filesgg_session=${SESSION_TOKEN}` } }));
    assert.equal(api[0].headers.cookie, `filesgg_session=${SESSION_TOKEN}`);
    const login = await local.request('https://files.gg/api/auth/login', { method: 'POST' });
    assert.deepEqual(setCookies(login), [LOCAL_SET_COOKIE]);
  });
});


describe('auth redirects on files.gg (§6.2)', () => {
  const REDIRECTS = {
    '/login': '/app/login', '/login/': '/app/login',
    '/register': '/app/register', '/register/': '/app/register', '/signup': '/app/register',
  };

  it('308s to the dashboard pages, keeping the query, with no lookup', async () => {
    for (const [path, location] of Object.entries(REDIRECTS)) {
      for (const method of ['GET', 'HEAD']) {
        const { response, api } = await sentDuring(() => worker.request(`https://files.gg${path}?next=%2Fapp%2Ffiles&x=1`, { method, headers: browser }));
        assert.equal(response.status, 308, `${method} ${path}`);
        assert.equal(response.headers.location, `${location}?next=%2Fapp%2Ffiles&x=1`, path);
        assert.deepEqual(api, [], path);
      }
      const bare = await worker.request('https://files.gg' + path, { headers: browser });
      assert.equal(bare.headers.location, location, path);
    }
  });

  it('only for GET and HEAD', async () => {
    const response = await worker.request('https://files.gg/login', { method: 'POST', headers: browser });
    assert.equal(response.status, 405);
  });

  it('serves the auth pages themselves from the dashboard', async () => {
    for (const path of ['/app/login', '/app/register', '/app/verify', '/app/forgot', '/app/reset', '/app/auth/discord']) {
      const response = await worker.request(`https://files.gg${path}?next=/app`, { headers: browser });
      assert.equal(response.status, 200, path);
      assert.match(response.text, /<title>Dashboard · files\.gg<\/title>/, path);
      // the strict app policy (PLAN.md hardening): scripts only from files.gg and Turnstile, never framed
      const csp = response.headers['content-security-policy'];
      assert.match(csp, /(^|; )script-src 'self' 'wasm-unsafe-eval' https:\/\/challenges\.cloudflare\.com(;|$)/, path);
      assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/, path);
      assert.match(csp, /(^|; )object-src 'none'(;|$)/, path);
      assert.match(csp, /img-src [^;]*https:\/\/cdn\.discordapp\.com/, path);
    }
  });
});


describe('reserved vanity segments (§6.3)', () => {
  it('are missing on files.gg without a lookup', async () => {
    for (const path of ['/files/img1.png', '/previews/thumb/mvid.webp', '/albums/collage/albmedia.webp', '/albums/download/alb1.zip', '/challenge.png', '/Login.png', '/x/register', '/SIGNUP']) {
      const { response, api } = await sentDuring(() => worker.request('https://files.gg' + path, { headers: browser }));
      assert.equal(response.status, 404, path);
      assert.match(response.text, /data-page="file" data-state="missing"/, path);
      assert.deepEqual(api, [], path);
    }
  });
});


describe('files.gg/challenge, the Turnstile frame for custom domains (§10.10)', () => {
  const challenge = (query, options = {}) => worker.request(`https://files.gg/challenge?${query}`, { headers: browser, ...options });

  it('renders challenge.html for a serving domain, framable by that origin only', async () => {
    for (const action of ['unlock', 'report', 'view']) {
      const response = await challenge(`host=i.example.com&action=${action}`, { headers: { ...browser, cookie: COOKIE } });
      assert.equal(response.status, 200, action);
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(response.headers['content-security-policy'], CHALLENGE_CSP('https://i.example.com'));
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-frame-options'], undefined);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(setCookies(response), []);
      assert.match(response.text, new RegExp(`<body><script id="challenge-data" type="application/json">\\{"host":"i\\.example\\.com","action":"${action}"\\}</script>`));
      assert.match(response.text, /<div id="challenge"><\/div>/);
    }
  });

  it('answers HEAD without a body', async () => {
    const response = await challenge('host=any.example.com&action=unlock', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.text, '');
    assert.equal(response.headers['content-security-policy'], CHALLENGE_CSP('https://any.example.com'));
  });

  it('is 404 for anything but a serving custom domain and a known action', async () => {
    for (const query of [
      '', 'host=i.example.com', 'action=unlock', 'host=i.example.com&action=login', 'host=I.EXAMPLE.COM&action=unlock',
      'host=unknown.example.com&action=unlock', 'host=pending.example.com&action=unlock', 'host=paused.example.com&action=report',
      'host=disabled.example.com&action=unlock', 'host=gone.example.com&action=unlock', 'host=nostr.example.com&action=unlock',
      'host=mismatch.example.com&action=unlock',
      'host=files.gg&action=unlock', 'host=cdn.files.gg&action=unlock', 'host=evil.files.gg&action=unlock',
      'host=i.example.com%20https://evil.example&action=unlock', 'host=i.example.com:444&action=unlock',
    ]) {
      const response = await challenge(query);
      assert.equal(response.status, 404, query);
      assert.equal(response.headers['cache-control'], 'no-store', query);
      assert.doesNotMatch(response.text, /challenge-data/, query);
    }
  });

  it('never looks up our own hosts', async () => {
    const { api } = await sentDuring(() => challenge('host=cdn.files.gg&action=unlock'));
    assert.deepEqual(api, []);
  });

  it('is only on MAIN_HOST itself', async () => {
    for (const base of ['https://www.files.gg', 'https://cdn.files.gg', 'https://i.example.com']) {
      const response = await worker.request(`${base}/challenge?host=i.example.com&action=unlock`, { headers: browser });
      assert.equal(response.status, 404, base);
      assert.doesNotMatch(response.text, /challenge-data/, base);
    }
  });

  it('is 503 while the API is down', async () => {
    upstream.failLookups.add('flaky.example.com');
    try {
      const response = await challenge('host=flaky.example.com&action=unlock');
      assert.equal(response.status, 503);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    } finally {
      upstream.failLookups.delete('flaky.example.com');
    }
  });
});


describe('fixtures', () => {
  it('carry the v6 lookup fields', () => {
    for (const table of [FILES, ALBUMS]) {
      for (const entry of Object.values(table)) {
        assert.ok('owner_user_id' in entry && 'served_on' in entry && 'owner_state' in entry);
      }
    }
  });
});
