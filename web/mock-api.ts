/**
 * In-memory mock of the Milestone 2 API (docs/redesign/contracts/milestone-2.md) for
 * `npm run dev`, mounted at /__mock-api. It never runs in a build.
 *
 * Implements: fingerprint, @me, limits, single and chunked uploads, unlock, refresh,
 * view and owner passes. Tokens are real contract §1 tokens (HMAC-SHA256 over sorted
 * JSON) signed with the contract's test secret. Turnstile accepts only Cloudflare's
 * testing dummy token, like the testing secret keys do.
 *
 * Knobs (env): MOCK_CHUNK_DELAY_MS (default 400), MOCK_CHUNK_FAIL_RATE (default 0),
 * MOCK_PROCESSING_MS (default 1500).
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Connect } from 'vite';

export const MOCK_API_PREFIX = '/__mock-api';
const TOKEN_SECRET = 'test-cdn-token-secret';
const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const CHUNK_SIZE = 10 * 1024 * 1024;
const MB = 1024 * 1024;
const DAY = 86400;

const env = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== undefined ? value : fallback;
};

// ---------------------------------------------------------------------------
// Tokens (contract §1)
// ---------------------------------------------------------------------------

interface Claims {
  e: number;
  k: 'file' | 'album';
  s: 'unlock' | 'owner';
  t: string;
  u: number;
  v: number;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

export function signToken(claims: Claims, secret = TOKEN_SECRET): string {
  const sorted = Object.fromEntries(Object.entries(claims).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = b64url(JSON.stringify(sorted));
  return `${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;
}

export function verifyToken(token: string, secret = TOKEN_SECRET): Claims | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Protected fixtures
// ---------------------------------------------------------------------------

interface Protected {
  id: string;
  kind: 'file' | 'album';
  visibility: 'password' | 'private';
  password: string;
  unlockTtl: number;
  passwordExpired: boolean;
  accessVersion: number;
  payload: (origin: string) => Record<string, unknown>;
}

const now = () => Math.floor(Date.now() / 1000);

const image = (origin: string, vanity: string, n: number, extra: Record<string, unknown> = {}) => ({
  kind: 'image',
  filename: `photo-${n}.png`,
  mimetype: 'image/png',
  extension: 'png',
  size: 9000,
  width: [800, 400, 600, 1000, 600][n - 1],
  height: [500, 600, 600, 350, 400][n - 1],
  cdnUrl: `${origin}/fixtures/photo-${n}.png`,
  url: `${origin}/${vanity}.png`,
  uploadedAt: Date.now() - 3 * 3600_000,
  expiresAt: null,
  visibility: 'password',
  ...extra,
});

const PROTECTED: Record<string, Protected> = {
  locked1234: {
    id: '1234567890123456789',
    kind: 'file',
    visibility: 'password',
    password: 'files.gg',
    unlockTtl: 3600,
    passwordExpired: false,
    accessVersion: 0,
    payload: (origin) => ({ ...image(origin, 'locked1234', 1), filename: 'holiday.png' }),
  },
  shortlock1: {
    id: '1234567890123456790',
    kind: 'file',
    visibility: 'password',
    password: 'files.gg',
    // Shorter than any real choice, so refresh and expiry can be watched in dev.
    unlockTtl: 90,
    passwordExpired: false,
    accessVersion: 0,
    payload: (origin) => ({
      kind: 'pdf',
      filename: 'short-lived.pdf',
      mimetype: 'application/pdf',
      extension: 'pdf',
      size: 17113,
      cdnUrl: `${origin}/fixtures/sample.pdf`,
      url: `${origin}/shortlock1.pdf`,
      media: { pages: 8 },
      uploadedAt: Date.now() - 3600_000,
      expiresAt: null,
      visibility: 'password',
    }),
  },
  expired123: {
    id: '1234567890123456791',
    kind: 'file',
    visibility: 'password',
    password: 'files.gg',
    unlockTtl: 3600,
    passwordExpired: true,
    accessVersion: 0,
    payload: (origin) => image(origin, 'expired123', 3),
  },
  private123: {
    id: '1234567890123456792',
    kind: 'file',
    visibility: 'private',
    password: '',
    unlockTtl: 3600,
    passwordExpired: false,
    accessVersion: 2,
    payload: (origin) => ({ ...image(origin, 'private123', 4), filename: 'only-me.png', visibility: 'private' }),
  },
  lockedalbum: {
    id: '987654321098765432',
    kind: 'album',
    visibility: 'password',
    password: 'files.gg',
    unlockTtl: 3600,
    passwordExpired: false,
    accessVersion: 3,
    payload: (origin) => ({
      vanity: 'lockedalbum',
      url: `${origin}/a/lockedalbum`,
      title: 'Private trip',
      description: 'Unlocked with the album password. The last photo is a public (link) file, so it has no ?t=.',
      layout: 'grid',
      nsfw: false,
      expires_at: null,
      items: [
        { ...image(origin, 'al1', 1), position: 0, caption: 'Day one' },
        { ...image(origin, 'al2', 2), position: 1, caption: 'The lighthouse' },
        { ...image(origin, 'al5', 5), position: 2, caption: 'Public photo', visibility: 'link' },
      ],
    }),
  },
};

const byId = (kind: 'file' | 'album', id: string) =>
  Object.entries(PROTECTED).find(([, entry]) => entry.kind === kind && entry.id === id);

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  owner: string;
  filename: string;
  size: number;
  chunkCount: number;
  received: Set<number>;
  status: 'open' | 'processing' | 'complete' | 'failed';
  options: Record<string, unknown>;
  file?: Record<string, unknown>;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const attempts = new Map<string, number[]>();
let usedBytes = 2.4 * 1024 * MB;

const WORDS = ['amber', 'tunnel', 'oxide', 'violet', 'harbor', 'quartz', 'meadow', 'cobalt', 'ember', 'lantern', 'willow', 'orbit', 'saffron', 'glacier', 'pebble', 'falcon'];
const passphrase = () => Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]).join('-');
const vanity = () => randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 7) || 'abc1234';
const snowflake = () => String(BigInt(Date.now() - 1550102400000) << 22n | BigInt(randomInt(4096)));

function owner(req: IncomingMessage): { key: string; anonymous: boolean } {
  const auth = req.headers.authorization;
  if (auth) return { key: `user:${auth}`, anonymous: false };
  const fingerprint = req.headers['x-fingerprint'];
  return { key: `fp:${String(fingerprint ?? 'none')}`, anonymous: true };
}

const limitsFor = (anonymous: boolean) =>
  anonymous
    ? {
        storage: { used: 0, limit: null },
        max_file_size_single: 25 * MB,
        max_file_size_chunked: 25 * MB,
        max_expiry: 21 * DAY,
        allow_no_expiry: false,
        anonymous: true,
      }
    : {
        storage: { used: Math.round(usedBytes), limit: 10 * 1024 * MB },
        max_file_size_single: 100 * MB,
        max_file_size_chunked: 1024 * MB,
        max_expiry: null,
        allow_no_expiry: true,
        anonymous: false,
      };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Shared upload rules for POST /files and POST /uploads (contract §6). */
