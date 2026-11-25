#!/usr/bin/env node
// Production smoke and security checks (docs/redesign/contracts/milestone-7.md §5.1): the launch gate for
// files.gg, cdn.files.gg and api.files.gg, and the deploy script's post-rollover check (`--quick`).
//
//   node ops/smoke.mjs <base-url> [--quick | --uploads] [--key fgg_…] [--session fgs_…]
//                      [--cdn <url>] [--api <url>] [--cookie-name <name>] [--no-body-limit]
//
//   node ops/smoke.mjs https://files.gg --quick                  # pages and headers only (deploys)
//   node ops/smoke.mjs https://files.gg                          # + /internal, cookies (read-only, the default)
//   FILESGG_SMOKE_SESSION=fgs_… node ops/smoke.mjs https://files.gg --uploads
//   node ops/smoke.mjs http://files.localhost:8787 --uploads --session "$(jq -r .session.value e2e/.local/e2e-user.json)"
//
// The CDN and API hosts are the base's host with `cdn.` and `api.` in front (same scheme and port), unless
// `--cdn` / `--api` say otherwise. Node 22+, no dependencies. Exit 0 when every check passed, 1 when one failed,
// 2 on bad arguments.
//
// `--uploads` uploads the hostile files of §5.1 (and the 100,000,000-byte body-limit pair) and checks each against
// what milestones 2-4 promise. An upload key can only upload (milestone-6 §7.2), so it also needs the uploader's
// web session (`--session` or FILESGG_SMOKE_SESSION: the `__Host-filesgg_session` cookie's value from a signed-in
// browser) to read each file's scan result and to delete everything it uploaded at the end. The key is `--key` or
// FILESGG_SMOKE_KEY; without one, a temporary key is made with the session and revoked at the end. Every upload
// also expires in an hour, so nothing outlives an interrupted run. Use a staff account: flagged and blocked files
// open moderation cases and notices for their uploader.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

const USAGE = 'usage: node ops/smoke.mjs <base-url> [--quick | --uploads] [--key fgg_…] [--session fgs_…] ' +
  '[--cdn <url>] [--api <url>] [--cookie-name <name>] [--no-body-limit]';

