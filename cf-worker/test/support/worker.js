// Runs the real Worker (bundled by wrangler from wrangler.toml, in workerd) with wrangler's
// createTestHarness, against local mocks of the API, the old GCS bucket and B2 (S3).
//
// Static assets come from test/fixtures/web-dist (a real `web` build's viewer.html and app.html,
// plus placeholder files). Set WEB_DIST to run against a real build instead, for example
// `WEB_DIST=../web/dist npm run test:integration`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AwsV4Signer } from 'aws4fetch';

import { cases } from './fixtures.js';

process.env.WRANGLER_SEND_METRICS = 'false';
const { createTestHarness, experimental_readRawConfig } = await import('wrangler');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WEB_DIST = resolve(ROOT, process.env.WEB_DIST || 'test/fixtures/web-dist');

export const SECRETS = Object.freeze({
  ORIGIN_SHARED_SECRET: 'origin-secret',
  CDN_TOKEN_SECRET: 'test-cdn-token-secret',
  S3_READ_ACCESS_KEY_ID: 'test-read-key-id',
  S3_READ_SECRET_ACCESS_KEY: 'test-read-secret',
});
export const S3_BUCKET = 'filesgg-test';
export const S3_REGION = 'us-west-004';
export const NOW_S = () => Math.floor(Date.now() / 1000);


// --- Fixture data --------------------------------------------------------------------------
// The internal lookup (contract §2) for every file of the old page fixtures, plus files for each
// access case. `s3` / `gcs` say where the object's bytes live.

const files = {};
const albums = {};
let nextId = 1000000000000000000n;

function addFile(vanity, { visibility = 'link', backend = 'b2', s3 = true, gcs = false, accessVersion = 0, ...file }) {
  const id = String(nextId++);
  const hash = `h-${vanity.replace(/\W/g, '-')}`;
  const extension = (file.filename.match(/\.([^.]+)$/) || [])[1] || '';
  files[vanity] = {
    file: {
      id, vanity, kind: 'file', mimetype: 'application/octet-stream', extension, size: 1,
      cdnUrl: `https://cdn.files.gg/files/${vanity}${extension ? '.' + extension : ''}`,
      url: `https://files.gg/${vanity}${extension ? '.' + extension : ''}`,
      uploadedAt: Date.now() - 60000, expiresAt: null,
      ...file,
    },
    access: {
      visibility, access_version: accessVersion, unlock_ttl: 3600,
      password_expires_at: file.password_expires_at ?? null,
      show_name_when_locked: !!file.show_name_when_locked,
    },
    owner_user_id: '42',
    albums: [],
    storage: { backend, key: `files/${hash}` },
    bytes: { s3, gcs, body: file.body || `bytes of ${file.filename}` },
  };
  delete files[vanity].file.password_expires_at;
  delete files[vanity].file.show_name_when_locked;
  delete files[vanity].file.body;
  return files[vanity];
}

