#!/usr/bin/env node
// End-to-end test of the local files.gg stack started by e2e/up.sh (e2e/README.md): the browser-facing
// hosts served by the Worker under wrangler dev, the API and jobs worker in Docker, MinIO for B2,
// and Cloudflare's real siteverify with the Turnstile testing keys (so it needs internet).
//
//   node e2e/run.mjs
//
// Plain fetch() against http://files.localhost, cdn.files.localhost and api.files.localhost (all
// loopback, no /etc/hosts edits). One step uses `docker compose exec postgres psql` to move a file's
// expiry into the past. The Worker caches internal lookups for 5 s (contract §2), so the steps that
// change an existing file's access poll until the change reaches the CDN.
//
// Milestone 4: every new upload stays `pending` until the scanner has checked it, so each step that
// expects a public page or CDN bytes first waits for its scan (waitScanned), and the scan times are
// printed at the end. Steps 14-19 cover gating, malware, archives, reports and moderation,
// security.txt and the admin API's 404 for non-staff (docs/redesign/contracts/milestone-4.md).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(E2E_DIR, '..');
const LOCAL = join(E2E_DIR, '.local');
const PORT = process.env.E2E_PORT || '8787';
const MAIN = `http://files.localhost:${PORT}`;
const CDN = `http://cdn.files.localhost:${PORT}`;
const API = `http://api.files.localhost:${PORT}`;
const LOOKUP_TTL_MS = 5_000;

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

// Milestone 4 §2: a new upload is `pending` until the scanner is done with it. Polls the owner's
// GET /users/@me/files/<id> until `safety.state` leaves `pending` (or the upload is rejected after
// the scan: 410 UPLOAD_REJECTED), and records how long that took.
const scanTimes = [];
async function waitScanned(file, headers, label = file.filename) {
  const done = await poll(`${label} to be scanned`, async () => {
    const response = await api(`/users/@me/files/${file.id}`, { headers });
    if (response.status === 410) {
      return { done: true, state: response.data, rejected: response.data };
    }
    if (response.status !== 200) {
      throw new Error(`GET /users/@me/files/${file.id} gave ${response.status}: ${response.text.slice(0, 300)}`);
    }
    return { done: response.data.safety.state !== 'pending', state: response.data.safety, item: response.data };
  }, { timeoutMs: 180_000, intervalMs: 200 });
  const outcome = done.rejected ? `rejected (${done.rejected.reason})` : done.item.safety.state;
  scanTimes.push({ label, ms: done.waited, outcome });
  note(`${label}: scanned in ${(done.waited / 1000).toFixed(1)}s (${outcome})`);
  return done.rejected ? { rejected: done.rejected } : done.item;
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
  equal(file.safety && file.safety.state, 'pending', 'the upload response has the owner safety (pending until scanned)');
  equal((await waitScanned(file, headers, 'step 1 anonymous upload')).safety.state, 'ok', 'scanned: ok');

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
  equal((await waitScanned(file, OWNER, 'step 2 chunked 30 MB')).safety.state, 'ok', 'scanned: ok');

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
  // A real PNG: since Milestone 4 a ".png" the scanner can't decode is served as an attachment only
  // (§2.3), and step 7 needs this to be an image.
  const bytes = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png']);
  const created = await uploadFile(OWNER, { bytes, filename: hostile, type: 'image/png' });
  equal(created.status, 200, 'POST /files');
  const file = files.hostile = created.data;
  // The API has always replaced \\ / ? % * : | " < > in names with _ (utils/uploading.py) ...
  equal(file.filename, '__script__script_alert(1)__script_.png', 'the API neutralises <, > and / on upload');
  // ... so put the raw name in the database (as an older row could have it) before the Worker
  // first looks the file up, to check the shell's own escaping end to end.
  const stored = psql(`UPDATE files SET filename = '</script><script>alert(1)</script>' WHERE id = ${BigInt(file.id)} RETURNING filename`);
  equal(stored, '</script><script>alert(1)</script>', 'raw name stored (psql)');
  equal((await waitScanned(file, OWNER, 'step 3 PNG')).safety.state, 'ok', 'scanned: ok');

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

  // PATCH before the Worker ever looks the file up, so its 5 s lookup cache can't serve the old state.
  const patched = await api(`/users/@me/files/${file.id}`, { method: 'PATCH', headers: OWNER, json: { visibility: 'password', password: 'correct-horse-1' } });
  equal(patched.status, 200, 'PATCH visibility: password');
  equal(patched.data.visibility, 'password', 'visibility');
  const version = patched.data.access_version;
  // A pending file shows the `pending` shell before `locked` (§10.1), so wait for the scan first.
  equal((await waitScanned(file, OWNER, 'step 4 password file')).safety.state, 'ok', 'scanned: ok');

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
  note(`the CDN refused the old signed URL after ${(revoked.waited / 1000).toFixed(1)}s (Worker lookup cache: 5 s)`);
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
  equal((await waitScanned(file, OWNER, 'step 5 private file')).safety.state, 'ok', 'scanned: ok');

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
  equal((await waitScanned(file, OWNER, 'step 6 expiring file')).safety.state, 'ok', 'scanned: ok');
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
  note(`the Worker showed it as missing after ${(gone.waited / 1000).toFixed(1)}s (Worker lookup cache: 5 s)`);
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
    nsfw_allowed: false, // milestone-4 §13
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
    nsfw_allowed: true, // milestone-4 §13: signed in and not restricted
  }, 'signed-in limits');
  equal(storage.limit, 10 * 1024 * 1024 * 1024, 'storage.limit (10 GB)');
  check(storage.used >= files.chunked.size, 'storage.used counts the uploads', storage);
});


