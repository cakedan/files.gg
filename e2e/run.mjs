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
import { existsSync, readFileSync } from 'node:fs';
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
  check(file.urls.main.startsWith(`${MAIN}/${file.vanity}`), 'urls.main uses PUBLIC_URL', file.urls);
  check(file.urls.cdn.startsWith(`${CDN}/files/${file.vanity}`), 'urls.cdn uses CDN_URL', file.urls);

  const blob = await request(file.urls.cdn);
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
  equal(parsed.data.cdnUrl, file.urls.cdn, '#file-data cdnUrl');
  equal(parsed.data.url, file.urls.main, '#file-data url');
  check(!/[<>&]/.test(parsed.raw), 'the inlined JSON has no raw <, > or &', parsed.raw);
  check(parsed.raw.includes("e2e anon \\u0026 friends'.bin"), 'and escapes & as \\u0026', parsed.raw);
  check(parsed.meta.includes(`<meta property="og:url" content="${file.urls.main}">`), 'og:url is the local page URL', parsed.meta);
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

  const blob = await request(file.urls.cdn);
  equal(blob.status, 200, 'GET the CDN URL');
  equal(blob.buffer.length, size, 'CDN length');
  equal(sha256(blob.buffer), sha256(bytes), 'CDN bytes (sha256)');

  const ranged = await request(file.urls.cdn, { headers: { range: `bytes=${chunkSize - 5}-${chunkSize + 4}` } });
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

  const blob = await request(file.urls.cdn);
  equal(blob.status, 200, 'CDN serves it');
  const disposition = blob.headers.get('content-disposition');
  check(disposition.startsWith('inline; filename="') && disposition.endsWith(`filename*=UTF-8''%3C%2Fscript%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E.png`),
    'CDN Content-Disposition quotes and percent-encodes the name', disposition);
});

await step('4. password: locked shell, 401 CDN, unlock, ?t=, /view, wrong password, password change revokes', async () => {
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
  check(!shell.text.includes('e2e-secret') && !shell.text.includes(file.urls.cdn), 'neither the name nor the CDN URL leaks');

  const noToken = await request(file.urls.cdn);
  equal(noToken.status, 401, 'CDN without a token');
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
  check(!unlocked.data.file.cdnUrl.includes('?'), 'payload URLs carry no token', unlocked.data.file.cdnUrl);

  const withToken = await request(`${file.urls.cdn}?t=${encodeURIComponent(token)}`);
  equal(withToken.status, 200, 'CDN with ?t=');
  equal(sha256(withToken.buffer), sha256(bytes), 'CDN bytes (sha256)');
  equal(withToken.headers.get('cache-control'), 'private, no-store', 'protected bytes are private');

  const view = await api(`/files/${vanity}/view`, { headers: { 'X-Filesgg-Access': token } });
  equal(view.status, 200, 'GET /files/<vanity>/view with X-Filesgg-Access');
  equal(view.data.file.id, file.id, '/view payload');
  const refreshed = await api(`/files/${vanity}/unlock/refresh`, { method: 'POST', json: { token } });
  equal(refreshed.status, 200, 'unlock/refresh');

  // Changing the password bumps access_version, which revokes every token.
  const changed = await api(`/users/@me/files/${file.id}`, { method: 'PATCH', headers: OWNER, json: { password: 'another-pass-2' } });
  equal(changed.status, 200, 'PATCH a new password');
  equal(changed.data.access_version, version + 1, 'access_version is bumped');
  const oldView = await api(`/files/${vanity}/view`, { headers: { 'X-Filesgg-Access': token } });
  equal([oldView.status, oldView.data.code], [401, 'UNLOCK_EXPIRED'], 'the API refuses the old token at once');
  const revoked = await poll('the CDN to refuse the old token', async () => {
    const response = await request(`${file.urls.cdn}?t=${encodeURIComponent(token)}`, { method: 'HEAD' });
    return { done: response.status === 401, state: response.status };
  });
  equal(revoked.state, 401, 'CDN with the old token');
  note(`the CDN refused the old token after ${(revoked.waited / 1000).toFixed(1)}s (Worker lookup cache: 30 s)`);
  equal((await unlock('correct-horse-1')).data.code, 'WRONG_PASSWORD', 'the old password no longer unlocks');
  const again = await unlock('another-pass-2');
  equal(again.status, 200, 'the new password unlocks');
  equal((await request(`${file.urls.cdn}?t=${encodeURIComponent(again.data.token)}`)).status, 200, 'CDN with the new token');
});