const KIND = { image: 'image', video: 'video', audio: 'audio', text: 'text' };
for (const [vanity, file] of Object.entries(cases.files)) {
  const major = file.mimetype.split('/')[0];
  const kind = file.mimetype === 'application/pdf' ? 'pdf' : (file.mimetype === 'image/svg+xml' ? 'file' : (KIND[major] || 'file'));
  addFile(vanity, {
    kind, filename: file.filename, mimetype: file.mimetype, size: file.size,
    width: file.width, height: file.height, cdnUrl: file.urls.cdn, url: file.urls.main,
  });
}
addFile('pw1', { visibility: 'password', accessVersion: 2, kind: 'image', filename: 'secret.png', mimetype: 'image/png', size: 9 });
addFile('pwname', { visibility: 'password', kind: 'image', filename: 'named.png', mimetype: 'image/png', size: 9, show_name_when_locked: true });
addFile('pwexp', { visibility: 'password', kind: 'image', filename: 'old.png', mimetype: 'image/png', size: 9, password_expires_at: NOW_S() - 60 });
addFile('priv1', { visibility: 'private', kind: 'image', filename: 'mine.png', mimetype: 'image/png', size: 9 });
addFile('pwalb', { visibility: 'password', kind: 'image', filename: 'in-album.png', mimetype: 'image/png', size: 9 });
addFile('hostile', { kind: 'image', filename: '</script><script>alert(1)</script>.png', mimetype: 'image/png', size: 9 });
addFile('expired1', { kind: 'image', filename: 'gone.png', mimetype: 'image/png', size: 9, expiresAt: Date.now() - 1000 });
addFile('gcsonly', { backend: 'gcs', s3: false, gcs: true, kind: 'text', filename: 'legacy.txt', mimetype: 'text/plain', size: 9 });
addFile('migrating', { backend: 'b2', s3: false, gcs: true, kind: 'text', filename: 'not-copied-yet.txt', mimetype: 'text/plain', size: 9 });
addFile('nowhere', { s3: false, gcs: false, kind: 'text', filename: 'lost.txt', mimetype: 'text/plain', size: 9 });
addFile('cached1', { kind: 'image', filename: 'cache-me.png', mimetype: 'image/png', size: 9 });
addFile('noid', { visibility: 'password', kind: 'image', filename: 'no-id.png', mimetype: 'image/png', size: 9 });
delete files.noid.file.id;
addFile('noalbums', { visibility: 'password', kind: 'image', filename: 'no-albums.png', mimetype: 'image/png', size: 9 });
delete files.noalbums.albums;
addFile('ranged', { kind: 'video', filename: 'range.mp4', mimetype: 'video/mp4', size: 26, body: 'abcdefghijklmnopqrstuvwxyz' });

function addAlbum(vanity, { visibility = 'link', accessVersion = 0, items, title = 'Trip', ...album }) {
  const id = String(nextId++);
  albums[vanity] = {
    album: {
      id, vanity, title, url: `https://files.gg/a/${vanity}`,
      items: items.map((item, position) => ({ ...files[item].file, position, caption: '' })),
      count: items.length,
      ...album,
    },
    access: { visibility, access_version: accessVersion, unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: false },
    items_access: Object.fromEntries(items.map((item) => [files[item].file.id, {
      visibility: files[item].access.visibility, access_version: files[item].access.access_version,
    }])),
  };
  // contract §2: each file lookup lists the albums it is a visible item of, with their versions.
  for (const item of items) {
    if (files[item].access.visibility !== 'private') {
      files[item].albums.push({ id, access_version: accessVersion });
    }
  }
  return albums[vanity];
}
addAlbum('alb1', { items: ['img1', 'vid1', 'priv1'] });
addAlbum('albpw', { visibility: 'password', accessVersion: 3, items: ['pwalb', 'img1'] });
addAlbum('albempty', { items: ['priv1'] });

export const FILES = files;
export const ALBUMS = albums;


// --- Mock servers --------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolveBody) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => resolveBody(body));
  });
}

function send(res, status, type, payload, headers = {}) {
  res.writeHead(status, { ...(type ? { 'content-type': type } : {}), ...headers });
  res.end(payload);
}

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(`http://127.0.0.1:${server.address().port}`)));
}

// Serves `body` honouring Range and If-None-Match, like S3 and GCS do.
function sendObject(req, res, body, type, extraHeaders = {}) {
  const etag = `"${Buffer.from(body).toString('hex').slice(0, 16)}"`;
  const headers = { etag, 'accept-ranges': 'bytes', 'last-modified': 'Tue, 01 Sep 2026 00:00:00 GMT', ...extraHeaders };
  if (req.headers['if-none-match'] === etag) {
    return send(res, 304, null, undefined, headers);
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
    if (start >= body.length) {
      return send(res, 416, 'application/xml', '<Error>InvalidRange</Error>', { 'content-range': `bytes */${body.length}` });
    }
    return send(res, 206, type, req.method === 'HEAD' ? undefined : body.slice(start, end + 1), {
      ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1,
    });
  }
  return send(res, 200, type, req.method === 'HEAD' ? undefined : body, { ...headers, 'content-length': body.length });
}