// --- Milestone 3: media, albums, library -------------------------------------------------------

// Real media, made by ffmpeg inside the jobs worker container (the host may not have ffmpeg).
function ffmpeg(args, input) {
  return execFileSync('docker', [
    'compose', '-f', join(E2E_DIR, 'docker-compose.e2e.yml'), '--env-file', join(LOCAL, '.env'),
    'exec', '-T', 'worker', 'ffmpeg', '-v', 'error', ...(input ? [] : ['-nostdin']), ...args, 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024, input });
}
// A PNG of random pixels: new content (a new hash, so a new scan) on every run.
const noisePng = (width, height) => ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', 'pipe:0',
  '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png'], randomBytes(width * height * 3));
const PREVIEW_URL = /^http:\/\/cdn\.files\.localhost:\d+\/previews\/(thumb|thumb-2x|display|poster|cover|waveform|peaks|hover)\/[a-z0-9/]+\.(webp|mp4|json)\?v=\d+$/;
const ownerFile = async (id) => {
  const list = await api('/users/@me/files?limit=100', { headers: OWNER });
  return list.data.items.find((item) => item.id === id);
};
async function waitProcessed(file) {
  // probe and derive run only after the scan (§2.1)
  await waitScanned(file, OWNER, `${file.filename} (step ${current.name.split('.')[0]})`);
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
  // The album page above was looked up before the collage existed; the Worker caches lookups 5 s.
  const collageServed = await poll('the Worker to serve the new collage', async () => {
    const response = await request(withCollage.album.collage.url);
    return { done: response.status === 200, state: [response.status, response.headers.get('content-type')], response };
  });
  const collage = collageServed.response;
  equal([collage.status, collage.headers.get('content-type')], [200, 'image/webp'], 'collage.webp');
  note(`the collage was served ${(collageServed.waited / 1000).toFixed(1)}s after it existed (Worker lookup cache: 5 s)`);
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
  // The Worker may still hold the file's lookup from step 10 (5 s), from before it joined this album.
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


// --- Milestone 4: trust & safety -------------------------------------------------------------------

// The other two users up.sh made (not staff): e2e-member owns the reported file, e2e-reporter reports it.
const MEMBER = JSON.parse(readFileSync(join(LOCAL, 'e2e-member.json'), 'utf8'));
const REPORTER = JSON.parse(readFileSync(join(LOCAL, 'e2e-reporter.json'), 'utf8'));
const AS_MEMBER = { Authorization: MEMBER.token };
const AS_REPORTER = { Authorization: REPORTER.token };

// The standard antivirus test file (eicar.org), assembled here at runtime so no file in the repo
// carries it. The e2e clamd (api/tests/fixtures/clamav/db) detects it by its exact hash, as a block.
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'ascii');
// The test-only PUA signature's bytes, read from that database (an ndb body is hex): a flag, not a block.
const PUA_STRING = Buffer.from(readFileSync(join(ROOT, 'api/tests/fixtures/clamav/db/filesgg-test.ndb'), 'utf8')
  .split('\n').find((line) => line.startsWith('PUA.')).trim().split(':')[3], 'hex');
// A minimal Windows PE header, as api/tests/test_filetypes.py builds it: "MZ", the PE offset at 0x3C,
// then "PE\0\0" and the i386 machine type there.
function peBytes(size = 4096) {
  const bytes = Buffer.alloc(size, 0xcc);
  bytes.write('MZ', 0, 'latin1');
  bytes.fill(0x90, 2, 0x3c);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.fill(0, 0x40, 0x80);
  bytes.write('PE\0\0', 0x80, 'latin1');
  bytes.writeUInt16LE(0x014c, 0x84);
  return bytes;
}
// A zip (stored, no compression) of [name, bytes] entries.
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0x0800, 6);     // UTF-8 names
    local.writeUInt16LE(0x21, 12);      // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const nonce = () => Buffer.from(`e2e nonce ${randomBytes(16).toString('hex')}\n`);
