#!/usr/bin/env node
// End-to-end test of the local files.gg stack started by e2e/up.sh (e2e/README.md): the browser-facing
// hosts served by the Worker under wrangler dev, the API and jobs worker in Docker, MinIO for B2,
// a mock of Cloudflare's custom hostnames API, and Cloudflare's real siteverify with the Turnstile
// testing keys (so it needs internet).
//
//   node e2e/run.mjs
//
// Plain fetch() against http://files.localhost, cdn.files.localhost, api.files.localhost and, for custom
// domains, <random>.example.localhost (all loopback, no /etc/hosts edits). A few steps use
// `docker compose exec` to run psql (to move a time into the past) and the API's CLIs (tools.create_user,
// tools.entitlements). The Worker caches internal lookups for 5 s (contract §2), so the steps that change
// an existing file's access poll until the change reaches the Worker.
//
// Milestone 4: every new upload stays `pending` until the scanner has checked it, so each step that
// expects a public page or CDN bytes first waits for its scan (waitScanned), and the scan times are
// printed at the end. Steps 14-19 cover gating, malware, archives, reports and moderation,
// security.txt and the admin API's 404 for non-staff (docs/redesign/contracts/milestone-4.md).
//
// Milestone 6 (docs/redesign/contracts/milestone-6.md): the website is signed in with the HttpOnly session
// cookie, which the Worker forwards only on files.localhost/api/* (a `Caller` below keeps a cookie jar and
// sends `X-Filesgg-Csrf: 1` on every write there, like the web app); tools upload to api.files.localhost
// with `Authorization: Key fgg_…`. Steps 20-27 cover sessions, register, upload keys, premium, custom
// domains, view limits, the vanity-last routes (§20) and account deletion.
//
// Milestone 5 (docs/redesign/contracts/milestone-5.md): steps 28-43 cover conversions on the RQ converter pools and
// the network-less office service (polled as the web app does, GET /conversions/<id> until finished, with each
// conversion's time printed at the end), document previews, the moderation cascade, the anonymous limits, a Redis
// rate limit, the home, changelog, Terms, Privacy and link-warnings help pages (with the app CSP and HSTS), and the 100 MB single-request limit for upload keys.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
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
// The website's API: the same-origin passthrough, the only place the Worker forwards the session cookie.
const WEB_API = `${MAIN}/api`;
const MOCK_CLOUDFLARE = `http://127.0.0.1:${process.env.E2E_CLOUDFLARE_PORT || '18081'}`;
const LOOKUP_TTL_MS = 5_000;
// The API's cookie name over plain http (SESSION_COOKIE_INSECURE=1, milestone-6 §3.2).
const SESSION_COOKIE = 'filesgg_session';
// Sizes are decimal (1 MB = 1,000,000 bytes), as the API and the web app count them (api/utils/limits.py).
const MB = 1000 * 1000;
const GB = 1000 * MB;
const MIB = 1024 * 1024;

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
const FACEBOOK = { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'accept-language': 'en-US' };
const WHATSAPP = { 'user-agent': 'WhatsApp/2.23.20.0 A', 'accept-language': 'en-US' };


// --- tiny test runner ------------------------------------------------------------------------

const results = [];
let current = null;

// E2E_STEPS=28-43 (or "9,28-30") runs only those steps, plus step 0 (the sign-in every step needs). Steps that use
// what an earlier step made fail or fall back when it was skipped; a full run is the real test.
const ONLY = process.env.E2E_STEPS ? new Set(process.env.E2E_STEPS.split(',').flatMap((part) => {
  const [from, to = from] = part.split('-').map(Number);
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}).concat(0)) : null;