// The API, the old GCS bucket and the proxy's remote URLs, on one server.
export async function startUpstream() {
  const state = { requests: [], noManifest: false, failLookups: new Set() };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://upstream');
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });

    // API: internal lookups (contract §2). Wrong or missing secret: 404, like an unknown vanity.
    const internal = /^\/internal\/(files|albums)\/(.+)$/.exec(url.pathname);
    if (internal) {
      const [, kind, raw] = internal;
      const vanity = raw.split('/').map(decodeURIComponent).join('/');
      if (state.failLookups.has(vanity)) {
        return send(res, 502, 'text/html', 'Bad Gateway');
      }
      if (req.headers['x-filesgg-origin-secret'] !== SECRETS.ORIGIN_SHARED_SECRET) {
        return send(res, 404, 'application/json', '{"code":"UNKNOWN_FILE"}');
      }
      const found = (kind === 'files') ? files[vanity] : albums[vanity];
      if (!found) {
        return send(res, 404, 'application/json', '{"code":"UNKNOWN_FILE"}', { 'cache-control': 'no-store' });
      }
      const { bytes, ...payload } = found;
      return send(res, 200, 'application/json', JSON.stringify(payload), { 'cache-control': 'no-store' });
    }
    // API: anything else echoes, with the API's own (too loose) CORS headers.
    if (url.pathname.startsWith('/users/') || url.pathname === '/auth/login') {
      return send(res, 200, 'application/json', JSON.stringify({ path: url.pathname, method: req.method }), {
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true',
      });
    }
    // GCS: the old frontend.
    if (url.pathname === '/assets/stable/manifest.json') {
      return (state.noManifest)
        ? send(res, 403, 'application/xml', '<Error>AccessDenied</Error>')
        : send(res, 200, 'application/json', JSON.stringify(cases.manifest));
    }
    const legacy = {
      '/assets/stable/favicon.ico': ['image/x-icon', 'ICO'],
      '/assets/stable/old-app.js': ['application/javascript', 'old()'],
      '/assets/stable/evil.html': ['text/html', '<script>alert(1)</script>'],
    }[url.pathname];
    if (legacy) {
      return send(res, 200, legacy[0], legacy[1], { 'x-goog-generation': '1' });
    }
    // GCS: blobs not yet copied to B2.
    const blob = Object.values(files).find((file) => '/' + file.storage.key === url.pathname);
    if (blob && blob.bytes.gcs) {
      return sendObject(req, res, blob.bytes.body, 'application/octet-stream', { 'x-goog-generation': '1' });
    }
    // Pages the proxy fetches.
    if (url.pathname === '/remote/page.html') {
      return send(res, 200, 'text/html', '<html><head><meta property="og:image" content="/img.png"></head></html>');
    }
    if (url.pathname === '/remote/img.png') {
      return send(res, 200, 'image/png', 'PNG');
    }
    // The bucket answers 403 for objects that don't exist.
    return send(res, 403, 'application/xml', '<Error>AccessDenied</Error>');
  });
  state.origin = await listen(server);
  state.close = () => new Promise((resolveClose) => server.close(resolveClose));
  return state;
}


const AUTHORIZATION = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/;