const anonymousHeaders = async () => ({ 'X-Fingerprint': await fingerprint() });
const anonymousUpload = (headers, file) => uploadFile(headers, { ...file, fields: { ...(file.fields || {}), turnstile_token: TURNSTILE_TOKEN } });

// Nothing about the file anywhere: the shell is `missing` (404), the CDN 404 and the public API 404
// UNKNOWN_FILE. A blocked file's CDN 404 is `private, no-store` (§10.2); a deleted file (an anonymous
// upload rejected after its scan, §2.5) is simply unknown, so its 404 is the CDN's usual one.
// The Worker may still hold a `pending` lookup from before the scan (5 s): until then the page may
// be the pending shell, but never the file, and the CDN never serves the bytes.
async function checkNotServed(file, what, { deleted = false } = {}) {
  const settled = await poll(`${what}: the Worker to show it missing`, async () => {
    const shell = await page(vanityPath(file));
    const state = parseShell(shell.text).state;
    check(state === 'missing' || state === 'pending', `${what}: the page is never served meanwhile`, state);
    check((await request(plain(file.cdn_url), { method: 'HEAD' })).status === 404, `${what}: the CDN never serves it meanwhile`);
    return { done: shell.status === 404, state: [shell.status, state], shell };
  });
  const shell = settled.shell;
  equal(shell.status, 404, `${what}: the page is 404`);
  const parsed = parseShell(shell.text);
  equal([parsed.page, parsed.state, parsed.data], ['file', 'missing', null], `${what}: the missing shell`);
  const blob = await request(plain(file.cdn_url));
  if (deleted) {
    equal(blob.status, 404, `${what}: the CDN is 404`);
  } else {
    equal([blob.status, blob.headers.get('cache-control')], [404, 'private, no-store'], `${what}: the CDN is 404, private, no-store`);
  }
  const publicApi = await api(`/files/${file.vanity}`);
  equal([publicApi.status, publicApi.data && publicApi.data.code], [404, 'UNKNOWN_FILE'], `${what}: GET /files/<vanity>`);
}

// The owner's notice (§8.2) for a file, from GET /users/@me/warnings.
async function noticeFor(headers, noticeId) {
  const list = await api('/users/@me/warnings?limit=100', { headers });
  equal(list.status, 200, 'GET /users/@me/warnings');
  return list.data.items.find((item) => item.id === noticeId);
}

await step('14. gating: pending shell and CDN 404 until the scan passes, then served', async () => {
  const bytes = noisePng(1280, 720);
  const created = await uploadFile(OWNER, { bytes, filename: 'e2e-gated.png', type: 'image/png' });
  const uploadedAt = Date.now();
  equal(created.status, 200, 'POST /files');
  const file = created.data;
  equal(file.safety && file.safety.state, 'pending', 'the upload response says pending');

  // Straight after the upload, before the scanner is done (images take about a second).
  const shell = await page(vanityPath(file));
  const blob = await request(file.cdn_url);
  const publicApi = await api(`/files/${file.vanity}`);
  note(`pending checks made ${Date.now() - uploadedAt} ms after the upload response`);
  equal(shell.status, 200, 'the pending shell is 200');
  equal(shell.headers.get('cache-control'), 'private, no-store', 'the pending shell is private, no-store');
  const parsed = parseShell(shell.text);
  equal([parsed.page, parsed.state], ['file', 'pending'], 'data-page / data-state');
  equal(parsed.data, { vanity: file.vanity, pending: true }, '#file-data');
  check(parsed.meta.includes('<meta property="og:title" content="Checking this file · files.gg">'), 'og:title "Checking this file"', parsed.meta);
  check(!/og:image|og:video|twitter:image/.test(parsed.meta) && !shell.text.includes('e2e-gated'), 'no media and no filename in the pending page', parsed.meta);
  equal([blob.status, blob.headers.get('cache-control')], [404, 'private, no-store'], 'the CDN is 404, private, no-store');
  equal([publicApi.status, publicApi.data.code, publicApi.data.retry_after], [409, 'FILE_PENDING', 5], 'GET /files/<vanity>: 409 FILE_PENDING');
  const bot = await page(vanityPath(file), TELEGRAMBOT);
  equal([bot.status, bot.headers.get('location')], [200, null], 'TelegramBot isn\'t redirected to the CDN while pending');

  const scanned = await waitScanned(file, OWNER, 'step 14 gated 1280x720 PNG');
  equal(scanned.safety.state, 'ok', 'the scan passed');
  // The Worker may hold the pending lookup for up to 5 s.
  const served = await poll('the Worker to serve the scanned file', async () => {
    const response = await request(file.cdn_url);
    return { done: response.status === 200, state: response.status, response };
  });
  note(`the CDN served it ${(served.waited / 1000).toFixed(1)}s after the scan finished (Worker lookup cache: 5 s)`);
  equal(sha256(served.response.buffer), sha256(bytes), 'CDN bytes (sha256)');
  equal(served.response.headers.get('cache-control'), 'public, max-age=3600', 'public CDN cache-control');
  const after = await page(vanityPath(file));
  equal(after.status, 200, 'the page is 200');
  const afterShell = parseShell(after.text);
  equal([afterShell.state, afterShell.data.id, afterShell.data.nsfw], ['file', file.id, false], 'the file shell, not NSFW');
  check(after.headers.get('cache-control') !== 'private, no-store', 'the file page is no longer no-store', after.headers.get('cache-control'));
  equal((await api(`/files/${file.vanity}`)).status, 200, 'GET /files/<vanity>');
});