await step('5. private: missing shell, CDN 404, owner pass via ?t=', async () => {
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

  const noToken = await request(file.urls.cdn);
  equal(noToken.status, 404, 'CDN without a token');
  const anonymousView = await api(`/files/${file.vanity}/view`);
  equal([anonymousView.status, anonymousView.data.code], [404, 'UNKNOWN_FILE'], '/view without a token');

  const pass = await api(`/users/@me/files/${file.id}/pass`, { method: 'POST', headers: OWNER });
  equal(pass.status, 200, 'POST /users/@me/files/<id>/pass');
  equal(pass.data.url, `${MAIN}/${file.vanity}#t=${pass.data.token}`, 'the owner-pass url uses PUBLIC_URL');
  const withPass = await request(`${file.urls.cdn}?t=${encodeURIComponent(pass.data.token)}`);
  equal(withPass.status, 200, 'CDN with the owner pass');
  equal(sha256(withPass.buffer), sha256(bytes), 'CDN bytes (sha256)');
  const view = await api(`/files/${file.vanity}/view`, { headers: { 'X-Filesgg-Access': pass.data.token } });
  equal(view.status, 200, '/view with the owner pass');
});

await step('6. expiry: a file whose expires_at is in the past is missing everywhere', async () => {
  const bytes = randomBytes(16 * 1024);
  const created = await uploadFile(OWNER, { bytes, filename: 'e2e-expiring.png', type: 'image/png', fields: { expires_in: 3600 } });
  equal(created.status, 200, 'POST /files expires_in=3600');
  const file = files.expiring = created.data;
  equal((await request(file.urls.cdn)).status, 200, 'CDN before expiry');
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
    const blob = await request(file.urls.cdn, { method: 'HEAD' });
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
  equal([telegram.status, telegram.headers.get('location')], [302, link.urls.cdn], 'TelegramBot on a link file: 302 to the CDN');
  // Discordbot (and every other *bot) gets the embed page, whose og:* tags point at the CDN; that's
  // the old Worker's behaviour, kept by the contract (only Telegram among bots is redirected).
  const discord = await page(vanityPath(link), DISCORDBOT);
  equal(discord.status, 200, 'Discordbot on a link file: the embed page');
  const discordShell = parseShell(discord.text);
  equal(discordShell.state, 'file', 'Discordbot sees the file');
  check(discordShell.meta.includes(`<meta property="og:url" content="${link.urls.main}">`), 'with its og:* tags', discordShell.meta);
  const image = files.hostile;
  const discordImage = parseShell((await page(vanityPath(image), DISCORDBOT)).text);
  check(discordImage.meta.includes(`<meta property="og:image" content="${image.urls.cdn}">`), 'an image\'s og:image is its CDN URL', discordImage.meta);

  const locked = files.password;
  for (const [name, headers] of Object.entries({ Discordbot: DISCORDBOT, TelegramBot: TELEGRAMBOT, 'Accept: image/*': { ...BROWSER, accept: 'image/*' } })) {
    const response = await page(vanityPath(locked), headers);
    equal([response.status, response.headers.get('location')], [200, null], `${name} on a password file: no redirect`);
    const parsed = parseShell(response.text);
    equal(parsed.state, 'locked', `${name} gets the locked shell`);
    check(!/og:image|og:video|twitter:image/.test(parsed.meta) && !response.text.includes(locked.urls.cdn), `${name}: no media, no CDN URL`, parsed.meta);
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
  }, 'signed-in limits');
  equal(storage.limit, 10 * 1024 * 1024 * 1024, 'storage.limit (10 GB)');
  check(storage.used >= files.chunked.size, 'storage.used counts the uploads', storage);
});


const failed = results.filter((result) => !result.ok);
const checks = results.reduce((sum, result) => sum + result.checks, 0);
console.log(`\n${results.length - failed.length}/${results.length} steps passed, ${checks} checks` +
  (failed.length ? `; failed: ${failed.map((result) => result.name.split('.')[0]).join(', ')}` : ''));
process.exit(failed.length ? 1 : 0);