// B2's S3 API, path-style. Every request must carry a valid SigV4 Authorization header for the
// read-only key; the mock recomputes the signature with aws4fetch's signer to check it.
export async function startS3() {
  const state = { requests: [], rejected: [] };
  const server = http.createServer(async (req, res) => {
    await readBody(req);
    const url = new URL(req.url, 'http://s3');
    const entry = { method: req.method, path: url.pathname, headers: req.headers };
    state.requests.push(entry);

    const reject = (why) => {
      state.rejected.push({ ...entry, why });
      send(res, 403, 'application/xml', `<Error><Code>SignatureDoesNotMatch</Code><Message>${why}</Message></Error>`);
    };
    const match = AUTHORIZATION.exec(req.headers.authorization || '');
    if (!match) {
      return reject('malformed Authorization header');
    }
    const [, keyId, date, region, signedList] = match;
    const signed = signedList.split(';');
    const amzDate = req.headers['x-amz-date'] || '';
    if (keyId !== SECRETS.S3_READ_ACCESS_KEY_ID || region !== S3_REGION || !amzDate.startsWith(date)) {
      return reject('wrong key, region or date');
    }
    for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) {
      if (!signed.includes(required)) {
        return reject(`${required} is not signed`);
      }
    }
    const headers = {};
    for (const name of signed) {
      headers[name] = req.headers[name];
    }
    const signer = new AwsV4Signer({
      method: req.method, url: `http://${req.headers.host}${req.url}`, headers,
      accessKeyId: SECRETS.S3_READ_ACCESS_KEY_ID, secretAccessKey: SECRETS.S3_READ_SECRET_ACCESS_KEY,
      service: 's3', region: S3_REGION, datetime: amzDate,
    });
    if ((await signer.authHeader()) !== req.headers.authorization) {
      return reject('signature mismatch');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reject('read-only key');
    }

    const prefix = `/${S3_BUCKET}/`;
    const key = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    const blob = Object.values(files).find((file) => file.storage.key === key);
    if (!blob || !blob.bytes.s3) {
      return send(res, 404, 'application/xml', '<Error><Code>NoSuchKey</Code></Error>');
    }
    return sendObject(req, res, blob.bytes.body, 'application/octet-stream', { 'x-amz-request-id': 'r1', 'x-bz-file-id': 'f1' });
  });
  state.origin = await listen(server);
  state.close = () => new Promise((resolveClose) => server.close(resolveClose));
  return state;
}


// wrangler.toml, with absolute paths and the assets directory pointed at WEB_DIST.
function testConfigPath() {
  const { rawConfig } = experimental_readRawConfig({ config: join(ROOT, 'wrangler.toml') });
  const config = {
    ...rawConfig,
    main: join(ROOT, rawConfig.main),
    assets: { ...rawConfig.assets, directory: WEB_DIST },
  };
  delete config.routes;
  const dir = mkdtempSync(join(tmpdir(), 'filesgg-worker-test-'));
  const path = join(dir, 'wrangler.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}


export async function startWorker({ upstream, s3 }, { secrets = SECRETS, vars = {} } = {}) {
  const config = testConfigPath();
  const harness = createTestHarness({
    workers: [{
      configPath: config.path,
      vars: {
        API_ORIGIN: upstream.origin,
        STORAGE_ORIGIN: upstream.origin,
        S3_ENDPOINT: s3 ? s3.origin : '',
        S3_REGION,
        S3_BUCKET_FILES: S3_BUCKET,
        ...vars,
      },
      secrets,
    }],
  });
  const { url } = await harness.listen();

  // Raw HTTP so the test controls every request header (fetch() would add Accept,
  // Accept-Language and User-Agent, which the bot routing looks at). Host picks the domain.
  const request = (target, { method = 'GET', headers = {}, body } = {}) => new Promise((resolveRequest, reject) => {
    const parsed = new URL(target);
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method,
      path: parsed.pathname + parsed.search,
      headers: { host: parsed.host, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolveRequest({ status: res.statusCode, headers: res.headers, text: buffer.toString('utf8'), buffer });
      });
    });
    req.on('error', reject);
    req.end(body);
  });

  const close = async () => {
    await harness.close();
    config.cleanup();
  };
  return { harness, request, close };
}