await step('15. malware: EICAR is blocked or rejected and never served; the test PUA signature only flags', async () => {
  check(EICAR.length === 68 && createHash('md5').update(EICAR).digest('hex') === '44d88612fea8a8f36de82e1278abb02f', 'the EICAR string is the standard one');

  // Anonymous: rejected after the scan (§2.5). The e2e clamd knows EICAR by its exact hash, so it goes
  // into a zip with a fresh second entry: a new hash every run, still found (clamd scans archives).
  const headers = await anonymousHeaders();
  const anonymousZip = zipOf([['eicar.com.txt', EICAR], ['nonce.txt', nonce()]]);
  const anon = await anonymousUpload(headers, { bytes: anonymousZip, filename: 'e2e-eicar.zip', type: 'application/zip' });
  equal([anon.status, anon.data.safety && anon.data.safety.state], [200, 'pending'], 'anonymous upload: accepted, pending');
  equal((await request(plain(anon.data.cdn_url))).status, 404, 'the CDN doesn\'t serve it while pending');
  const rejected = await waitScanned(anon.data, headers, 'step 15 EICAR zip (anonymous)');
  const { code, status, reason } = rejected.rejected || {};
  equal([status, code, reason], [410, 'UPLOAD_REJECTED', 'MALWARE_DETECTED'], 'the owner gets 410 UPLOAD_REJECTED { reason: MALWARE_DETECTED }');
  await checkNotServed(anon.data, 'anonymous EICAR', { deleted: true });

  // Signed in: the file stays, blocked, with a notice (§2.5, §8.1).
  const signedZip = zipOf([['eicar.com.txt', EICAR], ['nonce.txt', nonce()]]);
  const mine = await uploadFile(OWNER, { bytes: signedZip, filename: 'e2e-eicar-signed-in.zip', type: 'application/zip' });
  equal([mine.status, mine.data.safety && mine.data.safety.state], [200, 'pending'], 'signed-in upload: accepted, pending');
  const blocked = await waitScanned(mine.data, OWNER, 'step 15 EICAR zip (signed in)');
  equal([blocked.safety.state, blocked.safety.reason], ['blocked', 'malware'], 'the owner sees it blocked (malware)');
  check(blocked.safety.notice_id, 'with a notice', blocked.safety);
  const notice = await noticeFor(OWNER, blocked.safety.notice_id);
  check(notice, 'the notice is in GET /users/@me/warnings', blocked.safety.notice_id);
  equal([notice.action, notice.rule, notice.target.kind, notice.target.id, notice.appeal.can_appeal],
    ['scan_block', 'malware', 'file', mine.data.id, true], 'the notice: scan_block, malware, appealable');
  await checkNotServed(mine.data, 'signed-in EICAR');
  const again = await uploadFile(OWNER, { bytes: signedZip, filename: 'again.zip', type: 'application/zip' });
  equal([again.status, again.data.code], [400, 'MALWARE_DETECTED'], 'the same bytes again: refused at upload (known malware)');

  // The bare EICAR file. The first run scans and blocks it; on later runs its hash is known, so the
  // upload itself is refused. Either way it's never served.
  const plainEicar = await uploadFile(OWNER, { bytes: EICAR, filename: 'eicar.txt', type: 'text/plain' });
  if (plainEicar.status === 200) {
    const state = await waitScanned(plainEicar.data, OWNER, 'step 15 bare EICAR (signed in)');
    equal([state.safety.state, state.safety.reason], ['blocked', 'malware'], 'bare EICAR: blocked (malware)');
    await checkNotServed(plainEicar.data, 'bare EICAR');
    note('bare EICAR: new to this stack, so it was scanned and blocked');
  } else {
    equal([plainEicar.status, plainEicar.data.code], [400, 'MALWARE_DETECTED'], 'bare EICAR: refused at upload (known hash)');
    note('bare EICAR: already known to this stack, so it was refused at upload with 400 MALWARE_DETECTED');
  }

  // The test-only PUA signature: flagged (public, with a warning), not blocked (§5.2).
  const puaBytes = Buffer.concat([PUA_STRING, Buffer.from(' '), nonce()]);
  const pua = await uploadFile(OWNER, { bytes: puaBytes, filename: 'e2e-pua.txt', type: 'text/plain' });
  equal(pua.status, 200, 'PUA upload');
  const flagged = await waitScanned(pua.data, OWNER, 'step 15 test PUA text');
  equal([flagged.safety.state, flagged.safety.reason], ['flagged', 'unwanted_software'], 'the owner sees it flagged (unwanted_software)');
  equal(flagged.warnings, ['unwanted_software'], 'with the unwanted_software warning');
  const shell = await page(vanityPath(pua.data));
  equal(shell.status, 200, 'the page is served');
  const parsed = parseShell(shell.text);
  equal([parsed.state, parsed.data.warnings], ['file', ['unwanted_software']], 'the file shell carries the warning');
  const blob = await request(pua.data.cdn_url);
  equal([blob.status, sha256(blob.buffer)], [200, sha256(puaBytes)], 'the CDN serves it');
  equal((await api(`/files/${pua.data.vanity}`)).data.warnings, ['unwanted_software'], 'GET /files/<vanity> has the warning');
});