async function step(name, fn) {
  if (ONLY && !ONLY.has(Number(name.split('.')[0]))) {
    return;
  }
  current = { name, checks: 0, notes: [] };
  const started = Date.now();
  try {
    await fn();
    results.push({ ...current, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ${name} (${current.checks} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push({ ...current, ok: false, error, ms: Date.now() - started });
    console.log(`  ✖ ${name}\n      ${String(error && error.stack || error).split('\n').slice(0, 6).join('\n      ')}`);
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
const hex = (bytes) => randomBytes(bytes).toString('hex');
// A client address for the Worker to vouch for. Locally, wrangler dev passes a client's CF-Connecting-IP
// through to the Worker (Cloudflare's edge overwrites it in production), and the Worker sends it to the
// API as X-Filesgg-Client-Ip with the origin secret (api/utils/client_ip.py). So each address is a
// different viewer (view limits) and a different rate-limit bucket (register).
const clientIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const fromIp = (ip) => ({ 'cf-connecting-ip': ip });

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

// api.files.localhost: public calls, and tools (upload keys). Never a cookie.
const api = (path, options) => request(API + path, options);
const page = (path, headers = BROWSER) => request(MAIN + path, { headers });

// The session cookie a response sets or clears, as { raw, value, attributes }, or null.
function sessionCookieOf(response) {
  const line = response.headers.getSetCookie().find((cookie) => cookie.startsWith(SESSION_COOKIE + '='));
  if (!line) {
    return null;
  }
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  return { raw: line, value: pair.slice(SESSION_COOKIE.length + 1), attributes };
}

// Someone calling the API: the website (WEB_API, files.localhost/api, the default) with a cookie jar for
// the one session cookie, or a tool on api.files.localhost. On the website every write sends
// `X-Filesgg-Csrf: 1`, as web/src/lib/api.ts does (`csrf: false` leaves it out). The jar follows the
// API's Set-Cookie: a new value replaces it, a clearing one (empty, Max-Age=0) empties it.
class Caller {
  constructor(label, { base = WEB_API, headers = {}, cookie = null } = {}) {
    this.label = label;
    this.base = base;
    this.headers = headers;
    this.cookie = cookie;
    this.lastCookie = null;
  }

  async call(path, { method = 'GET', headers = {}, body, json, csrf, cookie = true, redirect } = {}) {
    const sent = { ...this.headers, ...headers };
    if (cookie && this.cookie) {
      sent.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    }
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (csrf ?? (write && this.base === WEB_API)) {
      sent['x-filesgg-csrf'] = '1';
    }
    const response = await request(this.base + path, { method, headers: sent, body, json, redirect });
    this.lastCookie = sessionCookieOf(response);
    if (this.lastCookie) {
      this.cookie = this.lastCookie.value || null;
    }
    return response;
  }
}
// A signed-out website visitor: a guest (`Authorization: Guest`, milestone-5 §20).
const visitor = async (headers = {}) => new Caller('visitor', { headers: { authorization: `Guest ${await guest()}`, ...headers } });
// A tool with an upload key, on api.files.localhost.
const tool = (secret, headers = {}) => new Caller('upload key', { base: API, headers: { authorization: `Key ${secret}`, ...headers } });

// POST /auth/login through files.localhost/api, as /app/login does; returns the signed-in Caller.
async function signIn(email, password, { headers = {}, label = email } = {}) {
  const caller = new Caller(label);
  const response = await caller.call('/auth/login', { method: 'POST', headers, json: { email, password, turnstile_token: TURNSTILE_TOKEN } });
  equal(response.status, 200, `POST /api/auth/login as ${email}`);
  check(typeof caller.cookie === 'string' && caller.cookie.startsWith('fgs_'), `${email}: the login sets the session cookie`, response.headers.getSetCookie());
  return caller;
}

// Reads the viewer shell: #root attributes, the boot JSON (raw and parsed) and the meta block.
function parseShell(html) {
  const root = /<div id="root"([^>]*)><\/div>/.exec(html);
  if (!root) {
    throw new Error('no #root in the page:\n' + html.slice(0, 500));
  }
  const attributes = Object.fromEntries([...root[1].matchAll(/ (data-[a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const script = /<script id="(file-data|album-data|report-data|domain-data)" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const hostData = /<script id="host-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const metaStart = html.indexOf('-->', html.indexOf('filesgg:meta:start')) + 3;
  return {
    page: attributes['data-page'],
    state: attributes['data-state'],
    host: attributes['data-host'],
    raw: script ? script[2] : undefined,
    data: script ? JSON.parse(script[2]) : undefined,
    hostData: hostData ? JSON.parse(hostData[1]) : undefined,
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

const COMPOSE = ['compose', '-f', join(E2E_DIR, 'docker-compose.e2e.yml'), '--env-file', join(LOCAL, '.env')];
function psql(sql) {
  return execFileSync('docker', [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-q', '-U', 'filesgg', '-d', 'filesgg',
    '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { encoding: 'utf8' }).trim();
}
// A python -m tools.<name> CLI in the API container; returns its last line of output, parsed as JSON.
function apiTool(args, { devTools = false } = {}) {
  const output = execFileSync('docker', [...COMPOSE, 'exec', '-T', ...(devTools ? ['-e', 'FILESGG_DEV_TOOLS=1'] : []), 'api',
    'python', '-m', ...args], { encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').pop());
}
// A fresh verified account for one step (the dev tool), with its printed web session: no state carries
// over between runs. Usernames are [a-z0-9_.] (milestone-6 §2.2).
function makeUser(tag, { premium = false } = {}) {
  const username = `e2e_${tag}_${hex(4)}`;
  const password = `e2e-${hex(12)}`;
  const user = apiTool(['tools.create_user', '--username', username, '--password', password, ...(premium ? ['--premium'] : [])], { devTools: true });
  return { ...user, password };
}

async function guest() {
  const response = await api('/auth/guest');
  equal(response.status, 200, 'GET /auth/guest');
  return response.data.guest;
}

// POST /files, multipart, as `caller`. The fields go before the file, as the web app sends them
// (web/src/lib/upload/uploadTask.ts): signed out, the API refuses before reading the file unless a
// `turnstile_token` field comes first (UPLOAD_KEY_REQUIRED, milestone-6 §7.5).
async function uploadFile(caller, { bytes, filename, type = 'application/octet-stream', fields = {} }) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, String(value));
  }
  form.append('file', new Blob([bytes], { type }), filename);
  return await caller.call('/files', { method: 'POST', body: form });
}

// Milestone 4 §2: a new upload is `pending` until the scanner is done with it. Polls the owner's
// GET /users/@me/files/<id> (as `caller`, the owner's session or guest) until
// `safety.state` leaves `pending` (or the upload is rejected after the scan: 410 UPLOAD_REJECTED),
// and records how long that took.
const scanTimes = [];
async function waitScanned(file, caller, label = file.filename) {
  const done = await poll(`${label} to be scanned`, async () => {
    const response = await caller.call(`/users/@me/files/${file.id}`);
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
// A URL with its origin swapped for another (what the Worker's rehosting does, §10.9).
const onOrigin = (url, origin) => origin + url.slice(new URL(url).origin.length);


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
// The other two users up.sh made (not staff): e2e.member owns the reported file, e2e.reporter reports it.
const MEMBER_USER = JSON.parse(readFileSync(join(LOCAL, 'e2e-member.json'), 'utf8'));
const REPORTER_USER = JSON.parse(readFileSync(join(LOCAL, 'e2e-reporter.json'), 'utf8'));
// Signed-in website Callers, from real logins in step 0.
let OWNER = null; // e2e (staff)
let AS_MEMBER = null;
let AS_REPORTER = null;
const files = {};

console.log(`files.gg e2e against ${MAIN}, ${CDN} and ${API}\n`);

await step('0. the stack answers on the *.localhost hosts, and the e2e users sign in (session cookie)', async () => {
  for (const host of ['files.localhost', 'cdn.files.localhost', 'api.files.localhost']) {
    const addresses = await lookup(host, { all: true });
    check(addresses.length && addresses.every((a) => a.address === '127.0.0.1' || a.address === '::1'),
      `${host} resolves to loopback`, addresses);
  }
  const health = await api('/health');
  equal(health.status, 200, 'API /health through the Worker');
  // Milestone 5 §19: `/` is the home page from the app bundle (step 30 checks it); the viewer shell's CSP is on its
  // own pages, such as /report.
  const viewer = await page('/report');
  equal(viewer.status, 200, 'a viewer page (/report)');
  const csp = viewer.headers.get('content-security-policy');
  check(csp.includes(`connect-src 'self' ${CDN} ${API}`), 'viewer CSP allows the local CDN and API', csp);

  // The password up.sh printed works with the real login endpoint, through files.localhost/api as
  // /app/login sends it (Turnstile testing token, X-Filesgg-Csrf).
  OWNER = await signIn(E2E_USER.email, LOCAL_ENV.E2E_USER_PASSWORD, { label: 'e2e' });
  const set = OWNER.lastCookie;
  equal(set.attributes, ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${set.attributes.at(-1).slice(8)}`], 'filesgg_session: Path=/, HttpOnly, SameSite=Lax, no Secure (plain http), no Domain');
  check(Number(set.attributes.at(-1).slice(8)) > 179 * 24 * 3600, 'Max-Age runs to the 180-day absolute expiry', set.raw);
  const me = await OWNER.call('/users/@me');
  equal(me.status, 200, 'GET /api/users/@me with the cookie');
  equal([me.data.username, me.data.email_verified, me.data.staff], ['e2e', true, { role: 'admin', child_safety: true }], 'signed in as e2e (verified, staff)');
  AS_MEMBER = await signIn(MEMBER_USER.email, LOCAL_ENV.E2E_MEMBER_PASSWORD, { label: 'e2e.member' });
  AS_REPORTER = await signIn(REPORTER_USER.email, LOCAL_ENV.E2E_REPORTER_PASSWORD, { label: 'e2e.reporter' });
  equal((await AS_MEMBER.call('/users/@me')).data.username, 'e2e.member', 'e2e.member signs in');
  equal((await AS_REPORTER.call('/users/@me')).data.username, 'e2e.reporter', 'e2e.reporter signs in');
});

await step('1. anonymous single upload (Turnstile testing token): CDN bytes and the escaped #file-data', async () => {
  // The website uploads through files.localhost/api, signed out, as a guest.
  const headers = await visitor();
  const bytes = randomBytes(256 * 1024 + 7);

  const refused = await uploadFile(headers, { bytes, filename: 'anon.bin' });
  equal([refused.status, refused.data && refused.data.code], [401, 'UPLOAD_KEY_REQUIRED'], 'an anonymous upload with no credential and no Turnstile token (milestone-6 §7.5)');

  const created = await uploadFile(headers, { bytes, filename: "e2e anon & friends'.bin", fields: { turnstile_token: TURNSTILE_TOKEN } });
  equal(created.status, 200, 'POST /api/files (anonymous)');
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
  const size = 30 * MIB + 12_345;
  const bytes = randomBytes(size);
  const created = await OWNER.call('/uploads', { method: 'POST', json: { filename: 'e2e-chunked.bin', size } });
  equal(created.status, 201, 'POST /api/uploads (session cookie)');
  const { upload_id: id, chunk_size: chunkSize, chunk_count: count } = created.data;
  equal(chunkSize, 10 * MIB, 'chunk_size (10 MiB, UPLOAD_CHUNK_SIZE)');
  equal(count, Math.ceil(size / chunkSize), 'chunk_count');

  const order = [...Array(count).keys()].reverse();
  [order[0], order[1]] = [order[1], order[0]];
  note(`chunks sent concurrently in the order ${order.join(', ')}`);
  const puts = await Promise.all(order.map((index) => OWNER.call(`/uploads/${id}/chunks/${index}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes.subarray(index * chunkSize, Math.min(size, (index + 1) * chunkSize)),
  })));
  equal(puts.map((r) => r.status), order.map(() => 204), 'every PUT chunk');

  const status = await OWNER.call(`/uploads/${id}`);
  equal(status.data.status, 'open', 'status before complete');
  equal([...status.data.received].sort((a, b) => a - b), [...Array(count).keys()], 'received');

  const complete = await OWNER.call(`/uploads/${id}/complete`, { method: 'POST' });
  equal(complete.status, 202, 'POST complete');
  const done = await poll('the upload to finish', async () => {
    const response = await OWNER.call(`/uploads/${id}`);
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

  // The missing shell has the viewer's scripts plus `#file-data` (null): a file page must have no more.
  const baseline = parseShell((await page('/zzzzzzzzzzzz')).text).scripts;
  const shell = await page(vanityPath(file));
  equal(shell.status, 200, 'the shell renders');
  const parsed = parseShell(shell.text);
  equal([parsed.page, parsed.state], ['file', 'file'], 'data-page / data-state');
  equal(parsed.data.filename, hostile, '#file-data round-trips the filename');
  check(parsed.raw.includes('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e.png'),
    'the boot JSON escapes < and > as \\u003c / \\u003e', parsed.raw);
  check(!shell.text.includes('<script>alert(1)'), 'no live <script>alert(1) anywhere in the page');
  equal(parsed.scripts, baseline, 'exactly the missing page\'s <script>s (the viewer and #file-data): nothing extra');
  check(parsed.meta.includes('content="&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;.png"'), 'meta tags escape the filename', parsed.meta);

  const blob = await request(file.cdn_url);
  equal(blob.status, 200, 'CDN serves it');
  const disposition = blob.headers.get('content-disposition');
  check(disposition.startsWith('inline; filename="') && disposition.endsWith(`filename*=UTF-8''%3C%2Fscript%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E.png`),
    'CDN Content-Disposition quotes and percent-encodes the name', disposition);
});

await step('4. password: locked shell, 401 CDN, unlock gives signed URLs, /access/view, wrong password, password change revokes', async () => {
  const bytes = randomBytes(64 * 1024);
  const created = await uploadFile(OWNER, { bytes, filename: 'e2e-secret.png', type: 'image/png' });
  equal(created.status, 200, 'POST /files');
  const file = files.password = created.data;
  const vanity = file.vanity;

  // PATCH before the Worker ever looks the file up, so its 5 s lookup cache can't serve the old state.
  const patched = await OWNER.call(`/users/@me/files/${file.id}`, { method: 'PATCH', json: { visibility: 'password', password: 'correct-horse-1' } });
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

  const unlock = (password, token = TURNSTILE_TOKEN) => api(`/access/unlock/files/${vanity}`, { method: 'POST', json: { password, turnstile_token: token } });
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

  const view = await api(`/access/view/files/${vanity}`, { headers: { 'X-Filesgg-Access': token } });
  equal(view.status, 200, 'GET /access/view/files/<vanity> with X-Filesgg-Access');
  equal(view.data.file.id, file.id, '/view payload');
  check(isSigned(view.data.file.cdn_url), '/view returns signed URLs', view.data.file.cdn_url);
  const refreshed = await api(`/access/refresh/files/${vanity}`, { method: 'POST', json: { token } });
  equal(refreshed.status, 200, 'POST /access/refresh/files/<vanity>');
  check(isSigned(refreshed.data.file.cdn_url), 'refresh returns fresh signed URLs', refreshed.data);

  // Changing the password bumps access_version, which revokes every token.
  const changed = await OWNER.call(`/users/@me/files/${file.id}`, { method: 'PATCH', json: { password: 'another-pass-2' } });
  equal(changed.status, 200, 'PATCH a new password');
  equal(changed.data.access_version, version + 1, 'access_version is bumped');
  const oldView = await api(`/access/view/files/${vanity}`, { headers: { 'X-Filesgg-Access': token } });
  equal([oldView.status, oldView.data.code], [401, 'UNLOCK_EXPIRED'], 'the API refuses the old token at once');
  const revoked = await poll('the CDN to refuse the old signed URL', async () => {
    const response = await request(signedUrl, { method: 'HEAD' });
    return { done: response.status === 401, state: response.status };
  });
  equal(revoked.state, 401, 'CDN with the old signed URL');
  note(`the CDN refused the old signed URL after ${(revoked.waited / 1000).toFixed(1)}s (Worker lookup cache: 5 s)`);
  const oldPassword = await unlock('correct-horse-1');
  equal([oldPassword.status, oldPassword.data && oldPassword.data.code], [401, 'WRONG_PASSWORD'], 'the old password no longer unlocks');
  const again = await unlock('another-pass-2');
  equal(again.status, 200, 'the new password unlocks');
  equal((await request(again.data.file.cdn_url)).status, 200, 'CDN with the new signed URL');
});

await step('5. private: missing shell, CDN 404, the owner gets signed URLs, owner pass for /access/view', async () => {
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
  const anonymousView = await api(`/access/view/files/${file.vanity}`);
  equal([anonymousView.status, anonymousView.data.code], [404, 'UNKNOWN_FILE'], '/access/view without a token');

  const pass = await OWNER.call(`/users/@me/files/${file.id}/pass`, { method: 'POST' });
  equal(pass.status, 200, 'POST /api/users/@me/files/<id>/pass');
  equal(pass.data.url, `${MAIN}/${file.vanity}#t=${pass.data.token}`, 'the owner-pass url uses PUBLIC_URL');
  equal((await request(`${plain(file.cdn_url)}?t=${encodeURIComponent(pass.data.token)}`)).status, 404, 'an owner pass in ?t= opens nothing on the CDN');
  check(isSigned(file.cdn_url), 'the upload response gives the owner a signed cdn_url', file.cdn_url);
  const withPass = await request(file.cdn_url);
  equal(withPass.status, 200, 'CDN with the owner\'s signed URL');
  equal(sha256(withPass.buffer), sha256(bytes), 'CDN bytes (sha256)');
  const view = await api(`/access/view/files/${file.vanity}`, { headers: { 'X-Filesgg-Access': pass.data.token } });
  equal(view.status, 200, '/access/view with the owner pass');
  check(isSigned(view.data.file.cdn_url), '/access/view with an owner pass returns signed URLs', view.data.file.cdn_url);
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
  const apiView = await api(`/access/view/files/${file.vanity}`);
  equal(apiView.status, 404, 'API /access/view/files/<vanity>');
  const mine = await OWNER.call(`/users/@me/files/${file.id}`, { method: 'PATCH', json: { show_name_when_locked: true } });
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

// The single-request limit is 100 MB (100,000,000 bytes) for everyone signed in, premium too: under Cloudflare's
// request-body limit (PROXY_BODY_LIMIT_BYTES, assumed 100 MiB) less 1 MiB of multipart framing (milestone-6 §9.5),
// so the proxy cap never cuts it. Step 32 uploads exactly 100,000,000 bytes with an upload key.
const SINGLE_LIMIT = 100 * MB;
// GET /users/@me/limits without `storage`, `upload_keys` and `daily`, whose numbers depend on earlier uploads.
const SIGNED_IN_LIMITS = {
  max_file_size_single: SINGLE_LIMIT,
  max_file_size_single_configured: SINGLE_LIMIT,
  max_file_size_chunked: GB,
  max_expiry: null,
  allow_no_expiry: true,
  anonymous: false,
  premium: false,
  custom_domains: { used: 0, limit: 0 },
  domain_only_allowed: false,
  album_max_files: 500,
  albums_max: 1000,
  nsfw_allowed: true, // milestone-4 §13: signed in and not restricted
  adult_region_blocked: false, // milestone-7 §11.3: e2e runs from a country where adult content is available
};
const PREMIUM_LIMITS = {
  ...SIGNED_IN_LIMITS,
  // premium raises storage and chunked uploads; a single request stays 100 MB
  max_file_size_chunked: 5 * GB,
  premium: true,
  custom_domains: { used: 0, limit: 5 },
  domain_only_allowed: true,
};

await step('8. limits: anonymous and signed-in values', async () => {
  const anonymous = await (await visitor()).call('/users/@me/limits');
  equal(anonymous.status, 200, 'GET /api/users/@me/limits (anonymous)');
  const { storage: anonymousStorage, daily, ...anonymousRest } = anonymous.data;
  equal(anonymousRest, {
    max_file_size_single: 25 * MB,
    max_file_size_single_configured: 25 * MB,
    max_file_size_chunked: 25 * MB,
    max_expiry: 21 * 24 * 3600,
    allow_no_expiry: false,
    anonymous: true,
    premium: false,
    custom_domains: { used: 0, limit: 0 },
    upload_keys: { used: 0, limit: 0 },
    domain_only_allowed: false,
    album_max_files: 50,
    albums_max: null,
    nsfw_allowed: false, // milestone-4 §13
    adult_region_blocked: false, // milestone-7 §11.3
  }, 'anonymous limits');
  equal(anonymousStorage.limit, null, 'anonymous storage.limit');
  // Anonymous usage is counted per guest and per IP; step 1 uploaded from this IP.
  check(anonymousStorage.used >= files.anon.size, 'anonymous storage.used includes step 1 (same IP)', anonymousStorage);
  if (daily) {
    note(`anonymous callers also get daily: ${JSON.stringify(daily)} (not in contract §6)`);
  }

  const signedIn = await OWNER.call('/users/@me/limits');
  equal(signedIn.status, 200, 'GET /api/users/@me/limits (signed in)');
  const { storage, upload_keys: keys, ...rest } = signedIn.data;
  equal(rest, SIGNED_IN_LIMITS, 'signed-in limits (decimal: single requests 100,000,000 bytes, chunked 1,000,000,000)');
  equal(storage.limit, 10 * GB, 'storage.limit (10 GB)');
  check(storage.used >= files.chunked.size, 'storage.used counts the uploads', storage);
  equal(keys.limit, 20, 'upload_keys.limit (20)');
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
  const list = await OWNER.call('/users/@me/files?limit=100');
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
  const unlocked = await api(`/access/unlock/files/${file.vanity}`, { method: 'POST', json: { password: 'preview-pass-1', turnstile_token: TURNSTILE_TOKEN } });
  equal(unlocked.status, 200, 'unlock');
  const url = unlocked.data.file.assets.thumb.url;
  check(isSigned(url), 'unlock signs preview URLs too', url);
  const signed = await request(url);
  equal([signed.status, signed.headers.get('cache-control')], [200, 'private, no-store'], 'signed thumb is private');
  equal((await request(withSignatureOf(unlocked.data.file.assets['thumb-2x'].url, url))).status, 401, 'a signature only works for its own path (thumb\'s on thumb-2x)');
  equal((await request(withSignatureOf(url, unlocked.data.file.cdn_url))).status, 401, '...and the file\'s signature doesn\'t open its preview');
  const other = await api(`/access/unlock/files/${files.password.vanity}`, { method: 'POST', json: { password: 'another-pass-2', turnstile_token: TURNSTILE_TOKEN } });
  equal((await request(withSignatureOf(url, other.data.file.cdn_url))).status, 401, 'another file\'s signature is refused');
});

await step('11. albums: create, page, collage, ZIP, link albums hide protected items, album passwords', async () => {
  const ids = [media.png.id, media.mp4.id, media.mp3.id, media.locked.id];
  const created = await OWNER.call('/users/@me/albums', { method: 'POST', json: { title: 'e2e album', description: 'made by e2e/run.mjs', file_ids: ids } });
  equal(created.status, 201, 'POST /users/@me/albums');
  const album = media.album = created.data;
  equal(album.items.map((item) => item.id), ids, 'items in order');
  equal(album.items.map((item) => item.shown), [true, true, true, false], 'the password file is hidden in a link album');

  const shell = parseShell((await page('/a/' + album.vanity)).text);
  equal([shell.page, shell.state], ['album', 'album'], 'album shell');
  equal(shell.data.items.map((item) => item.id), ids.slice(0, 3), 'the page shows only the link items');
  check(shell.meta.includes('<meta property="og:title" content="e2e album · 3 files">'), 'album og:title', shell.meta);

  const withCollage = await poll('the album collage', async () => {
    const owner = await OWNER.call(`/users/@me/albums/${album.id}`);
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
  const second = await OWNER.call('/users/@me/albums', { method: 'POST', json: { title: 'e2e locked album', file_ids: [media.png.id, media.locked.id] } });
  equal(second.status, 201, 'second album');
  const locked = await OWNER.call(`/users/@me/albums/${second.data.id}`, { method: 'PATCH', json: { visibility: 'password', password: 'album-pass-1' } });
  equal([locked.status, locked.data.visibility], [200, 'password'], 'PATCH album password');
  const lockedShell = parseShell((await page('/a/' + second.data.vanity)).text);
  equal([lockedShell.state, lockedShell.data], ['locked', { vanity: second.data.vanity, protected: 'password' }], 'locked album shell');
  equal((await request(plain(locked.data.download_url))).status, 401, 'ZIP without a signature');
  const unlocked = await api(`/access/unlock/albums/${second.data.vanity}`, { method: 'POST', json: { password: 'album-pass-1', turnstile_token: TURNSTILE_TOKEN } });
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
  const videos = await OWNER.call('/users/@me/files?type=video&limit=100');
  equal(videos.status, 200, 'GET /users/@me/files?type=video');
  check(videos.data.items.every((item) => item.kind === 'video') && videos.data.items.some((item) => item.id === media.mp4.id), 'type filter', videos.data.items.map((item) => item.kind));
  check(videos.data.total.count >= videos.data.count, 'total covers all files', videos.data);
  const byName = await OWNER.call('/users/@me/files?query=E2E-AUDIO');
  equal(byName.data.items.map((item) => item.id), [media.mp3.id], 'case-insensitive search');

  const expiring = await OWNER.call('/users/@me/files/expiry', { method: 'POST', json: { file_ids: [media.png.id], expires_in: 3600 } });
  check(expiring.status === 200 && expiring.data.items[0].expires_at > Date.now() / 1000, 'bulk expiry', expiring.data);
  const forever = await OWNER.call('/users/@me/files/expiry', { method: 'POST', json: { file_ids: [media.png.id], expires_in: null } });
  equal(forever.data.items[0].expires_at, null, 'Keep forever');

  equal((await OWNER.call(`/users/@me/files/${media.mp3.id}`, { method: 'DELETE' })).status, 204, 'DELETE a file');
  const album = await OWNER.call(`/users/@me/albums/${media.album.id}`);
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

  const session = await OWNER.call('/uploads', { method: 'POST', json: { filename: 'tool.bin', size: pe.length } });
  equal(session.status, 201, 'a chunked upload with a harmless name starts');
  refused(await OWNER.call(`/uploads/${session.data.upload_id}/chunks/0`, { method: 'PUT', body: pe }), 'its first chunk is a program');
  const state = await OWNER.call(`/uploads/${session.data.upload_id}`);
  equal([state.data.status, state.data.error], ['failed', 'FILE_TYPE_NOT_ALLOWED'], 'and the session is failed');

  const ok = await uploadFile(OWNER, { bytes: Buffer.from('MZ was here.\n'), filename: 'mz.txt', type: 'text/plain' });
  equal(ok.status, 200, 'a text file that merely starts with "MZ" is fine');
});


// --- Milestone 4: trust & safety -------------------------------------------------------------------

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
const anonymousHeaders = () => visitor();
const anonymousUpload = (caller, file) => uploadFile(caller, { ...file, fields: { ...(file.fields || {}), turnstile_token: TURNSTILE_TOKEN } });

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
async function noticeFor(caller, noticeId) {
  const list = await caller.call('/users/@me/warnings?limit=100');
  equal(list.status, 200, 'GET /api/users/@me/warnings');
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
  equal([anon.status, anon.data && anon.data.safety && anon.data.safety.state], [200, 'pending'], `anonymous upload: accepted, pending (${anon.text.slice(0, 300)})`);
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
  // e2e.member's public file, reported by an anonymous visitor and by e2e.reporter.
  const bytes = noisePng(320, 240);
  const created = await uploadFile(AS_MEMBER, { bytes, filename: 'e2e-reported.png', type: 'image/png' });
  equal(created.status, 200, 'e2e.member uploads a file');
  const file = created.data;
  equal((await waitScanned(file, AS_MEMBER, 'step 17 reported PNG')).safety.state, 'ok', 'scanned: ok');
  const before = await page(vanityPath(file));
  equal([before.status, parseShell(before.text).state], [200, 'file'], 'the page before the reports');
  equal((await request(file.cdn_url)).status, 200, 'the CDN before the reports');

  const target = { type: 'file', vanity: file.vanity };
  const fp = await anonymousHeaders();
  const noCaptcha = await fp.call('/reports/anonymous', { method: 'POST', json: { target, reason: 'spam' } });
  equal([noCaptcha.status, noCaptcha.data.code], [403, 'CAPTCHA_INVALID'], 'an anonymous report without Turnstile');
  const anonymous = await fp.call('/reports/anonymous', { method: 'POST', json: { target, reason: 'spam', details: 'e2e: anonymous report', turnstile_token: TURNSTILE_TOKEN } });
  equal([anonymous.status, anonymous.data.status, anonymous.data.report], [201, 'open', undefined], 'anonymous report: 201 { id, status: open }, no thread');
  check(/^\d+$/.test(anonymous.data.id), 'with an id', anonymous.data);

  const own = await AS_MEMBER.call('/reports', { method: 'POST', json: { target, reason: 'spam' } });
  equal([own.status, own.data.code], [400, 'CANNOT_REPORT_YOURSELF'], 'the owner can\'t report their own file');
  const signedIn = await AS_REPORTER.call('/reports', { method: 'POST', json: { target: { type: 'url', url: file.url }, reason: 'spam', details: 'e2e: signed-in report' } });
  equal(signedIn.status, 201, 'e2e.reporter reports it (a files.localhost URL target)');
  const report = signedIn.data.report;
  equal([report.kind, report.reason, report.status, report.target.vanity, report.target.url], ['file', 'spam', 'open', file.vanity, `${MAIN}/${file.vanity}`], 'the reporter\'s report (§7.5: no filename, no state)');
  // Two `spam` reports are under the threshold of 3 (§7.3): nothing happens automatically.
  equal(parseShell((await page(vanityPath(file))).text).state, 'file', 'still served after two spam reports');

  // Staff: the case in the queue, claim it, hide the file.
  const queue = await OWNER.call('/admin/cases?status=open&kind=file&reason=spam&limit=100');
  equal(queue.status, 200, 'GET /admin/cases as staff');
  const summary = queue.data.items.find((item) => item.target && item.target.id === file.id);
  check(summary, 'the file\'s case is in the queue', queue.data.items.map((item) => item.target));
  equal([summary.kind, summary.priority, summary.status, summary.reasons, summary.report_count, summary.assignee],
    ['file', 3, 'open', { spam: 2 }, 2, null], 'case summary: file, P3, open, 2 spam reports, unassigned');
  note(`distinct_reporters = ${summary.distinct_reporters} (both reports come from the same local IP hash, §7.4)`);
  const claimed = await OWNER.call(`/admin/cases/${summary.id}/claim`, { method: 'POST' });
  equal([claimed.status, claimed.data.assignee && claimed.data.assignee.id], [200, E2E_USER.id], 'claim: assigned to e2e');
  check(claimed.data.reports.length === 2 && claimed.data.reports.every((r) => r.reason === 'spam'), 'the case lists both reports', claimed.data.reports);
  const hidden = await OWNER.call('/admin/actions', { method: 'POST', json: {
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
  const ownerFile = await AS_MEMBER.call(`/users/@me/files/${file.id}`);
  equal([ownerFile.data.safety.state, ownerFile.data.safety.reason, ownerFile.data.safety.notice_id], ['hidden', 'spam', hidden.data.notice_ids[0]], 'the owner file: hidden (spam), with the notice');
  const notice = await noticeFor(AS_MEMBER, hidden.data.notice_ids[0]);
  check(notice, 'the notice is in GET /users/@me/warnings', hidden.data.notice_ids[0]);
  equal([notice.action, notice.rule, notice.rule_text, notice.message, notice.target.vanity, notice.acknowledged_at, notice.appeal.state, notice.appeal.can_appeal],
    ['hide', 'spam', 'Spam', 'e2e: hidden after reports', file.vanity, null, 'none', true], 'the notice');
  const badges = await AS_MEMBER.call('/users/@me/badges');
  equal(badges.status, 200, 'GET /users/@me/badges');
  check(badges.data.notices_unacknowledged >= 1 && badges.data.staff === null, 'badges: an unacknowledged notice, not staff', badges.data);

  // The owner appeals, once.
  const appeal = await AS_MEMBER.call(`/users/@me/warnings/${notice.id}/appeal`, { method: 'POST', json: { message: 'e2e: this is not spam' } });
  equal([appeal.status, appeal.data.appeal.state, appeal.data.appeal.can_appeal], [200, 'open', false], 'appeal: open');
  const second = await AS_MEMBER.call(`/users/@me/warnings/${notice.id}/appeal`, { method: 'POST', json: { message: 'again' } });
  equal([second.status, second.data.code], [409, 'APPEAL_NOT_ALLOWED'], 'a second appeal');
  const acknowledged = await AS_MEMBER.call('/users/@me/warnings/acknowledge', { method: 'POST', json: { ids: [notice.id] } });
  equal(acknowledged.data.acknowledged, [notice.id], 'acknowledge the notice');

  // The signed-in reporter follows the report: open until the case is closed, then resolved, with
  // a message from "files.gg staff".
  equal((await AS_REPORTER.call(`/users/@me/reports/${report.id}`)).data.status, 'open', 'the reporter sees it open');
  const closed = await OWNER.call(`/admin/cases/${summary.id}/close`, { method: 'POST', json: { outcome: 'actioned', reason: 'e2e: hidden for spam' } });
  equal([closed.status, closed.data.status, closed.data.outcome], [200, 'closed', 'actioned'], 'close the case (actioned)');
  const resolved = await AS_REPORTER.call(`/users/@me/reports/${report.id}`);
  equal([resolved.data.status, resolved.data.closed], ['resolved', false], 'the reporter sees it resolved');
  check(resolved.data.unread >= 1, 'with something unread', resolved.data);
  const listed = await AS_REPORTER.call('/users/@me/reports?status=resolved');
  check(listed.data.items.some((item) => item.id === report.id), 'in My reports (resolved)', listed.data);
  const thread = await AS_REPORTER.call(`/users/@me/reports/${report.id}/messages`);
  check(thread.data.items.some((item) => item.author === 'staff'), 'a message from staff in the thread', thread.data.items);
  equal((await AS_REPORTER.call(`/users/@me/reports/${report.id}`)).data.unread, 0, 'reading the thread marks it read');
  const badgesReporter = await AS_REPORTER.call('/users/@me/badges');
  equal(badgesReporter.data.reports_unread, 0, 'the reporter\'s badges: nothing unread');

  // The appeal is a case for staff; e2e is the only staff member, so it may decide its own action (§9.4).
  const appeals = await OWNER.call('/admin/cases?status=open&kind=appeal&needs_second_review=true&limit=100');
  const appealCase = appeals.data.items.find((item) => item.target && item.target.id === notice.id);
  check(appealCase, 'the appeal case is in the queue', appeals.data.items.map((item) => item.target));
  equal([appealCase.priority, appealCase.needs_second_review], [2, true], 'appeal case: P2, needs second review');
  const granted = await OWNER.call(`/admin/cases/${appealCase.id}/appeal`, { method: 'POST', json: { decision: 'grant', message: 'e2e: appeal granted' } });
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
  const meStaff = await OWNER.call('/users/@me');
  equal(meStaff.data.staff, { role: 'admin', child_safety: true }, 'GET /users/@me: e2e is staff (granted by up.sh)');
  equal((await AS_MEMBER.call('/users/@me')).data.staff, null, 'e2e.member isn\'t');
  equal((await OWNER.call('/admin/cases')).status, 200, 'staff: GET /admin/cases');
  const summary = await OWNER.call('/admin/summary');
  equal(summary.status, 200, 'staff: GET /admin/summary');
  equal(summary.data.scans_stalled, 0, 'no stalled scans');
  const staffBadges = await OWNER.call('/users/@me/badges');
  check(staffBadges.data.staff && typeof staffBadges.data.staff.open === 'number', 'staff badges', staffBadges.data);

  const unknown = await AS_MEMBER.call('/admin/no-such-route');
  equal(unknown.status, 404, 'an unknown route is 404');
  for (const [who, caller] of [['e2e.member', AS_MEMBER], ['e2e.reporter', AS_REPORTER], ['signed out', new Caller('signed out')]]) {
    for (const path of ['/admin/cases', '/admin/summary', `/admin/files/${files.anon.id}`]) {
      const response = await caller.call(path);
      equal([response.status, response.text], [404, unknown.text], `${who}: GET /api${path} is the unknown-route 404`);
    }
  }
  // the session cookie never reaches the API through api.files.localhost, so staff are signed out there
  const viaApiHost = await api('/admin/cases', { headers: { cookie: `${SESSION_COOKIE}=${OWNER.cookie}` } });
  equal(viaApiHost.status, 404, 'staff\'s cookie sent to api.files.localhost: /admin/cases is the unknown-route 404');
  const action = await AS_MEMBER.call('/admin/actions', { method: 'POST', json: { action: 'hide', target: { type: 'file', id: files.anon.id }, rule: 'spam' } });
  equal(action.status, 404, 'e2e.member: POST /admin/actions is 404');
  equal(parseShell((await page(vanityPath(files.anon))).text).state, 'file', 'and changed nothing');
});


// --- Milestone 6: accounts (docs/redesign/contracts/milestone-6.md) ---------------------------------------------

await step('20. sessions: HttpOnly cookie on files.localhost only, CSRF, no Bearer, logout, sign out everywhere, password change', async () => {
  const user = makeUser('sess');
  // Sign-in as /app/login does it: the cookie is set on files.localhost, and the token is never in the body.
  const first = await signIn(user.email, user.password, { label: 'session A' });
  const set = first.lastCookie;
  check(set.attributes.includes('HttpOnly') && set.attributes.includes('SameSite=Lax') && set.attributes.includes('Path=/'), 'Set-Cookie is HttpOnly, SameSite=Lax, Path=/', set.raw);
  check(!set.attributes.some((attribute) => /^domain=/i.test(attribute)), 'no Domain attribute: host-only on files.localhost', set.raw);
  check(/^fgs_[0-9A-Za-z]{36}$/.test(first.cookie), 'the session token is fgs_ + 36 base62 characters (§3.2, §7.1)', first.cookie);

  const session = await first.call('/auth/session');
  equal([session.status, session.data.user && session.data.user.username], [200, user.username], 'GET /api/auth/session');
  const signedOut = await new Caller('no cookie').call('/auth/session');
  equal([signedOut.status, signedOut.data], [200, { user: null }], 'GET /api/auth/session without a cookie: 200 { user: null }, never 401');
  // The dev tool's printed session (the cookie you'd set with devtools) is a normal session too.
  const printed = new Caller('printed session', { cookie: user.session.value });
  equal(user.session.name, SESSION_COOKIE, 'tools.create_user names the local cookie filesgg_session');
  equal((await printed.call('/auth/session')).data.user.username, user.username, 'the session tools.create_user printed works as the cookie');

  // The Worker forwards the cookie only on files.localhost/api: api.files.localhost has no X-Filesgg-Via,
  // so the API ignores it (and a client's own X-Filesgg-Via is stripped).
  const cookieHeader = { cookie: `${SESSION_COOKIE}=${first.cookie}` };
  for (const [label, headers] of [['the cookie', cookieHeader], ['the cookie and a forged X-Filesgg-Via: main', { ...cookieHeader, 'x-filesgg-via': 'main' }]]) {
    const me = await api('/users/@me', { headers });
    equal([me.status, me.data && me.data.code], [401, 'UNAUTHORIZED'], `api.files.localhost/users/@me with ${label}`);
    equal((await api('/auth/session', { headers })).data, { user: null }, `api.files.localhost/auth/session with ${label}: { user: null }`);
    check(!me.headers.getSetCookie().length, `api.files.localhost never sets a cookie (${label})`, me.headers.getSetCookie());
  }

  // CSRF (§3.6): a cookie write needs X-Filesgg-Csrf: 1, a same-origin Origin and Sec-Fetch-Site when sent.
  const rename = (options) => first.call('/users/@me', { method: 'PATCH', json: { display_name: 'E2E Sessions' }, ...options });
  for (const [label, options] of [
    ['without X-Filesgg-Csrf', { csrf: false }],
    ['with a foreign Origin', { headers: { origin: 'http://evil.localhost:8787' } }],
    ['with Origin: null (a sandboxed CDN document)', { headers: { origin: 'null', 'sec-fetch-site': 'same-site' } }],
    ['with Sec-Fetch-Site: cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }],
  ]) {
    const refused = await rename(options);
    equal([refused.status, refused.data && refused.data.code], [403, 'CSRF'], `PATCH /api/users/@me ${label}`);
  }
  const renamed = await rename({ headers: { origin: MAIN, 'sec-fetch-site': 'same-origin' } });
  equal([renamed.status, renamed.data.display_name], [200, 'E2E Sessions'], 'PATCH /api/users/@me with the header, Origin and Sec-Fetch-Site of files.localhost');
  const forgedLogin = await new Caller('forged login').call('/auth/login', { method: 'POST', csrf: false, json: { email: user.email, password: user.password, turnstile_token: TURNSTILE_TOKEN } });
  equal([forgedLogin.status, forgedLogin.data.code], [403, 'CSRF'], 'POST /api/auth/login without X-Filesgg-Csrf (every /auth/* POST is checked, cookie or not)');

  // Authorization: Bearer is never a session, on either host.
  for (const [label, base] of [['files.localhost/api', WEB_API], ['api.files.localhost', API]]) {
    const bearer = await request(`${base}/users/@me`, { headers: { authorization: `Bearer ${first.cookie}` } });
    equal([bearer.status, bearer.data && bearer.data.code], [401, 'UNAUTHORIZED'], `${label}: Authorization: Bearer <the session token> is 401`);
  }

  // Logout ends this session and clears the cookie.
  const second = await signIn(user.email, user.password, { label: 'session B' });
  const listed = await second.call('/users/@me/sessions');
  equal(listed.status, 200, 'GET /api/users/@me/sessions');
  check(listed.data.items.length >= 3 && listed.data.items.filter((item) => item.current).length === 1, 'three sessions (A, B and the printed one), one of them current', listed.data.items);
  check(listed.data.items.every((item) => !JSON.stringify(item).includes('fgs_')), 'no token in the session list', listed.data.items);
  const secondToken = second.cookie;
  const logout = await second.call('/auth/logout', { method: 'POST' });
  equal(logout.status, 204, 'POST /api/auth/logout');
  check(logout.headers.getSetCookie().some((line) => line.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/.test(line)), 'logout clears the cookie (empty, Max-Age=0)', logout.headers.getSetCookie());
  equal(second.cookie, null, 'the jar is empty after logout');
  const reused = new Caller('old cookie B', { cookie: secondToken });
  equal((await reused.call('/users/@me')).status, 401, 'the logged-out session\'s cookie is refused (401)');
  equal((await first.call('/users/@me')).status, 200, 'session A still works');

  // A password change ends every other session; the current one stays.
  const third = await signIn(user.email, user.password, { label: 'session C' });
  const newPassword = `e2e-changed-${hex(8)}`;
  const wrongCurrent = await third.call('/users/@me/password', { method: 'PUT', json: { current_password: 'not-the-password', new_password: newPassword } });
  equal([wrongCurrent.status, wrongCurrent.data.code], [400, 'INVALID_CREDENTIALS'], 'PUT /api/users/@me/password with a wrong current password');
  const changed = await third.call('/users/@me/password', { method: 'PUT', json: { current_password: user.password, new_password: newPassword } });
  equal(changed.status, 204, 'PUT /api/users/@me/password');
  equal((await third.call('/users/@me')).status, 200, 'the session that changed it still works');
  equal((await first.call('/users/@me')).status, 401, 'session A was ended by the password change');
  equal((await printed.call('/users/@me')).status, 401, 'so was the printed session');
  const oldLogin = await new Caller('old password').call('/auth/login', { method: 'POST', json: { email: user.email, password: user.password, turnstile_token: TURNSTILE_TOKEN } });
  equal([oldLogin.status, oldLogin.data.code], [400, 'INVALID_CREDENTIALS'], 'the old password no longer signs in');

  // Sign out everywhere ends every session, including this one, and clears the cookie.
  const fourth = await signIn(user.email, newPassword, { label: 'session D' });
  const everywhere = await third.call('/users/@me/sessions', { method: 'DELETE' });
  equal([everywhere.status, everywhere.data.revoked], [200, 2], 'DELETE /api/users/@me/sessions (sign out everywhere): C and D');
  equal(third.cookie, null, 'and clears this browser\'s cookie');
  equal((await fourth.call('/users/@me')).status, 401, 'the other session (D) is ended');
  const deadCookie = await fourth.call('/auth/session');
  equal(deadCookie.data, { user: null }, 'GET /api/auth/session with a dead cookie: { user: null }');
  equal(fourth.cookie, null, '...and the dead cookie is cleared');
});

await step('21. register: a new unverified account, username checks, and it claims the anonymous uploads of its guest', async () => {
  const config = await new Caller('visitor').call('/auth/config');
  equal([config.status, config.data.discord], [200, false], 'GET /api/auth/config: Discord is off locally (DISCORD_* unset)');
  // milestone-7 §11: the country is wrangler dev's (where this runs). The suite marks files as adult, so it needs a
  // country where that's available; the minimum age is 16 in the EU and EEA, 13 elsewhere.
  equal(config.data.adult_content_available, true, 'GET /api/auth/config: adult content is available here (e2e must not run from a blocked country)');
  check([13, 16].includes(config.data.minimum_age), 'GET /api/auth/config: minimum_age is 13 or 16 (the Worker forwarded a country)', config.data);
  const discord = await new Caller('visitor').call('/auth/discord/authorize', { method: 'POST', json: { purpose: 'login', code_challenge: 'SkrKhQFbMBX5ptYerKJJajG2CIJ-X_1O1IyRGzbnMZ8' } });
  equal([discord.status, discord.data.code], [503, 'DISCORD_UNAVAILABLE'], 'POST /api/auth/discord/authorize: 503 DISCORD_UNAVAILABLE');

  // `register` is limited to 5 an hour per IP: this run registers from an address of its own.
  const ip = clientIp();
  const browser = await visitor(fromIp(ip));
  const username = `e2e_new_${hex(4)}`;
  const availability = async (name) => (await browser.call(`/users/@me/username/check?username=${encodeURIComponent(name)}`)).data;
  equal(await availability(username.toUpperCase()), { username, available: true }, 'GET /users/@me/username/check, signed out: lowercased and available');
  equal(await availability('e2e'), { username: 'e2e', available: false, reason: 'taken' }, 'an existing username is taken');
  equal((await availability('admin')).reason, 'reserved', 'a reserved username');
  equal((await availability('e2e-new')).reason, 'characters', 'a hyphen isn\'t allowed');

  // Uploaded before signing up, from this browser (same guest).
  const bytes = randomBytes(8 * 1024);
  const before = await anonymousUpload(browser, { bytes, filename: 'e2e-before-register.bin' });
  equal(before.status, 200, 'anonymous upload before registering');
  check(before.data.expires_at !== null, 'it expires, like every anonymous upload', before.data);

  const email = `${username.replace(/_/g, '.')}@files.gg`;
  const password = `e2e-${hex(10)}`;
  const registered = await browser.call('/auth/register', { method: 'POST', json: { email, username: username.toUpperCase(), password, display_name: 'E2E New', turnstile_token: TURNSTILE_TOKEN } });
  equal(registered.status, 201, 'POST /api/auth/register');
  const user = registered.data.user;
  equal([user.username, user.display_name, user.email, user.email_verified, user.has_password, user.premium.active, user.staff],
    [username, 'E2E New', email, false, true, false, null], 'a new account: lowercased username, unverified email, not premium, not staff');
  check(typeof registered.data.expires_at === 'number' && !registered.text.includes('fgs_'), 'the body has expires_at and no token', registered.data);
  check(typeof browser.cookie === 'string' && browser.cookie.startsWith('fgs_'), 'register signs in with the session cookie', registered.headers.getSetCookie());
  equal((await browser.call('/users/@me')).data.email_verified, false, 'GET /api/users/@me: unverified, and usable at once');
  equal(await availability(username), { username, available: true }, 'signed in as its owner, the username is "available" (it\'s yours)');
  const others = await visitor(fromIp(ip));
  equal((await others.call(`/users/@me/username/check?username=${username}`)).data, { username, available: false, reason: 'taken' }, 'to anyone else the username is taken now');
  const again = await (await visitor(fromIp(ip))).call('/auth/register', { method: 'POST', json: { email: email.toUpperCase(), username: `${username}x`, password, turnstile_token: TURNSTILE_TOKEN } });
  equal([again.status, again.data.code, Object.keys(again.data.errors || {})], [400, 'EMAIL_TAKEN', ['email']], 'the same email again (any case): EMAIL_TAKEN on the email field');

  // §4.2: the guest's upload moved into the account, and keeps its expiry.
  const claimed = await browser.call(`/users/@me/files/${before.data.id}`);
  equal(claimed.status, 200, 'the anonymous upload is the new account\'s file');
  equal(claimed.data.expires_at, before.data.expires_at, 'and keeps its expiry');
  const listed = await browser.call('/users/@me/files?limit=100');
  check(listed.data.items.some((item) => item.id === before.data.id), 'it\'s in the account\'s library', listed.data.items.map((item) => item.id));
});

await step('22. upload keys: shown once, upload to api.files.localhost, refused elsewhere, revoked; anonymous tools need a key', async () => {
  const created = await OWNER.call('/users/@me/upload-keys', { method: 'POST', json: { name: 'e2e run.mjs' } });
  equal(created.status, 201, 'POST /api/users/@me/upload-keys');
  const { key, secret, sharex, curl } = created.data;
  check(/^fgg_[0-9A-Za-z]{36}$/.test(secret), 'the secret is fgg_ + 36 base62 characters (§7.1)', secret);
  equal([key.name, key.prefix, key.scopes, key.state, key.domain], ['e2e run.mjs', secret.slice(0, 12), ['files:upload'], 'active', null], 'the key object (prefix = the first 12 characters)');
  equal([sharex.Version, sharex.RequestURL, sharex.Headers.Authorization, sharex.FileFormName, sharex.URL], ['17.0.0', `${API}/files`, `Key ${secret}`, 'file', '{json:url_with_password}'], 'the ShareX .sxcu (RequestURL is API_PUBLIC_URL/files; URL is url_with_password, milestone-5 §21)');
  check(curl.includes(`Authorization: Key ${secret}`) && curl.includes(`${API}/files`), 'the curl snippet', curl);
  const listed = await OWNER.call('/users/@me/upload-keys');
  equal(listed.status, 200, 'GET /api/users/@me/upload-keys');
  check(listed.data.items.some((item) => item.id === key.id) && !listed.text.includes(secret), 'listed, and the secret is never shown again', listed.data);

  // A tool uploads to api.files.localhost with the key (no guest, no Turnstile).
  const sharexTool = tool(secret);
  const bytes = randomBytes(48 * 1024);
  const uploaded = await uploadFile(sharexTool, { bytes, filename: 'e2e-sharex.bin' });
  equal(uploaded.status, 200, 'POST api.files.localhost/files with Authorization: Key');
  equal(uploaded.data.expires_at, null, 'the key\'s owner (signed in): no forced expiry');
  const mine = await OWNER.call(`/users/@me/files/${uploaded.data.id}`);
  equal(mine.status, 200, 'the file is e2e\'s (GET /api/users/@me/files/<id> with the cookie)');
  equal((await waitScanned(uploaded.data, OWNER, 'step 22 upload-key file')).safety.state, 'ok', 'scanned: ok');
  equal(sha256((await request(uploaded.data.cdn_url)).buffer), sha256(bytes), 'CDN bytes (sha256)');
  // a chunked upload with the key, start to finish
  const chunkedBytes = randomBytes(64 * 1024);
  const session = await sharexTool.call('/uploads', { method: 'POST', json: { filename: 'e2e-key-chunked.bin', size: chunkedBytes.length } });
  equal(session.status, 201, 'POST /uploads with the key');
  equal((await sharexTool.call(`/uploads/${session.data.upload_id}/chunks/0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: chunkedBytes })).status, 204, 'PUT the chunk with the key');
  equal((await sharexTool.call(`/uploads/${session.data.upload_id}/complete`, { method: 'POST' })).status, 202, 'complete with the key');
  const finished = await poll('the key\'s chunked upload', async () => {
    const status = await sharexTool.call(`/uploads/${session.data.upload_id}`);
    return { done: ['complete', 'failed'].includes(status.data.status), state: status.data };
  }, { timeoutMs: 60_000, intervalMs: 500 });
  equal(finished.state.status, 'complete', 'the chunked upload completes');
  equal((await OWNER.call(`/users/@me/files/${finished.state.file.id}`)).status, 200, 'and is e2e\'s file');

  // A key authenticates the upload endpoints only (§7.2, §7.4).
  for (const [method, path] of [['GET', '/users/@me'], ['GET', '/users/@me/files'], ['DELETE', `/users/@me/files/${uploaded.data.id}`], ['POST', '/users/@me/albums'], ['GET', '/users/@me/upload-keys']]) {
    const refused = await sharexTool.call(path, { method, json: method === 'POST' ? { title: 'nope' } : undefined });
    equal([refused.status, refused.data && refused.data.code], [403, 'UPLOAD_KEY_NOT_ALLOWED'], `the key on ${method} api.files.localhost${path}`);
  }
  equal((await sharexTool.call('/admin/cases')).status, 404, 'the key on /admin/cases: the plain 404');
  const onWebsite = new Caller('key on the website', { headers: { authorization: `Key ${secret}` } });
  for (const [method, path] of [['GET', '/users/@me'], ['POST', '/users/@me/upload-keys']]) {
    const refused = await onWebsite.call(path, { method, json: method === 'POST' ? { name: 'nope' } : undefined });
    equal([refused.status, refused.data && refused.data.code], [403, 'UPLOAD_KEY_NOT_ALLOWED'], `the key on ${method} files.localhost/api${path}`);
  }
  equal((await OWNER.call(`/users/@me/files/${uploaded.data.id}`)).status, 200, 'the file wasn\'t deleted by the key');

  // Revoked: refused at once.
  equal((await OWNER.call(`/users/@me/upload-keys/${key.id}`, { method: 'DELETE' })).status, 204, 'DELETE /api/users/@me/upload-keys/<id> (revoke)');
  const revoked = await uploadFile(sharexTool, { bytes: randomBytes(1024), filename: 'after-revoke.bin' });
  equal([revoked.status, revoked.data && revoked.data.code], [401, 'UPLOAD_KEY_INVALID'], 'an upload with the revoked key');
  equal((await OWNER.call('/users/@me/upload-keys')).data.items.find((item) => item.id === key.id).state, 'revoked', 'listed as revoked');
  const typo = await uploadFile(tool(secret.slice(0, -1) + (secret.at(-1) === 'A' ? 'B' : 'A')), { bytes: randomBytes(1024), filename: 'typo.bin' });
  equal([typo.status, typo.data && typo.data.code], [401, 'UPLOAD_KEY_INVALID'], 'a key with a bad checksum');

  // Anonymous tools: no credential and no turnstile_token at all.
  const noKey = await uploadFile(new Caller('anonymous tool', { base: API }), { bytes: randomBytes(1024), filename: 'curl.bin' });
  equal([noKey.status, noKey.data && noKey.data.code], [401, 'UPLOAD_KEY_REQUIRED'], 'POST api.files.localhost/files with no key and no Turnstile');
  const noKeyChunked = await api('/uploads', { method: 'POST', json: { filename: 'curl.bin', size: 1024 } });
  equal([noKeyChunked.status, noKeyChunked.data && noKeyChunked.data.code], [401, 'UPLOAD_KEY_REQUIRED'], 'POST /uploads with no key and no Turnstile');
});

async function limitsOf(caller) {
  const response = await caller.call('/users/@me/limits');
  equal(response.status, 200, 'GET /api/users/@me/limits');
  const { storage, upload_keys: keys, daily, ...rest } = response.data;
  return { storage, rest };
}

await step('23. premium: granted by an admin and by the CLI, limits rise (100 GB, 5 GB chunked, single stays 100 MB), revoked, back', async () => {
  const user = makeUser('prem');
  const member = new Caller('premium candidate', { cookie: user.session.value });
  const twoGb = { filename: 'e2e-big.bin', size: 2 * GB };

  const before = await limitsOf(member);
  equal(before.rest, SIGNED_IN_LIMITS, 'signed-in limits before');
  equal(before.storage.limit, 10 * GB, 'storage.limit 10 GB');
  const tooBig = await member.call('/uploads', { method: 'POST', json: twoGb });
  equal([tooBig.status, tooBig.data.code, tooBig.data.limit], [413, 'FILE_TOO_LARGE', GB], 'a 2 GB chunked upload is too large without premium');

  // An admin grants it (POST /admin/users/<id>/entitlements); a non-admin can't.
  const notStaff = await AS_MEMBER.call(`/admin/users/${user.id}/entitlements`, { method: 'POST', json: { kind: 'premium', note: 'e2e' } });
  equal(notStaff.status, 404, 'e2e.member: POST /admin/users/<id>/entitlements is the plain 404');
  const granted = await OWNER.call(`/admin/users/${user.id}/entitlements`, { method: 'POST', json: { kind: 'premium', note: 'e2e/run.mjs: premium step' } });
  equal(granted.status, 201, 'staff (admin): POST /api/admin/users/<id>/entitlements');
  equal([granted.data.kind, granted.data.active, granted.data.expires_at, granted.data.granted_by && granted.data.granted_by.id], ['premium', true, null, E2E_USER.id], 'the entitlement');
  const twice = await OWNER.call(`/admin/users/${user.id}/entitlements`, { method: 'POST', json: { kind: 'premium', note: 'again' } });
  equal([twice.status, twice.data.code], [409, 'ENTITLEMENT_EXISTS'], 'granting it twice');
  const premium = await limitsOf(member);
  equal(premium.rest, PREMIUM_LIMITS, 'premium limits: 5 GB chunked, 5 domains, domain-only; a single request stays 100 MB');
  equal(premium.storage.limit, 100 * GB, 'storage.limit 100 GB');
  equal((await member.call('/users/@me')).data.premium, { active: true, expires_at: null }, 'GET /api/users/@me: premium');
  const big = await member.call('/uploads', { method: 'POST', json: twoGb });
  equal(big.status, 201, 'a 2 GB chunked upload is accepted with premium');
  equal((await member.call(`/uploads/${big.data.upload_id}`, { method: 'DELETE' })).status, 204, '(and cancelled)');

  const revoked = await OWNER.call(`/admin/users/${user.id}/entitlements/${granted.data.id}`, { method: 'DELETE', json: { note: 'e2e/run.mjs: revoke' } });
  equal([revoked.status, revoked.data.active, typeof revoked.data.revoked_at], [200, false, 'number'], 'DELETE /api/admin/users/<id>/entitlements/<eid>');
  equal((await limitsOf(member)).rest, SIGNED_IN_LIMITS, 'the signed-in limits are back at once');
  equal((await member.call('/uploads', { method: 'POST', json: twoGb })).status, 413, 'and 2 GB is too large again');

  // The production CLI, as an operator would run it.
  const cliGrant = apiTool(['tools.entitlements', 'grant', user.id, '--kind', 'premium', '--days', '30', '--by', 'e2e/run.mjs', '--note', 'e2e: CLI grant']);
  check(cliGrant.active === true && cliGrant.expires_at > Date.now() / 1000 + 29 * 86400, 'python -m tools.entitlements grant --days 30', cliGrant);
  const viaCli = await limitsOf(member);
  equal([viaCli.rest.premium, viaCli.rest.max_file_size_chunked, viaCli.storage.limit], [true, 5 * GB, 100 * GB], 'premium limits again');
  const listedCli = apiTool(['tools.entitlements', 'list']);
  check(listedCli.some((row) => row.user_id === user.id), 'tools.entitlements list shows it', listedCli);
  const cliRevoke = apiTool(['tools.entitlements', 'revoke', user.id, '--by', 'e2e/run.mjs', '--note', 'e2e: CLI revoke']);
  equal(cliRevoke.active, false, 'python -m tools.entitlements revoke');
  const after = await limitsOf(member);
  equal([after.rest, after.storage.limit], [SIGNED_IN_LIMITS, 10 * GB], 'back to the signed-in limits');
  const history = await OWNER.call(`/admin/users/${user.id}`);
  equal(history.status, 200, 'GET /api/admin/users/<id>');
  equal([history.data.premium, history.data.entitlements.length], [{ active: false, expires_at: null }, 2], 'the admin detail: not premium, two entitlements in the history');
});

const mockHostnames = async () => (await request(`${MOCK_CLOUDFLARE}/_mock/hostnames`)).data.items;

await step('24. custom domain: mock Cloudflare to active, served with rehosted signed URLs, only my files, domain-only, isn\'t connected, no staff grant', async () => {
  // A fresh premium account per run (tools.create_user --premium), and a hostname of its own: *.localhost
  // reaches the same wrangler dev, which sends every host it doesn't know to the custom-host router.
  const owner = makeUser('dom', { premium: true });
  const DOM = new Caller('domain owner', { cookie: owner.session.value });
  const host = `files-${hex(3)}.example.localhost`;
  const CUSTOM = `http://${host}:${PORT}`;
  note(`custom domain ${CUSTOM}`);

  const notPremium = await AS_MEMBER.call('/users/@me/domains', { method: 'POST', json: { hostname: host } });
  equal([notPremium.status, notPremium.data.code], [403, 'PREMIUM_REQUIRED'], 'not premium: 403 PREMIUM_REQUIRED');
  const tooNew = await DOM.call('/users/@me/domains', { method: 'POST', json: { hostname: host } });
  equal([tooNew.status, tooNew.data.code, tooNew.data.reason], [403, 'DOMAIN_REQUIREMENTS', 'account_too_new'], 'premium, but the account is minutes old (§10.13: 7 days)');
  equal(psql(`UPDATE users SET created_at = now() - interval '8 days' WHERE id = ${BigInt(owner.id)} RETURNING id`), owner.id, 'the account made 8 days old (psql)');
  const apex = await DOM.call('/users/@me/domains', { method: 'POST', json: { hostname: 'example.com' } });
  equal([apex.status, apex.data.code, apex.data.reason], [400, 'INVALID_HOSTNAME', 'apex'], 'an apex hostname');

  const added = await DOM.call('/users/@me/domains', { method: 'POST', json: { hostname: `${host.toUpperCase()}.` } });
  equal(added.status, 201, 'POST /api/users/@me/domains');
  const domain = added.data;
  equal([domain.hostname, domain.status, domain.serving, domain.scope, domain.cloudflare], [host, 'pending_dns', false, 'own', { status: 'pending', ssl_status: 'initializing' }], 'pending_dns, not serving, scope own, Cloudflare pending');
  equal(domain.records.map((record) => [record.type, record.name]), [['CNAME', host], ['TXT', `_filesgg-verify.${host}`]], 'the CNAME and TXT records to add');
  const created = (await mockHostnames()).find((item) => item.hostname === host);
  check(created && created.ssl && created.ssl.method === 'http' && created.ssl.type === 'dv', 'the API created the custom hostname at (mock) Cloudflare with HTTP DCV', created);

  const pending = await request(`${CUSTOM}/`);
  equal([pending.status, pending.headers.get('cache-control')], [404, 'no-cache'], 'while pending, the custom host is the 404 page');
  check(pending.text.includes('This domain isn\'t connected to files.gg right now.'), '"This domain isn\'t connected to files.gg right now."', pending.text);

  // "Check now": the DNS stub sees both records, and the mock goes active on the re-check.
  const verified = await DOM.call(`/users/@me/domains/${domain.id}/verify`, { method: 'POST' });
  equal(verified.status, 200, 'POST /api/users/@me/domains/<id>/verify');
  equal([verified.data.status, verified.data.serving, verified.data.cloudflare, verified.data.records.map((record) => record.ok)],
    ['active', true, { status: 'active', ssl_status: 'active' }, [true, true]], 'active and serving');
  check(typeof verified.data.verified_at === 'number', 'verified_at is set', verified.data);
  const tooSoon = await DOM.call(`/users/@me/domains/${domain.id}/verify`, { method: 'POST' });
  equal([tooSoon.status, tooSoon.data.code], [429, 'DOMAIN_CHECK_RATE_LIMITED'], 'Check now again within a minute');
  equal((await DOM.call(`/users/@me/domains/${domain.id}`, { method: 'PATCH', json: { default: true } })).data.is_default, true, 'set as the default domain');

  // The owner's files: a link file and a password file, uploaded on the website.
  const linkBytes = noisePng(160, 120);
  const link = (await uploadFile(DOM, { bytes: linkBytes, filename: 'e2e-domain.png', type: 'image/png' })).data;
  check(link.cdn_url.startsWith(`${CDN}/files/${link.vanity}`), 'cdn_url stays on the CDN host', link.cdn_url);
  const lockedBytes = randomBytes(20 * 1024);
  const locked = (await uploadFile(DOM, { bytes: lockedBytes, filename: 'e2e-domain-secret.png', type: 'image/png', fields: { visibility: 'password', password: 'domain-pass-1' } })).data;
  equal((await waitScanned(link, DOM, 'step 24 domain link PNG')).safety.state, 'ok', 'scanned: ok');
  equal((await waitScanned(locked, DOM, 'step 24 domain password file')).safety.state, 'ok', 'scanned: ok');
  // An owner pass on the domain ("Open on <host>"): its token opens the file through /access/view as anywhere.
  const pass = await DOM.call(`/users/@me/files/${locked.id}/pass`, { method: 'POST', json: { domain_id: domain.id } });
  equal(pass.status, 200, 'POST /api/users/@me/files/<id>/pass { domain_id }');
  equal((await api(`/access/view/files/${locked.vanity}`, { headers: { 'X-Filesgg-Access': pass.data.token } })).status, 200, 'the owner pass opens the file (/access/view)');

  // The custom host serves it once the Worker's domain lookup (5 s, negative entries too) has expired.
  const served = await poll('the custom host to serve the file', async () => {
    const response = await request(`${CUSTOM}/${link.vanity}`, { headers: BROWSER });
    return { done: response.status === 200, state: response.status, response };
  });
  note(`the custom host served the file ${(served.waited / 1000).toFixed(1)}s after the domain went active (domain lookup cache: 5 s)`);
  const shell = parseShell(served.response.text);
  equal([shell.page, shell.state, shell.host], ['file', 'file', 'custom'], 'the file shell, data-host="custom"');
  equal(shell.hostData, { host, main_origin: MAIN, api_origin: API }, '#host-data');
  equal(shell.data.cdn_url, `${CUSTOM}/files/${link.vanity}.png`, '#file-data cdn_url is rehosted onto the custom host');
  check(shell.data.url.startsWith(`${CUSTOM}/${link.vanity}`), '#file-data url too', shell.data.url);
  check(!served.response.text.includes(CDN) && !served.response.text.includes(`${MAIN}/${link.vanity}`), 'no files.localhost or CDN URL left in the page', shell.meta);
  equal(served.response.headers.get('strict-transport-security'), 'max-age=31536000', 'HSTS without includeSubDomains or preload');
  check(!served.response.headers.getSetCookie().length, 'no cookie on the custom host', served.response.headers.getSetCookie());
  const bytesThere = await request(shell.data.cdn_url);
  equal([bytesThere.status, sha256(bytesThere.buffer)], [200, sha256(linkBytes)], 'the rehosted byte URL serves the file');
  check(/^sandbox;/.test(bytesThere.headers.get('content-security-policy')) && bytesThere.headers.get('x-content-type-options') === 'nosniff', 'with the CDN hardening (sandbox, nosniff)', bytesThere.headers.get('content-security-policy'));
  const home = await request(`${CUSTOM}/`, { headers: BROWSER });
  equal([home.status, parseShell(home.text).page], [200, 'domain-home'], 'the custom host\'s landing card');
  for (const path of ['/app', '/api/users/@me', '/login', '/.well-known/security.txt']) {
    equal((await request(CUSTOM + path)).status, 404, `${path} is 404 on the custom host`);
  }

  // Password file: locked there, and a signed URL from an unlock works on the custom host (rehosted).
  const lockedShell = parseShell((await request(`${CUSTOM}/${locked.vanity}`, { headers: BROWSER })).text);
  equal(lockedShell.state, 'locked', 'the password file is locked on the custom host');
  equal((await request(`${CUSTOM}/files/${locked.vanity}.png`)).status, 401, 'its bytes need a signature there too');
  const unlocked = await api(`/access/unlock/files/${locked.vanity}`, { method: 'POST', json: { password: 'domain-pass-1', turnstile_token: TURNSTILE_TOKEN } });
  equal(unlocked.status, 200, 'unlock (api.files.localhost, as the custom-host viewer calls it)');
  const rehosted = onOrigin(unlocked.data.file.cdn_url, CUSTOM);
  check(isSigned(rehosted), 'a signed URL', rehosted);
  const signedThere = await request(rehosted);
  equal([signedThere.status, sha256(signedThere.buffer)], [200, sha256(lockedBytes)], 'the signed URL, rehosted, works on the custom host (signatures cover the path only)');

  // "Only my files" (scope own): someone else's file, or an anonymous one, isn't served there.
  for (const [label, other, ext] of [['e2e\'s file', media.png, 'png'], ['an anonymous file', files.anon, 'bin']]) {
    const response = await request(`${CUSTOM}/${other.vanity}`, { headers: BROWSER });
    equal([response.status, parseShell(response.text).state], [404, 'missing'], `${label} on the custom host: the missing shell`);
    equal((await request(`${CUSTOM}/files/${other.vanity}.${ext}`)).status, 404, `${label}'s bytes on the custom host: 404`);
    equal((await page(vanityPath(other))).status, 200, `${label} is still served on files.localhost`);
  }

  // Domain-only mode: the owner's files leave files.localhost and the CDN (unless signed), stay on the domain.
  const preview = await DOM.call('/users/@me/domain-only/preview');
  check(preview.status === 200 && preview.data.affected_files >= 2, 'GET /api/users/@me/domain-only/preview', preview.data);
  const unconfirmed = await DOM.call('/users/@me/domain-only', { method: 'PUT', json: { enabled: true } });
  equal(unconfirmed.status, 400, 'turning it on needs confirm: true');
  const domainOnly = await DOM.call('/users/@me/domain-only', { method: 'PUT', json: { enabled: true, confirm: true } });
  equal([domainOnly.status, domainOnly.data.enabled, domainOnly.data.effective, domainOnly.data.paused], [200, true, true, false], 'PUT /api/users/@me/domain-only: effective');
  const hidden = await poll('files.localhost to stop showing the owner\'s file', async () => {
    const response = await page(vanityPath(link));
    return { done: response.status === 404, state: response.status, response };
  });
  note(`files.localhost showed it missing ${(hidden.waited / 1000).toFixed(1)}s later (lookup cache: 5 s)`);
  equal([parseShell(hidden.response.text).state, parseShell(hidden.response.text).data], ['missing', null], 'files.localhost/<vanity>: the missing shell');
  const unsigned = await request(plain(link.cdn_url));
  equal([unsigned.status, unsigned.headers.get('cache-control')], [404, 'private, no-store'], 'the CDN without a signature: 404, private, no-store');
  const ownerView = await DOM.call(`/users/@me/files/${link.id}`);
  check(isSigned(ownerView.data.cdn_url), 'the owner\'s payload signs even a link file while domain-only is effective', ownerView.data.cdn_url);
  equal((await request(ownerView.data.cdn_url)).status, 200, 'and that signed CDN URL works');
  const stillThere = await request(`${CUSTOM}/${link.vanity}`, { headers: BROWSER });
  equal([stillThere.status, parseShell(stillThere.text).state], [200, 'file'], 'the custom host still serves it');
  equal((await request(`${CUSTOM}/files/${link.vanity}.png`)).status, 200, 'with its bytes');

  // Staff URLs (staff=) work only on the CDN host, never on a custom domain (§10.9).
  const adminFile = await OWNER.call(`/admin/files/${link.id}`);
  equal(adminFile.status, 200, 'staff: GET /api/admin/files/<id>');
  const staffUrl = adminFile.data.staff_urls.content;
  check(/[?&]staff=\d+&/.test(staffUrl) && staffUrl.startsWith(`${CDN}/files/${link.vanity}`), 'a staff URL on the CDN', staffUrl);
  equal((await request(staffUrl)).status, 200, 'the staff URL works on cdn.files.localhost (even with domain-only on)');
  equal((await request(onOrigin(staffUrl, CUSTOM))).status, 404, 'the same staff URL on the custom host is refused (a bad signature: 404 for a link file)');
  const lockedStaff = (await OWNER.call(`/admin/files/${locked.id}`)).data.staff_urls.content;
  equal((await request(onOrigin(lockedStaff, CUSTOM))).status, 401, '...and 401 for a password file');

  // Another *.localhost host nobody added.
  const unknown = await request(`http://unknown-${hex(3)}.example.localhost:${PORT}/${link.vanity}`, { headers: BROWSER });
  equal([unknown.status, unknown.headers.get('cache-control')], [404, 'no-cache'], 'an unknown *.localhost host: 404, no-cache');
  check(unknown.text.includes('This domain isn\'t connected to files.gg right now.') && !unknown.text.includes(link.vanity), '"isn\'t connected", and nothing about the file', unknown.text);

  // Domain-only off, then remove the domain: Cloudflare's hostname is deleted by the domain_delete job.
  equal((await DOM.call('/users/@me/domain-only', { method: 'PUT', json: { enabled: false } })).data.enabled, false, 'domain-only off');
  equal((await DOM.call(`/users/@me/domains/${domain.id}`, { method: 'DELETE' })).status, 204, 'DELETE /api/users/@me/domains/<id>');
  const deleted = await poll('the mock Cloudflare hostname to be deleted', async () => {
    const item = (await mockHostnames()).find((entry) => entry.hostname === host);
    return { done: item && item.deleted, state: item && item.calls };
  }, { timeoutMs: 60_000 });
  check(deleted.state.includes('DELETE'), 'the worker\'s domain_delete job deleted the custom hostname at (mock) Cloudflare', deleted.state);
  const gone = await poll('the custom host to stop serving', async () => {
    const response = await request(`${CUSTOM}/${link.vanity}`, { headers: BROWSER });
    return { done: response.status === 404 && response.text.includes('isn\'t connected'), state: response.status };
  });
  equal(gone.state, 404, 'the removed domain isn\'t connected any more');
  equal((await page(vanityPath(link))).status, 200, 'and the file is back on files.localhost');

  // Owner-facing links (§10.9): the upload response's url and direct_url on the default domain, and an owner
  // pass on the domain. Their paths first, then (last, so everything above runs anyway) their origin:
  // like the Worker's rehosting, it must keep PUBLIC_URL's scheme and port (http and :8787 locally).
  const path = (url) => url.slice(new URL(url).origin.length);
  equal([path(link.url).split('.')[0], path(link.direct_url).split('?')[0], path(pass.data.url)],
    [`/${link.vanity}`, `/files/${link.vanity}.png`, `/${locked.vanity}#t=${pass.data.token}`], 'url, direct_url and the owner pass url: their paths');
  equal([link.url, link.direct_url, pass.data.url].map((url) => new URL(url).origin), [CUSTOM, CUSTOM, CUSTOM],
    'url, direct_url and the owner pass url are on the domain, with the scheme and port kept');
});

// Opening a view-limited file, as the viewer does after Turnstile: POST /api/access/open/files/<vanity>,
// from `ip` (a different address is a different viewer, §19.1).
const openFile = (vanity, ip, { token = TURNSTILE_TOKEN, headers = {} } = {}) => new Caller(`viewer ${ip}`, { headers: fromIp(ip) })
  .call(`/access/open/files/${vanity}`, { method: 'POST', headers, json: token === null ? {} : { turnstile_token: token } });
const unlockFrom = (vanity, ip, password) => new Caller(`viewer ${ip}`, { headers: fromIp(ip) })
  .call(`/access/unlock/files/${vanity}`, { method: 'POST', json: { password, turnstile_token: TURNSTILE_TOKEN } });
const viewsUsed = async (file) => (await OWNER.call(`/users/@me/files/${file.id}`)).data;

await step('25. view limits: limited shell, bots refused, unique viewers counted once, expire and private actions, unlock counts', async () => {
  const created = await OWNER.call('/users/@me/upload-keys', { method: 'POST', json: { name: 'e2e view limits' } });
  equal(created.status, 201, 'an upload key for this step');
  const sharexTool = tool(created.data.secret);
  try {
    const anonymousPrivate = await anonymousUpload(await visitor(), { bytes: randomBytes(512), filename: 'x.bin', fields: { view_limit: 2, view_limit_action: 'private' } });
    equal([anonymousPrivate.status, anonymousPrivate.data.code], [400, 'PRIVATE_REQUIRES_ACCOUNT'], 'an anonymous upload can\'t choose the private action');

    // --- view_limit=2, action expire (the default), uploaded with the key -----------------------------
    const bytes = noisePng(200, 150);
    const uploaded = await uploadFile(sharexTool, { bytes, filename: 'e2e-limited.png', type: 'image/png', fields: { view_limit: 2 } });
    equal(uploaded.status, 200, 'POST api.files.localhost/files with view_limit=2 (upload key)');
    const file = uploaded.data;
    equal([file.view_limit, file.view_limit_action, file.views_used], [2, 'expire', 0], 'the owner payload: limit 2, expire, 0 used');
    equal((await waitScanned(file, OWNER, 'step 25 view-limited PNG')).safety.state, 'ok', 'scanned: ok');

    const shell = await page(vanityPath(file));
    equal([shell.status, shell.headers.get('cache-control')], [200, 'private, no-store'], 'the page: 200, private, no-store');
    const parsed = parseShell(shell.text);
    equal([parsed.page, parsed.state, parsed.data], ['file', 'limited', { vanity: file.vanity, view_limited: true, views_remaining: 2 }], 'the limited shell');
    check(parsed.meta.includes('<meta property="og:title" content="View-limited file · files.gg">') && !/og:image|og:video|og:audio|twitter:image/.test(parsed.meta), 'generic og:title, no media', parsed.meta);
    check(!shell.text.includes('e2e-limited') && !shell.text.includes(plain(file.cdn_url)), 'no name and no CDN URL in the page');
    const unsigned = await request(plain(file.cdn_url));
    equal([unsigned.status, unsigned.headers.get('cache-control')], [404, 'private, no-store'], 'the CDN refuses an unsigned URL');
    const publicStub = await api(`/files/${file.vanity}`);
    equal([publicStub.status, publicStub.data], [200, { vanity: file.vanity, view_limited: true, views_remaining: 2 }], 'GET /files/<vanity>: only the stub');

    // Link-preview bots: 403, never an embed or a redirect, and no view used.
    for (const [name, headers] of Object.entries({ Discordbot: DISCORDBOT, facebookexternalhit: FACEBOOK, WhatsApp: WHATSAPP, TelegramBot: TELEGRAMBOT, 'Accept: image/*': { ...BROWSER, accept: 'image/*' } })) {
      const bot = await page(vanityPath(file), headers);
      equal([bot.status, bot.headers.get('location'), bot.headers.get('cache-control'), bot.text], [403, null, 'private, no-store', 'This file has a view limit and can\'t be previewed.'], `${name}: 403 with the text, no redirect`);
    }

    // The owner opens it without counting; Turnstile is required for everyone else.
    const ownerOpen = await OWNER.call(`/access/open/files/${file.vanity}`, { method: 'POST', json: { turnstile_token: TURNSTILE_TOKEN } });
    equal(ownerOpen.status, 200, 'the owner opens it (session cookie)');
    const noToken = await openFile(file.vanity, clientIp(), { token: null });
    equal([noToken.status, noToken.data.code], [403, 'CAPTCHA_INVALID'], 'open without a Turnstile token');
    equal((await viewsUsed(file)).views_used, 0, 'bots, the owner and a refused open used no view');

    const [ipA, ipB, ipC] = [clientIp(), clientIp(), clientIp()];
    const firstA = await openFile(file.vanity, ipA);
    equal(firstA.status, 200, 'viewer A opens it');
    equal([firstA.data.file.view_limit, firstA.data.file.id], [{ remaining: 1 }, file.id], 'the payload, with 1 view remaining');
    check(isSigned(firstA.data.file.cdn_url), 'signed URLs', firstA.data.file.cdn_url);
    check(firstA.data.expires_at <= Date.now() / 1000 + 3600 + 5, 'for at most 1 hour', firstA.data.expires_at);
    const urlA = firstA.data.file.cdn_url;
    const bytesA = await request(urlA);
    equal([bytesA.status, sha256(bytesA.buffer)], [200, sha256(bytes)], 'viewer A\'s signed URL serves the file');
    const againA = await openFile(file.vanity, ipA);
    equal([againA.status, againA.data.file.view_limit], [200, { remaining: 1 }], 'viewer A again: still 1 remaining');
    equal((await viewsUsed(file)).views_used, 1, 'the same viewer twice uses one view');

    const lastB = await openFile(file.vanity, ipB);
    equal([lastB.status, lastB.data.file.view_limit], [200, { remaining: 0 }], 'viewer B is the last viewer and still gets the file');
    equal((await viewsUsed(file)).views_used, 2, '2 of 2 views used');
    const servedB = await poll('viewer B\'s signed URL', async () => {
      const response = await request(lastB.data.file.cdn_url, { method: 'HEAD' });
      return { done: response.status === 200, state: response.status };
    });
    equal(servedB.state, 200, 'the last viewer\'s URL works (signed at the new access_version)');
    const refusedA = await poll('viewer A\'s earlier URL to stop working', async () => {
      const response = await request(urlA, { method: 'HEAD' });
      return { done: response.status !== 200, state: response.status };
    });
    check([401, 404].includes(refusedA.state), 'a URL given out before the last view stops working (access_version bump)', refusedA.state);
    const thirdC = await openFile(file.vanity, ipC);
    equal([thirdC.status, thirdC.data.code], [404, 'UNKNOWN_FILE'], 'viewer C: 404 UNKNOWN_FILE, never "limit reached"');
    equal((await api(`/files/${file.vanity}`)).status, 404, 'GET /files/<vanity>: 404');
    const missing = await poll('the page to show the file missing', async () => {
      const response = await page(vanityPath(file));
      return { done: response.status === 404, state: response.status, response };
    });
    equal([parseShell(missing.response.text).state, parseShell(missing.response.text).data], ['missing', null], 'the page is the missing shell');

    // --- view_limit=1, action private -----------------------------------------------------------------
    const privBytes = randomBytes(16 * 1024);
    const priv = (await uploadFile(sharexTool, { bytes: privBytes, filename: 'e2e-limited-private.bin', fields: { view_limit: 1, view_limit_action: 'private' } })).data;
    equal([priv.view_limit, priv.view_limit_action], [1, 'private'], 'view_limit=1, action private');
    equal((await waitScanned(priv, OWNER, 'step 25 view-limited private-action file')).safety.state, 'ok', 'scanned: ok');
    const ipD = clientIp();
    const onlyD = await openFile(priv.vanity, ipD);
    equal([onlyD.status, onlyD.data.file.view_limit], [200, { remaining: 0 }], 'viewer D opens it (the last view)');
    const afterD = await viewsUsed(priv);
    equal([afterD.visibility, afterD.views_used], ['private', 1], 'the action made it private');
    equal((await openFile(priv.vanity, clientIp())).status, 404, 'viewer E: 404');
    const privatePage = await poll('the page to show it missing', async () => {
      const response = await page(vanityPath(priv));
      return { done: response.status === 404, state: response.status };
    });
    equal(privatePage.state, 404, 'files.localhost/<vanity>: missing');
    check(isSigned(afterD.cdn_url), 'the owner still gets signed URLs', afterD.cdn_url);
    const ownerBytes = await poll('the owner\'s signed URL', async () => {
      const response = await request(afterD.cdn_url);
      return { done: response.status === 200, state: response.status, response };
    });
    equal(sha256(ownerBytes.response.buffer), sha256(privBytes), 'the file is the owner\'s now: their signed URL serves it');

    // --- a password file with view_limit=2: the unlock is the view ---------------------------------------
    const locked = (await uploadFile(sharexTool, { bytes: randomBytes(8 * 1024), filename: 'e2e-limited-secret.bin', fields: { view_limit: 2, visibility: 'password', password: 'limited-pass-1' } })).data;
    equal([locked.visibility, locked.view_limit], ['password', 2], 'a password file with view_limit=2');
    equal((await waitScanned(locked, OWNER, 'step 25 view-limited password file')).safety.state, 'ok', 'scanned: ok');
    const lockedShell = parseShell((await page(vanityPath(locked))).text);
    equal([lockedShell.state, lockedShell.data.view_limited, lockedShell.data.views_remaining], ['locked', true, 2], 'the lock screen, with the view limit');
    const [ipF, ipG] = [clientIp(), clientIp()];
    const noUnlock = await openFile(locked.vanity, ipF);
    equal([noUnlock.status, noUnlock.data.code], [401, 'UNLOCK_REQUIRED'], 'open without unlocking: 401 UNLOCK_REQUIRED');
    const wrong = await unlockFrom(locked.vanity, ipF, 'nope-nope-1');
    equal([wrong.status, wrong.data.code], [401, 'WRONG_PASSWORD'], 'a wrong password');
    equal((await viewsUsed(locked)).views_used, 0, 'a failed unlock uses no view');
    const unlockF = await unlockFrom(locked.vanity, ipF, 'limited-pass-1');
    equal([unlockF.status, unlockF.data.file.view_limit], [200, { remaining: 1 }], 'viewer F unlocks: that\'s the view');
    equal((await viewsUsed(locked)).views_used, 1, '1 view used');
    equal((await unlockFrom(locked.vanity, ipF, 'limited-pass-1')).status, 200, 'viewer F unlocks again');
    const withToken = await openFile(locked.vanity, ipF, { headers: { 'X-Filesgg-Access': unlockF.data.token } });
    equal(withToken.status, 200, 'and opens it with the unlock token');
    equal((await viewsUsed(locked)).views_used, 1, 'still 1 view used');
    equal((await unlockFrom(locked.vanity, ipG, 'limited-pass-1')).status, 200, 'viewer G unlocks (the last view)');
    equal((await viewsUsed(locked)).views_used, 2, '2 of 2 views used');
    const lateUnlock = await unlockFrom(locked.vanity, clientIp(), 'limited-pass-1');
    equal([lateUnlock.status, lateUnlock.data.code], [404, 'UNKNOWN_FILE'], 'a third viewer\'s correct password: 404');
  } finally {
    await OWNER.call(`/users/@me/upload-keys/${created.data.key.id}`, { method: 'DELETE' });
  }
});

await step('26. routes (§20): the vanity is last; the old access paths are 404, report pages and ?item= at the new paths', async () => {
  const fileVanity = files.password.vanity;
  const album = media.album;
  for (const base of [API, WEB_API]) {
    for (const [method, path] of [
      ['POST', `/files/${fileVanity}/unlock`],
      ['POST', `/files/${fileVanity}/unlock/refresh`],
      ['GET', `/files/${fileVanity}/view`],
      ['POST', `/files/${fileVanity}/open`],
      ['POST', `/albums/${album.vanity}/unlock`],
      ['POST', `/albums/${album.vanity}/unlock/refresh`],
      ['GET', `/albums/${album.vanity}/view`],
    ]) {
      const response = await request(base + path, { method, json: method === 'POST' ? { password: 'x', turnstile_token: TURNSTILE_TOKEN } : undefined });
      equal(response.status, 404, `${method} ${base === API ? 'api.files.localhost' : 'files.localhost/api'}${path} (the old route)`);
    }
  }
  const viaNew = await api(`/access/unlock/albums/${album.vanity}`, { method: 'POST', json: { password: 'x', turnstile_token: TURNSTILE_TOKEN } });
  check(viaNew.status !== 404 || viaNew.data.code !== 'NOT_FOUND', 'the new album unlock route exists', viaNew.data);

  // Report pages: /report/<vanity> and /report/a/<vanity>.
  const reportFile = await page(`/report/${media.png.vanity}`);
  equal([reportFile.status, reportFile.headers.get('cache-control')], [200, 'no-cache'], 'files.localhost/report/<vanity>');
  const reportFileShell = parseShell(reportFile.text);
  equal([reportFileShell.page, reportFileShell.data], ['report', { type: 'file', vanity: media.png.vanity }], 'the report page for a file');
  const reportAlbum = parseShell((await page(`/report/a/${album.vanity}`)).text);
  equal([reportAlbum.page, reportAlbum.data], ['report', { type: 'album', vanity: album.vanity }], 'files.localhost/report/a/<vanity>: the report page for an album');
  equal(parseShell((await page('/report')).text).data, { type: 'any' }, 'files.localhost/report');
  for (const path of [`/${media.png.vanity}/report`, `/a/${album.vanity}/report`]) {
    const old = await page(path);
    equal([old.status, parseShell(old.text).state], [404, 'missing'], `the old ${path}: missing`);
  }

  // Album items are ?item=<n>.
  const item = await page(`/a/${album.vanity}?item=2`);
  equal(item.status, 200, 'files.localhost/a/<vanity>?item=2');
  const itemShell = parseShell(item.text);
  equal([itemShell.page, itemShell.state, itemShell.data.vanity], ['album', 'album', album.vanity], 'the album shell, whatever ?item is');
  const oldItem = await page(`/a/${album.vanity}/2`);
  equal([oldItem.status, parseShell(oldItem.text).state], [404, 'missing'], 'the old /a/<vanity>/2: missing');
});

await step('27. account deletion: re-auth, files go missing (never removed), the account is locked, Keep my account brings them back', async () => {
  const user = makeUser('del');
  const browser = await signIn(user.email, user.password, { label: 'deleting account' });
  const otherDevice = await signIn(user.email, user.password, { label: 'another device' });
  const bytes = noisePng(120, 90);
  const file = (await uploadFile(browser, { bytes, filename: 'e2e-deleted-account.png', type: 'image/png' })).data;
  equal((await waitScanned(file, browser, 'step 27 deleting account\'s file')).safety.state, 'ok', 'scanned: ok');
  equal((await page(vanityPath(file))).status, 200, 'the file is served before');
  const key = await browser.call('/users/@me/upload-keys', { method: 'POST', json: { name: 'e2e deletion' } });
  equal(key.status, 201, 'an upload key, before');

  // Staff can't request it.
  const staff = await OWNER.call('/users/@me/delete', { method: 'POST', json: { confirm_username: 'e2e' } });
  equal([staff.status, staff.data.code, staff.data.reason], [409, 'ACCOUNT_DELETE_NOT_ALLOWED', 'staff'], 'staff (e2e): 409 ACCOUNT_DELETE_NOT_ALLOWED { reason: staff }');

  // Re-authentication: a session that proved the password more than 10 minutes ago must prove it again.
  psql(`UPDATE sessions SET authenticated_at = now() - interval '1 hour' WHERE user_id = ${BigInt(user.id)}`);
  const stale = await browser.call('/users/@me/delete', { method: 'POST', json: { confirm_username: user.username } });
  equal([stale.status, stale.data.code, stale.data.methods], [403, 'REAUTH_REQUIRED', ['password']], 'a session signed in an hour ago (psql): 403 REAUTH_REQUIRED');
  const badReauth = await browser.call('/auth/reauth', { method: 'POST', json: { password: 'not-it-at-all' } });
  equal([badReauth.status, badReauth.data.code], [400, 'INVALID_CREDENTIALS'], 'POST /api/auth/reauth with a wrong password');
  equal((await browser.call('/auth/reauth', { method: 'POST', json: { password: user.password } })).status, 204, 'POST /api/auth/reauth');
  const wrongName = await browser.call('/users/@me/delete', { method: 'POST', json: { confirm_username: 'someone.else' } });
  equal([wrongName.status, wrongName.data.code], [400, 'INVALID_PARAMETERS'], 'confirm_username must be the username');
  const requested = await browser.call('/users/@me/delete', { method: 'POST', json: { confirm_username: user.username } });
  equal(requested.status, 202, 'POST /api/users/@me/delete');
  const { requested_at: requestedAt, scheduled_for: scheduledFor } = requested.data.deletion;
  equal(scheduledFor - requestedAt, 14 * 86400, 'scheduled 14 days later');

  // Locked: other sessions ended, most endpoints refused, the key paused.
  equal((await otherDevice.call('/users/@me')).status, 401, 'the other session is ended');
  const me = await browser.call('/users/@me');
  equal([me.status, me.data.deletion], [200, { requested_at: requestedAt, scheduled_for: scheduledFor }], 'this session can still read GET /api/users/@me, with deletion');
  const library = await browser.call('/users/@me/files');
  equal([library.status, library.data.code], [403, 'ACCOUNT_PENDING_DELETION'], 'the library: 403 ACCOUNT_PENDING_DELETION');
  const keyUpload = await uploadFile(tool(key.data.secret), { bytes: randomBytes(512), filename: 'during.bin' });
  equal([keyUpload.status, keyUpload.data.code], [403, 'ACCOUNT_PENDING_DELETION'], 'the upload key: 403 ACCOUNT_PENDING_DELETION');
  const again = await browser.call('/users/@me/delete', { method: 'POST', json: { confirm_username: user.username } });
  equal([again.status, again.data.reason], [409, 'pending'], 'requesting it twice');

  // Content offline, as missing (never "removed").
  const offline = await poll('the file to go offline', async () => {
    const response = await page(vanityPath(file));
    return { done: response.status === 404, state: response.status, response };
  });
  note(`the file went missing ${(offline.waited / 1000).toFixed(1)}s after the request (lookup cache: 5 s)`);
  const offlineShell = parseShell(offline.response.text);
  equal([offlineShell.state, offlineShell.data], ['missing', null], 'the page is the missing shell, not removed');
  const cdn = await request(file.cdn_url);
  equal([cdn.status, cdn.headers.get('cache-control')], [404, 'private, no-store'], 'the CDN: 404, private, no-store');
  const publicApi = await api(`/files/${file.vanity}`);
  equal([publicApi.status, publicApi.data.code], [404, 'UNKNOWN_FILE'], 'GET /files/<vanity>: 404 UNKNOWN_FILE');

  // Signing in still works, and shows the pending deletion (the Keep my account screen).
  const signedIn = await signIn(user.email, user.password, { label: 'during the grace period' });
  equal((await signedIn.call('/auth/session')).data.user.deletion.scheduled_for, scheduledFor, 'signing in during the grace period: user.deletion is set');

  // Keep my account.
  const kept = await signedIn.call('/users/@me/delete/cancel', { method: 'POST' });
  equal([kept.status, kept.data.deletion, kept.data.username], [200, null, user.username], 'POST /api/users/@me/delete/cancel (Keep my account)');
  const back = await poll('the file to be served again', async () => {
    const response = await page(vanityPath(file));
    return { done: response.status === 200, state: response.status, response };
  });
  equal(parseShell(back.response.text).state, 'file', 'the file is back');
  const cdnBack = await request(file.cdn_url);
  equal([cdnBack.status, sha256(cdnBack.buffer)], [200, sha256(bytes)], 'and its bytes');
  equal((await signedIn.call('/users/@me/files')).status, 200, 'the library works again');
  equal((await uploadFile(tool(key.data.secret), { bytes: randomBytes(512), filename: 'after.bin' })).status, 200, 'and the upload key');
});


// --- Milestone 5: conversion (docs/redesign/contracts/milestone-5.md) -------------------------------------------

const FINISHED = ['succeeded', 'failed', 'cancelled'];
// Each conversion: POST /conversions (it waits up to 2 s, §4.1), then GET /conversions/<id> once a second until it's
// finished, as the Convert page polls (§8). The times are printed under the step and summarised at the end.
const conversionTimes = [];
async function convert(caller, body, label, { timeoutMs = 240_000 } = {}) {
  const started = Date.now();
  const created = await caller.call('/conversions', { method: 'POST', json: body });
  check([200, 202].includes(created.status) && created.data && created.data.id, `${label}: POST /conversions answers 200 or 202 with the conversion`, created.text.slice(0, 600));
  equal(created.status === 200, FINISHED.includes(created.data.status), `${label}: 200 exactly when it's finished within the brief wait (else 202)`);
  let conversion = created.data;
  if (!FINISHED.includes(conversion.status)) {
    const done = await poll(`${label} to finish`, async () => {
      const response = await caller.call(`/conversions/${conversion.id}`);
      if (response.status !== 200) {
        throw new Error(`GET /conversions/${conversion.id} gave ${response.status}: ${response.text.slice(0, 300)}`);
      }
      const { status, stage, position, progress, queue } = response.data;
      return { done: FINISHED.includes(status), state: { status, stage, position, progress, queue }, conversion: response.data };
    }, { timeoutMs, intervalMs: 1000 });
    conversion = done.conversion;
  }
  const ms = Date.now() - started;
  conversionTimes.push({ label, ms, took: conversion.took, status: conversion.status, cached: conversion.cached });
  note(`${label}: ${conversion.status}${conversion.cached ? ' (cache hit)' : ''} in ${(ms / 1000).toFixed(1)}s ` +
    `(took ${conversion.took} ms, ${conversion.queue} queue, ${conversion.cpu_seconds}s CPU, ${conversion.input_size} -> ${conversion.output_size} bytes)`);
  return { created, conversion };
}
function succeeded(conversion, label) {
  check(conversion.status === 'succeeded', `${label}: succeeded`, { status: conversion.status, error: conversion.error });
  return conversion;
}
// An owner's file, once its probe has run (kind, size, duration, pages): the output of a conversion, as its owner.
async function waitProcessedAs(caller, file, label) {
  const scanned = await waitScanned(file, caller, label);
  if (scanned.rejected) {
    return scanned;
  }
  const done = await poll(`${label} to be processed`, async () => {
    const response = await caller.call(`/users/@me/files/${file.id}`);
    return { done: response.status === 200 && response.data.processing === false, state: response.status, item: response.data };
  }, { timeoutMs: 120_000, intervalMs: 500 });
  return done.item;
}
// The bytes of an owner's file, once scanned (its cdn_url is signed when it's protected).
async function ownerBytes(caller, file, label) {
  const item = await waitScanned(file, caller, label);
  check(item.safety && ['ok', 'flagged'].includes(item.safety.state), `${label}: scanned and served`, item.safety || item);
  const response = await request(item.cdn_url);
  equal(response.status, 200, `${label}: CDN serves the output`);
  return { item, bytes: response.buffer, response };
}
// A signed-out visitor on an address of its own: the anonymous conversion limits are per guest **and** per IP
// (§7.1), so each anonymous step is a fresh viewer and every run starts from zero.
const anonymousConverter = async () => visitor(fromIp(clientIp()));
// Did an RQ worker in `services` log the job `jobId` (the API names them conversion-<id> and preview-<hash_id>)?
function rqLogged(services, jobId) {
  const logs = execFileSync('docker', [...COMPOSE, 'logs', '--no-color', ...services], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return logs.includes(jobId);
}
const hashIdOf = (fileId) => psql(`SELECT hash_id FROM files WHERE id = ${BigInt(fileId)}`);

// JPEG segments: inserts a comment (COM) with `text` after the APPn segments (EXIF stays), for a new hash every run.
function jpegWithComment(jpeg, text) {
  let offset = 2;
  while (jpeg[offset] === 0xff && jpeg[offset + 1] >= 0xe0 && jpeg[offset + 1] <= 0xef) {
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  const data = Buffer.from(text, 'latin1');
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xfffe, 0);
  segment.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, offset), segment, data, jpeg.subarray(offset)]);
}
// The tag ids of a JPEG's EXIF IFD0 (0x8825 is the GPS IFD, 0x010F the camera make), or null without EXIF.
function exifTags(jpeg) {
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker === 0xe1 && jpeg.subarray(offset + 4, offset + 10).toString('latin1') === 'Exif\0\0') {
      const tiff = jpeg.subarray(offset + 10, offset + 2 + length);
      const little = tiff.subarray(0, 2).toString('latin1') === 'II';
      const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
      const ifd = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
      return [...Array(u16(ifd)).keys()].map((index) => u16(ifd + 2 + index * 12));
    }
    offset += 2 + length;
  }
  return null;
}
// A GIF with a comment extension before its trailer: a new hash every run.
const gifWithComment = (gif, text) => {
  const data = Buffer.from(text.slice(0, 255), 'latin1');
  return Buffer.concat([gif.subarray(0, gif.length - 1), Buffer.from([0x21, 0xfe, data.length]), data, Buffer.from([0x00, 0x3b])]);
};
// A minimal PDF written by hand, as api/tests/fixtures/convert/make_fixtures.py does, with a nonce comment.
function pdfBytes(pages, tag) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${[...Array(pages).keys()].map((i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`];
  const font = 3 + pages * 2;
  for (let index = 0; index < pages; index++) {
    const content = `0.${index + 2} 0.3 0.6 rg 20 20 160 100 re f BT /F1 24 Tf 80 60 Td (${index + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 140] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = `%PDF-1.4\n% ${tag}\n`;
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
// A minimal .docx (stored zip), as make_fixtures.py writes document.docx, with `text` in a paragraph.
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function docxBytes(text) {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${DOCX_TYPE}.main+xml"/></Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${w}"><w:body>` +
      `<w:p><w:r><w:t>files.gg e2e document</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ];
  return zipOf(files.map(([name, xml]) => [name, Buffer.from(xml, 'utf8')]));
}
// ffmpeg's volumedetect on some audio (in the jobs worker container): { mean, max } in dB.
function volumeOf(bytes) {
  const result = spawnSync('docker', [...COMPOSE, 'exec', '-T', 'worker', 'ffmpeg', '-hide_banner', '-i', 'pipe:0',
    '-af', 'volumedetect', '-f', 'null', '-'], { input: bytes, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const stderr = result.stderr.toString('utf8');
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(stderr);
  const max = /max_volume: (-?[\d.]+) dB/.exec(stderr);
  if (!mean || !max) {
    throw new Error('volumedetect printed no volume:\n' + stderr.slice(-800));
  }
  return { mean: Number(mean[1]), max: Number(max[1]) };
}
// Unique test media for this step: a short noise tag in the container metadata.
const tag = () => `e2e-${hex(8)}`;
const m5 = {};

await step('28. conversions: the formats document, and a JPEG with GPS EXIF converted with strip_metadata (the default)', async () => {
  const formats = await request(`${WEB_API}/conversions/formats`);
  equal([formats.status, formats.headers.get('cache-control')], [200, 'public, max-age=300'], 'GET /api/conversions/formats: public, 5 minutes');
  const kinds = formats.data.kinds;
  equal(Object.keys(kinds).sort(), ['animated', 'audio', 'document', 'image', 'images', 'pdf', 'video'], 'every source kind (§1.1)');
  equal(kinds.image.targets.map((t) => t.target), ['png', 'jpg', 'webp', 'avif', 'gif', 'ico'], 'image targets (§1.2)');
  const docPdf = kinds.document.targets.find((t) => t.target === 'pdf');
  equal([docPdf.anonymous, docPdf.options], [false, []], 'document -> pdf: signed in only, no options');
  const strip = kinds.image.targets.find((t) => t.target === 'jpg').options.find((o) => o.name === 'strip_metadata');
  equal([strip.type, strip.default], ['bool', true], 'strip_metadata: a bool, true by default');
  check(['play_everywhere', 'discord', 'extract_audio', 'gif_to_mp4', 'remove_location'].every((id) => formats.data.presets.some((p) => p.id === id)), 'the presets (§10.1)', formats.data.presets.map((p) => p.id));

  const source = jpegWithComment(readFileSync(join(ROOT, 'api/tests/fixtures/convert/gps.jpg')), tag());
  const sourceTags = exifTags(source);
  check(sourceTags && sourceTags.includes(0x8825) && sourceTags.includes(0x010f), 'the source JPEG has EXIF with a GPS IFD and a camera make', sourceTags);
  const created = await uploadFile(OWNER, { bytes: source, filename: 'e2e-gps.jpg', type: 'image/jpeg' });
  equal(created.status, 200, 'upload the JPEG');
  const file = m5.jpeg = created.data;
  equal((await waitScanned(file, OWNER, 'step 28 GPS JPEG')).safety.state, 'ok', 'scanned: ok');

  const { conversion } = await convert(OWNER, { source: file.vanity, target: 'jpg', options: {} }, 'image -> jpg (strip metadata)');
  succeeded(conversion, 'image -> jpg');
  m5.jpegConversion = conversion;
  equal([conversion.target, conversion.source.kind, conversion.queue, conversion.cached, conversion.options.strip_metadata, conversion.options.quality],
    ['jpg', 'image', 'member', false, true, 85], 'the conversion: image -> jpg on the member queue, options normalised (strip_metadata true, quality 85)');
  equal(conversion.source.file.id, file.id, 'source.file is the JPEG');
  const output = conversion.output.file;
  equal([output.filename, output.mimetype], ['e2e-gps.jpg', 'image/jpeg'], 'the output: <name>.jpg (§1.3)');
  check(output.id !== file.id && output.vanity !== file.vanity, 'the output is a new file with its own link', output);
  const { bytes } = await ownerBytes(OWNER, output, 'step 28 stripped JPEG');
  equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff', 'the output is a JPEG');
  const outputTags = exifTags(bytes);
  check(outputTags === null || (!outputTags.includes(0x8825) && !outputTags.includes(0x010f)), 'the output has no GPS IFD and no camera make', outputTags);
  check(!bytes.includes(Buffer.from('FilesggTestCamera')), 'the camera make string is gone');
  equal(conversion.output_size, bytes.length, 'output_size is the output\'s size');
  const fromConversion = psql(`SELECT derived_from_file_id || ' ' || conversion_id FROM files WHERE id = ${BigInt(output.id)}`);
  equal(fromConversion, `${file.id} ${conversion.id}`, 'provenance: derived_from_file_id and conversion_id (psql)');
  check(rqLogged(['converter', 'converter-premium'], `conversion-${conversion.id}`), `an RQ member worker ran the job conversion-${conversion.id}`);
});

await step('29. cache hit: the same recipe again is 200 { cached: true }, a new file over the same bytes, and the anonymous 720p cap isn\'t shared', async () => {
  const first = m5.jpegConversion;
  // §6: `{}` and `{ quality: 85 }` for jpg are the same recipe
  const { created, conversion } = await convert(OWNER, { source: m5.jpeg.vanity, target: 'jpg', options: { quality: 85 } }, 'image -> jpg again (cache)');
  equal([created.status, conversion.status, conversion.cached, conversion.cpu_seconds], [200, 'succeeded', true, 0], 'POST /conversions: 200, succeeded, cached, no CPU');
  check(conversion.output.file.id !== first.output.file.id, 'a new output file', conversion.output.file.id);
  equal(conversion.output.file.size, first.output.file.size, 'over the same bytes (size)');
  equal(psql(`SELECT count(DISTINCT hash_id) FROM files WHERE id IN (${BigInt(first.output.file.id)}, ${BigInt(conversion.output.file.id)})`), '1', 'the same hash (psql)');
  equal(rqLogged(['converter', 'converter-premium'], `conversion-${conversion.id}`), false, 'no RQ job for a cache hit');

  // The anonymous 720p cap is part of the recipe: a capped output is never served to a signed-in caller from the cache.
  const video = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1440x1080:rate=15:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-metadata', `comment=${tag()}`, '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']);
  const uploaded = await uploadFile(OWNER, { bytes: video, filename: 'e2e-1080p.mp4', type: 'video/mp4' });
  equal(uploaded.status, 200, 'upload a 1440x1080 video');
  const source = await waitProcessedAs(OWNER, uploaded.data, 'step 29 1080p video');
  m5.video = uploaded.data;
  equal([source.width, source.height], [1440, 1080], 'probed 1440x1080');
  const anonymous = await anonymousConverter();
  const capped = succeeded((await convert(anonymous, { source: uploaded.data.vanity, target: 'mp4', turnstile_token: TURNSTILE_TOKEN }, 'video -> mp4, anonymous (720p cap)')).conversion, 'anonymous mp4');
  equal([capped.queue, capped.cached], ['anonymous', false], 'anonymous queue, not cached');
  const cappedFile = await waitProcessedAs(anonymous, capped.output.file, 'step 29 anonymous mp4');
  equal(cappedFile.height, 720, 'the anonymous output is capped at 720p');
  const full = succeeded((await convert(OWNER, { source: uploaded.data.vanity, target: 'mp4' }, 'video -> mp4, signed in (no cap)')).conversion, 'signed-in mp4');
  equal(full.cached, false, 'the signed-in caller doesn\'t get the anonymous capped output from the cache');
  equal((await waitProcessedAs(OWNER, full.output.file, 'step 29 signed-in mp4')).height, 1080, 'the signed-in output keeps 1080p');
});

await step('30. GIF -> MP4: an animated GIF becomes an H.264 MP4', async () => {
  const gif = gifWithComment(ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2', '-f', 'gif']), tag());
  const created = await uploadFile(OWNER, { bytes: gif, filename: 'e2e-animated.gif', type: 'image/gif' });
  equal(created.status, 200, 'upload an animated GIF');
  // Straight away its scan (then its probe, which tells a still GIF from an animated one) hasn't run
  const early = await OWNER.call('/conversions', { method: 'POST', json: { source: created.data.vanity, target: 'mp4' } });
  check([[404, 'SOURCE_UNAVAILABLE'], [409, 'FILE_PENDING']].some(([status, code]) => early.status === status && early.data.code === code),
    'before the scan and probe: 404 SOURCE_UNAVAILABLE (scan pending) or 409 FILE_PENDING (probe pending)', early.text.slice(0, 300));
  note(`converting it straight after the upload: ${early.status} ${early.data.code}`);
  const source = await waitProcessedAs(OWNER, created.data, 'step 30 animated GIF');
  check(source.media && source.media.framecount > 1, 'probed as animated', source.media);
  const conversion = succeeded((await convert(OWNER, { source: created.data.vanity, target: 'mp4' }, 'GIF -> MP4')).conversion, 'GIF -> MP4');
  equal([conversion.source.kind, conversion.output.file.mimetype, conversion.output.file.filename], ['animated', 'video/mp4', 'e2e-animated.mp4'], 'animated -> video/mp4');
  const output = await waitProcessedAs(OWNER, conversion.output.file, 'step 30 MP4');
  equal([output.kind, output.media.playable, output.width, output.height], ['video', true, 160, 120], 'a playable 160x120 video');
  check(Math.abs(output.duration - 2000) < 400, 'about 2 s long', output.duration);
  note(`GIF ${conversion.input_size} bytes -> MP4 ${conversion.output_size} bytes`);
});

await step('31. video -> mp4 with target_size: 1 MB, two-pass, within 5%', async () => {
  const video = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-vf', 'noise=alls=30:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-metadata', `comment=${tag()}`, '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']);
  check(video.length > 1.5 * MB, 'a source well over 1 MB', video.length);
  const created = await uploadFile(OWNER, { bytes: video, filename: 'e2e-big-video.mp4', type: 'video/mp4' });
  equal(created.status, 200, 'upload the video');
  await waitProcessedAs(OWNER, created.data, 'step 31 video');
  const tooSmall = await OWNER.call('/conversions', { method: 'POST', json: { source: created.data.vanity, target: 'mp4', options: { target_size: 0 } } });
  equal([tooSmall.status, tooSmall.data.code, tooSmall.data.option], [400, 'INVALID_OPTION', 'target_size'], 'target_size 0: INVALID_OPTION');
  const conversion = succeeded((await convert(OWNER, { source: created.data.vanity, target: 'mp4', options: { target_size: 1 } }, 'video -> mp4, target_size 1 MB')).conversion, 'target_size');
  equal(conversion.options.target_size, 1, 'options.target_size');
  check(conversion.output_size <= 1.05 * MB, 'the output is at most 1 MB + 5%', conversion.output_size);
  check(conversion.output_size >= 0.5 * MB, 'and uses the budget (at least half of it)', conversion.output_size);
  note(`target 1,000,000 bytes: ${conversion.output_size} bytes (${(100 * conversion.output_size / MB).toFixed(1)}%), from ${conversion.input_size}`);
  const output = await waitProcessedAs(OWNER, conversion.output.file, 'step 31 sized MP4');
  equal([output.kind, output.media.playable, output.media.has_audio], ['video', true, true], 'a playable video with its audio');
});

await step('32. audio normalise: a quiet tone -> mp3 with loudnorm is louder', async () => {
  const wav = ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-af', 'volume=-25dB', '-c:a', 'pcm_s16le', '-metadata', `comment=${tag()}`, '-f', 'wav']);
  const created = await uploadFile(OWNER, { bytes: wav, filename: 'e2e-quiet.wav', type: 'audio/wav' });
  equal(created.status, 200, 'upload a quiet WAV');
  await waitProcessedAs(OWNER, created.data, 'step 32 WAV');
  const conversion = succeeded((await convert(OWNER, { source: created.data.vanity, target: 'mp3', options: { normalize: true } }, 'audio -> mp3, normalize')).conversion, 'normalize');
  equal([conversion.source.kind, conversion.options.normalize, conversion.output.file.mimetype], ['audio', true, 'audio/mpeg'], 'audio -> audio/mpeg, normalize');
  const { bytes } = await ownerBytes(OWNER, conversion.output.file, 'step 32 normalised MP3');
  const before = volumeOf(wav);
  const after = volumeOf(bytes);
  note(`mean volume ${before.mean} dB -> ${after.mean} dB, max ${before.max} dB -> ${after.max} dB`);
  check(after.mean > before.mean + 10, 'at least 10 dB louder on average', { before, after });
  check(after.max <= -1, 'and the peak stays under 0 dBFS (true peak -1.5)', after);
});

await step('33. docx -> PDF on the office service, signed in; anonymous callers are refused (CONVERSION_REQUIRES_ACCOUNT)', async () => {
  const docx = docxBytes(`run ${tag()}`);
  const created = await uploadFile(OWNER, { bytes: docx, filename: 'e2e-document.docx', type: DOCX_TYPE });
  equal(created.status, 200, 'upload a docx');
  equal(created.data.mimetype, DOCX_TYPE, 'stored as a Word document');
  const file = m5.docx = created.data;
  equal((await waitScanned(file, OWNER, 'step 33 docx')).safety.state, 'ok', 'scanned: ok');

  const anonymous = await anonymousConverter();
  const refused = await anonymous.call('/conversions', { method: 'POST', json: { source: file.vanity, target: 'pdf', turnstile_token: TURNSTILE_TOKEN } });
  equal([refused.status, refused.data.code, refused.data.sign_in], [403, 'CONVERSION_REQUIRES_ACCOUNT', true], 'anonymous docx -> pdf: 403 CONVERSION_REQUIRES_ACCOUNT { sign_in: true }');
  const byDefault = await anonymous.call('/conversions', { method: 'POST', json: { source: file.vanity, turnstile_token: TURNSTILE_TOKEN } });
  equal([byDefault.status, byDefault.data.code], [403, 'CONVERSION_REQUIRES_ACCOUNT'], 'and with the default target (pdf)');

  const conversion = succeeded((await convert(OWNER, { source: file.vanity, target: 'pdf' }, 'docx -> PDF (office)')).conversion, 'docx -> pdf');
  equal([conversion.source.kind, conversion.output.file.filename, conversion.output.file.mimetype], ['document', 'e2e-document.pdf', 'application/pdf'], 'document -> e2e-document.pdf');
  const { bytes, item } = await ownerBytes(OWNER, conversion.output.file, 'step 33 PDF');
  equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'the output is a PDF');
  // LibreOffice writes an /OpenAction (a "fit page" destination), which the milestone-4 PDF check flags as
  // pdf_javascript (§5.5): served, with the warning.
  check(item.safety.state === 'ok' || (item.safety.state === 'flagged' && item.safety.reason === 'pdf_javascript'), 'the PDF output is served (ok, or flagged pdf_javascript for its /OpenAction)', item.safety);
  note(`the docx -> PDF output was scanned ${item.safety.state}${item.safety.reason ? ` (${item.safety.reason})` : ''}`);
  const probed = await waitProcessedAs(OWNER, conversion.output.file, 'step 33 PDF probe');
  equal(probed.media && probed.media.pages, 1, 'one page');
});

await step('34. document preview: a docx uploaded signed in gets a PDF preview (preview_state done, assets.document, the CDN serves it)', async () => {
  const file = m5.docx;
  const withPreview = await poll('the docx preview', async () => {
    const response = await OWNER.call(`/users/@me/files/${file.id}`);
    return { done: Boolean(response.data.assets && response.data.assets.document), state: psql(`SELECT preview_state FROM file_hashes WHERE id = (SELECT hash_id FROM files WHERE id = ${BigInt(file.id)})`), item: response.data };
  }, { timeoutMs: 180_000, intervalMs: 1000 });
  note(`the preview was there ${(withPreview.waited / 1000).toFixed(1)}s after step 33 finished`);
  const hashId = hashIdOf(file.id);
  equal(psql(`SELECT preview_state FROM file_hashes WHERE id = ${hashId}`), 'done', 'preview_state = done (psql)');
  check(rqLogged(['converter-previews'], `preview-${hashId}`), `converter-previews ran the job preview-${hashId}`);
  const document = withPreview.item.assets.document;
  check(document.url.startsWith(`${CDN}/previews/document/${file.vanity}.pdf?v=`), 'assets.document at /previews/document/<vanity>.pdf?v=', document.url);
  equal([document.pages, typeof document.size], [1, 'number'], 'with its pages and size');
  const pdf = await request(document.url);
  equal([pdf.status, pdf.headers.get('content-type')], [200, 'application/pdf'], 'the CDN serves it as application/pdf');
  equal([pdf.buffer.subarray(0, 5).toString('latin1'), pdf.buffer.length], ['%PDF-', document.size], 'a PDF of the given size');
  check(/^inline/.test(pdf.headers.get('content-disposition') || 'inline'), 'inline', pdf.headers.get('content-disposition'));
  const shell = await poll('the viewer to show the preview', async () => {
    const parsed = parseShell((await page(vanityPath(file))).text);
    return { done: Boolean(parsed.data && parsed.data.assets && parsed.data.assets.document), state: parsed.state, parsed };
  });
  equal(shell.parsed.data.assets.document.url, document.url, '#file-data carries assets.document for the viewer');
  equal(shell.parsed.data.cdn_url, file.cdn_url, 'and the original stays the download');
});

await step('35. PDF -> images: an album of the pages signed in, a ZIP anonymously', async () => {
  const pdf = pdfBytes(3, tag());
  const created = await uploadFile(OWNER, { bytes: pdf, filename: 'e2e-three-pages.pdf', type: 'application/pdf' });
  equal(created.status, 200, 'upload a 3-page PDF');
  await waitProcessedAs(OWNER, created.data, 'step 35 PDF');

  const signedIn = succeeded((await convert(OWNER, { source: created.data.vanity, target: 'png', options: { dpi: 72 } }, 'PDF -> PNG pages (album)')).conversion, 'pdf -> album');
  equal([signedIn.source.kind, signedIn.output.file], ['pdf', null], 'signed in: no single output file');
  check(signedIn.output.album && signedIn.output.album.vanity, 'an output album', signedIn.output);
  const album = await OWNER.call(`/users/@me/albums/${signedIn.output.album.id}`);
  equal(album.status, 200, 'the album is the caller\'s');
  equal(album.data.title, 'e2e-three-pages', 'titled after the source');
  equal(album.data.items.map((item) => [item.filename, item.mimetype]), [1, 2, 3].map((n) => [`e2e-three-pages-p${n}.png`, 'image/png']), 'three pages in order, <name>-p<n>.png');
  const pageBytes = await ownerBytes(OWNER, album.data.items[0], 'step 35 page 1');
  equal(pageBytes.bytes.subarray(1, 4).toString('latin1'), 'PNG', 'page 1 is a PNG');

  const anonymous = await anonymousConverter();
  const zipped = succeeded((await convert(anonymous, { source: created.data.vanity, target: 'png', options: { dpi: 72 }, turnstile_token: TURNSTILE_TOKEN }, 'PDF -> PNG pages, anonymous (ZIP)')).conversion, 'pdf -> zip');
  equal([zipped.output.album, zipped.output.file.filename, zipped.output.file.mimetype], [null, 'e2e-three-pages-pages.zip', 'application/zip'], 'anonymous: one <name>-pages.zip');
  check(zipped.output.file.expires_at !== null, 'an anonymous output expires', zipped.output.file);
  const { bytes } = await ownerBytes(anonymous, zipped.output.file, 'step 35 pages ZIP');
  const zipPath = join(LOCAL, `e2e-pages-${hex(4)}.zip`);
  writeFileSync(zipPath, bytes);
  try {
    check(/No errors detected/.test(execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' })), 'unzip -t: no errors');
    equal(execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n'), [1, 2, 3].map((n) => `e2e-three-pages-p${n}.png`), 'the ZIP holds the three pages in order');
  } finally {
    rmSync(zipPath, { force: true });
  }
});

await step('36. images -> PDF from an album, in album order', async () => {
  const ids = [];
  const vanities = [];
  for (const [width, height] of [[200, 150], [120, 160]]) {
    const created = await uploadFile(OWNER, { bytes: noisePng(width, height), filename: `e2e-page-${width}.png`, type: 'image/png' });
    equal(created.status, 200, `upload a ${width}x${height} PNG`);
    equal((await waitScanned(created.data, OWNER, `step 36 ${width}x${height} PNG`)).safety.state, 'ok', 'scanned: ok');
    ids.push(created.data.id);
    vanities.push(created.data.vanity);
  }
  const album = await OWNER.call('/users/@me/albums', { method: 'POST', json: { title: 'e2e scans', file_ids: ids } });
  equal(album.status, 201, 'an album of the two images');
  const conversion = succeeded((await convert(OWNER, { album: album.data.vanity, target: 'pdf' }, 'album images -> PDF')).conversion, 'images -> pdf');
  equal([conversion.source.kind, conversion.source.count, conversion.source.album && conversion.source.album.vanity, conversion.skipped],
    ['images', 2, album.data.vanity, []], 'source: the album\'s two images, nothing skipped');
  equal([conversion.output.file.filename, conversion.output.file.mimetype], ['e2e scans.pdf', 'application/pdf'], 'named after the album');
  const { bytes } = await ownerBytes(OWNER, conversion.output.file, 'step 36 PDF');
  equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'a PDF');
  equal((await waitProcessedAs(OWNER, conversion.output.file, 'step 36 PDF probe')).media.pages, 2, 'two pages');
  m5.images = vanities;
});

await step('37. batch: one conversion per file with a batch_id, unsupported kinds skipped, items past the concurrent limit held until polled', async () => {
  const anonymous = await anonymousConverter();
  const refused = await anonymous.call('/conversions/batch', { method: 'POST', json: { files: m5.images, target: 'webp', turnstile_token: TURNSTILE_TOKEN } });
  equal([refused.status, refused.data.code, refused.data.sign_in], [403, 'CONVERSION_REQUIRES_ACCOUNT', true], 'anonymous batch: 403 CONVERSION_REQUIRES_ACCOUNT');

  const files = [...m5.images];
  for (const size of [64, 96]) {
    const created = await uploadFile(OWNER, { bytes: noisePng(size, size), filename: `e2e-batch-${size}.png`, type: 'image/png' });
    await waitScanned(created.data, OWNER, `step 37 ${size}px PNG`);
    files.push(created.data.vanity);
  }
  // a video (step 9's, or step 29's when only these steps run) has no webp target
  const video = (media.mp4 || m5.video).vanity;
  const started = Date.now();
  const batch = await OWNER.call('/conversions/batch', { method: 'POST', json: { files: [...files, video], target: 'webp', options: { quality: 70 } } });
  equal(batch.status, 202, 'POST /api/conversions/batch: 202');
  const { batch_id: batchId, items, skipped } = batch.data;
  equal(items.length, 4, 'four conversions (signed-in concurrent limit: 3)');
  check(items.every((item) => item.batch_id === batchId && item.target === 'webp'), 'sharing the batch_id', items.map((item) => item.batch_id));
  equal(skipped, [{ source: video, code: 'UNSUPPORTED_CONVERSION' }], 'the video is skipped: UNSUPPORTED_CONVERSION');

  const done = await poll('the batch to finish', async () => {
    const list = await OWNER.call(`/conversions?batch=${batchId}`);
    return { done: list.data.items.length === 4 && list.data.items.every((item) => FINISHED.includes(item.status)), state: list.data.items.map((item) => item.status), list: list.data };
  }, { timeoutMs: 180_000, intervalMs: 1000 });
  note(`batch of 4 finished in ${((Date.now() - started) / 1000).toFixed(1)}s: ${done.list.items.map((item) => `${item.took} ms`).join(', ')}`);
  conversionTimes.push({ label: 'batch of 4 images -> webp', ms: Date.now() - started, took: Math.max(...done.list.items.map((item) => item.took)), status: 'succeeded', cached: false });
  equal(done.list.items.map((item) => item.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded'], 'every item succeeded');
  equal(done.list.items.map((item) => item.output.file.mimetype), Array(4).fill('image/webp'), 'four WebP files');
  equal(done.list.batch_id, batchId, 'GET /conversions?batch=<id>');
  // Held items go on the queue later than they were created (a batch's first 3 go on it in the same transaction).
  equal(psql(`SELECT count(*) FROM conversions WHERE batch_id = ${BigInt(batchId)} AND queued_at > created_at`), '1', 'one item was held for a free slot and released when polled (psql)');
});

await step('38. cancel: DELETE a running conversion cancels it, no output is stored, and DELETE again hides it', async () => {
  const video = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-metadata', `comment=${tag()}`, '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']);
  const created = await uploadFile(OWNER, { bytes: video, filename: 'e2e-long.mp4', type: 'video/mp4' });
  equal(created.status, 200, 'upload a 30 s video');
  await waitProcessedAs(OWNER, created.data, 'step 38 30 s video');
  const posted = await OWNER.call('/conversions', { method: 'POST', json: { source: created.data.vanity, target: 'webm' } });
  equal([posted.status, ['queued', 'running'].includes(posted.data.status)], [202, true], 'a VP9 encode of 30 s: 202, still queued or running');
  const id = posted.data.id;
  const running = await poll('the conversion to start', async () => {
    const response = await OWNER.call(`/conversions/${id}`);
    return { done: response.data.status === 'running' && response.data.stage === 'converting', state: response.data };
  }, { timeoutMs: 60_000, intervalMs: 250 });
  note(`running (stage ${running.state.stage}, progress ${running.state.progress}) ${(running.waited / 1000).toFixed(1)}s after the POST`);
  const cancelled = await OWNER.call(`/conversions/${id}`, { method: 'DELETE' });
  equal([cancelled.status, cancelled.data.status, cancelled.data.stage, cancelled.data.output.file], [200, 'cancelled', null, null], 'DELETE /api/conversions/<id>: 200 cancelled');
  // The horse is stopped (rq's stop command): it never stores an output, and the row stays cancelled.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const after = await OWNER.call(`/conversions/${id}`);
  equal([after.data.status, after.data.output.file], ['cancelled', null], 'still cancelled 5 s later, no output');
  equal(psql(`SELECT count(*) FROM files WHERE conversion_id = ${BigInt(id)}`), '0', 'no output file was stored (psql)');
  equal(psql(`SELECT failure_reason FROM conversions WHERE id = ${BigInt(id)}`), 'cancelled', 'failure_reason cancelled (psql)');
  conversionTimes.push({ label: 'video -> webm, cancelled while running', ms: after.data.took, took: after.data.took, status: 'cancelled', cached: false });
  // The worker is free again: a quick conversion goes through.
  succeeded((await convert(OWNER, { source: m5.images[0], target: 'gif' }, 'image -> gif after the cancel')).conversion, 'after cancel');
  // DELETE on a finished conversion hides it from the history (204), the output untouched.
  equal((await OWNER.call(`/conversions/${id}`, { method: 'DELETE' })).status, 204, 'DELETE again (finished): 204');
  equal([(await OWNER.call(`/conversions/${id}`)).status], [404], 'then GET is 404');
  const history = await OWNER.call('/users/@me/conversions?limit=100');
  check(history.status === 200 && !history.data.items.some((item) => item.id === id), 'and it left GET /users/@me/conversions', history.data.items.map((item) => item.id));
});

await step('39. moderation cascade: staff remove a source, and its conversion output is removed too', async () => {
  // Fresh accounts: a removal is a strike, which mustn't pile up on the shared users over runs.
  const owner = makeUser('src');
  const converter = makeUser('conv');
  const asOwner = new Caller('source owner', { cookie: owner.session.value });
  const asConverter = new Caller('converter', { cookie: converter.session.value });
  const created = await uploadFile(asOwner, { bytes: noisePng(160, 120), filename: 'e2e-cascade-source.png', type: 'image/png' });
  equal(created.status, 200, 'someone uploads an image');
  const source = created.data;
  equal((await waitScanned(source, asOwner, 'step 39 source')).safety.state, 'ok', 'scanned: ok');
  const conversion = succeeded((await convert(asConverter, { source: source.vanity, target: 'webp' }, 'someone else\'s image -> webp')).conversion, 'cascade conversion');
  const output = conversion.output.file;
  equal(conversion.source.file && conversion.source.file.vanity, source.vanity, 'source.file is the public payload');
  equal((await waitScanned(output, asConverter, 'step 39 output')).safety.state, 'ok', 'the output is scanned: ok');
  equal((await page(vanityPath(output))).status, 200, 'the output is served');

  const removed = await OWNER.call('/admin/actions', { method: 'POST', json: {
    action: 'remove', target: { type: 'file', id: source.id }, rule: 'spam', note: 'e2e: cascade', message: 'e2e: removed',
  } });
  equal(removed.status, 200, 'staff: POST /admin/actions remove the source');
  const gone = await poll('the output to be removed by the cascade', async () => {
    const shell = await page(vanityPath(output));
    return { done: shell.status === 410, state: shell.status, shell };
  }, { timeoutMs: 60_000 });
  note(`the output's page was 410 ${(gone.waited / 1000).toFixed(1)}s after the removal (cascade job + lookup cache)`);
  equal(parseShell(gone.shell.text).state, 'removed', 'the output page is the removed shell');
  equal(psql(`SELECT moderation_state || ' ' || moderation_rule FROM files WHERE id = ${BigInt(output.id)}`), 'removed derived_from_removed', 'removed with derived_from_removed (psql)');
  const cdn = await request(output.cdn_url, { method: 'HEAD' });
  equal(cdn.status, 410, 'the CDN is 410 for the output');
  equal((await api(`/files/${output.vanity}`)).data.code, 'FILE_REMOVED', 'GET /files/<vanity>: FILE_REMOVED');
  const again = await asConverter.call('/conversions', { method: 'POST', json: { source: source.vanity, target: 'png' } });
  equal([again.status, again.data.code], [404, 'SOURCE_UNAVAILABLE'], 'the removed source can\'t be converted again');
  m5.removed = { output, url: `${MAIN}/${output.vanity}` };
});

await step('40. anonymous conversions: Turnstile, then 10 a day per guest and per IP', async () => {
  const created = await uploadFile(OWNER, { bytes: noisePng(96, 72), filename: 'e2e-daily.png', type: 'image/png' });
  equal((await waitScanned(created.data, OWNER, 'step 40 PNG')).safety.state, 'ok', 'scanned: ok');
  const ip = clientIp();
  const anonymous = await visitor(fromIp(ip));
  const noToken = await anonymous.call('/conversions', { method: 'POST', json: { source: created.data.vanity, target: 'webp' } });
  equal([noToken.status, noToken.data.code], [403, 'CAPTCHA_INVALID'], 'without a Turnstile token: 403 CAPTCHA_INVALID');
  // (Cloudflare's always-pass testing secret accepts any token, so a wrong token can't be shown failing here; the API
  // suite covers that with a mocked siteverify.)
  const body = { source: created.data.vanity, target: 'webp', turnstile_token: TURNSTILE_TOKEN };
  const first = succeeded((await convert(anonymous, body, 'anonymous image -> webp (1 of 10)')).conversion, 'first');
  equal([first.queue, first.output.file.visibility], ['anonymous', 'link'], 'anonymous queue, a link output');
  // the other nine are cache hits: each still counts (§4.1)
  for (let n = 2; n <= 10; n++) {
    const response = await anonymous.call('/conversions', { method: 'POST', json: body });
    check(response.status === 200 && response.data.cached === true, `conversion ${n} of 10: 200, a cache hit`, response.text.slice(0, 300));
  }
  const eleventh = await anonymous.call('/conversions', { method: 'POST', json: body });
  equal([eleventh.status, eleventh.data.code, eleventh.data.limit, eleventh.data.sign_in], [429, 'CONVERSION_LIMIT_REACHED', 'count', true], 'the 11th: 429 CONVERSION_LIMIT_REACHED { limit: count, sign_in }');
  check(eleventh.data.retry_after > 0 && eleventh.data.retry_after <= 86400, 'retry_after runs to midnight UTC', eleventh.data.retry_after);
  const sameIp = await (await visitor(fromIp(ip))).call('/conversions', { method: 'POST', json: body });
  equal([sameIp.status, sameIp.data.limit], [429, 'count'], 'a new guest from the same IP is refused too (per IP)');
  const elsewhere = await (await anonymousConverter()).call('/conversions', { method: 'POST', json: body });
  equal([elsewhere.status, elsewhere.data.cached], [200, true], 'another visitor on another address still converts');
  const history = await anonymous.call('/users/@me/conversions');
  equal([history.status, history.data.items.length], [200, 10], 'the visitor\'s own conversions: GET /users/@me/conversions as the guest');
});

await step('41. a Redis rate limit refuses with 429 RATE_LIMITED and Retry-After (GET /conversions/<id>: 5 per second)', async () => {
  const user = makeUser('rate');
  const caller = new Caller('rate-limited', { cookie: user.session.value });
  const unknown = '1000000000000000000';
  const responses = await Promise.all(Array.from({ length: 15 }, () => caller.call(`/conversions/${unknown}`)));
  const statuses = responses.map((response) => response.status);
  note(`15 concurrent polls: ${statuses.filter((s) => s === 404).length} answered (404), ${statuses.filter((s) => s === 429).length} refused (429)`);
  check(statuses.every((status) => status === 404 || status === 429), 'each is 404 UNKNOWN_CONVERSION or 429', statuses);
  check(statuses.filter((status) => status === 404).length <= 5 * 2, 'at most 5 a second get through', statuses);
  const refused = responses.find((response) => response.status === 429);
  check(refused, 'some are refused', statuses);
  equal([refused.data.code, typeof refused.data.retry_after], ['RATE_LIMITED', 'number'], '429 RATE_LIMITED { retry_after }');
  const header = Number(refused.headers.get('retry-after'));
  check(Number.isInteger(header) && header >= 1 && header <= 2, 'Retry-After: whole seconds, at least 1', refused.headers.get('retry-after'));
  equal(responses.find((response) => response.status === 404).data.code, 'UNKNOWN_CONVERSION', 'the ones through are the plain 404');
  await new Promise((resolve) => setTimeout(resolve, header * 1000 + 200));
  equal((await caller.call(`/conversions/${unknown}`)).status, 404, 'after Retry-After the window has moved on');
  const other = await AS_MEMBER.call(`/conversions/${unknown}`);
  equal(other.status, 404, 'the limit is per caller: another user isn\'t affected');
});

await step('42. pages: home, changelog, Terms, Privacy and the link-warnings help signed out, with the app CSP and HSTS; /legal redirects; the removed page\'s Terms link resolves', async () => {
  for (const [path, title] of [
    ['/', 'files.gg: share any file with a link'],
    ['/changelog', 'Changelog · files.gg'],
    ['/legal/terms', 'Terms of Service · files.gg'],
    ['/legal/privacy', 'Privacy Policy · files.gg'],
    ['/help/link-warnings', 'Link warnings · files.gg'],
  ]) {
    const response = await page(path);
    equal([response.status, response.headers.get('content-type')], [200, 'text/html; charset=utf-8'], `files.localhost${path}, signed out`);
    equal((/<title>([^<]*)<\/title>/.exec(response.text) || [])[1], title, `${path}: <title>`);
    check(/<script type="module"[^>]+src="\/assets\/app-[^"]+\.js"/.test(response.text) && response.text.includes('<div id="root"></div>'), `${path}: the app bundle's page`);
    check(!response.headers.getSetCookie().length, `${path}: no cookie`);
    // Milestone 7: the app pages carry the viewer's strict CSP (plus Discord avatars) and our own hosts' HSTS.
    const csp = response.headers.get('content-security-policy') || '';
    check(/script-src 'self' 'wasm-unsafe-eval' https:\/\/challenges\.cloudflare\.com;/.test(csp) && csp.includes("object-src 'none'")
      && csp.includes("frame-ancestors 'none'") && csp.includes('https://cdn.discordapp.com'), `${path}: the app CSP`, csp);
    equal(response.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains; preload', `${path}: HSTS`);
  }
  const legal = await page('/legal');
  equal([legal.status, legal.headers.get('location')], [302, '/legal/terms'], '/legal: 302 to /legal/terms');
  const onCdn = await request(`${CDN}/changelog`, { headers: BROWSER });
  check(!onCdn.text.includes('<title>Changelog'), 'the changelog is on files.localhost only (not on the CDN host)', onCdn.status);

  // The removed-file page (step 39) links to Terms (TERMS_URL in the viewer): the link is in the viewer's code and
  // resolves against files.localhost.
  check(m5.removed, 'step 39 left a removed file');
  const removed = await request(m5.removed.url, { headers: BROWSER });
  equal([removed.status, parseShell(removed.text).state], [410, 'removed'], 'the removed page');
  const scripts = [...removed.text.matchAll(/<(?:script type="module"[^>]*src|link rel="modulepreload"[^>]*href)="([^"]+\.js)"/g)].map((m) => m[1]);
  let found = null;
  for (const src of scripts) {
    if ((await request(new URL(src, MAIN).href)).text.includes('/legal/terms')) {
      found = src;
      break;
    }
  }
  check(found, 'the viewer code that renders the removed page links /legal/terms', scripts);
  const terms = await request(new URL('/legal/terms', m5.removed.url).href, { headers: BROWSER });
  equal([terms.status, (/<title>([^<]*)<\/title>/.exec(terms.text) || [])[1]], [200, 'Terms of Service · files.gg'], 'and the link resolves to the Terms page');
});

await step('43. upload keys: a single upload of exactly 100,000,000 bytes is accepted, one byte more is 413', async () => {
  const created = await OWNER.call('/users/@me/upload-keys', { method: 'POST', json: { name: 'e2e 100 MB' } });
  equal(created.status, 201, 'an upload key');
  const sharexTool = tool(created.data.secret);
  try {
    equal((await limitsOf(OWNER)).rest.max_file_size_single, 100_000_000, 'max_file_size_single: 100,000,000');
    const bytes = randomBytes(100_000_000);
    const started = Date.now();
    const ok = await uploadFile(sharexTool, { bytes, filename: 'e2e-100mb.bin' });
    equal(ok.status, 200, `100,000,000 bytes through api.files.localhost with the key (${ok.text.slice(0, 200)})`);
    equal(ok.data.size, 100_000_000, 'stored size');
    note(`100,000,000 bytes uploaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    let over;
    try {
      over = await uploadFile(sharexTool, { bytes: Buffer.concat([bytes, Buffer.from([0x2a])]), filename: 'e2e-100mb-plus-one.bin' });
    } catch (error) {
      throw new Error(`the 100,000,001-byte upload didn't get an answer: ${error.cause || error}`);
    }
    equal([over.status, over.data && over.data.code, over.data && over.data.limit], [413, 'FILE_TOO_LARGE', 100_000_000], 'one byte more: 413 FILE_TOO_LARGE { limit: 100000000 }');
    equal((await OWNER.call(`/users/@me/files/${ok.data.id}`, { method: 'DELETE' })).status, 204, '(the 100 MB file is deleted again)');
  } finally {
    await OWNER.call(`/users/@me/upload-keys/${created.data.key.id}`, { method: 'DELETE' });
  }
});


const failed = results.filter((result) => !result.ok);
const checks = results.reduce((sum, result) => sum + result.checks, 0);
if (scanTimes.length) {
  const sorted = scanTimes.map((entry) => entry.ms).sort((a, b) => a - b);
  const seconds = (ms) => (ms / 1000).toFixed(1) + 's';
  console.log(`\nScan times (upload, or upload completion, to safety.state leaving pending), ${scanTimes.length} files: ` +
    `min ${seconds(sorted[0])}, median ${seconds(sorted[Math.floor(sorted.length / 2)])}, max ${seconds(sorted[sorted.length - 1])}`);
}
if (conversionTimes.length) {
  console.log(`\nConversion times (POST /conversions until GET /conversions/<id> says finished), ${conversionTimes.length} conversions:`);
  for (const entry of conversionTimes) {
    console.log(`  ${(entry.ms / 1000).toFixed(1).padStart(6)}s  ${entry.label}: ${entry.status}${entry.cached ? ', cache hit' : ''} (took ${entry.took} ms)`);
  }
}
console.log(`\n${results.length - failed.length}/${results.length} steps passed, ${checks} checks` +
  (failed.length ? `; failed: ${failed.map((result) => result.name.split('.')[0]).join(', ')}` : ''));
process.exit(failed.length ? 1 : 0);