function checkUpload(anonymous: boolean, size: number, fields: Record<string, unknown>, chunked: boolean) {
  if (anonymous && fields.turnstile_token !== TURNSTILE_DUMMY_TOKEN) {
    throw new HttpError(403, 'CAPTCHA_INVALID', 'Human verification failed.');
  }
  const limits = limitsFor(anonymous);
  const max = chunked ? limits.max_file_size_chunked : limits.max_file_size_single;
  if (size > max) throw new HttpError(413, 'FILE_TOO_LARGE', 'File is too large.', { limit: max });
  if (limits.storage.limit !== null && limits.storage.used + size > limits.storage.limit) {
    throw new HttpError(413, 'STORAGE_LIMIT_REACHED', 'Storage is full.', { limit: limits.storage.limit, used: limits.storage.used });
  }
  const visibility = String(fields.visibility ?? 'link');
  if (visibility === 'private' && anonymous) throw new HttpError(400, 'PRIVATE_REQUIRES_ACCOUNT', 'Private files need an account.');
  const expiresIn = fields.expires_in === undefined ? null : Number(fields.expires_in);
  if (anonymous && (expiresIn === null || expiresIn > 21 * DAY)) {
    if (expiresIn !== null) throw new HttpError(400, 'EXPIRY_NOT_ALLOWED', 'Expiry not allowed.', { max_expiry: 21 * DAY });
  }
  if (visibility === 'password' && !fields.generate_password) {
    const password = String(fields.password ?? '');
    if (password.length < 6 || password.length > 128) throw new HttpError(400, 'BAD_REQUEST', 'Password must be 6–128 characters.');
  }
}