await step('16. archives: a zip holding a Windows program is blocked (signed in) or rejected (anonymous)', async () => {
  const pe = peBytes();
  for (const [label, entries] of [
    ['setup.exe inside', [['setup.exe', pe], ['readme.txt', nonce()]]],
    ['a program named readme.txt', [['docs/readme.txt', Buffer.concat([pe, nonce()])]]],
  ]) {
    const created = await uploadFile(OWNER, { bytes: zipOf(entries), filename: 'e2e-tools.zip', type: 'application/zip' });
    equal([created.status, created.data.safety && created.data.safety.state], [200, 'pending'], `${label}: accepted (the zip itself is allowed), pending`);
    const blocked = await waitScanned(created.data, OWNER, `step 16 zip, ${label}`);
    equal([blocked.safety.state, blocked.safety.reason], ['blocked', 'blocked_type'], `${label}: blocked (blocked_type)`);
    check(blocked.safety.notice_id, `${label}: with a notice`, blocked.safety);
    await checkNotServed(created.data, label);
  }

  const headers = await anonymousHeaders();
  const anon = await anonymousUpload(headers, { bytes: zipOf([['game/bin/tool.EXE', pe], ['n.txt', nonce()]]), filename: 'e2e-game.zip', type: 'application/zip' });
  equal(anon.status, 200, 'anonymous upload of a zip with game/bin/tool.EXE: accepted');
  const rejected = await waitScanned(anon.data, headers, 'step 16 zip with tool.EXE (anonymous)');
  const { code, status, reason } = rejected.rejected || {};
  equal([status, code, reason], [410, 'UPLOAD_REJECTED', 'FILE_TYPE_NOT_ALLOWED'], 'the owner gets 410 UPLOAD_REJECTED { reason: FILE_TYPE_NOT_ALLOWED }');
  await checkNotServed(anon.data, 'anonymous zip', { deleted: true });
});