let options;
try {
  options = parseArgs({
    allowPositionals: true,
    options: {
      quick: { type: 'boolean', default: false },
      uploads: { type: 'boolean', default: false },
      'no-body-limit': { type: 'boolean', default: false },
      key: { type: 'string' },
      session: { type: 'string' },
      cdn: { type: 'string' },
      api: { type: 'string' },
      'cookie-name': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}
if (options.values.help) {
  console.log(USAGE);
  process.exit(0);
}
const args = options.values;
if (options.positionals.length !== 1 || (args.quick && args.uploads)) {
  console.error(USAGE);
  process.exit(2);
}

function originOf(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    console.error(`${label} isn't a URL: ${value}`);
    process.exit(2);
  }
  return url.origin;
}
const MAIN = originOf(options.positionals[0], 'the base URL');
const sibling = (prefix) => {
  const url = new URL(MAIN);
  url.hostname = `${prefix}.${url.hostname}`;
  return url.origin;
};
const CDN = args.cdn ? originOf(args.cdn, '--cdn') : sibling('cdn');
const API = args.api ? originOf(args.api, '--api') : sibling('api');
const HTTPS = MAIN.startsWith('https:');
// The web session cookie: `__Host-filesgg_session` in production; the local stack (plain http) uses
// `filesgg_session` without `Secure` (e2e/README.md).
const COOKIE_NAME = args['cookie-name'] || (HTTPS ? '__Host-filesgg_session' : 'filesgg_session');
const SESSION = args.session || process.env.FILESGG_SMOKE_SESSION || null;
const KEY = args.key || process.env.FILESGG_SMOKE_KEY || null;
if (args.uploads && !SESSION) {
  console.error('--uploads needs the uploader\'s web session (--session or FILESGG_SMOKE_SESSION): an upload key can\'t read ' +
    'scan results or delete files.');
  process.exit(2);
}

// The single-request limit (milestone-5 §18, PLAN.md §4) and the Worker's lookup cache (milestone-4 §10.2).
const BODY_LIMIT = 100_000_000;
const LOOKUP_TTL_MS = 5_000;
const SCAN_TIMEOUT_MS = 180_000;
const YEAR = 31_536_000;


// --- output -------------------------------------------------------------------------------------------------

const results = [];
function check(condition, name, detail) {
  results.push({ ok: !!condition, name });
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    const text = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
    console.log(`  FAIL  ${name}${text ? `\n        ${text.slice(0, 600)}` : ''}`);
  }
  return !!condition;
}
const equal = (actual, expected, name) => check(JSON.stringify(actual) === JSON.stringify(expected), name,
  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const note = (text) => console.log(`        ${text}`);

async function section(title, fn) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (error) {
    check(false, `${title}: finished without an error`, error.stack || String(error));
  }
}


// --- HTTP ---------------------------------------------------------------------------------------------------

async function request(url, { method = 'GET', headers = {}, body, json, timeoutMs = 120_000 } = {}) {
  if (json !== undefined) {
    body = JSON.stringify(json);
    headers = { 'content-type': 'application/json', ...headers };
  }
  const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const buffer = Buffer.from(await response.arrayBuffer());
  let data;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch {
    data = undefined;
  }
  return { status: response.status, headers: response.headers, buffer, text: buffer.toString('utf8'), data };
}

// The uploader's website session, on files.gg/api with the CSRF header on writes (milestone-6 §3.6).
const web = (path, { method = 'GET', ...rest } = {}) => request(`${MAIN}/api${path}`, {
  method,
  ...rest,
  headers: {
    cookie: `${COOKIE_NAME}=${SESSION}`,
    ...(method === 'GET' ? {} : { 'x-filesgg-csrf': '1' }),
    ...(rest.headers || {}),
  },
});

async function poll(what, fn, { timeoutMs, intervalMs = 500 }) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last.done) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last: ${JSON.stringify(last && (last.state ?? last))}`);
}


// --- header rules -------------------------------------------------------------------------------------------

function parseCsp(value) {
  const directives = new Map();
  for (const part of String(value || '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      directives.set(name.toLowerCase(), sources);
    }
  }
  return directives;
}

// No script can come from anywhere but files.gg itself (and Turnstile): no inline script, no eval, no wildcard.
function scriptsLockedDown(csp) {
  const scripts = csp.get('script-src') || csp.get('default-src');
  if (!scripts) {
    return false;
  }
  return !scripts.some((source) => ["'unsafe-inline'", "'unsafe-eval'", '*', 'http:', 'https:', 'data:', 'blob:'].includes(source));
}

function checkHsts(response, label, { strict }) {
  if (!HTTPS) {
    return;
  }
  const value = response.headers.get('strict-transport-security') || '';
  const maxAge = Number((/max-age=(\d+)/i.exec(value) || [])[1] || 0);
  const ok = maxAge >= YEAR && (!strict || (/includesubdomains/i.test(value) && /preload/i.test(value)));
  check(ok, `${label}: HSTS (max-age ≥ 1 year${strict ? ', includeSubDomains, preload' : ''})`, value || '(none)');
}

function checkNoCookies(response, label) {
  check(response.headers.getSetCookie().length === 0, `${label}: sets no cookie`, response.headers.getSetCookie());
}

// Every files.gg page (milestone-2 §4, milestone-4 §10, milestone-6 §6): nosniff, a referrer policy, no cookie, HSTS.
function checkPageBasics(response, label) {
  equal(response.headers.get('x-content-type-options'), 'nosniff', `${label}: X-Content-Type-Options: nosniff`);
  check(['strict-origin-when-cross-origin', 'no-referrer', 'same-origin', 'strict-origin'].includes(response.headers.get('referrer-policy')),
    `${label}: Referrer-Policy`, response.headers.get('referrer-policy'));
  checkNoCookies(response, label);
  checkHsts(response, label, { strict: true });
}

// The viewer shell (web/README.md §6, utils/viewer.js viewerCsp).
function checkViewerPage(response, label) {
  const csp = parseCsp(response.headers.get('content-security-policy'));
  check(scriptsLockedDown(csp), `${label}: CSP script-src has no inline, eval or wildcard sources`, response.headers.get('content-security-policy'));
  equal(csp.get('frame-ancestors'), ["'none'"], `${label}: CSP frame-ancestors 'none'`);
  equal(csp.get('object-src'), ["'none'"], `${label}: CSP object-src 'none'`);
  equal(csp.get('base-uri'), ["'none'"], `${label}: CSP base-uri 'none'`);
  const connect = csp.get('connect-src') || [];
  check(connect.includes(CDN) && connect.includes(API), `${label}: CSP connect-src names the CDN and the API`, connect);
  checkPageBasics(response, label);
}

// The dashboard entry's pages (/, /changelog, /legal/*, /convert, /app/*): never framed (milestone-6 §6, the
// clickjacking rule), and PLAN.md "Hardening cdn.files.gg": "a strict CSP (script-src 'self' plus the Turnstile host)".
function checkAppPage(response, label) {
  const raw = response.headers.get('content-security-policy');
  const csp = parseCsp(raw);
  equal(csp.get('frame-ancestors'), ["'none'"], `${label}: CSP frame-ancestors 'none'`);
  equal(response.headers.get('x-frame-options'), 'DENY', `${label}: X-Frame-Options: DENY`);
  check(scriptsLockedDown(csp), `${label}: CSP restricts scripts (script-src 'self' plus Turnstile, PLAN.md Hardening)`, raw);
  checkPageBasics(response, label);
}

// Every cdn.files.gg response, errors included (utils/security.js cdnSecurityHeaders, PLAN.md Hardening part A).
function checkCdnHeaders(response, label) {
  const raw = response.headers.get('content-security-policy');
  const csp = parseCsp(raw);
  check(csp.has('sandbox') && csp.get('sandbox').length === 0, `${label}: CSP sandbox, with no allow-* exceptions`, raw);
  equal(csp.get('default-src'), ["'none'"], `${label}: CSP default-src 'none'`);
  equal(csp.get('frame-ancestors'), [MAIN], `${label}: CSP frame-ancestors is only files.gg`);
  equal(response.headers.get('x-content-type-options'), 'nosniff', `${label}: X-Content-Type-Options: nosniff`);
  equal(response.headers.get('referrer-policy'), 'no-referrer', `${label}: Referrer-Policy: no-referrer`);
  equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', `${label}: Cross-Origin-Opener-Policy: same-origin`);
  equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin', `${label}: Cross-Origin-Resource-Policy: cross-origin`);
  check(response.headers.get('access-control-allow-credentials') === null, `${label}: no credentialed CORS`);
  checkNoCookies(response, label);
  checkHsts(response, label, { strict: false });
}

const randomVanity = () => `smoke${randomBytes(6).toString('hex')}`;


// --- the checks -----------------------------------------------------------------------------------------------

async function checkPages() {
  for (const [path, label] of [['/', 'home'], ['/changelog', 'changelog'], ['/legal/terms', 'Terms'],
    ['/legal/privacy', 'Privacy'], ['/convert', 'convert'], ['/app', 'dashboard'], ['/app/login', 'sign-in']]) {
    const response = await request(MAIN + path);
    equal(response.status, 200, `${label} (${path}): 200`);
    check(/^text\/html/.test(response.headers.get('content-type')), `${label}: text/html`, response.headers.get('content-type'));
    checkAppPage(response, label);
  }
  const legal = await request(`${MAIN}/legal`);
  equal([legal.status, legal.headers.get('location')], [302, '/legal/terms'], '/legal: 302 to /legal/terms');

  const report = await request(`${MAIN}/report`);
  equal(report.status, 200, 'report page (/report, the viewer shell): 200');
  checkViewerPage(report, 'report page');
  const missing = await request(`${MAIN}/${randomVanity()}`);
  equal(missing.status, 404, 'viewer for an unknown file: 404');
  checkViewerPage(missing, 'viewer (missing file)');
  const album = await request(`${MAIN}/a/${randomVanity()}`);
  equal(album.status, 404, 'album viewer for an unknown album: 404');
  checkViewerPage(album, 'album viewer (missing album)');
}

async function checkSecurityTxt() {
  const main = await request(`${MAIN}/.well-known/security.txt`);
  equal([main.status, main.headers.get('content-type')], [200, 'text/plain; charset=utf-8'], 'security.txt on files.gg: 200 text/plain');
  check(/^Contact:\s*\S+/m.test(main.text), 'security.txt: a Contact line', main.text);
  const expires = (/^Expires:\s*(\S+)/m.exec(main.text) || [])[1];
  check(expires && Date.parse(expires) > Date.now(), 'security.txt: Expires is in the future (RFC 9116)', expires || '(none)');
  equal(main.headers.get('x-content-type-options'), 'nosniff', 'security.txt on files.gg: X-Content-Type-Options: nosniff');
  checkNoCookies(main, 'security.txt on files.gg');
  checkHsts(main, 'security.txt on files.gg', { strict: true });
  const cdn = await request(`${CDN}/.well-known/security.txt`);
  equal([cdn.status, cdn.text], [200, main.text], 'security.txt on the CDN: 200, the same file');
  checkCdnHeaders(cdn, 'security.txt on the CDN');
  equal((await request(`${API}/.well-known/security.txt`)).status, 404, 'security.txt on the API host: 404');
}

async function checkCdnAndApiHosts() {
  for (const path of ['/', `/files/${randomVanity()}.png`, `/previews/thumb/${randomVanity()}.webp`]) {
    const response = await request(CDN + path);
    equal(response.status, 404, `CDN ${path}: 404`);
    checkCdnHeaders(response, `CDN ${path} (404)`);
  }
  const health = await request(`${API}/health`, { headers: { origin: 'https://evil.example' } });
  equal(health.status, 200, 'API host /health: 200');
  equal(health.headers.get('access-control-allow-origin'), '*', 'API host: CORS is `*` for a foreign origin');
  check(health.headers.get('access-control-allow-credentials') === null, 'API host: never credentialed CORS');
  checkNoCookies(health, 'API host /health');
  checkHsts(health, 'API host /health', { strict: false });
  const sameOrigin = await request(`${MAIN}/api/health`, { headers: { origin: 'https://evil.example' } });
  equal(sameOrigin.status, 200, 'files.gg/api/health: 200');
  check(sameOrigin.headers.get('access-control-allow-credentials') === null, 'files.gg/api: never credentialed CORS for a foreign origin');
}

// milestone-4 §9.1, milestone-7 §2.2: no client reaches the API's /internal routes, through any host or spelling.
async function checkInternal() {
  const spellings = ['/internal/metrics', '/internal/files/smoke', '/%69nternal/metrics', '/INTERNAL/metrics',
    '//internal/metrics', '/internal%2Fmetrics', '/internal%2fmetrics'];
  const targets = [
    ...spellings.map((path) => [MAIN, `/api${path}`]),
    ...spellings.map((path) => [MAIN, path]),
    ...spellings.map((path) => [API, path]),
    ...spellings.map((path) => [CDN, path]),
  ];
  const leaks = [];
  for (const [origin, path] of targets) {
    const response = await request(origin + path);
    if (response.status !== 404 || /# (HELP|TYPE) /.test(response.text) || /"safety"|"storage"/.test(response.text)) {
      leaks.push(`${origin}${path}: ${response.status} ${response.text.slice(0, 80)}`);
    }
  }
  check(leaks.length === 0, `/internal/* is 404 on every host (${targets.length} spellings)`, leaks.join('\n        '));
}

// PLAN.md Hardening: "a page on cdn.files.gg can't set a __Host- cookie for files.gg".
// - The session cookie is host-only and `__Host-` (Secure, Path=/, no Domain), which browsers refuse to accept from any
//   other host: read from the API's own clearing Set-Cookie for a dead session.
// - The CDN never sets a cookie, and every CDN response is sandboxed (an opaque origin: no script, no document.cookie);
//   checked on every CDN response above and below.
// - If a sibling host managed to plant a second cookie under the same name anyway, the Worker forwards neither
//   (utils/cookies.js sessionCookieHeader), so it can't sign anyone in.
async function checkCookies() {
  const dead = `fgs_${randomBytes(15).toString('hex')}`;
  const cleared = await request(`${MAIN}/api/auth/session`, { headers: { cookie: `${COOKIE_NAME}=${dead}` } });
  equal([cleared.status, cleared.data && cleared.data.user], [200, null], 'a dead session cookie: GET /api/auth/session is signed out');
  const line = cleared.headers.getSetCookie().find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
  if (check(line, `the API clears the dead ${COOKIE_NAME} cookie`, cleared.headers.getSetCookie())) {
    const attributes = line.split(';').slice(1).map((part) => part.trim().toLowerCase());
    check(attributes.includes('path=/'), 'session cookie: Path=/', line);
    check(!attributes.some((attribute) => attribute.startsWith('domain=')), 'session cookie: host-only (no Domain)', line);
    check(attributes.includes('httponly'), 'session cookie: HttpOnly', line);
    check(attributes.includes('samesite=lax') || attributes.includes('samesite=strict'), 'session cookie: SameSite', line);
    if (HTTPS) {
      check(COOKIE_NAME.startsWith('__Host-'), 'session cookie: the __Host- prefix', COOKIE_NAME);
      check(attributes.includes('secure'), 'session cookie: Secure', line);
    } else {
      note('plain http: the __Host- prefix and Secure are production-only (the local stack runs SESSION_COOKIE_INSECURE)');
    }
  }
  const doubled = await request(`${MAIN}/api/auth/session`, {
    headers: { cookie: `${COOKIE_NAME}=${dead}; ${COOKIE_NAME}=fgs_${randomBytes(15).toString('hex')}` },
  });
  check(doubled.status === 200 && doubled.headers.getSetCookie().length === 0,
    'two session cookies under one name (one planted by a sibling host): the Worker forwards neither', doubled.headers.getSetCookie());
  const onApi = await request(`${API}/auth/session`, { headers: { cookie: `${COOKIE_NAME}=${dead}` } });
  check(onApi.headers.getSetCookie().length === 0, 'the API host ignores the session cookie (no Set-Cookie)', onApi.headers.getSetCookie());
  const cdn = await request(`${CDN}/files/${randomVanity()}.html`, { headers: { cookie: `${COOKIE_NAME}=${dead}` } });
  checkCdnHeaders(cdn, 'CDN with a cookie sent');
}


// --- hostile files (§5.1) ------------------------------------------------------------------------------------

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tag = () => randomBytes(12).toString('hex');

function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, { flags = 0x0800, stored = data } = {}] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + stored.length;
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

// Traditional PKWARE encryption (ZipCrypto), as api/tests/m4.py zipcrypto() writes it: flag bit 0 set.
function zipCrypto(entries, password = 'smoke') {
  const crcByte = (crc, byte) => (crc32(Buffer.from([byte]), (crc ^ 0xffffffff) >>> 0) ^ 0xffffffff) >>> 0;
  return zipOf(entries.map(([name, data]) => {
    const keys = [0x12345678, 0x23456789, 0x34567890];
    const update = (byte) => {
      keys[0] = crcByte(keys[0], byte);
      keys[1] = (keys[1] + (keys[0] & 0xff)) >>> 0;
      keys[1] = (Number((BigInt(keys[1]) * 134775813n + 1n) & 0xffffffffn)) >>> 0;
      keys[2] = crcByte(keys[2], keys[1] >>> 24);
    };
    for (const byte of Buffer.from(password)) {
      update(byte);
    }
    const plain = Buffer.concat([randomBytes(11), Buffer.from([crc32(data) >>> 24]), data]);
    const cipher = Buffer.alloc(plain.length);
    for (let i = 0; i < plain.length; i++) {
      const temp = (keys[2] | 2) & 0xffff;
      cipher[i] = plain[i] ^ (((temp * (temp ^ 1)) >>> 8) & 0xff);
      update(plain[i]);
    }
    return [name, data, { flags: 0x0801, stored: cipher }];
  }));
}

// A minimal Windows PE header (api/tests/test_filetypes.py): "MZ", the PE offset at 0x3C, "PE\0\0" and i386 there.
function peBytes() {
  const bytes = Buffer.alloc(4096, 0xcc);
  bytes.write('MZ', 0, 'latin1');
  bytes.fill(0x90, 2, 0x3c);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.fill(0, 0x40, 0x80);
  bytes.write('PE\0\0', 0x80, 'latin1');
  bytes.writeUInt16LE(0x014c, 0x84);
  return bytes;
}

// A decodable RGB PNG of random noise.
function pngBytes(width = 64, height = 48) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]), randomBytes(width * 3));
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// A 1x1 GIF with a fresh comment, then an HTML document (the image + HTML polyglot).
function gifHtmlBytes() {
  const comment = Buffer.from(tag(), 'latin1');
  return Buffer.concat([
    Buffer.from('47494638396101000100800000ffffff000000', 'hex'),
    Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0]),
    Buffer.from('2c00000000010001000002024401003b', 'hex'),
    Buffer.from('<html><body><script>document.cookie="__Host-filesgg_session=planted; Path=/; Secure"</script></body></html>'),
  ]);
}

// A one-page PDF whose catalog opens a JavaScript action (api/tests/m4.py pdf_javascript()).
function pdfJavascriptBytes() {
  const text = `BT /F1 12 Tf 72 720 Td (files.gg smoke ${tag()}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    "<< /S /JavaScript /JS (app.alert('files.gg smoke')) >>",
  ];
  let body = '%PDF-1.7\n';
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

// A .docx carrying a VBA project (api/tests/m4.py docx_with_vba()).
function macroDocxBytes() {
  return zipOf([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', Buffer.from(`<w:document><w:body><w:p>${tag()}</w:p></w:body></w:document>`)],
    ['word/vbaProject.bin', Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), randomBytes(512)])],
  ]);
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const RLO = '‮';

// What milestones 2-4 promise for each (milestone-4 §5.8, PLAN.md Hardening parts A-D). `served`: the CDN's
// Content-Type and disposition; `state`/`reason`: the owner's safety after the scan; `refused`: the upload's answer.
function hostileFiles() {
  const html = Buffer.from(`<!doctype html><title>smoke ${tag()}</title><script>document.cookie="__Host-filesgg_session=planted; Path=/; Secure"</script>`);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!-- ${tag()} --><script>alert(document.domain)</script></svg>`);
  return [
    { label: 'HTML page', filename: 'smoke.html', type: 'text/html', bytes: html, state: 'ok', served: ['text/plain', 'inline'] },
    { label: 'SVG with a script', filename: 'smoke.svg', type: 'image/svg+xml', bytes: svg, state: 'ok', served: ['text/plain', 'inline'] },
    { label: 'PDF with /JavaScript', filename: 'smoke.pdf', type: 'application/pdf', bytes: pdfJavascriptBytes(),
      state: 'flagged', reason: 'pdf_javascript', served: ['application/pdf', 'attachment'] },
    { label: 'polyglot: PNG with a zip appended', filename: 'smoke-polyglot.png', type: 'image/png',
      bytes: Buffer.concat([pngBytes(), zipOf([['notes.txt', Buffer.from(tag())]])]),
      state: 'flagged', reason: 'polyglot_archive', served: ['image/png', 'inline'] },
    { label: 'polyglot: GIF that is also HTML', filename: 'smoke-polyglot.gif', type: 'image/gif', bytes: gifHtmlBytes(),
      state: 'ok', served: ['image/gif', 'inline'] },
    { label: 'renamed .exe (a PE as photo.jpg)', filename: 'photo.jpg', type: 'image/jpeg', bytes: peBytes(), refused: [400, 'FILE_TYPE_NOT_ALLOWED'] },
    { label: 'bidi-trick .exe (invoice<RLO>fdp.exe)', filename: `invoice${RLO}fdp.exe`, type: 'application/pdf',
      bytes: Buffer.from(`%PDF-1.4\n% ${tag()}\n`), refused: [400, 'FILE_TYPE_NOT_ALLOWED'] },
    { label: 'archive holding an .exe', filename: 'smoke-tools.zip', type: 'application/zip',
      bytes: zipOf([['setup.exe', peBytes()], ['readme.txt', Buffer.from(tag())]]), state: 'blocked', reason: 'blocked_type' },
    { label: 'encrypted archive (ZipCrypto)', filename: 'smoke-encrypted.zip', type: 'application/zip',
      bytes: zipCrypto([['secret.txt', Buffer.from(tag().repeat(4))]]), state: 'ok', warning: 'encrypted_archive',
      served: ['application/zip', 'attachment'] },
    { label: 'macro .docx (vbaProject.bin)', filename: 'smoke-macro.docx', type: DOCX, bytes: macroDocxBytes(),
      state: 'blocked', reason: 'blocked_type' },
    { label: 'bidi-trick filename (smoke<RLO>gpj.txt)', filename: `smoke${RLO}gpj.txt`, type: 'text/plain',
      bytes: Buffer.from(`files.gg smoke ${tag()}\n`), state: 'ok', served: ['text/plain', 'inline'], bidi: true },
  ];
}

const uploaded = [];
let temporaryKey = null;

async function uploadKey() {
  if (KEY) {
    return KEY;
  }
  const created = await web('/users/@me/upload-keys', { method: 'POST', json: { name: `smoke ${new Date().toISOString().slice(0, 16)}` } });
  if (!check(created.status === 201, 'a temporary upload key is made with the session', `${created.status} ${created.text.slice(0, 200)}`)) {
    throw new Error('no upload key');
  }
  temporaryKey = created.data.key;
  return created.data.secret;
}

// POST api.files.gg/files with the key, multipart (fields first, as tools send them), expiring in an hour.
async function upload(key, { filename, type, bytes }) {
  const form = new FormData();
  form.append('expires_in', '3600');
  form.append('file', new Blob([bytes], { type }), filename);
  const response = await request(`${API}/files`, { method: 'POST', headers: { authorization: `Key ${key}` }, body: form });
  if (response.status === 200 && response.data && response.data.id) {
    uploaded.push(response.data.id);
  }
  return response;
}

async function waitScanned(id, label) {
  const done = await poll(`${label} to be scanned`, async () => {
    const response = await web(`/users/@me/files/${id}`);
    if (response.status !== 200) {
      return { done: true, item: null, state: response.status, response };
    }
    return { done: response.data.safety.state !== 'pending', item: response.data, state: response.data.safety };
  }, { timeoutMs: SCAN_TIMEOUT_MS });
  if (!done.item) {
    throw new Error(`GET /api/users/@me/files/${id}: ${done.response.status} ${done.response.text.slice(0, 200)}`);
  }
  return done.item;
}

// The CDN serves a file once the Worker's lookup cache (5 s) no longer holds it as pending.
async function cdnServed(url) {
  return (await poll('the CDN to serve it', async () => {
    const response = await request(url);
    return { done: response.status !== 404, response, state: response.status };
  }, { timeoutMs: LOOKUP_TTL_MS + 15_000, intervalMs: 1000 })).response;
}

async function checkHostileFile(key, file) {
  const label = file.label;
  const response = await upload(key, file);
  if (file.refused) {
    equal([response.status, response.data && response.data.code], file.refused, `${label}: refused at upload (${file.refused.join(' ')})`);
    return;
  }
  if (!equal(response.status, 200, `${label}: accepted at upload`) || !response.data) {
    note(response.text.slice(0, 300));
    return;
  }
  const item = await waitScanned(response.data.id, label);
  const plainUrl = response.data.cdn_url.split('?')[0];
  equal([item.safety.state, item.safety.reason], [file.state, file.reason ?? null],
    `${label}: scanned ${file.state}${file.reason ? ` (${file.reason})` : ''}`);
  if (file.warning) {
    const publicFile = await request(`${API}/files/${response.data.vanity}`);
    check(publicFile.status === 200 && (publicFile.data.warnings || []).includes(file.warning),
      `${label}: visitors get the ${file.warning} warning`, publicFile.data);
  }
  if (!file.served) {
    // blocked: never served, and it looks missing (milestone-4 §10.2)
    await new Promise((resolve) => setTimeout(resolve, LOOKUP_TTL_MS + 1000));
    const blob = await request(plainUrl);
    equal([blob.status, blob.headers.get('cache-control')], [404, 'private, no-store'], `${label}: the CDN never serves it (404, private, no-store)`);
    checkCdnHeaders(blob, `${label}: CDN 404`);
    const publicFile = await request(`${API}/files/${response.data.vanity}`);
    equal(publicFile.status, 404, `${label}: GET /files/<vanity> is 404`);
    return;
  }
  const blob = await cdnServed(plainUrl);
  equal(blob.status, 200, `${label}: the CDN serves it`);
  equal(sha256(blob.buffer), sha256(file.bytes), `${label}: the CDN bytes match (sha256)`);
  const [type, disposition] = file.served;
  equal((blob.headers.get('content-type') || '').split(';')[0], type, `${label}: Content-Type ${type}${type === 'text/plain' && file.type !== 'text/plain' ? ' (forced text)' : ''}`);
  const contentDisposition = blob.headers.get('content-disposition') || '';
  check(contentDisposition.startsWith(disposition), `${label}: Content-Disposition ${disposition}`, contentDisposition);
  checkCdnHeaders(blob, `${label}: CDN`);
  if (file.bidi) {
    check(!contentDisposition.includes(RLO) && !/%E2%80%AE/i.test(contentDisposition),
      `${label}: the bidi control is stripped from Content-Disposition`, contentDisposition);
    check(/filename\*=UTF-8''[^;]*\.txt$/.test(contentDisposition), `${label}: the real extension (.txt) is what the download is named`, contentDisposition);
  }
  if (file.label === 'HTML page') {
    const page = await request(`${MAIN}/${response.data.vanity}`);
    equal(page.status, 200, 'the viewer page of an uploaded file: 200');
    checkViewerPage(page, 'viewer (an uploaded file)');
  }
}

async function checkUploads() {
  const key = await uploadKey();
  // one after another: a failure names its file, and the scanner isn't flooded
  for (const file of hostileFiles()) {
    try {
      await checkHostileFile(key, file);
    } catch (error) {
      check(false, `${file.label}: finished without an error`, error.message);
    }
  }
  return key;
}

// Exactly 100,000,000 bytes through the API host is accepted, one more is 413 (milestone-7 §5.1, §10 "Cloudflare's
// body limit unit"). A raw body (`type=raw`), so the request body is exactly that many bytes, with no multipart framing.
// node:http rather than fetch(): a server may answer 413 from Content-Length alone and close the connection before
// reading the body (the API does), and fetch() then reports the broken write (EPIPE) instead of the answer.
function rawPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const client = url.startsWith('https:') ? https : http;
    const outgoing = client.request(url, { method: 'POST', headers: { ...headers, 'content-length': body.length }, timeout: 600_000 }, (response) => {
      answered = true;
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let data;
        try {
          data = JSON.parse(buffer.toString('utf8'));
        } catch {
          data = undefined;
        }
        resolve({ status: response.statusCode, headers: new Headers(response.headers), buffer, text: buffer.toString('utf8'), data });
      });
      response.on('error', reject);
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('timed out')));
    outgoing.on('error', (error) => {
      // the answer may still be on its way after the write broke
      setTimeout(() => answered || reject(error), 2000);
    });
    outgoing.end(body);
  });
}

async function checkBodyLimit(key) {
  const bytes = randomBytes(BODY_LIMIT);
  const send = (body, name) => rawPost(`${API}/files?type=raw&expires_in=3600&filename=${name}`,
    { authorization: `Key ${key}`, 'content-type': 'application/octet-stream' }, body);
  const started = Date.now();
  const ok = await send(bytes, 'smoke-100mb.bin');
  if (ok.status === 200 && ok.data && ok.data.id) {
    uploaded.push(ok.data.id);
  }
  equal([ok.status, ok.data && ok.data.size], [200, BODY_LIMIT], 'exactly 100,000,000 bytes: accepted, stored size 100,000,000');
  note(`uploaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  let over;
  try {
    over = await send(Buffer.concat([bytes, Buffer.from([0x2a])]), 'smoke-100mb-plus-one.bin');
  } catch (error) {
    check(false, 'one byte more: an answer', String(error.cause || error));
    return;
  }
  if (over.status === 200 && over.data && over.data.id) {
    uploaded.push(over.data.id);
  }
  equal(over.status, 413, 'one byte more (100,000,001): 413');
  if (over.status === 413) {
    note(over.data && over.data.code
      ? `the 413 came from the API: ${over.data.code} { limit: ${over.data.limit} }`
      : `the 413 came from in front of the API (Cloudflare or nginx): ${over.headers.get('content-type')} ${over.text.slice(0, 80)}`);
  }
}

async function cleanUp() {
  if (uploaded.length) {
    const failures = [];
    for (const id of uploaded) {
      const response = await web(`/users/@me/files/${id}`, { method: 'DELETE' });
      if (response.status !== 204) {
        failures.push(`${id}: ${response.status} ${response.text.slice(0, 120)}`);
      }
    }
    check(failures.length === 0, `deleted the ${uploaded.length} uploaded file(s)`, failures.join('\n        '));
  }
  if (temporaryKey) {
    const response = await web(`/users/@me/upload-keys/${temporaryKey.id}`, { method: 'DELETE' });
    equal(response.status, 204, 'revoked the temporary upload key');
  }
}


// --- run --------------------------------------------------------------------------------------------------------

const mode = args.quick ? 'quick' : args.uploads ? 'uploads' : 'read-only';
console.log(`files.gg smoke (${mode}): ${MAIN}, ${CDN}, ${API}`);

await section('pages and their security headers', checkPages);
await section('security.txt', checkSecurityTxt);
await section('the CDN and API hosts', checkCdnAndApiHosts);
if (!args.quick) {
  await section('/internal/* is unreachable', checkInternal);
  await section('the session cookie can\'t be set from the CDN', checkCookies);
}
if (args.uploads) {
  try {
    let key = null;
    await section('hostile uploads (milestone-7 §5.1)', async () => {
      key = await checkUploads();
    });
    if (key && !args['no-body-limit']) {
      await section('the body limit through the API host', () => checkBodyLimit(key));
    }
  } finally {
    await section('clean-up', cleanUp);
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length} checks, ${failed.length} failed`);
for (const result of failed) {
  console.log(`  FAIL  ${result.name}`);
}
process.exit(failed.length ? 1 : 0);
