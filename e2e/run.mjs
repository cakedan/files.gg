#!/usr/bin/env node
// End-to-end test of the local files.gg stack started by e2e/up.sh (e2e/README.md): the browser-facing
// hosts served by the Worker under wrangler dev, the API and jobs worker in Docker, MinIO for B2,
// and Cloudflare's real siteverify with the Turnstile testing keys (so it needs internet).
//
//   node e2e/run.mjs
//
// Plain fetch() against http://files.localhost, cdn.files.localhost and api.files.localhost (all
// loopback, no /etc/hosts edits). One step uses `docker compose exec postgres psql` to move a file's
// expiry into the past. The Worker caches internal lookups for 30 s (contract §2), so the steps that
// change an existing file's access poll until the change reaches the CDN.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(E2E_DIR, '..');
const LOCAL = join(E2E_DIR, '.local');
const PORT = process.env.E2E_PORT || '8787';
const MAIN = `http://files.localhost:${PORT}`;
const CDN = `http://cdn.files.localhost:${PORT}`;
const API = `http://api.files.localhost:${PORT}`;
const LOOKUP_TTL_MS = 30_000;

// Cloudflare's documented testing token, which the always-pass testing secret accepts (web/src/lib/config.ts).
const TURNSTILE_TOKEN = /TURNSTILE_TEST_TOKEN = '([^']+)'/.exec(readFileSync(join(ROOT, 'web/src/lib/config.ts'), 'utf8'))[1];
// What a browser sends for a page navigation (the bot routing looks at these).
const BROWSER = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
const DISCORDBOT = { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', accept: '*/*' };
const TELEGRAMBOT = { 'user-agent': 'TelegramBot (like TwitterBot)' };


// --- tiny test runner ------------------------------------------------------------------------

const results = [];
let current = null;

async function step(name, fn) {
  current = { name, checks: 0, notes: [] };
  const started = Date.now();
  try {
    await fn();
    results.push({ ...current, ok: true, ms: Date.now() - started });
    console.log(`  \u2714 ${name} (${current.checks} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push({ ...current, ok: false, error, ms: Date.now() - started });
    console.log(`  \u2716 ${name}\n      ${String(error && error.stack || error).split('\n').slice(0, 6).join('\n      ')}`);
  }
  for (const note of current.notes) {
    console.log(`      - ${note}`);
  }
}

function check(condition, message, detail) {
  current.checks++;
  if (!condition) {
    throw new Error(message + (detail === undefined ? '' : `\n      got: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 1500)));
  }
}
const equal = (actual, expected, message) => check(Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
  `${message}: expected ${JSON.stringify(expected)}`, actual);
const note = (text) => current.notes.push(text);


// --- helpers ------------------------------------------------------------------------------

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function request(url, { method = 'GET', headers = {}, body, json, redirect = 'manual' } = {}) {
  if (json !== undefined) {
    body = JSON.stringify(json);
    headers = { 'content-type': 'application/json', ...headers };
  }
  const response = await fetch(url, { method, headers, body, redirect });
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, headers: response.headers, buffer, text, data };
}

const api = (path, options) => request(API + path, options);
const page = (path, headers = BROWSER) => request(MAIN + path, { headers });

// Reads the viewer shell: #root attributes, the boot JSON (raw and parsed) and the meta block.
function parseShell(html) {
  const root = /<div id="root"([^>]*)><\/div>/.exec(html);
  if (!root) {
    throw new Error('no #root in the page:\n' + html.slice(0, 500));
  }
  const attributes = Object.fromEntries([...root[1].matchAll(/ (data-[a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const script = /<div id="root"[^>]*><\/div><script id="(file-data|album-data)" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const metaStart = html.indexOf('-->', html.indexOf('filesgg:meta:start')) + 3;
  return {
    page: attributes['data-page'],
    state: attributes['data-state'],
    raw: script ? script[2] : undefined,
    data: script ? JSON.parse(script[2]) : undefined,
    meta: html.slice(metaStart, html.indexOf('<!-- filesgg:meta:end')),
    scripts: (html.match(/<script\b/gi) || []).length,
  };
}

async function poll(what, fn, { timeoutMs = LOOKUP_TTL_MS + 15_000, intervalMs = 1000 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last.done) {
      return { ...last, waited: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last: ${JSON.stringify(last.state ?? last)}`);
}

function psql(sql) {
  return execFileSync('docker', [
    'compose', '-f', join(E2E_DIR, 'docker-compose.e2e.yml'), '--env-file', join(LOCAL, '.env'),
    'exec', '-T', 'postgres', 'psql', '-q', '-U', 'filesgg', '-d', 'filesgg', '-v', 'ON_ERROR_STOP=1', '-tAc', sql,
  ], { encoding: 'utf8' }).trim();
}

async function fingerprint() {
  const response = await api('/auth/fingerprint');
  equal(response.status, 200, 'GET /auth/fingerprint');
  return response.data.fingerprint;
}

// POST /files, multipart, the way the browser sends it.
async function uploadFile(headers, { bytes, filename, type = 'application/octet-stream', fields = {} }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, String(value));
  }
  return await api('/files', { method: 'POST', headers, body: form });
}

const vanityPath = (file) => '/' + file.vanity;
// A CDN URL without its query: no signature (and no ?v=), as a stranger would have it.
const plain = (url) => url.split('?')[0];
const isSigned = (url) => /[?&]expires=\d+&sig=[A-Za-z0-9_-]+$/.test(url);
// The same path with another URL's expires/sig: a signature must only work for its own path.
const withSignatureOf = (url, other) => plain(url) + '?' + new URL(other).searchParams.toString().split('&').filter((kv) => /^(expires|sig|album)=/.test(kv)).join('&');


// --- setup -----------------------------------------------------------------------------------

function readEnvFile(path) {
  return Object.fromEntries(readFileSync(path, 'utf8').split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

if (!existsSync(join(LOCAL, '.env')) || !existsSync(join(LOCAL, 'e2e-user.json'))) {
  console.error('e2e/run.mjs: the stack isn\'t up. Run e2e/up.sh first.');
  process.exit(2);
}
const LOCAL_ENV = readEnvFile(join(LOCAL, '.env'));
const E2E_USER = JSON.parse(readFileSync(join(LOCAL, 'e2e-user.json'), 'utf8'));
let OWNER = null; // { Authorization } of the signed-in e2e user, from a real login
const files = {};

console.log(`files.gg e2e against ${MAIN}, ${CDN} and ${API}\n`);

await step('0. the stack answers on the *.localhost hosts, and the e2e user can sign in', async () => {
  for (const host of ['files.localhost', 'cdn.files.localhost', 'api.files.localhost']) {
    const addresses = await lookup(host, { all: true });
    check(addresses.length && addresses.every((a) => a.address === '127.0.0.1' || a.address === '::1'),
      `${host} resolves to loopback`, addresses);
  }
  const health = await api('/health');
  equal(health.status, 200, 'API /health through the Worker');
  const home = await page('/');
  equal(home.status, 200, 'home page');
  equal(parseShell(home.text).page, 'home', 'home data-page');
  const csp = home.headers.get('content-security-policy');
  check(csp.includes(`connect-src 'self' ${CDN} ${API}`), 'viewer CSP allows the local CDN and API', csp);

  // The password up.sh printed works with the real login endpoint (Turnstile testing token).
  const login = await api('/auth/login', {
    method: 'POST',
    json: { email: E2E_USER.email, password: LOCAL_ENV.E2E_USER_PASSWORD, turnstile_token: TURNSTILE_TOKEN },
  });
  equal(login.status, 200, `POST /auth/login as ${E2E_USER.email}`);
  check(typeof login.data.token === 'string' && login.data.token.length > 10, 'login returns a token', login.data);
  OWNER = { Authorization: login.data.token };
  const me = await api('/users/@me', { headers: OWNER });
  equal(me.status, 200, 'GET /users/@me');
  equal(me.data.username, 'e2e', 'signed in as e2e');
});

await step('1. anonymous single upload (Turnstile testing token): CDN bytes and the escaped #file-data', async () => {
  const fp = await fingerprint();
  const bytes = randomBytes(256 * 1024 + 7);
  const headers = { 'X-Fingerprint': fp };

  const refused = await uploadFile(headers, { bytes, filename: 'anon.bin' });
  check(refused.status === 400 || refused.status === 403, 'an anonymous upload without a Turnstile token is refused', refused.text);

  const created = await uploadFile(headers, { bytes, filename: "e2e anon & friends'.bin", fields: { turnstile_token: TURNSTILE_TOKEN } });
  equal(created.status, 200, 'POST /files (anonymous)');
  const file = files.anon = created.data;
  equal(file.visibility, 'link', 'visibility');
  check(Number.isInteger(file.expires_at) && file.expires_at > Date.now() / 1000, 'anonymous uploads expire (21 days by default)', file.expires_at);
  check(file.url.startsWith(`${MAIN}/${file.vanity}`), 'url uses PUBLIC_URL', file.url);
  check(file.cdn_url.startsWith(`${CDN}/files/${file.vanity}`) && !file.cdn_url.includes('?'), 'cdn_url uses CDN_URL and a link file is unsigned', file.cdn_url);

  const blob = await request(file.cdn_url);
  equal(blob.status, 200, 'GET the CDN URL');
  equal(sha256(blob.buffer), sha256(bytes), 'CDN bytes (sha256)');
  check(/^sandbox;/.test(blob.headers.get('content-security-policy')), 'CDN response is sandboxed', blob.headers.get('content-security-policy'));
  equal(blob.headers.get('x-content-type-options'), 'nosniff', 'CDN nosniff');
  equal(blob.headers.get('cache-control'), 'public, max-age=3600', 'public CDN cache-control');

  const shell = await page(vanityPath(file));
  equal(shell.status, 200, 'files.localhost/<vanity>');
  equal(shell.headers.get('content-type'), 'text/html; charset=utf-8', 'shell content-type');
  const parsed = parseShell(shell.text);
  equal([parsed.page, parsed.state], ['file', 'file'], 'data-page / data-state');
  equal(parsed.data.vanity, file.vanity, '#file-data vanity');
  equal(parsed.data.id, file.id, '#file-data id');
  equal(parsed.data.filename, file.filename, '#file-data filename');
  equal(parsed.data.cdn_url, file.cdn_url, '#file-data cdn_url');
  equal(parsed.data.url, file.url, '#file-data url');
  check(!/[<>&]/.test(parsed.raw), 'the inlined JSON has no raw <, > or &', parsed.raw);
  check(parsed.raw.includes("e2e anon \\u0026 friends'.bin"), 'and escapes & as \\u0026', parsed.raw);
  check(parsed.meta.includes(`<meta property="og:url" content="${file.url}">`), 'og:url is the local page URL', parsed.meta);
});

await step('2. signed-in chunked upload, ~30 MB, chunks in parallel and out of order', async () => {
  const size = 30 * 1024 * 1024 + 12_345;
  const bytes = randomBytes(size);
  const created = await api('/uploads', { method: 'POST', headers: OWNER, json: { filename: 'e2e-chunked.bin', size } });
  equal(created.status, 201, 'POST /uploads');
  const { upload_id: id, chunk_size: chunkSize, chunk_count: count } = created.data;
  equal(chunkSize, 10 * 1024 * 1024, 'chunk_size');
  equal(count, Math.ceil(size / chunkSize), 'chunk_count');

  const order = [...Array(count).keys()].reverse();
  [order[0], order[1]] = [order[1], order[0]];
  note(`chunks sent concurrently in the order ${order.join(', ')}`);
  const puts = await Promise.all(order.map((index) => api(`/uploads/${id}/chunks/${index}`, {
    method: 'PUT',
    headers: { ...OWNER, 'content-type': 'application/octet-stream' },
    body: bytes.subarray(index * chunkSize, Math.min(size, (index + 1) * chunkSize)),
  })));
  equal(puts.map((r) => r.status), order.map(() => 204), 'every PUT chunk');

  const status = await api(`/uploads/${id}`, { headers: OWNER });
  equal(status.data.status, 'open', 'status before complete');
  equal([...status.data.received].sort((a, b) => a - b), [...Array(count).keys()], 'received');

  const complete = await api(`/uploads/${id}/complete`, { method: 'POST', headers: OWNER });
  equal(complete.status, 202, 'POST complete');
  const done = await poll('the upload to finish', async () => {
    const response = await api(`/uploads/${id}`, { headers: OWNER });
    return { done: ['complete', 'failed'].includes(response.data.status), state: response.data };
  }, { timeoutMs: 120_000, intervalMs: 500 });
  equal(done.state.status, 'complete', 'final status');
  note(`processed in ${(done.waited / 1000).toFixed(1)}s`);
  const file = files.chunked = done.state.file;
  equal(file.size, size, 'file size');

  const blob = await request(file.cdn_url);
  equal(blob.status, 200, 'GET the CDN URL');
  equal(blob.buffer.length, size, 'CDN length');
  equal(sha256(blob.buffer), sha256(bytes), 'CDN bytes (sha256)');

  const ranged = await request(file.cdn_url, { headers: { range: `bytes=${chunkSize - 5}-${chunkSize + 4}` } });
  equal(ranged.status, 206, 'Range request');
  equal(ranged.buffer.toString('hex'), bytes.subarray(chunkSize - 5, chunkSize + 5).toString('hex'), 'Range bytes across a chunk boundary');
});

await step('3. an HTML filename can\'t break out of the shell', async () => {
  const hostile = '</script><script>alert(1)</script>.png';
  const bytes = randomBytes(1024);
  const created = await uploadFile(OWNER, { bytes, filename: hostile, type: 'image/png' });
  equal(created.status, 200, 'POST /files');
  const file = files.hostile = created.data;
  // The API has always replaced \\ / ? % * : | " < > in names with _ (utils/uploading.py) ...
  equal(file.filename, '__script__script_alert(1)__script_.png', 'the API neutralises <, > and / on upload');
  // ... so put the raw name in the database (as an older row could have it) before the Worker
  // first looks the file up, to check the shell's own escaping end to end.
  const stored = psql(`UPDATE files SET filename = '</script><script>alert(1)</script>' WHERE id = ${BigInt(file.id)} RETURNING filename`);
  equal(stored, '</script><script>alert(1)</script>', 'raw name stored (psql)');

  const baseline = parseShell((await page('/')).text).scripts;
  const shell = await page(vanityPath(file));
  equal(shell.status, 200, 'the shell renders');
  const parsed = parseShell(shell.text);
  equal([parsed.page, parsed.state], ['file', 'file'], 'data-page / data-state');
  equal(parsed.data.filename, hostile, '#file-data round-trips the filename');
  check(parsed.raw.includes('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e.png'),
    'the boot JSON escapes < and > as \\u003c / \\u003e', parsed.raw);
  check(!shell.text.includes('<script>alert(1)'), 'no live <script>alert(1) anywhere in the page');
  equal(parsed.scripts, baseline + 1, 'exactly one extra <script> (#file-data) compared with the home page');
  check(parsed.meta.includes('content="&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;.png"'), 'meta tags escape the filename', parsed.meta);

  const blob = await request(file.cdn_url);
  equal(blob.status, 200, 'CDN serves it');
  const disposition = blob.headers.get('content-disposition');
  check(disposition.startsWith('inline; filename="') && disposition.endsWith(`filename*=UTF-8''%3C%2Fscript%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E.png`),
    'CDN Content-Disposition quotes and percent-encodes the name', disposition);
});

await step('4. password: locked shell, 401 CDN, unlock gives signed URLs, /view, wrong password, password change revokes', async () => {
  const bytes = randomBytes(64 * 1024);
  const created = await uploadFile(OWNER, { bytes, filename: 'e2e-secret.png', type: 'image/png' });
  equal(created.status, 200, 'POST /files');
  const file = files.password = created.data;
  const vanity = file.vanity;

  // PATCH before the Worker ever looks the file up, so its 30 s lookup cache can't serve the old state.
  const patched = await api(`/users/@me/files/${file.id}`, { method: 'PATCH', headers: OWNER, json: { visibility: 'password', password: 'correct-horse-1' } });
  equal(patched.status, 200, 'PATCH visibility: password');
  equal(patched.data.visibility, 'password', 'visibility');
  const version = patched.data.access_version;

  const shell = await page('/' + vanity);
  equal(shell.status, 200, 'the locked shell is 200');
  const parsed = parseShell(shell.text);
  equal([parsed.page, parsed.state], ['file', 'locked'], 'data-page / data-state');
  equal(parsed.data, { vanity, protected: 'password' }, '#file-data (no filename: show_name_when_locked is off)');
  check(!/og:image|og:video|og:audio|twitter:image|twitter:player/.test(parsed.meta), 'no media in the meta tags', parsed.meta);
  check(parsed.meta.includes('<meta property="og:title" content="Password-protected file · files.gg">'), 'generic og:title', parsed.meta);
  check(!shell.text.includes('e2e-secret') && !shell.text.includes(plain(file.cdn_url)), 'neither the name nor the CDN URL leaks');

  const noToken = await request(plain(file.cdn_url));
  equal(noToken.status, 401, 'CDN without a signature');
  equal(noToken.headers.get('cache-control'), 'private, no-store', 'protected CDN errors are not cached');

  const unlock = (password, token = TURNSTILE_TOKEN) => api(`/files/${vanity}/unlock`, { method: 'POST', json: { password, turnstile_token: token } });
  const noCaptcha = await unlock('correct-horse-1', '');
  equal([noCaptcha.status, noCaptcha.data.code], [403, 'CAPTCHA_INVALID'], 'unlock without a Turnstile token');
  const wrong = await unlock('wrong-password');
  equal([wrong.status, wrong.data.code], [401, 'WRONG_PASSWORD'], 'unlock with the wrong password');
  const unlocked = await unlock('correct-horse-1');
  equal(unlocked.status, 200, 'unlock');
  const token = unlocked.data.token;
  check(typeof token === 'string' && unlocked.data.expires_at > Date.now() / 1000, 'a token with a future expiry', unlocked.data);
  equal(unlocked.data.file.vanity, vanity, 'unlock returns the payload');
  const signedUrl = unlocked.data.file.cdn_url;
  check(isSigned(signedUrl) && !signedUrl.includes(token), 'unlock returns a signed cdn_url, and the API token never appears in it', signedUrl);
  equal(Number(new URL(signedUrl).searchParams.get('expires')), unlocked.data.expires_at, 'the URL expires with the unlock');
  equal((await request(`${plain(signedUrl)}?t=${encodeURIComponent(token)}`)).status, 401, '?t= no longer opens anything');

  const withToken = await request(signedUrl);
  equal(withToken.status, 200, 'CDN with the signed URL');
  equal(sha256(withToken.buffer), sha256(bytes), 'CDN bytes (sha256)');
  equal(withToken.headers.get('cache-control'), 'private, no-store', 'protected bytes are private');
  equal((await request(signedUrl + '&download=true')).status, 200, '?download=true works with the same signature');

  const view = await api(`/files/${vanity}/view`, { headers: { 'X-Filesgg-Access': token } });
  equal(view.status, 200, 'GET /files/<vanity>/view with X-Filesgg-Access');
  equal(view.data.file.id, file.id, '/view payload');
  check(isSigned(view.data.file.cdn_url), '/view returns signed URLs', view.data.file.cdn_url);
  const refreshed = await api(`/files/${vanity}/unlock/refresh`, { method: 'POST', json: { token } });
  equal(refreshed.status, 200, 'unlock/refresh');
  check(isSigned(refreshed.data.file.cdn_url), 'refresh returns fresh signed URLs', refreshed.data);

  // Changing the password bumps access_version, which revokes every token.
  const changed = await api(`/users/@me/files/${file.id}`, { method: 'PATCH', headers: OWNER, json: { password: 'another-pass-2' } });
  equal(changed.status, 200, 'PATCH a new password');
  equal(changed.data.access_version, version + 1, 'access_version is bumped');
  const oldView = await api(`/files/${vanity}/view`, { headers: { 'X-Filesgg-Access': token } });
  equal([oldView.status, oldView.data.code], [401, 'UNLOCK_EXPIRED'], 'the API refuses the old token at once');
  const revoked = await poll('the CDN to refuse the old signed URL', async () => {
    const response = await request(signedUrl, { method: 'HEAD' });
    return { done: response.status === 401, state: response.status };
  });
  equal(revoked.state, 401, 'CDN with the old signed URL');
  note(`the CDN refused the old signed URL after ${(revoked.waited / 1000).toFixed(1)}s (Worker lookup cache: 30 s)`);
  equal((await unlock('correct-horse-1')).data.code, 'WRONG_PASSWORD', 'the old password no longer unlocks');
  const again = await unlock('another-pass-2');
  equal(again.status, 200, 'the new password unlocks');
  equal((await request(again.data.file.cdn_url)).status, 200, 'CDN with the new signed URL');
});

await step('5. private: missing shell, CDN 404, the owner gets signed URLs, owner pass for /view', async () => {
  const bytes = randomBytes(32 * 1024);
  const created = await uploadFile(OWNER, { bytes, filename: 'e2e-private.png', type: 'image/png', fields: { visibility: 'private' } });
  equal(created.status, 200, 'POST /files visibility=private');
  const file = files.private = created.data;
  equal(file.visibility, 'private', 'visibility');

  const shell = await page(vanityPath(file));
  equal(shell.status, 404, 'the shell is 404');
  const parsed = parseShell(shell.text);
  equal([parsed.page, parsed.state], ['file', 'missing'], 'data-page / data-state');
  equal(parsed.data, null, '#file-data is null');
  check(!shell.text.includes('e2e-private'), 'nothing about the file leaks');
  for (const [name, headers] of Object.entries({ Discordbot: DISCORDBOT, TelegramBot: TELEGRAMBOT })) {
    const bot = await page(vanityPath(file), headers);
    equal([bot.status, bot.headers.get('location')], [404, null], `${name} gets the missing page, no redirect`);
  }

  const noToken = await request(plain(file.cdn_url));
  equal(noToken.status, 404, 'CDN without a signature');
  const anonymousView = await api(`/files/${file.vanity}/view`);
  equal([anonymousView.status, anonymousView.data.code], [404, 'UNKNOWN_FILE'], '/view without a token');

  const pass = await api(`/users/@me/files/${file.id}/pass`, { method: 'POST', headers: OWNER });
  equal(pass.status, 200, 'POST /users/@me/files/<id>/pass');
  equal(pass.data.url, `${MAIN}/${file.vanity}#t=${pass.data.token}`, 'the owner-pass url uses PUBLIC_URL');
  equal((await request(`${plain(file.cdn_url)}?t=${encodeURIComponent(pass.data.token)}`)).status, 404, 'an owner pass in ?t= opens nothing on the CDN');
  check(isSigned(file.cdn_url), 'the upload response gives the owner a signed cdn_url', file.cdn_url);
  const withPass = await request(file.cdn_url);
  equal(withPass.status, 200, 'CDN with the owner\'s signed URL');
  equal(sha256(withPass.buffer), sha256(bytes), 'CDN bytes (sha256)');
  const view = await api(`/files/${file.vanity}/view`, { headers: { 'X-Filesgg-Access': pass.data.token } });
  equal(view.status, 200, '/view with the owner pass');
  check(isSigned(view.data.file.cdn_url), '/view with an owner pass returns signed URLs', view.data.file.cdn_url);
});

await step('6. expiry: a file whose expires_at is in the past is missing everywhere', async () => {
  const bytes = randomBytes(16 * 1024);
  const created = await uploadFile(OWNER, { bytes, filename: 'e2e-expiring.png', type: 'image/png', fields: { expires_in: 3600 } });
  equal(created.status, 200, 'POST /files expires_in=3600');
  const file = files.expiring = created.data;
  equal((await request(file.cdn_url)).status, 200, 'CDN before expiry');
  equal((await page(vanityPath(file))).status, 200, 'shell before expiry');

  // The API's minimum expires_in is 1 h, so move it into the past in the database.
  const updated = psql(`UPDATE files SET expires_at = now() - interval '1 minute' WHERE id = ${BigInt(file.id)} RETURNING id`);
  equal(updated, file.id, 'expires_at set in the past (psql)');

  const apiFile = await api(`/files/${file.vanity}`);
  equal(apiFile.status, 404, 'API GET /files/<vanity>');
  const apiView = await api(`/files/${file.vanity}/view`);
  equal(apiView.status, 404, 'API /files/<vanity>/view');
  const mine = await api(`/users/@me/files/${file.id}`, { method: 'PATCH', headers: OWNER, json: { show_name_when_locked: true } });
  equal(mine.status, 404, 'the owner can no longer change it either');

  const gone = await poll('the Worker to see the expiry', async () => {
    const shell = await page(vanityPath(file));
    const blob = await request(file.cdn_url, { method: 'HEAD' });
    return { done: shell.status === 404 && blob.status === 404, state: { shell: shell.status, cdn: blob.status, html: shell.text } };
  });
  const parsed = parseShell(gone.state.html);
  equal([parsed.page, parsed.state, parsed.data], ['file', 'missing', null], 'the shell is missing');
  note(`the Worker showed it as missing after ${(gone.waited / 1000).toFixed(1)}s (Worker lookup cache: 30 s)`);
});

await step('7. bots: link files go to the CDN (or get the embed page), password files never do', async () => {
  const link = files.anon;
  // Redirecting bots (ShareX, Telegram, no Accept-Language, Accept: <type>/*): 302 straight to the bytes.
  const telegram = await page(vanityPath(link), TELEGRAMBOT);
  equal([telegram.status, telegram.headers.get('location')], [302, link.cdn_url], 'TelegramBot on a link file: 302 to the CDN');
  // Discordbot (and every other *bot) gets the embed page, whose og:* tags point at the CDN; that's
  // the old Worker's behaviour, kept by the contract (only Telegram among bots is redirected).
  const discord = await page(vanityPath(link), DISCORDBOT);
  equal(discord.status, 200, 'Discordbot on a link file: the embed page');
  const discordShell = parseShell(discord.text);
  equal(discordShell.state, 'file', 'Discordbot sees the file');
  check(discordShell.meta.includes(`<meta property="og:url" content="${link.url}">`), 'with its og:* tags', discordShell.meta);
  const image = files.hostile;
  const discordImage = parseShell((await page(vanityPath(image), DISCORDBOT)).text);
  check(discordImage.meta.includes(`<meta property="og:image" content="${image.cdn_url}">`), 'an image\'s og:image is its CDN URL', discordImage.meta);

  const locked = files.password;
  for (const [name, headers] of Object.entries({ Discordbot: DISCORDBOT, TelegramBot: TELEGRAMBOT, 'Accept: image/*': { ...BROWSER, accept: 'image/*' } })) {
    const response = await page(vanityPath(locked), headers);
    equal([response.status, response.headers.get('location')], [200, null], `${name} on a password file: no redirect`);
    const parsed = parseShell(response.text);
    equal(parsed.state, 'locked', `${name} gets the locked shell`);
    check(!/og:image|og:video|twitter:image/.test(parsed.meta) && !response.text.includes(plain(locked.cdn_url)), `${name}: no media, no CDN URL`, parsed.meta);
  }
});

await step('8. limits: anonymous and signed-in values', async () => {
  const anonymous = await api('/users/@me/limits', { headers: { 'X-Fingerprint': await fingerprint() } });
  equal(anonymous.status, 200, 'GET /users/@me/limits (anonymous)');
  const { storage: anonymousStorage, daily, ...anonymousRest } = anonymous.data;
  equal(anonymousRest, {
    max_file_size_single: 25 * 1024 * 1024,
    max_file_size_chunked: 25 * 1024 * 1024,
    max_expiry: 21 * 24 * 3600,
    allow_no_expiry: false,
    anonymous: true,
    album_max_files: 50,
    albums_max: null,
  }, 'anonymous limits');
  equal(anonymousStorage.limit, null, 'anonymous storage.limit');
  // Anonymous usage is counted per fingerprint and per IP; step 1 uploaded from this IP.
  check(anonymousStorage.used >= files.anon.size, 'anonymous storage.used includes step 1 (same IP)', anonymousStorage);
  if (daily) {
    note(`anonymous callers also get daily: ${JSON.stringify(daily)} (not in contract §6)`);
  }

  const signedIn = await api('/users/@me/limits', { headers: OWNER });
  equal(signedIn.status, 200, 'GET /users/@me/limits (signed in)');
  const { storage, ...rest } = signedIn.data;
  equal(rest, {
    max_file_size_single: 100 * 1024 * 1024,
    max_file_size_chunked: 1024 * 1024 * 1024,
    max_expiry: null,
    allow_no_expiry: true,
    anonymous: false,
    album_max_files: 500,
    albums_max: 1000,
  }, 'signed-in limits');
  equal(storage.limit, 10 * 1024 * 1024 * 1024, 'storage.limit (10 GB)');
  check(storage.used >= files.chunked.size, 'storage.used counts the uploads', storage);
});


// --- Milestone 3: media, albums, library -------------------------------------------------------

// Real media, made by ffmpeg inside the jobs worker container (the host may not have ffmpeg).
function ffmpeg(args) {
  return execFileSync('docker', [
    'compose', '-f', join(E2E_DIR, 'docker-compose.e2e.yml'), '--env-file', join(LOCAL, '.env'),
    'exec', '-T', 'worker', 'ffmpeg', '-v', 'error', '-nostdin', ...args, 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 });
}
const PREVIEW_URL = /^http:\/\/cdn\.files\.localhost:\d+\/previews\/(thumb|thumb-2x|display|poster|cover|waveform|peaks|hover)\/[a-z0-9/]+\.(webp|mp4|json)\?v=\d+$/;
const ownerFile = async (id) => {
  const list = await api('/users/@me/files?limit=100', { headers: OWNER });
  return list.data.items.find((item) => item.id === id);
};
async function waitProcessed(file) {
  const done = await poll(`${file.filename} to be processed`, async () => {
    const item = await ownerFile(file.id);
    return { done: item && item.processing === false, state: item && { processing: item.processing, assets: Object.keys(item.assets || {}) }, item };
  }, { timeoutMs: 120_000 });
  note(`${file.filename}: processed in ${(done.waited / 1000).toFixed(1)}s, assets: ${Object.keys(done.item.assets || {}).join(', ') || 'none'}`);
  return done.item;
}
const media = {};

await step('9. media: probe and derive (image, video, audio), previews at /previews/<kind>/<vanity>', async () => {
  const png = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=800x600', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png']);
  const mp4 = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']);
  const mp3 = ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3']);
  for (const [key, bytes, filename, type] of [['png', png, 'e2e-image.png', 'image/png'], ['mp4', mp4, 'e2e-video.mp4', 'video/mp4'], ['mp3', mp3, 'e2e-audio.mp3', 'audio/mpeg']]) {
    const created = await uploadFile(OWNER, { bytes, filename, type });
    equal(created.status, 200, `upload ${filename}`);
    media[key] = { ...created.data, bytes };
  }

  const image = media.png.processed = await waitProcessed(media.png);
  equal([image.kind, image.width, image.height], ['image', 800, 600], 'image kind and probed size');
  check(image.assets.thumb && image.assets['thumb-2x'], 'image thumbs', image.assets);
  equal(image.thumbnail.type, 'thumb', 'image thumbnail type');
  for (const [kind, asset] of Object.entries(image.assets)) {
    check(PREVIEW_URL.test(asset.url) && asset.url.includes(`/previews/${kind}/${media.png.vanity}.webp?v=`), `${kind}: /previews/<kind>/<vanity>, unsigned for a link file`, asset.url);
  }
  const thumb = await request(image.assets.thumb.url);
  equal(thumb.status, 200, 'GET thumb.webp');
  equal(thumb.headers.get('content-type'), 'image/webp', 'thumb content type');
  equal(thumb.buffer.subarray(8, 12).toString('latin1'), 'WEBP', 'thumb is a real webp');
  equal(thumb.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'link previews are immutable');
  equal(thumb.headers.get('x-content-type-options'), 'nosniff', 'nosniff on previews');

  const video = media.mp4.processed = await waitProcessed(media.mp4);
  equal([video.kind, video.media.playable, video.media.has_audio], ['video', true, true], 'video kind, playable, has_audio');
  check(Math.abs(video.duration - 2000) < 300, 'video duration ~2 s (ms)', video.duration);
  check(video.assets.poster && video.assets.hover && video.hover_url === video.assets.hover.url, 'poster and hover clip', video.assets);
  equal(video.thumbnail.type, 'poster', 'video thumbnail is the poster');
  const clip = await request(video.hover_url, { headers: { range: 'bytes=0-99' } });
  equal([clip.status, clip.headers.get('content-type'), clip.buffer.length], [206, 'video/mp4', 100], 'hover.mp4 serves ranges');

  const audio = media.mp3.processed = await waitProcessed(media.mp3);
  equal(audio.kind, 'audio', 'audio kind');
  check(Math.abs(audio.duration - 3000) < 300, 'audio duration ~3 s (ms)', audio.duration);
  check(audio.assets.waveform && audio.assets.peaks && !audio.assets.cover, 'no embedded art: waveform and peaks', audio.assets);
  equal(audio.thumbnail.type, 'waveform', 'audio thumbnail is the waveform');
  const peaks = await request(audio.assets.peaks.url);
  equal([peaks.status, peaks.data.version, peaks.data.length, peaks.data.peaks.length], [200, 1, 1000, 1000], 'peaks.json');

  const vanity = media.png.vanity;
  const base = image.assets.thumb.url.slice(0, image.assets.thumb.url.indexOf('/previews/'));
  for (const [path, why] of [
    [`/previews/evil/${vanity}.webp`, 'a kind outside the set'],
    [`/previews/thumb/${vanity}.png`, 'the wrong extension for the kind'],
    [`/previews/thumb/${vanity}`, 'no extension'],
    ['/previews/thumb/zzzzzzzzzzzz.webp', 'an unknown vanity'],
    [`/previews/poster/${media.mp3.vanity}.webp`, 'a preview the file doesn\'t have'],
    [`/media/${media.png.id}/thumb.webp`, 'the old /media/<id>/ path'],
  ]) {
    equal((await request(base + path)).status, 404, `404 for ${why}`);
  }

  const shell = parseShell((await page('/' + media.mp4.vanity)).text);
  equal(shell.data.assets.poster.url, video.assets.poster.url, '#file-data carries the assets');
  check(shell.meta.includes(`<meta property="og:image" content="${video.assets.poster.url.replace(/&/g, '&amp;')}">`), 'og:image is the poster', shell.meta);
  check(shell.meta.includes('og:video'), 'og:video for a playable video', shell.meta);
});

await step('10. protected previews: signed per path, and a signature can\'t be reused', async () => {
  const png = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=500x500', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png']);
  const created = await uploadFile(OWNER, { bytes: png, filename: 'e2e-locked.png', type: 'image/png', fields: { visibility: 'password', password: 'preview-pass-1' } });
  equal([created.status, created.data.visibility], [200, 'password'], 'password upload');
  const file = media.locked = created.data;
  const processed = await waitProcessed(file);
  const ownerUrl = processed.assets.thumb.url;
  check(isSigned(ownerUrl), 'the owner list gives signed preview URLs', ownerUrl);
  equal((await request(ownerUrl)).status, 200, 'the owner\'s signed thumb');
  const bare = await request(plain(ownerUrl));
  equal([bare.status, bare.headers.get('cache-control')], [401, 'private, no-store'], 'thumb without a signature');
  const unlocked = await api(`/files/${file.vanity}/unlock`, { method: 'POST', json: { password: 'preview-pass-1', turnstile_token: TURNSTILE_TOKEN } });
  equal(unlocked.status, 200, 'unlock');
  const url = unlocked.data.file.assets.thumb.url;
  check(isSigned(url), 'unlock signs preview URLs too', url);
  const signed = await request(url);
  equal([signed.status, signed.headers.get('cache-control')], [200, 'private, no-store'], 'signed thumb is private');
  equal((await request(withSignatureOf(unlocked.data.file.assets['thumb-2x'].url, url))).status, 401, 'a signature only works for its own path (thumb\'s on thumb-2x)');
  equal((await request(withSignatureOf(url, unlocked.data.file.cdn_url))).status, 401, '...and the file\'s signature doesn\'t open its preview');
  const other = await api(`/files/${files.password.vanity}/unlock`, { method: 'POST', json: { password: 'another-pass-2', turnstile_token: TURNSTILE_TOKEN } });
  equal((await request(withSignatureOf(url, other.data.file.cdn_url))).status, 401, 'another file\'s signature is refused');
});

await step('11. albums: create, page, collage, ZIP, link albums hide protected items, album passwords', async () => {
  const ids = [media.png.id, media.mp4.id, media.mp3.id, media.locked.id];
  const created = await api('/users/@me/albums', { method: 'POST', headers: OWNER, json: { title: 'e2e album', description: 'made by e2e/run.mjs', file_ids: ids } });
  equal(created.status, 201, 'POST /users/@me/albums');
  const album = media.album = created.data;
  equal(album.items.map((item) => item.id), ids, 'items in order');
  equal(album.items.map((item) => item.shown), [true, true, true, false], 'the password file is hidden in a link album');

  const shell = parseShell((await page('/a/' + album.vanity)).text);
  equal([shell.page, shell.state], ['album', 'album'], 'album shell');
  equal(shell.data.items.map((item) => item.id), ids.slice(0, 3), 'the page shows only the link items');
  check(shell.meta.includes('<meta property="og:title" content="e2e album · 3 files">'), 'album og:title', shell.meta);

  const withCollage = await poll('the album collage', async () => {
    const owner = await api(`/users/@me/albums/${album.id}`, { headers: OWNER });
    return { done: Boolean(owner.data.collage), state: owner.data.collage, album: owner.data };
  }, { timeoutMs: 60_000 });
  // The album page above was looked up before the collage existed; the Worker caches lookups 30 s.
  const collageServed = await poll('the Worker to serve the new collage', async () => {
    const response = await request(withCollage.album.collage.url);
    return { done: response.status === 200, state: [response.status, response.headers.get('content-type')], response };
  });
  const collage = collageServed.response;
  equal([collage.status, collage.headers.get('content-type')], [200, 'image/webp'], 'collage.webp');
  note(`the collage was served ${(collageServed.waited / 1000).toFixed(1)}s after it existed (Worker lookup cache: 30 s)`);
  check(withCollage.album.collage.url.includes(`/albums/collage/${album.vanity}.webp?v=`), 'collage at /albums/collage/<vanity>.webp', withCollage.album.collage.url);
  check(withCollage.album.download_url.endsWith(`/albums/download/${album.vanity}.zip`), 'ZIP at /albums/download/<vanity>.zip', withCollage.album.download_url);

  const zip = await request(withCollage.album.download_url);
  equal([zip.status, zip.headers.get('content-type')], [200, 'application/zip'], 'download.zip');
  equal(Number(zip.headers.get('content-length')), zip.buffer.length, 'exact Content-Length');
  check(/attachment/.test(zip.headers.get('content-disposition') || ''), 'ZIP is an attachment', zip.headers.get('content-disposition'));
  const zipPath = join(LOCAL, 'e2e-album.zip');
  writeFileSync(zipPath, zip.buffer);
  try {
    const tested = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
    check(/No errors detected/.test(tested), 'unzip -t: no errors (CRCs match)', tested);
    const names = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
    equal(names, ['e2e-image.png', 'e2e-video.mp4', 'e2e-audio.mp3'], 'ZIP entries: the shown items, in album order');
    equal(sha256(execFileSync('unzip', ['-p', zipPath, 'e2e-video.mp4'], { maxBuffer: 64 * 1024 * 1024 })), sha256(media.mp4.bytes), 'ZIP bytes match the upload');
  } finally {
    rmSync(zipPath, { force: true });
  }

  // A password album, set before anything looks it up: its token opens the password item too.
  const second = await api('/users/@me/albums', { method: 'POST', headers: OWNER, json: { title: 'e2e locked album', file_ids: [media.png.id, media.locked.id] } });
  equal(second.status, 201, 'second album');
  const locked = await api(`/users/@me/albums/${second.data.id}`, { method: 'PATCH', headers: OWNER, json: { visibility: 'password', password: 'album-pass-1' } });
  equal([locked.status, locked.data.visibility], [200, 'password'], 'PATCH album password');
  const lockedShell = parseShell((await page('/a/' + second.data.vanity)).text);
  equal([lockedShell.state, lockedShell.data], ['locked', { vanity: second.data.vanity, protected: 'password' }], 'locked album shell');
  equal((await request(plain(locked.data.download_url))).status, 401, 'ZIP without a signature');
  const unlocked = await api(`/albums/${second.data.vanity}/unlock`, { method: 'POST', json: { password: 'album-pass-1', turnstile_token: TURNSTILE_TOKEN } });
  equal(unlocked.status, 200, 'album unlock');
  equal(unlocked.data.album.items.length, 2, 'a protected album shows every item');
  const item = unlocked.data.album.items.find((entry) => entry.id === media.locked.id);
  check(isSigned(item.cdn_url) && item.cdn_url.includes(`album=${second.data.vanity}`), 'album items are signed through the album', item.cdn_url);
  // The Worker may still hold the file's lookup from step 10 (30 s), from before it joined this album.
  const throughAlbum = await poll('the album-signed URL to open the password file', async () => {
    const response = await request(item.cdn_url, { method: 'HEAD' });
    return { done: response.status === 200, state: response.status };
  });
  equal(throughAlbum.state, 200, 'the album\'s signed URL opens the password file');
  equal((await request(item.assets.thumb.url)).status, 200, '...and its preview');
  equal((await request(unlocked.data.album.download_url)).status, 200, 'ZIP with the album\'s signed URL');
});

await step('12. library: list, filters, keep forever, delete removes from albums', async () => {
  const videos = await api('/users/@me/files?type=video&limit=100', { headers: OWNER });
  equal(videos.status, 200, 'GET /users/@me/files?type=video');
  check(videos.data.items.every((item) => item.kind === 'video') && videos.data.items.some((item) => item.id === media.mp4.id), 'type filter', videos.data.items.map((item) => item.kind));
  check(videos.data.total.count >= videos.data.count, 'total covers all files', videos.data);
  const byName = await api('/users/@me/files?query=E2E-AUDIO', { headers: OWNER });
  equal(byName.data.items.map((item) => item.id), [media.mp3.id], 'case-insensitive search');

  const expiring = await api('/users/@me/files/expiry', { method: 'POST', headers: OWNER, json: { file_ids: [media.png.id], expires_in: 3600 } });
  check(expiring.status === 200 && expiring.data.items[0].expires_at > Date.now() / 1000, 'bulk expiry', expiring.data);
  const forever = await api('/users/@me/files/expiry', { method: 'POST', headers: OWNER, json: { file_ids: [media.png.id], expires_in: null } });
  equal(forever.data.items[0].expires_at, null, 'Keep forever');

  equal((await api(`/users/@me/files/${media.mp3.id}`, { method: 'DELETE', headers: OWNER })).status, 204, 'DELETE a file');
  const album = await api(`/users/@me/albums/${media.album.id}`, { headers: OWNER });
  check(!album.data.items.some((item) => item.id === media.mp3.id), 'the deleted file left the album', album.data.items.map((item) => item.id));
  const gone = await poll('the deleted file to leave the album page', async () => {
    const shell = parseShell((await page('/a/' + media.album.vanity)).text);
    return { done: shell.data && shell.data.items.length === 2, state: shell.data && shell.data.items.length };
  });
  equal(gone.state, 2, 'album page after the delete');
  const previewGone = await poll('the deleted file\'s preview to 404', async () => {
    const response = await request(media.mp3.processed.assets.peaks.url, { method: 'HEAD' });
    return { done: response.status === 404, state: response.status };
  });
  equal(previewGone.state, 404, 'a deleted file\'s previews are gone (after the lookup cache)');
});

await step('13. executables are refused: by name, disguised as an image, and in a chunked upload', async () => {
  // A minimal Windows PE header: "MZ", the PE offset at 0x3C, then "PE\0\0" there.
  const pe = Buffer.alloc(4096, 0xcc);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'latin1');
  const refused = (response, what) => equal([response.status, response.data && response.data.code], [400, 'FILE_TYPE_NOT_ALLOWED'], what);

  refused(await uploadFile(OWNER, { bytes: Buffer.from('not really a program'), filename: 'setup.exe', type: 'application/octet-stream' }), 'setup.exe sent as a generic binary');
  refused(await uploadFile(OWNER, { bytes: pe, filename: 'photo.png', type: 'image/png' }), 'a program renamed photo.png');
  refused(await uploadFile(OWNER, { bytes: Buffer.from('hello'), filename: 'photo.png', type: 'application/x-msdownload' }), 'declared as a Windows program');

  const session = await api('/uploads', { method: 'POST', headers: OWNER, json: { filename: 'tool.bin', size: pe.length } });
  equal(session.status, 201, 'a chunked upload with a harmless name starts');
  refused(await request(`${API}/uploads/${session.data.upload_id}/chunks/0`, { method: 'PUT', headers: OWNER, body: pe }), 'its first chunk is a program');
  const state = await api(`/uploads/${session.data.upload_id}`, { headers: OWNER });
  equal([state.data.status, state.data.error], ['failed', 'FILE_TYPE_NOT_ALLOWED'], 'and the session is failed');

  const ok = await uploadFile(OWNER, { bytes: Buffer.from('MZ was here.\n'), filename: 'mz.txt', type: 'text/plain' });
  equal(ok.status, 200, 'a text file that merely starts with "MZ" is fine');
});

const failed = results.filter((result) => !result.ok);
const checks = results.reduce((sum, result) => sum + result.checks, 0);
console.log(`\n${results.length - failed.length}/${results.length} steps passed, ${checks} checks` +
  (failed.length ? `; failed: ${failed.map((result) => result.name.split('.')[0]).join(', ')}` : ''));
process.exit(failed.length ? 1 : 0);