await step('17. reports: anonymous and signed-in reports, a case, claim, hide, notice, appeal, report status', async () => {
  // e2e-member's public file, reported by an anonymous visitor and by e2e-reporter.
  const bytes = noisePng(320, 240);
  const created = await uploadFile(AS_MEMBER, { bytes, filename: 'e2e-reported.png', type: 'image/png' });
  equal(created.status, 200, 'e2e-member uploads a file');
  const file = created.data;
  equal((await waitScanned(file, AS_MEMBER, 'step 17 reported PNG')).safety.state, 'ok', 'scanned: ok');
  const before = await page(vanityPath(file));
  equal([before.status, parseShell(before.text).state], [200, 'file'], 'the page before the reports');
  equal((await request(file.cdn_url)).status, 200, 'the CDN before the reports');

  const target = { type: 'file', vanity: file.vanity };
  const fp = await anonymousHeaders();
  const noCaptcha = await api('/reports/anonymous', { method: 'POST', headers: fp, json: { target, reason: 'spam' } });
  equal([noCaptcha.status, noCaptcha.data.code], [403, 'CAPTCHA_INVALID'], 'an anonymous report without Turnstile');
  const anonymous = await api('/reports/anonymous', { method: 'POST', headers: fp, json: { target, reason: 'spam', details: 'e2e: anonymous report', turnstile_token: TURNSTILE_TOKEN } });
  equal([anonymous.status, anonymous.data.status, anonymous.data.report], [201, 'open', undefined], 'anonymous report: 201 { id, status: open }, no thread');
  check(/^\d+$/.test(anonymous.data.id), 'with an id', anonymous.data);

  const own = await api('/reports', { method: 'POST', headers: AS_MEMBER, json: { target, reason: 'spam' } });
  equal([own.status, own.data.code], [400, 'CANNOT_REPORT_YOURSELF'], 'the owner can\'t report their own file');
  const signedIn = await api('/reports', { method: 'POST', headers: AS_REPORTER, json: { target: { type: 'url', url: file.url }, reason: 'spam', details: 'e2e: signed-in report' } });
  equal(signedIn.status, 201, 'e2e-reporter reports it (a files.localhost URL target)');
  const report = signedIn.data.report;
  equal([report.kind, report.reason, report.status, report.target.vanity, report.target.url], ['file', 'spam', 'open', file.vanity, `${MAIN}/${file.vanity}`], 'the reporter\'s report (§7.5: no filename, no state)');
  // Two `spam` reports are under the threshold of 3 (§7.3): nothing happens automatically.
  equal(parseShell((await page(vanityPath(file))).text).state, 'file', 'still served after two spam reports');

  // Staff: the case in the queue, claim it, hide the file.
  const queue = await api('/admin/cases?status=open&kind=file&reason=spam&limit=100', { headers: OWNER });
  equal(queue.status, 200, 'GET /admin/cases as staff');
  const summary = queue.data.items.find((item) => item.target && item.target.id === file.id);
  check(summary, 'the file\'s case is in the queue', queue.data.items.map((item) => item.target));
  equal([summary.kind, summary.priority, summary.status, summary.reasons, summary.report_count, summary.assignee],
    ['file', 3, 'open', { spam: 2 }, 2, null], 'case summary: file, P3, open, 2 spam reports, unassigned');
  note(`distinct_reporters = ${summary.distinct_reporters} (both reports come from the same local IP hash, §7.4)`);
  const claimed = await api(`/admin/cases/${summary.id}/claim`, { method: 'POST', headers: OWNER });
  equal([claimed.status, claimed.data.assignee && claimed.data.assignee.id], [200, E2E_USER.id], 'claim: assigned to e2e');
  check(claimed.data.reports.length === 2 && claimed.data.reports.every((r) => r.reason === 'spam'), 'the case lists both reports', claimed.data.reports);
  const hidden = await api('/admin/actions', { method: 'POST', headers: OWNER, json: {
    action: 'hide', target: { type: 'file', id: file.id }, rule: 'spam', case_id: summary.id,
    note: 'e2e: staff-only note', message: 'e2e: hidden after reports',
  } });
  equal(hidden.status, 200, 'POST /admin/actions hide');
  equal(hidden.data.notice_ids.length, 1, 'one notice for the owner');
  const hiddenAt = Date.now();

  // The Worker's lookup cache (5 s) is the only delay.
  const gone = await poll('the page and the CDN to show the file removed', async () => {
    const shell = await page(vanityPath(file));
    const blob = await request(file.cdn_url, { method: 'HEAD' });
    return { done: shell.status === 410 && blob.status === 410, state: { shell: shell.status, cdn: blob.status }, shell, blob };
  }, { intervalMs: 250 });
  const waited = Date.now() - hiddenAt;
  note(`the page and the CDN answered 410 ${(waited / 1000).toFixed(1)}s after the hide (Worker lookup cache: 5 s)`);
  check(waited <= LOOKUP_TTL_MS + 3000, 'within the 5 s lookup cache (plus 3 s slack)', waited);
  const removed = parseShell(gone.shell.text);
  equal([removed.page, removed.state, removed.data], ['file', 'removed', { vanity: file.vanity, removed: 'review' }], 'the removed shell (reason review)');
  equal(gone.shell.headers.get('cache-control'), 'no-cache', 'the removed shell is no-cache');
  check(removed.meta.includes('<meta property="og:title" content="This file was removed · files.gg">') && !gone.shell.text.includes('e2e-reported'), 'og:title "This file was removed", no filename', removed.meta);
  equal(gone.blob.headers.get('cache-control'), 'private, no-store', 'the CDN 410 is private, no-store');
  const publicApi = await api(`/files/${file.vanity}`);
  equal([publicApi.status, publicApi.data.code, publicApi.data.reason], [410, 'FILE_REMOVED', 'review'], 'GET /files/<vanity>: 410 FILE_REMOVED (review)');

  // The owner: the file's safety, the notice and the badges.
  const ownerFile = await api(`/users/@me/files/${file.id}`, { headers: AS_MEMBER });
  equal([ownerFile.data.safety.state, ownerFile.data.safety.reason, ownerFile.data.safety.notice_id], ['hidden', 'spam', hidden.data.notice_ids[0]], 'the owner file: hidden (spam), with the notice');
  const notice = await noticeFor(AS_MEMBER, hidden.data.notice_ids[0]);
  check(notice, 'the notice is in GET /users/@me/warnings', hidden.data.notice_ids[0]);
  equal([notice.action, notice.rule, notice.rule_text, notice.message, notice.target.vanity, notice.acknowledged_at, notice.appeal.state, notice.appeal.can_appeal],
    ['hide', 'spam', 'Spam', 'e2e: hidden after reports', file.vanity, null, 'none', true], 'the notice');
  const badges = await api('/users/@me/badges', { headers: AS_MEMBER });
  equal(badges.status, 200, 'GET /users/@me/badges');
  check(badges.data.notices_unacknowledged >= 1 && badges.data.staff === null, 'badges: an unacknowledged notice, not staff', badges.data);

  // The owner appeals, once.
  const appeal = await api(`/users/@me/warnings/${notice.id}/appeal`, { method: 'POST', headers: AS_MEMBER, json: { message: 'e2e: this is not spam' } });
  equal([appeal.status, appeal.data.appeal.state, appeal.data.appeal.can_appeal], [200, 'open', false], 'appeal: open');
  const second = await api(`/users/@me/warnings/${notice.id}/appeal`, { method: 'POST', headers: AS_MEMBER, json: { message: 'again' } });
  equal([second.status, second.data.code], [409, 'APPEAL_NOT_ALLOWED'], 'a second appeal');
  const acknowledged = await api('/users/@me/warnings/acknowledge', { method: 'POST', headers: AS_MEMBER, json: { ids: [notice.id] } });
  equal(acknowledged.data.acknowledged, [notice.id], 'acknowledge the notice');

  // The signed-in reporter follows the report: open until the case is closed, then resolved, with
  // a message from "files.gg staff".
  equal((await api(`/users/@me/reports/${report.id}`, { headers: AS_REPORTER })).data.status, 'open', 'the reporter sees it open');
  const closed = await api(`/admin/cases/${summary.id}/close`, { method: 'POST', headers: OWNER, json: { outcome: 'actioned', reason: 'e2e: hidden for spam' } });
  equal([closed.status, closed.data.status, closed.data.outcome], [200, 'closed', 'actioned'], 'close the case (actioned)');
  const resolved = await api(`/users/@me/reports/${report.id}`, { headers: AS_REPORTER });
  equal([resolved.data.status, resolved.data.closed], ['resolved', false], 'the reporter sees it resolved');
  check(resolved.data.unread >= 1, 'with something unread', resolved.data);
  const listed = await api('/users/@me/reports?status=resolved', { headers: AS_REPORTER });
  check(listed.data.items.some((item) => item.id === report.id), 'in My reports (resolved)', listed.data);
  const thread = await api(`/users/@me/reports/${report.id}/messages`, { headers: AS_REPORTER });
  check(thread.data.items.some((item) => item.author === 'staff'), 'a message from staff in the thread', thread.data.items);
  equal((await api(`/users/@me/reports/${report.id}`, { headers: AS_REPORTER })).data.unread, 0, 'reading the thread marks it read');
  const badgesReporter = await api('/users/@me/badges', { headers: AS_REPORTER });
  equal(badgesReporter.data.reports_unread, 0, 'the reporter\'s badges: nothing unread');

  // The appeal is a case for staff; e2e is the only staff member, so it may decide its own action (§9.4).
  const appeals = await api('/admin/cases?status=open&kind=appeal&needs_second_review=true&limit=100', { headers: OWNER });
  const appealCase = appeals.data.items.find((item) => item.target && item.target.id === notice.id);
  check(appealCase, 'the appeal case is in the queue', appeals.data.items.map((item) => item.target));
  equal([appealCase.priority, appealCase.needs_second_review], [2, true], 'appeal case: P2, needs second review');
  const granted = await api(`/admin/cases/${appealCase.id}/appeal`, { method: 'POST', headers: OWNER, json: { decision: 'grant', message: 'e2e: appeal granted' } });
  equal([granted.status, granted.data.status, granted.data.outcome], [200, 'closed', 'actioned'], 'grant the appeal');
  const afterAppeal = await noticeFor(AS_MEMBER, notice.id);
  equal([afterAppeal.appeal.state, afterAppeal.appeal.message], ['granted', 'e2e: appeal granted'], 'the owner sees the appeal granted');
  const back = await poll('the file to be served again', async () => {
    const shell = await page(vanityPath(file));
    return { done: shell.status === 200, state: shell.status, shell };
  });
  equal(parseShell(back.shell.text).state, 'file', 'granting the appeal unhid the file');
  equal((await request(file.cdn_url)).status, 200, 'and the CDN serves it again');
});