function fileObject(origin: string, filename: string, size: number, fields: Record<string, unknown>, anonymous: boolean) {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : 'bin';
  const name = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  const v = vanity();
  const visibility = String(fields.visibility ?? 'link');
  const expiresIn = fields.expires_in !== undefined ? Number(fields.expires_in) : anonymous ? 21 * DAY : null;
  const main = `${origin}/${v}.${ext}`;
  const generated = visibility === 'password' && String(fields.generate_password) === 'true' ? passphrase() : undefined;
  if (!anonymous) usedBytes += size;
  return {
    id: snowflake(),
    vanity: v,
    mimetype: 'application/octet-stream',
    extension: ext,
    name,
    filename,
    size,
    width: null,
    height: null,
    duration: null,
    urls: { main, cdn: `${origin}/fixtures/archive.zip` },
    views: 0,
    expires_at: expiresIn === null ? null : now() + expiresIn,
    visibility,
    ...(generated ? { password: generated, url_with_password: `${main}#pw=${encodeURIComponent(generated)}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 1100 * MB): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'FILE_TOO_LARGE', 'Too large.', { limit }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, MB);
  try {
    return body.length ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Invalid JSON.');
  }
}

/** Minimal multipart/form-data parser: enough for `file` plus text fields. */
function parseMultipart(body: Buffer, contentType: string) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const marker = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ''}`);
  const fields: Record<string, string> = {};
  let file: { filename: string; size: number } | null = null;
  let start = body.indexOf(marker);
  while (start !== -1) {
    const next = body.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const part = body.subarray(start + marker.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, split).toString('utf8');
    const content = part.subarray(split + 4);
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    if (name === 'file' && filename !== undefined) file = { filename, size: content.length };
    else if (name) fields[name] = content.toString('utf8');
    start = next;
  }
  return { fields, file };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse, path: string, origin: string): Promise<void> {
  const method = req.method ?? 'GET';
  const who = owner(req);
  let match: RegExpExecArray | null;

  if (method === 'GET' && path === '/auth/fingerprint') {
    return send(res, 200, { fingerprint: String(BigInt(Date.now()) * 1000n + BigInt(randomInt(1000))) });
  }
  if (method === 'GET' && path === '/users/@me') {
    if (who.anonymous) return send(res, 401, { code: 40001, message: 'Unauthorized', status: 401 });
    return send(res, 200, { id: '42', username: 'mockuser', display_name: 'Mock User', flags: 0, email: 'mock@example.com', verified: true });
  }
  if (method === 'GET' && path === '/users/@me/limits') return send(res, 200, limitsFor(who.anonymous));

  // ---- Single upload ----
  if (method === 'POST' && path === '/files') {
    const declared = Number(req.headers['content-length'] ?? 0);
    const limits = limitsFor(who.anonymous);
    if (declared > limits.max_file_size_single + MB) {
      throw new HttpError(413, 'FILE_TOO_LARGE', 'File is too large.', { limit: limits.max_file_size_single });
    }
    const { fields, file } = parseMultipart(await readBody(req), String(req.headers['content-type'] ?? ''));
    if (!file) throw new HttpError(400, 'BAD_REQUEST', 'No file.');
    checkUpload(who.anonymous, file.size, fields, false);
    return send(res, 200, fileObject(origin, file.filename, file.size, fields, who.anonymous));
  }

  // ---- Chunked ----
  if (method === 'POST' && path === '/uploads') {
    const body = await readJson(req);
    const size = Number(body.size);
    checkUpload(who.anonymous, size, body, true);
    const id = snowflake();
    const session: Session = {
      id,
      owner: who.key,
      filename: String(body.filename ?? 'upload.bin'),
      size,
      chunkCount: Math.max(1, Math.ceil(size / CHUNK_SIZE)),
      received: new Set(),
      status: 'open',
      options: body,
      expiresAt: now() + DAY,
    };
    sessions.set(id, session);
    return send(res, 201, { upload_id: id, chunk_size: CHUNK_SIZE, chunk_count: session.chunkCount, expires_at: session.expiresAt });
  }
  if ((match = /^\/uploads\/([^/]+)(?:\/(chunks)\/(\d+)|\/(complete))?$/.exec(path))) {
    const session = sessions.get(match[1]!);
    if (!session || session.owner !== who.key) throw new HttpError(404, 'UNKNOWN_UPLOAD', 'Unknown upload.');
    if (match[2] === 'chunks' && method === 'PUT') {
      const index = Number(match[3]);
      const body = await readBody(req, CHUNK_SIZE + 1);
      const expected = index === session.chunkCount - 1 ? session.size - index * CHUNK_SIZE : CHUNK_SIZE;
      if (index >= session.chunkCount) throw new HttpError(400, 'CHUNK_SIZE_MISMATCH', 'Index out of range.', { expected: 0 });
      if (body.length !== expected) throw new HttpError(400, 'CHUNK_SIZE_MISMATCH', 'Wrong chunk size.', { expected });
      await sleep(env('MOCK_CHUNK_DELAY_MS', 400));
      if (Math.random() < env('MOCK_CHUNK_FAIL_RATE', 0)) throw new HttpError(503, 'UNAVAILABLE', 'Simulated chunk failure.');
      session.received.add(index);
      return send(res, 204);
    }
    if (match[4] === 'complete' && method === 'POST') {
      const missing = Array.from({ length: session.chunkCount }, (_, i) => i).filter((i) => !session.received.has(i));
      if (missing.length) throw new HttpError(409, 'UPLOAD_INCOMPLETE', 'Upload incomplete.', { missing });
      session.status = 'processing';
      setTimeout(() => {
        session.file = fileObject(origin, session.filename, session.size, session.options, who.anonymous);
        session.status = 'complete';
      }, env('MOCK_PROCESSING_MS', 1500));
      return send(res, 202, { status: 'processing' });
    }
    if (!match[2] && !match[4] && method === 'GET') {
      return send(res, 200, {
        status: session.status,
        received: [...session.received].sort((a, b) => a - b),
        size: session.size,
        ...(session.file ? { file: session.file } : {}),
      });
    }
    if (!match[2] && !match[4] && method === 'DELETE') {
      sessions.delete(session.id);
      return send(res, 204);
    }
  }

  // ---- Unlock, refresh, view (contract §5) ----
  if ((match = /^\/(files|albums)\/([^/]+)\/(unlock|unlock\/refresh|view)$/.exec(path))) {
    const kind = match[1] === 'albums' ? 'album' : 'file';
    const vanityName = decodeURIComponent(match[2]!);
    const entry = PROTECTED[vanityName];
    if (!entry || entry.kind !== kind) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
    const key = kind === 'album' ? 'album' : 'file';

    if (match[3] === 'view' && method === 'GET') {
      const token = String(req.headers['x-filesgg-access'] ?? '');
      const claims = verifyToken(token);
      const valid = claims && claims.k === kind && claims.t === entry.id && claims.e > now() && claims.v === entry.accessVersion;
      if (!valid) {
        if (entry.visibility === 'private') throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
        throw new HttpError(401, 'UNLOCK_EXPIRED', 'Access expired.');
      }
      return send(res, 200, { [key]: entry.payload(origin), expires_at: claims.e });
    }

    if (match[3] === 'unlock/refresh' && method === 'POST') {
      const body = await readJson(req);
      const claims = verifyToken(String(body.token ?? ''));
      if (!claims || claims.k !== kind || claims.t !== entry.id || claims.e <= now() || claims.v !== entry.accessVersion) {
        throw new HttpError(401, 'UNLOCK_EXPIRED', 'Access expired.');
      }
      // Unlock tokens cap at u + unlock_ttl; owner passes at u + 12 h (contract §5).
      const cap = claims.s === 'owner' ? claims.u + 43200 : claims.u + entry.unlockTtl;
      const e = Math.min(now() + 3600, cap);
      if (e <= now()) throw new HttpError(401, 'UNLOCK_EXPIRED', 'Access expired.');
      const token = signToken({ ...claims, e });
      return send(res, 200, { token, expires_at: e });
    }

    if (match[3] === 'unlock' && method === 'POST') {
      if (entry.visibility === 'private') throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
      const body = await readJson(req);
      if (body.turnstile_token !== TURNSTILE_DUMMY_TOKEN) throw new HttpError(403, 'CAPTCHA_INVALID', 'Human verification failed.');
      const ip = req.socket.remoteAddress ?? 'ip';
      const bucketKey = `${vanityName}:${ip}`;
      const recent = (attempts.get(bucketKey) ?? []).filter((t) => t > Date.now() - 60_000);
      if (recent.length >= 5) {
        throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts.', {
          retry_after: Math.ceil((recent[0]! + 60_000 - Date.now()) / 1000),
        });
      }
      recent.push(Date.now());
      attempts.set(bucketKey, recent);
      if (entry.passwordExpired) throw new HttpError(410, 'PASSWORD_EXPIRED', 'Password expired.');
      if (body.password !== entry.password) throw new HttpError(401, 'WRONG_PASSWORD', 'Wrong password.');
      attempts.delete(bucketKey);
      const u = now();
      const e = u + Math.min(entry.unlockTtl, 3600);
      const token = signToken({ e, k: kind, s: 'unlock', t: entry.id, u, v: entry.accessVersion });
      return send(res, 200, { token, expires_at: e, [key]: entry.payload(origin) });
    }
  }

  // ---- Owner passes (signed in) ----
  if ((match = /^\/users\/@me\/(files|albums)\/([^/]+)\/pass$/.exec(path)) && method === 'POST') {
    if (who.anonymous) return send(res, 401, { code: 40001, message: 'Unauthorized', status: 401 });
    const kind = match[1] === 'albums' ? 'album' : 'file';
    const found = byId(kind, match[2]!) ?? Object.entries(PROTECTED).find(([name, entry]) => name === match![2] && entry.kind === kind);
    if (!found) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
    const [name, entry] = found;
    const u = now();
    const token = signToken({ e: u + 3600, k: kind, s: 'owner', t: entry.id, u, v: entry.accessVersion });
    const url = kind === 'album' ? `${origin}/a/${name}#t=${token}` : `${origin}/${name}#t=${token}`;
    return send(res, 200, { token, expires_at: u + 3600, url });
  }

  throw new HttpError(404, 'NOT_FOUND', `Mock API has no ${method} ${path}`);
}

export function mockApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith(MOCK_API_PREFIX)) return next();
    const path = url.slice(MOCK_API_PREFIX.length).split('?')[0] || '/';
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    route(req, res, path, origin).catch((error: unknown) => {
      if (error instanceof HttpError) {
        send(res, error.status, { code: error.code, message: error.message, status: error.status, ...error.details });
      } else {
        send(res, 500, { code: 'INTERNAL', message: String(error), status: 500 });
      }
    });
  };
}