await step('18. security.txt on files.localhost and cdn.files.localhost', async () => {
  const expected = readFileSync(join(ROOT, 'web/public/.well-known/security.txt'), 'utf8');
  for (const base of [MAIN, CDN]) {
    const response = await request(`${base}/.well-known/security.txt`);
    equal([response.status, response.headers.get('content-type')], [200, 'text/plain; charset=utf-8'], `${base}/.well-known/security.txt`);
    equal(response.text, expected, `${base}: web/public/.well-known/security.txt`);
    check(/^Contact: mailto:security@files\.gg$/m.test(response.text) && /^Expires: /m.test(response.text), 'Contact and Expires', response.text);
  }
  const cdn = await request(`${CDN}/.well-known/security.txt`);
  equal(cdn.headers.get('x-content-type-options'), 'nosniff', 'the CDN copy has the CDN security headers (nosniff)');
  equal((await request(`${API}/.well-known/security.txt`)).status, 404, 'not on api.files.localhost');
});

await step('19. admin: staff get the queue; non-staff and signed-out callers get the unknown-route 404', async () => {
  const meStaff = await api('/users/@me', { headers: OWNER });
  equal(meStaff.data.staff, { role: 'admin', child_safety: true }, 'GET /users/@me: e2e is staff (granted by up.sh)');
  equal((await api('/users/@me', { headers: AS_MEMBER })).data.staff, null, 'e2e-member isn\'t');
  equal((await api('/admin/cases', { headers: OWNER })).status, 200, 'staff: GET /admin/cases');
  const summary = await api('/admin/summary', { headers: OWNER });
  equal(summary.status, 200, 'staff: GET /admin/summary');
  equal(summary.data.scans_stalled, 0, 'no stalled scans');
  const staffBadges = await api('/users/@me/badges', { headers: OWNER });
  check(staffBadges.data.staff && typeof staffBadges.data.staff.open === 'number', 'staff badges', staffBadges.data);

  const unknown = await api('/admin/no-such-route', { headers: AS_MEMBER });
  equal(unknown.status, 404, 'an unknown route is 404');
  for (const [who, headers] of [['e2e-member', AS_MEMBER], ['e2e-reporter', AS_REPORTER], ['signed out', {}]]) {
    for (const path of ['/admin/cases', '/admin/summary', `/admin/files/${files.anon.id}`]) {
      const response = await api(path, { headers });
      equal([response.status, response.text], [404, unknown.text], `${who}: GET ${path} is the unknown-route 404`);
    }
  }
  const action = await api('/admin/actions', { method: 'POST', headers: AS_MEMBER, json: { action: 'hide', target: { type: 'file', id: files.anon.id }, rule: 'spam' } });
  equal(action.status, 404, 'e2e-member: POST /admin/actions is 404');
  equal(parseShell((await page(vanityPath(files.anon))).text).state, 'file', 'and changed nothing');
});

const failed = results.filter((result) => !result.ok);
const checks = results.reduce((sum, result) => sum + result.checks, 0);
if (scanTimes.length) {
  const sorted = scanTimes.map((entry) => entry.ms).sort((a, b) => a - b);
  const seconds = (ms) => (ms / 1000).toFixed(1) + 's';
  console.log(`\nScan times (upload, or upload completion, to safety.state leaving pending), ${scanTimes.length} files: ` +
    `min ${seconds(sorted[0])}, median ${seconds(sorted[Math.floor(sorted.length / 2)])}, max ${seconds(sorted[sorted.length - 1])}`);
}
console.log(`\n${results.length - failed.length}/${results.length} steps passed, ${checks} checks` +
  (failed.length ? `; failed: ${failed.map((result) => result.name.split('.')[0]).join(', ')}` : ''));
process.exit(failed.length ? 1 : 0);
