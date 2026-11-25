/**
 * In-memory mock of the Milestone 2 and 3 APIs (docs/redesign/contracts/milestone-2.md,
 * milestone-3.md) for `npm run dev`, mounted at /__mock-api. It never runs in a build.
 *
 * Implements: fingerprint, @me, limits, single and chunked uploads, unlock, refresh,
 * view and owner passes (Milestone 2); the owner file library, bulk delete / expiry /
 * access, albums and their items, public album reads (Milestone 3). The signed-in user
 * starts with a seeded library: every kind of file, with `assets` pointing at generated
 * SVG placeholders and the dev fixtures, plus a few albums.
 *
 * Payloads follow milestone-3 §4: snake_case, times in epoch seconds, URLs ready to use.
 * Protected files' and albums' http(s) URLs are signed like the API signs CDN URLs
 * (milestone-3 §3, `expires` + `sig` over the path, with the contract's test secret):
 * for an unlock until it expires, and for 1 h in owner payloads. The dev server ignores
 * the query, so the fixtures still load. Unlock tokens keep the milestone-2 §1 format;
 * they only travel between the browser and this API. Turnstile accepts only
 * Cloudflare's testing dummy token, like the testing secret keys do.
 *
 * Knobs (env): MOCK_CHUNK_DELAY_MS (default 400), MOCK_CHUNK_FAIL_RATE (default 0),
 * MOCK_PROCESSING_MS (default 1500), MOCK_DERIVE_MS (default 6000: how long a new
 * upload stays `processing`).
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Connect } from 'vite';

export const MOCK_API_PREFIX = '/__mock-api';
/** Unlock tokens (the API signs them with `SECRET_KEY`). */
const TOKEN_SECRET = 'test-unlock-token-secret';
/** `CDN_SIGNING_SECRET` from the contract's test vectors. */
const CDN_SIGNING_SECRET = 'test-cdn-signing-secret';
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
// Signed CDN URLs (milestone-3 §3)
// ---------------------------------------------------------------------------

/** `file:<id>:<access_version>` or `album:<id>:<access_version>`. */
export type Grant = string;

export function cdnSignature(path: string, expires: number, grant: Grant, secret = CDN_SIGNING_SECRET): string {
  return b64url(createHmac('sha256', secret).update(`filesgg-cdn-1\n${path}\n${expires}\n${grant}`).digest());
}

/**
 * Adds `expires` and `sig` (and `album=` for album items) to an http(s) URL. `data:` and
 * `blob:` placeholders can't carry a query, so they stay as they are.
 */
export function signCdnUrl(url: string, expires: number, grant: Grant, album?: string): string {
  if (!/^https?:\/\//.test(url)) return url;
  const parsed = new URL(url);
  if (album) parsed.searchParams.set('album', album);
  parsed.searchParams.set('expires', String(expires));
  parsed.searchParams.set('sig', cdnSignature(parsed.pathname, expires, grant));
  return parsed.toString();
}

interface Signing {
  expires: number;
  grant: Grant;
  /** Album items carry `album=<album vanity>`. */
  album?: string;
}

/** Every media URL in a file payload, signed (the share `url` never is). */
function signFile<T extends Record<string, unknown>>(file: T, { expires, grant, album }: Signing): T {
  const sign = (url: unknown) => (typeof url === 'string' ? signCdnUrl(url, expires, grant, album) : url);
  const signAsset = (asset: unknown) => (asset && typeof asset === 'object' ? { ...asset, url: sign((asset as { url: unknown }).url) } : asset);
  const assets = (file.assets ?? {}) as Record<string, unknown>;
  return {
    ...file,
    cdn_url: sign(file.cdn_url),
    assets: Object.fromEntries(Object.entries(assets).map(([kind, asset]) => [kind, signAsset(asset)])),
    ...(file.thumbnail ? { thumbnail: signAsset(file.thumbnail) } : {}),
    ...(file.hover_url ? { hover_url: sign(file.hover_url) } : {}),
  };
}

/** A protected album: every item through the album grant (with `album=`), plus its cover, collage and ZIP. */
function signAlbum<T extends Record<string, unknown>>(album: T, expires: number, grant: Grant): T {
  const vanityName = String(album.vanity);
  const itemSigning = { expires, grant, album: vanityName };
  const signAsset = (asset: unknown, withAlbum: boolean) =>
    asset && typeof asset === 'object'
      ? { ...asset, url: signCdnUrl(String((asset as { url: unknown }).url), expires, grant, withAlbum ? vanityName : undefined) }
      : asset;
  return {
    ...album,
    cover: signAsset(album.cover, true),
    collage: signAsset(album.collage, false),
    ...(typeof album.download_url === 'string' ? { download_url: signCdnUrl(album.download_url, expires, grant) } : {}),
    items: ((album.items ?? []) as Array<Record<string, unknown>>).map((item) => signFile(item, itemSigning)),
  };
}

/** Owner payloads' URLs last 1 h (contract §6). */
const OWNER_URL_TTL = 3600;

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
  vanity,
  name: `photo-${n}`,
  filename: `photo-${n}.png`,
  mimetype: 'image/png',
  extension: 'png',
  size: 9000,
  width: [800, 400, 600, 1000, 600][n - 1],
  height: [500, 600, 600, 350, 400][n - 1],
  cdn_url: `${origin}/fixtures/photo-${n}.png`,
  url: `${origin}/${vanity}.png`,
  uploaded_at: now() - 3 * 3600,
  expires_at: null,
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
      vanity: 'shortlock1',
      name: 'short-lived',
      filename: 'short-lived.pdf',
      mimetype: 'application/pdf',
      extension: 'pdf',
      size: 17113,
      cdn_url: `${origin}/fixtures/sample.pdf`,
      url: `${origin}/shortlock1.pdf`,
      media: { pages: 8 },
      uploaded_at: now() - 3600,
      expires_at: null,
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
      id: '987654321098765432',
      vanity: 'lockedalbum',
      url: `${origin}/a/lockedalbum`,
      title: 'Private trip',
      description: 'Unlocked with the album password. Every item, the public last photo included, comes through the album grant.',
      layout: 'grid',
      nsfw: false,
      visibility: 'password',
      expires_at: null,
      download_url: 'https://cdn.files.gg/albums/download/lockedalbum.zip',
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

const WORDS = ['amber', 'tunnel', 'oxide', 'violet', 'harbor', 'quartz', 'meadow', 'cobalt', 'ember', 'lantern', 'willow', 'orbit', 'saffron', 'glacier', 'pebble', 'falcon'];
const passphrase = () => Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]).join('-');
const vanity = () => randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 7) || 'abc1234';
const snowflake = () => String(BigInt(Date.now() - 1550102400000) << 22n | BigInt(randomInt(4096)));

function owner(req: IncomingMessage): { key: string; anonymous: boolean } {
  // Every token is "Mock User", with one shared library.
  if (req.headers.authorization) return { key: USER_KEY, anonymous: false };
  const fingerprint = req.headers['x-fingerprint'];
  return { key: `fp:${String(fingerprint ?? 'none')}`, anonymous: true };
}

const limitsFor = (anonymous: boolean, key: string) =>
  anonymous
    ? {
        storage: { used: usageOf(key), limit: null },
        max_file_size_single: 25 * MB,
        max_file_size_chunked: 25 * MB,
        max_expiry: 21 * DAY,
        allow_no_expiry: false,
        anonymous: true,
        album_max_files: ANONYMOUS_ALBUM_MAX_FILES,
        albums_max: null,
      }
    : {
        storage: { used: usageOf(key), limit: STORAGE_LIMIT },
        max_file_size_single: 100 * MB,
        max_file_size_chunked: 1024 * MB,
        max_expiry: null,
        allow_no_expiry: true,
        anonymous: false,
        album_max_files: ALBUM_MAX_FILES,
        albums_max: ALBUMS_MAX,
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
function checkUpload(anonymous: boolean, key: string, size: number, fields: Record<string, unknown>, chunked: boolean) {
  if (anonymous && fields.turnstile_token !== TURNSTILE_DUMMY_TOKEN) {
    throw new HttpError(403, 'CAPTCHA_INVALID', 'Human verification failed.');
  }
  // Milestone 3: `album=<vanity>` must be one of your own albums, checked before anything is stored.
  if (fields.album !== undefined && (anonymous || !ownAlbums(key).some((album) => album.vanity === String(fields.album)))) {
    throw new HttpError(400, 'INVALID_ALBUM', 'Unknown album.');
  }
  const limits = limitsFor(anonymous, key);
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

/** The upload response: the file payload (contract §4, signed for the uploader), plus a generated password once. The file joins the library. */
function fileObject(origin: string, owner: string, filename: string, size: number, fields: Record<string, unknown>, anonymous: boolean) {
  const visibility = String(fields.visibility ?? 'link');
  const generated = visibility === 'password' && String(fields.generate_password) === 'true' ? passphrase() : undefined;
  const stored = storeUpload(owner, filename, size, fields, anonymous, generated);
  const payload = ownerSigned(stored, publicFile(origin, stored));
  return {
    ...payload,
    ...(generated ? { password: generated, url_with_password: `${String(payload.url)}#pw=${encodeURIComponent(generated)}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Library (Milestone 3): owner files and albums
// ---------------------------------------------------------------------------

type Kind = 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'file';
type Visibility = 'link' | 'password' | 'private';

interface Asset {
  /** Absolute, a data: URL, or a path resolved against the dev origin. */
  url: string;
  width?: number;
  height?: number;
}

interface StoredFile {
  id: string;
  vanity: string;
  owner: string;
  name: string;
  extension: string;
  mimetype: string;
  kind: Kind;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  framecount?: number;
  media: Record<string, unknown>;
  assets: Record<string, Asset>;
  /** Path or absolute URL of the bytes. */
  cdn: string;
  createdMs: number;
  /** Epoch s, or null. */
  expiresAt: number | null;
  visibility: Visibility;
  password: string | null;
  accessVersion: number;
  unlockTtl: number;
  passwordExpiresAt: number | null;
  showName: boolean;
  /** New uploads stay `processing` until this time (ms), then get placeholder assets. */
  derivedAtMs: number;
  views: number;
  deleted: boolean;
}

interface StoredAlbum {
  id: string;
  vanity: string;
  owner: string;
  title: string;
  description: string;
  layout: 'auto' | 'grid' | 'list' | 'tracklist';
  visibility: Visibility;
  password: string | null;
  accessVersion: number;
  unlockTtl: number;
  passwordExpiresAt: number | null;
  showName: boolean;
  coverFileId: string | null;
  items: Array<{ fileId: string; caption: string }>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  deleted: boolean;
}

const USER_KEY = 'user:42';
const library = new Map<string, StoredFile>();
const albumStore = new Map<string, StoredAlbum>();
const STORAGE_LIMIT = 10 * 1024 * MB;
const ALBUM_MAX_FILES = 500;
const ANONYMOUS_ALBUM_MAX_FILES = 50;
const ALBUMS_MAX = 1000;
let idCounter = 0;
const nextId = (createdMs = Date.now()) => String((BigInt(createdMs - 1550102400000) << 22n) | BigInt(idCounter++ % 4096));

const MIMETYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', py: 'text/x-python',
  js: 'text/javascript', ts: 'text/plain', json: 'application/json', html: 'text/html',
  zip: 'application/zip', gz: 'application/gzip', zst: 'application/zstd', dmg: 'application/x-apple-diskimage',
};
const BROWSER_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

/** The API's `kind_of` (api/utils/payloads.py). */
function kindOf(mimetype: string): Kind {
  if (BROWSER_IMAGES.has(mimetype)) return 'image';
  if (mimetype === 'application/pdf') return 'pdf';
  const major = mimetype.split('/')[0];
  if (major === 'video' || major === 'audio') return major;
  if (major === 'text' && mimetype !== 'text/html') return 'text';
  return 'file';
}

// ---- Placeholder media: generated SVGs (data: URLs) ----

/** A stable hue per name, so placeholders differ. */
const hueOf = (text: string) => [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 7);
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const escapeXml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

function placeholder(label: string, hue: number, width: number, height: number, mark: 'photo' | 'play' | 'note' | 'page' | 'none' = 'none'): string {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 7;
  const marks = {
    photo: `<circle cx="${width * 0.72}" cy="${height * 0.3}" r="${r * 0.6}" fill="#fff" opacity=".7"/><path d="M0 ${height} L${width * 0.35} ${height * 0.45} L${width * 0.6} ${height * 0.75} L${width * 0.75} ${height * 0.6} L${width} ${height}Z" fill="#000" opacity=".25"/>`,
    play: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000" opacity=".35"/><path d="M${cx - r * 0.35} ${cy - r * 0.5} L${cx + r * 0.55} ${cy} L${cx - r * 0.35} ${cy + r * 0.5}Z" fill="#fff"/>`,
    note: `<circle cx="${cx - r * 0.4}" cy="${cy + r * 0.6}" r="${r * 0.45}" fill="#fff"/><rect x="${cx}" y="${cy - r * 1.2}" width="${r * 0.14}" height="${r * 1.85}" fill="#fff"/><path d="M${cx} ${cy - r * 1.2} q${r} ${r * 0.3} ${r * 0.7} ${r * 1.1}" stroke="#fff" stroke-width="${r * 0.14}" fill="none"/>`,
    page: `<rect x="${width * 0.15}" y="${height * 0.12}" width="${width * 0.7}" height="${height * 0.76}" fill="#fff"/>${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${width * 0.22}" y="${height * (0.22 + i * 0.1)}" width="${width * (i === 5 ? 0.3 : 0.56)}" height="${height * 0.03}" fill="#c9ccd1"/>`).join('')}`,
    none: '',
  };
  const fontSize = Math.max(10, Math.round(Math.min(width, height) / 12));
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 55%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 65% 30%)"/></linearGradient></defs>` +
      `<rect width="${width}" height="${height}" fill="url(#g)"/>${marks[mark]}` +
      (label ? `<text x="${width / 2}" y="${height - fontSize * 0.9}" font-family="system-ui,sans-serif" font-size="${fontSize}" font-weight="600" fill="#fff" text-anchor="middle" opacity=".9">${escapeXml(label)}</text>` : '') +
      `</svg>`,
  );
}

function waveformSvg(seed: number): string {
  const bars = Array.from({ length: 100 }, (_, i) => {
    const h = 20 + Math.abs(Math.sin(i * 0.37 + seed) * Math.cos(i * 0.11 + seed * 2)) * 200;
    return `<rect x="${i * 16 + 2}" y="${120 - h / 2}" width="10" height="${h}" rx="3" fill="#3DEB7E"/>`;
  }).join('');
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="240" viewBox="0 0 1600 240">${bars}</svg>`);
}

const peaks = (seed: number) => ({
  version: 1,
  length: 1000,
  peaks: Array.from({ length: 1000 }, (_, i) => Math.round(Math.abs(Math.sin(i * 0.05 + seed) * Math.cos(i * 0.013)) * 1000) / 1000),
});

/** Assets a finished `derive` would leave, as placeholders (contract §2 table). */
function placeholderAssets(file: Pick<StoredFile, 'kind' | 'name' | 'id' | 'width' | 'height' | 'mimetype'>): Record<string, Asset> {
  const hue = hueOf(file.name);
  const label = file.name.slice(0, 24);
  const w = file.width ?? 1600;
  const h = file.height ?? 900;
  const fit = (max: number) => {
    const scale = Math.min(1, max / Math.max(w, h));
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  };
  switch (file.kind) {
    case 'image': {
      const t1 = fit(320);
      const t2 = fit(640);
      return { thumb: { url: placeholder(label, hue, t1.width, t1.height, 'photo'), ...t1 }, 'thumb-2x': { url: placeholder(label, hue, t2.width, t2.height, 'photo'), ...t2 } };
    }
    case 'video': {
      const p = fit(1280);
      const t1 = fit(320);
      return {
        poster: { url: placeholder(label, hue, p.width, p.height, 'photo'), ...p },
        thumb: { url: placeholder(label, hue, t1.width, t1.height, 'photo'), ...t1 },
      };
    }
    case 'audio':
      return { waveform: { url: waveformSvg(hue / 36), width: 1600, height: 240 }, peaks: { url: `/__mock-api/peaks/${file.id}.json` } };
    case 'pdf':
      return { thumb: { url: placeholder('', hue, 240, 310, 'page'), width: 240, height: 310 } };
    default:
      return {};
  }
}

// ---- Seed: the signed-in user's library ----

interface SeedFile {
  name: string;
  ext: string;
  size: number;
  daysAgo: number;
  cdn?: string;
  width?: number;
  height?: number;
  duration?: number;
  framecount?: number;
  media?: Record<string, unknown>;
  assets?: Record<string, Asset>;
  /** Seconds from now. */
  expiresIn?: number;
  visibility?: Visibility;
  processing?: boolean;
  mimetype?: string;
}

const GB = 1024 * MB;
const fixture = (name: string) => `/fixtures/${name}`;

function seedFiles(): SeedFile[] {
  const photo = (n: number, name: string, width: number, height: number, daysAgo: number, extra: Partial<SeedFile> = {}): SeedFile => ({
    name,
    ext: 'png',
    size: Math.round((1.2 + n * 0.7) * MB),
    daysAgo,
    cdn: fixture(`photo-${n}.png`),
    width,
    height,
    assets: { thumb: { url: fixture(`photo-${n}.png`), width: 320, height: Math.round((320 * height) / width) }, 'thumb-2x': { url: fixture(`photo-${n}.png`), width: 640, height: Math.round((640 * height) / width) } },
    ...extra,
  });
  const snippet = (lines: string[]) => lines.join('\n');
  return [
    photo(1, 'lisbon-tram', 800, 500, 0.02),
    photo(2, 'alfama-stairs', 400, 600, 0.05),
    photo(3, 'pastel-de-nata', 600, 600, 1.2),
    photo(4, 'tagus-panorama', 1000, 350, 1.3, { expiresIn: 5 * 3600 }),
    photo(5, 'belem-tower', 600, 400, 1.4, { visibility: 'password' }),
    { name: 'Screenshot 2026-11-20 at 14.02.11', ext: 'png', size: 2.4 * MB, daysAgo: 5, width: 2880, height: 1800 },
    { name: 'IMG_4032', ext: 'heic', size: 3.1 * MB, daysAgo: 9, width: 4032, height: 3024, mimetype: 'image/heic' },
    { name: 'party-parrot', ext: 'gif', size: 0.9 * MB, daysAgo: 12, width: 480, height: 480, framecount: 10 },
    { name: 'wallpaper-draft', ext: 'png', size: 6.2 * MB, daysAgo: 0, width: 3840, height: 2160, processing: true },
    { name: 'sunset-timelapse', ext: 'mp4', size: 1.2 * GB, daysAgo: 2, width: 1920, height: 1080, duration: 94_000, media: { playable: true, has_audio: true, codecs: ['h264', 'aac'], container: 'mp4', fps: 29.97 } },
    { name: 'drone-coast', ext: 'mp4', size: 2.1 * GB, daysAgo: 20, width: 3840, height: 2160, duration: 312_500, media: { playable: true, has_audio: false, codecs: ['h264'], container: 'mp4' }, expiresIn: 2 * 86400 },
    { name: 'phone-video', ext: 'mov', size: 640 * MB, daysAgo: 33, width: 1080, height: 1920, duration: 41_000, media: { playable: false, has_audio: true, codecs: ['hevc', 'aac'], container: 'mov' } },
    { name: 'screen-recording', ext: 'webm', size: 88 * MB, daysAgo: 0.01, width: 1280, height: 720, processing: true },
    { name: 'meeting-notes-call', ext: 'mp4', size: 410 * MB, daysAgo: 41, width: 1280, height: 720, duration: 1_860_000, media: { playable: true, has_audio: true, codecs: ['h264', 'aac'], container: 'mp4' }, visibility: 'private' },
    { name: '01 Low tone', ext: 'wav', size: 32_044, daysAgo: 3, cdn: fixture('tone-1.wav'), duration: 2000, media: { playable: true, sample_rate: 8000, channels: 1, tags: { title: 'Low tone', artist: 'files.gg', album: 'Tones', track: 1 } }, assets: { cover: { url: fixture('cover-1.png'), width: 400, height: 400 } } },
    { name: '02 Middle tone', ext: 'wav', size: 24_044, daysAgo: 3, cdn: fixture('tone-2.wav'), duration: 1500, media: { playable: true, tags: { title: 'Middle tone', artist: 'files.gg', album: 'Tones', track: 2 } }, assets: { cover: { url: fixture('cover-2.png'), width: 400, height: 400 } } },
    { name: '03 High tone', ext: 'wav', size: 40_044, daysAgo: 3, cdn: fixture('tone-3.wav'), duration: 2500, media: { playable: true, tags: { title: 'High tone', artist: 'files.gg', album: 'Tones', track: 3 } } },
    { name: 'voice-memo', ext: 'm4a', size: 4.2 * MB, daysAgo: 6, duration: 184_000, media: { playable: true }, expiresIn: 20 * 86400 },
    { name: 'mixtape-final', ext: 'flac', size: 312 * MB, daysAgo: 50, duration: 3_540_000, media: { playable: true, tags: { title: 'Mixtape (final)', artist: 'DJ Mock' } } },
    { name: 'files-gg-sample', ext: 'pdf', size: 17_113, daysAgo: 4, cdn: fixture('sample.pdf'), media: { pages: 8, page_width: 612, page_height: 792 }, assets: { thumb: { url: fixture('pdf-thumb.png'), width: 240, height: 310 }, 'thumb-2x': { url: fixture('pdf-thumb.png'), width: 240, height: 310 } } },
    { name: 'invoice-2026-11', ext: 'pdf', size: 184_000, daysAgo: 8, media: { pages: 2 }, visibility: 'password', expiresIn: 6 * 86400 },
    { name: 'contract-signed', ext: 'pdf', size: 1.4 * MB, daysAgo: 60, media: { pages: 14 }, visibility: 'private' },
    { name: 'README', ext: 'md', size: 2_310, daysAgo: 0.3, media: { lines: 64, language: 'markdown', snippet: snippet(['# files.gg', '', 'Simple, fast file hosting.', '', '## Running it', '', '```bash', 'cd web', 'npm install', 'npm run dev', '```', '']) } },
    { name: 'resize', ext: 'py', size: 1_045, daysAgo: 7, media: { lines: 38, language: 'python', snippet: snippet(['from PIL import Image', '', '', 'def thumb(path, size=320):', '    with Image.open(path) as im:', '        im.thumbnail((size, size))', '        return im', '', '', "if __name__ == '__main__':", "    thumb('in.png').save('out.webp')"]) }, expiresIn: 3 * 3600 },
    { name: 'sales', ext: 'csv', size: 48_200, daysAgo: 15, media: { lines: 1203, language: null, snippet: snippet(['date,region,units,revenue', '2026-11-01,EU,120,4800.00', '2026-11-01,US,98,3920.00', '2026-11-02,EU,131,5240.00', '2026-11-02,US,87,3480.00']) }, visibility: 'password' },
    { name: 'server', ext: 'log', size: 12.6 * MB, daysAgo: 1, mimetype: 'text/plain', media: { lines: 98_211, language: null, snippet: snippet(['[12:00:01] worker started (queues: default, media)', '[12:00:02] probe 1795600000123 ok in 84 ms', '[12:00:03] derive 1795600000123 ok in 1.9 s', '[12:00:09] finalize_upload 1795600000456 ok']) } },
    { name: 'project-backup', ext: 'zst', size: 3.3 * GB, daysAgo: 25, mimetype: 'application/zstd' },
    { name: 'archive', ext: 'zip', size: 144, daysAgo: 30, cdn: fixture('archive.zip') },
    { name: 'Installer', ext: 'dmg', size: 96 * MB, daysAgo: 44, expiresIn: 4 * 86400 },
    { name: 'config', ext: 'json', size: 812, daysAgo: 2 },
    { name: 'font-preview', ext: 'svg', size: 22_000, daysAgo: 10, mimetype: 'image/svg+xml' },
  ];
}

let seeded = false;

function seedLibrary(): void {
  if (seeded) return;
  seeded = true;
  const nowMs = Date.now();
  const byName = new Map<string, StoredFile>();
  for (const seed of seedFiles()) {
    const createdMs = Math.round(nowMs - seed.daysAgo * 86_400_000);
    const mimetype = seed.mimetype ?? MIMETYPES[seed.ext] ?? 'application/octet-stream';
    const id = nextId(createdMs);
    const file: StoredFile = {
      id,
      vanity: vanity(),
      owner: USER_KEY,
      name: seed.name,
      extension: seed.ext,
      mimetype,
      kind: kindOf(mimetype),
      size: Math.round(seed.size),
      width: seed.width,
      height: seed.height,
      duration: seed.duration,
      framecount: seed.framecount,
      media: { ...(seed.width ? { width: seed.width, height: seed.height } : {}), ...(seed.duration ? { duration: seed.duration } : {}), ...seed.media },
      assets: {},
      cdn: seed.cdn ?? '',
      createdMs,
      expiresAt: seed.expiresIn ? now() + seed.expiresIn : null,
      visibility: seed.visibility ?? 'link',
      password: seed.visibility === 'password' ? 'files.gg' : null,
      accessVersion: 0,
      unlockTtl: 3600,
      passwordExpiresAt: null,
      showName: false,
      derivedAtMs: seed.processing ? Number.POSITIVE_INFINITY : 0,
      views: Math.round(Math.abs(Math.sin(createdMs)) * 900),
      deleted: false,
    };
    // A non-browser image (HEIC) with a `display` preview counts as an image (contract §4).
    if (mimetype === 'image/heic') {
      file.kind = 'image';
      file.assets.display = { url: placeholder('IMG_4032 (display)', 30, 1600, 1200, 'photo'), width: 1600, height: 1200 };
    }
    if (!seed.processing) file.assets = { ...placeholderAssets(file), ...file.assets, ...seed.assets };
    if (!file.cdn) file.cdn = file.kind === 'text' ? `/__mock-api/raw/${file.vanity}` : file.assets.display?.url ?? file.assets['thumb-2x']?.url ?? fixture('archive.zip');
    library.set(id, file);
    byName.set(seed.name, file);
  }
  const ids = (...names: string[]) => names.map((name) => byName.get(name)!.id);
  const album = (title: string, description: string, layout: StoredAlbum['layout'], names: string[], extra: Partial<StoredAlbum> = {}, daysAgo = 1) => {
    const id = nextId(nowMs - daysAgo * 86_400_000);
    albumStore.set(id, {
      id,
      vanity: vanity(),
      owner: USER_KEY,
      title,
      description,
      layout,
      visibility: 'link',
      password: null,
      accessVersion: 0,
      unlockTtl: 3600,
      passwordExpiresAt: null,
      showName: false,
      coverFileId: null,
      items: ids(...names).map((fileId, index) => ({ fileId, caption: index === 0 ? 'Day one' : '' })),
      createdAt: now() - daysAgo * 86400,
      updatedAt: now() - Math.round(daysAgo * 0.5 * 86400),
      expiresAt: null,
      deleted: false,
      ...extra,
    });
  };
  album(
    'Lisbon, November',
    'Five days of trams, stairs and pastries. Full set: https://files.gg',
    'auto',
    ['lisbon-tram', 'alfama-stairs', 'pastel-de-nata', 'tagus-panorama', 'belem-tower', 'sunset-timelapse'],
    { coverFileId: byName.get('tagus-panorama')!.id },
    0.5,
  );
  album('Tones', '', 'auto', ['01 Low tone', '02 Middle tone', '03 High tone'], {}, 3);
  album('Client drafts', 'For review.', 'list', ['files-gg-sample', 'invoice-2026-11', 'lisbon-tram'], { visibility: 'password', password: 'files.gg', showName: true }, 8);
}

// ---- Lookups and payloads ----

const isLive = (file: StoredFile | undefined): file is StoredFile =>
  Boolean(file && !file.deleted && (file.expiresAt === null || file.expiresAt > now()));
const ownFiles = (key: string) => [...library.values()].filter((file) => file.owner === key && isLive(file));
const ownAlbums = (key: string) => [...albumStore.values()].filter((album) => album.owner === key && !album.deleted);
const abs = (origin: string, url: string) => (url.startsWith('/') ? origin + url : url);
const usageOf = (key: string) => ownFiles(key).reduce((sum, file) => sum + file.size, 0);

function ownedFile(key: string, id: string): StoredFile {
  const file = library.get(id);
  if (!isLive(file) || file.owner !== key) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
  return file;
}

function ownedAlbum(key: string, id: string): StoredAlbum {
  const album = albumStore.get(id);
  if (!album || album.deleted || album.owner !== key) throw new HttpError(404, 'UNKNOWN_ALBUM', 'Unknown album.');
  return album;
}

const processingOf = (file: StoredFile) => Date.now() < file.derivedAtMs;

/** The file payload (contract §4), unsigned. */
function publicFile(origin: string, file: StoredFile, owner = false): Record<string, unknown> {
  const ext = file.extension ? `.${file.extension}` : '';
  const main = `${origin}/${file.vanity}${ext}`;
  const cdn = abs(origin, file.cdn);
  const processing = processingOf(file);
  const version = Math.floor(file.createdMs / 1000);
  const assets = processing
    ? {}
    : Object.fromEntries(
        Object.entries(file.assets).map(([name, asset]) => {
          const url = abs(origin, asset.url);
          return [name, { ...asset, url: url.startsWith('data:') ? url : `${url}${url.includes('?') ? '&' : '?'}v=${version}` }];
        }),
      );
  const pick = (...names: string[]) => names.map((name) => assets[name]).find(Boolean);
  const best = file.kind === 'video' ? pick('poster') : file.kind === 'audio' ? pick('cover', 'waveform') : pick('thumb');
  const bestType = file.kind === 'video' ? 'poster' : file.kind === 'audio' ? (assets.cover ? 'cover' : 'waveform') : 'thumb';
  const { snippet, ...publicMedia } = file.media;
  return {
    id: file.id,
    vanity: file.vanity,
    mimetype: file.mimetype,
    extension: file.extension,
    name: file.name,
    filename: `${file.name}${ext}`,
    size: file.size,
    width: file.width ?? null,
    height: file.height ?? null,
    duration: file.duration ?? null,
    framecount: file.framecount ?? null,
    views: file.views,
    kind: file.kind,
    url: main,
    cdn_url: cdn,
    uploaded_at: Math.floor(file.createdMs / 1000),
    expires_at: file.expiresAt,
    visibility: file.visibility,
    media: owner && snippet !== undefined ? { ...publicMedia, snippet } : publicMedia,
    processing,
    assets,
    ...(best ? { thumbnail: { ...best, type: bestType } } : {}),
    ...(assets.hover ? { hover_url: assets.hover.url } : {}),
    nsfw: false,
  };
}

/** A protected file's payload signed for its owner: the file grant, 1 h (contract §6). */
function ownerSigned<T extends Record<string, unknown>>(file: StoredFile, payload: T): T {
  if (file.visibility === 'link') return payload;
  return signFile(payload, { expires: now() + OWNER_URL_TTL, grant: `file:${file.id}:${file.accessVersion}` });
}

function ownerFile(origin: string, file: StoredFile): Record<string, unknown> {
  return {
    ...ownerSigned(file, publicFile(origin, file, true)),
    access_version: file.accessVersion,
    unlock_ttl: file.unlockTtl,
    password_expires_at: file.passwordExpiresAt,
    show_name_when_locked: file.showName,
    albums: ownAlbums(file.owner)
      .filter((album) => album.items.some((item) => item.fileId === file.id))
      .map((album) => ({ id: album.id, vanity: album.vanity, title: album.title })),
  };
}

/** A protected album's own URLs (cover, collage, ZIP) signed for its owner: the album grant, 1 h. */
function ownerSignedAlbum<T extends Record<string, unknown>>(album: StoredAlbum, payload: T): T {
  if (album.visibility === 'link') return payload;
  const expires = now() + OWNER_URL_TTL;
  const grant = `album:${album.id}:${album.accessVersion}`;
  const sign = (asset: unknown, withAlbum: boolean) =>
    asset && typeof asset === 'object'
      ? { ...asset, url: signCdnUrl(String((asset as { url: unknown }).url), expires, grant, withAlbum ? album.vanity : undefined) }
      : asset;
  return {
    ...payload,
    cover: sign(payload.cover, true),
    collage: sign(payload.collage, false),
    ...(typeof payload.download_url === 'string' ? { download_url: signCdnUrl(payload.download_url, expires, grant) } : {}),
  };
}

const albumZip = (album: StoredAlbum) => `https://cdn.files.gg/albums/download/${album.vanity}.zip`;

/** Contract §4: a link album shows only link items; a protected one shows every live item. */
const shownIn = (album: StoredAlbum, file: StoredFile | undefined) => isLive(file) && (album.visibility !== 'link' || file.visibility === 'link');

function albumItems(album: StoredAlbum) {
  return album.items.flatMap((item) => {
    const file = library.get(item.fileId);
    return isLive(file) ? [{ file, caption: item.caption, shown: shownIn(album, file) }] : [];
  });
}

function albumVisuals(origin: string, album: StoredAlbum) {
  const shown = albumItems(album).filter((item) => item.shown);
  const thumbOf = (file: StoredFile) => publicFile(origin, file).thumbnail as Asset | undefined;
  const coverFile = shown.find((item) => item.file.id === album.coverFileId)?.file;
  const firstVisual = shown.find((item) => thumbOf(item.file))?.file;
  const coverSource = coverFile ?? firstVisual;
  const cover = coverSource ? thumbOf(coverSource) : undefined;
  const visual = shown.filter((item) => thumbOf(item.file)).slice(0, 4);
  const hue = hueOf(album.title || album.vanity);
  const collage = visual.length
    ? {
        url: placeholder(album.title || 'Album', hue, 1200, 630, visual.every((item) => item.file.kind === 'audio') ? 'note' : 'photo'),
        width: 1200,
        height: 630,
      }
    : null;
  return { cover: cover ? { ...cover, type: coverSource?.kind === 'audio' ? 'cover' : 'thumb' } : null, collage };
}

function albumSummary(origin: string, album: StoredAlbum) {
  const { cover, collage } = albumVisuals(origin, album);
  return ownerSignedAlbum(album, {
    id: album.id,
    vanity: album.vanity,
    url: `${origin}/a/${album.vanity}`,
    title: album.title,
    layout: album.layout,
    visibility: album.visibility,
    count: albumItems(album).length,
    cover,
    collage,
    created_at: album.createdAt,
    updated_at: album.updatedAt,
  });
}

function ownerAlbum(origin: string, album: StoredAlbum) {
  const items = albumItems(album);
  return {
    ...albumSummary(origin, album),
    description: album.description,
    nsfw: false,
    ...ownerSignedAlbum(album, { download_url: albumZip(album) }),
    expires_at: album.expiresAt,
    count: items.filter((item) => item.shown).length,
    access_version: album.accessVersion,
    unlock_ttl: album.unlockTtl,
    password_expires_at: album.passwordExpiresAt,
    show_name_when_locked: album.showName,
    cover_file_id: album.coverFileId,
    items: items.map((item, position) => ({ ...ownerFile(origin, item.file), position, caption: item.caption, shown: item.shown })),
  };
}

function publicAlbum(origin: string, album: StoredAlbum) {
  const items = albumItems(album).filter((item) => item.shown);
  const { cover, collage } = albumVisuals(origin, album);
  return {
    id: album.id,
    vanity: album.vanity,
    url: `${origin}/a/${album.vanity}`,
    title: album.title,
    description: album.description,
    layout: album.layout,
    nsfw: false,
    visibility: album.visibility,
    cover,
    collage,
    download_url: albumZip(album),
    expires_at: album.expiresAt,
    count: items.length,
    total_size: items.reduce((sum, item) => sum + item.file.size, 0),
    next_cursor: null,
    items: items.map((item, position) => ({ ...publicFile(origin, item.file), position, caption: item.caption })),
  };
}

// ---- Access changes (milestone-2 §5 rules: visibility/password changes bump access_version) ----

const UNLOCK_TTLS = [600, 3600, 86400, 604800, 2592000];

interface Protectable {
  visibility: Visibility;
  password: string | null;
  accessVersion: number;
  unlockTtl: number;
  passwordExpiresAt: number | null;
  showName: boolean;
}

/** Applies access fields; returns a generated password, if any. */
function applyAccess(target: Protectable, body: Record<string, unknown>, anonymous: boolean, sent: Set<string>): string | undefined {
  let bump = false;
  let generated: string | undefined;
  const visibility = (body.visibility as Visibility | undefined) ?? (body.password !== undefined || body.generate_password ? 'password' : target.visibility);
  if (!['link', 'password', 'private'].includes(visibility)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid visibility.');
  if (visibility === 'private' && anonymous) throw new HttpError(400, 'PRIVATE_REQUIRES_ACCOUNT', 'Private files need an account.');
  if (visibility !== target.visibility) bump = true;
  if (visibility === 'password') {
    let password = body.password as string | undefined;
    if (body.generate_password) password = generated = passphrase();
    if (password !== undefined) {
      if (password.length < 6 || password.length > 128) throw new HttpError(400, 'BAD_REQUEST', 'Password must be 6–128 characters.');
      target.password = password;
      bump = true;
    } else if (target.password === null) {
      throw new HttpError(400, 'BAD_REQUEST', 'A password is required for password visibility.');
    }
  } else {
    target.password = null;
  }
  target.visibility = visibility;
  if (body.unlock_ttl !== undefined) {
    const ttl = Number(body.unlock_ttl);
    if (!UNLOCK_TTLS.includes(ttl)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid unlock_ttl.');
    if (ttl < target.unlockTtl) bump = true;
    target.unlockTtl = ttl;
  }
  let pwExpiry = target.passwordExpiresAt;
  if (body.password_expires_in !== undefined) pwExpiry = now() + Number(body.password_expires_in);
  else if (sent.has('password_expires_at')) pwExpiry = body.password_expires_at === null ? null : Number(body.password_expires_at);
  if (pwExpiry !== target.passwordExpiresAt) {
    if (pwExpiry !== null && (target.passwordExpiresAt === null || pwExpiry < target.passwordExpiresAt)) bump = true;
    target.passwordExpiresAt = pwExpiry;
  }
  if (typeof body.show_name_when_locked === 'boolean') target.showName = body.show_name_when_locked;
  if (bump) target.accessVersion++;
  return generated;
}

function applyExpiry(file: StoredFile, expiresIn: unknown, anonymous: boolean) {
  if (expiresIn === null) {
    if (anonymous) throw new HttpError(400, 'EXPIRY_NOT_ALLOWED', 'Expiry not allowed.', { max_expiry: 21 * DAY });
    file.expiresAt = null;
    return;
  }
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds < 60) throw new HttpError(400, 'BAD_REQUEST', 'Invalid expires_in.');
  if (anonymous && seconds > 21 * DAY) throw new HttpError(400, 'EXPIRY_NOT_ALLOWED', 'Expiry not allowed.', { max_expiry: 21 * DAY });
  file.expiresAt = now() + seconds;
}

const idList = (value: unknown, max = 500): string[] => {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, 'BAD_REQUEST', `file_ids must be a list of at most ${max} ids.`);
  return value.map(String);
};

const cleanText = (value: unknown, max: number) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .slice(0, max);

function checkAlbumFiles(key: string, ids: string[], album?: StoredAlbum) {
  const invalid = ids.filter((id) => {
    const file = library.get(id);
    return !isLive(file) || file.owner !== key;
  });
  if (invalid.length) throw new HttpError(400, 'INVALID_ALBUM_FILES', 'Some files cannot be added.', { file_ids: invalid });
  const size = new Set([...(album?.items.map((item) => item.fileId) ?? []), ...ids]).size;
  if (size > ALBUM_MAX_FILES) throw new HttpError(400, 'ALBUM_FULL', 'The album is full.', { limit: ALBUM_MAX_FILES });
}

/** Registers an upload in the owner's library; derived placeholders appear after MOCK_DERIVE_MS. */
function storeUpload(owner: string, filename: string, size: number, fields: Record<string, unknown>, anonymous: boolean, generated?: string): StoredFile {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  const name = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  const mimetype = MIMETYPES[ext] ?? 'application/octet-stream';
  const createdMs = Date.now();
  const kind = kindOf(mimetype);
  const visibility = String(fields.visibility ?? 'link') as Visibility;
  const expiresIn = fields.expires_in !== undefined ? Number(fields.expires_in) : anonymous ? 21 * DAY : null;
  const file: StoredFile = {
    id: nextId(createdMs),
    vanity: vanity(),
    owner,
    name,
    extension: ext,
    mimetype,
    kind,
    size,
    ...(kind === 'image' || kind === 'video' ? { width: 1600, height: 900 } : {}),
    media: kind === 'text' ? { lines: 1, language: null, snippet: `${filename}\n(uploaded to the mock API; the bytes aren't kept)` } : {},
    assets: {},
    cdn: kind === 'text' ? '' : fixture('archive.zip'),
    createdMs,
    expiresAt: expiresIn === null ? null : now() + expiresIn,
    visibility,
    password: visibility === 'password' ? (generated ?? String(fields.password ?? '')) : null,
    accessVersion: 0,
    unlockTtl: fields.unlock_ttl !== undefined ? Number(fields.unlock_ttl) : 3600,
    passwordExpiresAt: fields.password_expires_in !== undefined ? now() + Number(fields.password_expires_in) : null,
    showName: false,
    derivedAtMs: createdMs + env('MOCK_DERIVE_MS', 6000),
    views: 0,
    deleted: false,
  };
  if (kind === 'text') file.cdn = `/__mock-api/raw/${file.vanity}`;
  file.assets = placeholderAssets(file);
  if (kind === 'image') file.cdn = file.assets['thumb-2x']!.url;
  library.set(file.id, file);
  const albumVanity = fields.album === undefined ? null : String(fields.album);
  if (albumVanity) {
    const album = ownAlbums(owner).find((each) => each.vanity === albumVanity);
    if (album && album.items.length < ALBUM_MAX_FILES) {
      album.items.push({ fileId: file.id, caption: '' });
      album.updatedAt = now();
    }
  }
  return file;
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

async function route(req: IncomingMessage, res: ServerResponse, path: string, origin: string, query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  const who = owner(req);
  let match: RegExpExecArray | null;

  if (method === 'GET' && path === '/auth/fingerprint') {
    return send(res, 200, { fingerprint: String(BigInt(Date.now()) * 1000n + BigInt(randomInt(1000))) });
  }
  if (method === 'GET' && path === '/users/@me') {
    if (who.anonymous) return send(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized', status: 401 });
    return send(res, 200, { id: '42', username: 'mockuser', display_name: 'Mock User', flags: 0, email: 'mock@example.com', verified: true });
  }
  if (method === 'GET' && path === '/users/@me/limits') {
    seedLibrary();
    return send(res, 200, limitsFor(who.anonymous, who.key));
  }
  if (await libraryRoute(req, res, path, origin, query)) return;

  // ---- Single upload ----
  if (method === 'POST' && path === '/files') {
    const declared = Number(req.headers['content-length'] ?? 0);
    const limits = limitsFor(who.anonymous, who.key);
    if (declared > limits.max_file_size_single + MB) {
      throw new HttpError(413, 'FILE_TOO_LARGE', 'File is too large.', { limit: limits.max_file_size_single });
    }
    const { fields, file } = parseMultipart(await readBody(req), String(req.headers['content-type'] ?? ''));
    if (!file) throw new HttpError(400, 'BAD_REQUEST', 'No file.');
    checkUpload(who.anonymous, who.key, file.size, fields, false);
    return send(res, 200, fileObject(origin, who.key, file.filename, file.size, fields, who.anonymous));
  }

  // ---- Chunked ----
  if (method === 'POST' && path === '/uploads') {
    const body = await readJson(req);
    const size = Number(body.size);
    checkUpload(who.anonymous, who.key, size, body, true);
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
        session.file = fileObject(origin, who.key, session.filename, session.size, session.options, who.anonymous);
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
    const entry = PROTECTED[vanityName] ?? libraryProtected(kind, (target) => target.vanity === vanityName)?.[1];
    if (!entry || entry.kind !== kind) throw new HttpError(404, kind === 'album' ? 'UNKNOWN_ALBUM' : 'UNKNOWN_FILE', 'Unknown file.');
    const key = kind === 'album' ? 'album' : 'file';
    // Unlock, view and refresh all return the payload with URLs signed until the token expires (milestone-3 §3).
    const granted = (token: string, e: number) => {
      const grant = `${kind}:${entry.id}:${entry.accessVersion}`;
      const payload = entry.payload(origin);
      return { token, expires_at: e, [key]: kind === 'album' ? signAlbum(payload, e, grant) : signFile(payload, { expires: e, grant }) };
    };

    if (match[3] === 'view' && method === 'GET') {
      const token = String(req.headers['x-filesgg-access'] ?? '');
      const claims = verifyToken(token);
      const valid = claims && claims.k === kind && claims.t === entry.id && claims.e > now() && claims.v === entry.accessVersion;
      if (!valid) {
        if (entry.visibility === 'private') throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
        throw new HttpError(401, 'UNLOCK_EXPIRED', 'Access expired.');
      }
      return send(res, 200, granted(token, claims.e));
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
      return send(res, 200, granted(signToken({ ...claims, e }), e));
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
      return send(res, 200, granted(signToken({ e, k: kind, s: 'unlock', t: entry.id, u, v: entry.accessVersion }), e));
    }
  }

  // ---- Owner passes (signed in) ----
  if ((match = /^\/users\/@me\/(files|albums)\/([^/]+)\/pass$/.exec(path)) && method === 'POST') {
    if (who.anonymous) return send(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized', status: 401 });
    const kind = match[1] === 'albums' ? 'album' : 'file';
    const found =
      byId(kind, match[2]!) ??
      Object.entries(PROTECTED).find(([name, entry]) => name === match![2] && entry.kind === kind) ??
      libraryProtected(kind, (target) => target.id === match![2] && (kind === 'file' ? library.get(target.id)?.owner : albumStore.get(target.id)?.owner) === who.key);
    if (!found) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
    const [name, entry] = found;
    const u = now();
    const token = signToken({ e: u + 3600, k: kind, s: 'owner', t: entry.id, u, v: entry.accessVersion });
    const url = kind === 'album' ? `${origin}/a/${name}#t=${token}` : `${origin}/${name}#t=${token}`;
    return send(res, 200, { token, expires_at: u + 3600, url });
  }

  throw new HttpError(404, 'NOT_FOUND', `Mock API has no ${method} ${path}`);
}

/** Milestone 3 routes: the owner library, albums, public album reads, raw text. Returns false when nothing matched. */
async function libraryRoute(req: IncomingMessage, res: ServerResponse, path: string, origin: string, query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const who = owner(req);
  let match: RegExpExecArray | null;
  seedLibrary();

  // ---- Owner files ----
  if (method === 'GET' && path === '/users/@me/files') {
    const all = ownFiles(who.key);
    const text = (query.get('query') ?? '').toLowerCase();
    const type = query.get('type');
    const visibility = query.get('visibility');
    const temporary = query.get('temporary') === 'true';
    const sort = query.get('sort_by') ?? '-created';
    const filtered = all.filter((file) => {
      const filename = `${file.name}.${file.extension}`.toLowerCase();
      if (text && !filename.includes(text)) return false;
      if (type && (type === 'other' ? file.kind !== 'file' : file.kind !== type)) return false;
      if (visibility && file.visibility !== visibility) return false;
      if (temporary && file.expiresAt === null) return false;
      return true;
    });
    const key = sort.replace(/^-/, '');
    const direction = sort.startsWith('-') ? -1 : 1;
    filtered.sort((a, b) => {
      const order =
        key === 'size' ? a.size - b.size : key === 'name' ? `${a.name}.${a.extension}`.localeCompare(`${b.name}.${b.extension}`) : a.createdMs - b.createdMs;
      return order * direction || (a.id < b.id ? 1 : -1);
    });
    const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 25) || 25));
    send(res, 200, {
      count: filtered.length,
      size: filtered.reduce((sum, file) => sum + file.size, 0),
      items: filtered.slice(offset, offset + limit).map((file) => ownerFile(origin, file)),
      total: { count: all.length, size: all.reduce((sum, file) => sum + file.size, 0) },
    });
    return true;
  }
  if (method === 'POST' && path === '/users/@me/files/delete') {
    const ids = idList((await readJson(req)).file_ids, 100);
    const deleted = ids.filter((id) => {
      const file = library.get(id);
      if (!isLive(file) || file.owner !== who.key) return false;
      deleteFile(file);
      return true;
    });
    send(res, 200, { deleted });
    return true;
  }
  if (method === 'POST' && path === '/users/@me/files/expiry') {
    const body = await readJson(req);
    const files = idList(body.file_ids).flatMap((id) => {
      const file = library.get(id);
      return isLive(file) && file.owner === who.key ? [file] : [];
    });
    for (const file of files) applyExpiry(file, body.expires_in, who.anonymous);
    send(res, 200, { items: files.map((file) => ownerFile(origin, file)) });
    return true;
  }
  if (method === 'POST' && path === '/users/@me/files/access') {
    const body = await readJson(req);
    const files = idList(body.file_ids).flatMap((id) => {
      const file = library.get(id);
      return isLive(file) && file.owner === who.key ? [file] : [];
    });
    // One generated password is shared by the batch (contract §6).
    const shared = body.generate_password ? passphrase() : undefined;
    const fields = shared ? { ...body, generate_password: false, password: shared } : body;
    for (const file of files) applyAccess(file, fields, who.anonymous, new Set(Object.keys(fields)));
    send(res, 200, { items: files.map((file) => ownerFile(origin, file)), ...(shared ? { password: shared } : {}) });
    return true;
  }
  if ((match = /^\/users\/@me\/files\/([^/]+)$/.exec(path))) {
    const file = ownedFile(who.key, match[1]!);
    if (method === 'DELETE') {
      deleteFile(file);
      send(res, 204);
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      const sent = new Set(Object.keys(body));
      if (body.filename !== undefined) {
        const name = String(body.filename).trim().slice(0, 200);
        if (!name) throw new HttpError(400, 'BAD_REQUEST', 'The name is empty.');
        file.name = name;
      }
      if (body.expires_in !== undefined) applyExpiry(file, body.expires_in, who.anonymous);
      else if (sent.has('expires_at')) applyExpiry(file, body.expires_at === null ? null : Number(body.expires_at) - now(), who.anonymous);
      const accessKeys = ['visibility', 'password', 'generate_password', 'unlock_ttl', 'password_expires_at', 'password_expires_in', 'show_name_when_locked'];
      const generated = accessKeys.some((name) => sent.has(name)) ? applyAccess(file, body, who.anonymous, sent) : undefined;
      const payload = ownerFile(origin, file);
      send(res, 200, generated ? { ...payload, password: generated, url_with_password: `${payload.url as string}#pw=${encodeURIComponent(generated)}` } : payload);
      return true;
    }
  }

  // ---- Albums ----
  if (path === '/users/@me/albums' && method === 'POST') {
    const body = await readJson(req);
    const ids = [...new Set(idList(body.file_ids))];
    if (who.anonymous) {
      const hourAgo = Date.now() - 3600_000;
      const ok = ids.length <= ANONYMOUS_ALBUM_MAX_FILES && ids.every((id) => {
        const file = library.get(id);
        return isLive(file) && file.owner === who.key && file.createdMs >= hourAgo;
      });
      if (!ok) throw new HttpError(403, 'ANONYMOUS_ALBUM_NOT_ALLOWED', 'Anonymous albums need up to 50 files uploaded in the last hour.');
    } else if (ownAlbums(who.key).length >= ALBUMS_MAX) {
      throw new HttpError(400, 'ALBUM_LIMIT_REACHED', 'Too many albums.', { limit: ALBUMS_MAX });
    }
    checkAlbumFiles(who.key, ids);
    const files = ids.map((id) => library.get(id)!);
    const id = nextId();
    const album: StoredAlbum = {
      id,
      vanity: vanity(),
      owner: who.key,
      title: cleanText(body.title, 100),
      description: cleanText(body.description, 2000),
      layout: (['auto', 'grid', 'list', 'tracklist'].includes(String(body.layout)) ? body.layout : 'auto') as StoredAlbum['layout'],
      visibility: 'link',
      password: null,
      accessVersion: 0,
      unlockTtl: 3600,
      passwordExpiresAt: null,
      showName: false,
      coverFileId: body.cover_file_id && ids.includes(String(body.cover_file_id)) ? String(body.cover_file_id) : null,
      items: ids.map((fileId) => ({ fileId, caption: '' })),
      createdAt: now(),
      updatedAt: now(),
      // Anonymous albums expire with their latest file.
      expiresAt: who.anonymous ? Math.max(0, ...files.map((file) => file.expiresAt ?? 0)) || null : null,
      deleted: false,
    };
    albumStore.set(id, album);
    send(res, 201, ownerAlbum(origin, album));
    return true;
  }
  if (path === '/users/@me/albums' && method === 'GET') {
    const text = (query.get('query') ?? '').toLowerCase();
    const list = ownAlbums(who.key)
      .filter((album) => !text || album.title.toLowerCase().includes(text))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
    const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 25) || 25));
    send(res, 200, { count: list.length, items: list.slice(offset, offset + limit).map((album) => albumSummary(origin, album)) });
    return true;
  }
  if ((match = /^\/users\/@me\/albums\/([^/]+)(\/files(?:\/([^/]+))?)?$/.exec(path))) {
    const album = ownedAlbum(who.key, match[1]!);
    const touch = () => {
      album.updatedAt = now();
      send(res, 200, ownerAlbum(origin, album));
      return true;
    };
    // Anonymous callers can't edit an album after creating it (contract §6).
    if (who.anonymous && method !== 'GET') throw new HttpError(403, 'ANONYMOUS_ALBUM_NOT_ALLOWED', 'Sign in to edit albums.');
    if (!match[2]) {
      if (method === 'GET') {
        send(res, 200, ownerAlbum(origin, album));
        return true;
      }
      if (method === 'DELETE') {
        album.deleted = true;
        if (query.get('delete_files') === 'true') for (const item of album.items) {
          const file = library.get(item.fileId);
          if (isLive(file)) deleteFile(file);
        }
        send(res, 204);
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        const sent = new Set(Object.keys(body));
        if (body.title !== undefined) album.title = cleanText(body.title, 100);
        if (body.description !== undefined) album.description = cleanText(body.description, 2000).replace(/\r/g, '');
        if (body.layout !== undefined) {
          if (!['auto', 'grid', 'list', 'tracklist'].includes(String(body.layout))) throw new HttpError(400, 'BAD_REQUEST', 'Invalid layout.');
          album.layout = body.layout as StoredAlbum['layout'];
        }
        if (sent.has('cover_file_id')) {
          const cover = body.cover_file_id === null ? null : String(body.cover_file_id);
          if (cover !== null && !album.items.some((item) => item.fileId === cover)) throw new HttpError(400, 'INVALID_ALBUM_FILES', 'Not in the album.', { file_ids: [cover] });
          album.coverFileId = cover;
        }
        const accessKeys = ['visibility', 'password', 'generate_password', 'unlock_ttl', 'password_expires_at', 'password_expires_in', 'show_name_when_locked'];
        const generated = accessKeys.some((name) => sent.has(name)) ? applyAccess(album, body, who.anonymous, sent) : undefined;
        album.updatedAt = now();
        const payload = ownerAlbum(origin, album);
        send(res, 200, generated ? { ...payload, password: generated, url_with_password: `${payload.url}#pw=${encodeURIComponent(generated)}` } : payload);
        return true;
      }
    } else if (!match[3]) {
      const body = await readJson(req);
      const ids = [...new Set(idList(body.file_ids))];
      if (method === 'PUT') {
        checkAlbumFiles(who.key, ids);
        const captions = new Map(album.items.map((item) => [item.fileId, item.caption]));
        album.items = ids.map((fileId) => ({ fileId, caption: captions.get(fileId) ?? '' }));
        if (album.coverFileId && !ids.includes(album.coverFileId)) album.coverFileId = null;
        return touch();
      }
      if (method === 'POST') {
        const fresh = ids.filter((id) => !album.items.some((item) => item.fileId === id));
        checkAlbumFiles(who.key, fresh, album);
        const at = body.position === undefined ? album.items.length : Math.max(0, Math.min(album.items.length, Number(body.position)));
        album.items.splice(at, 0, ...fresh.map((fileId) => ({ fileId, caption: '' })));
        return touch();
      }
    } else {
      const fileId = decodeURIComponent(match[3]);
      const item = album.items.find((each) => each.fileId === fileId);
      if (!item) throw new HttpError(404, 'UNKNOWN_FILE', 'Not in the album.');
      if (method === 'DELETE') {
        album.items = album.items.filter((each) => each !== item);
        if (album.coverFileId === fileId) album.coverFileId = null;
        return touch();
      }
      if (method === 'PATCH') {
        item.caption = cleanText((await readJson(req)).caption, 500);
        return touch();
      }
    }
  }

  // ---- Public album read (contract §6) ----
  if (method === 'GET' && (match = /^\/albums\/([^/]+)$/.exec(path))) {
    const album = [...albumStore.values()].find((each) => each.vanity === decodeURIComponent(match![1]!) && !each.deleted);
    if (!album || album.visibility === 'private') throw new HttpError(404, 'UNKNOWN_ALBUM', 'Unknown album.');
    if (album.visibility === 'password') {
      send(res, 200, { vanity: album.vanity, protected: 'password', ...(album.showName && album.title ? { title: album.title } : {}) });
      return true;
    }
    const payload = publicAlbum(origin, album);
    if (payload.items.length === 0) throw new HttpError(404, 'UNKNOWN_ALBUM', 'Unknown album.');
    send(res, 200, payload);
    return true;
  }

  // ---- Raw text for text files (stands in for the CDN) and peaks.json ----
  if (method === 'GET' && (match = /^\/raw\/([^/]+)$/.exec(path))) {
    const file = [...library.values()].find((each) => each.vanity === match![1] && isLive(each));
    if (!file) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(String(file.media.snippet ?? ''));
    return true;
  }
  if (method === 'GET' && (match = /^\/peaks\/([^/]+)\.json$/.exec(path))) {
    send(res, 200, peaks(Number(BigInt(match[1]!) % 97n)));
    return true;
  }
  return false;
}

/** Soft delete; removes the file from every album (contract §6). */
function deleteFile(file: StoredFile) {
  file.deleted = true;
  for (const album of albumStore.values()) {
    if (album.items.some((item) => item.fileId === file.id)) {
      album.items = album.items.filter((item) => item.fileId !== file.id);
      if (album.coverFileId === file.id) album.coverFileId = null;
    }
  }
}

/**
 * Library files and albums that are password or private, in the shape the
 * unlock / view / pass handlers use for the fixtures.
 */
function libraryProtected(kind: 'file' | 'album', match: (target: { id: string; vanity: string }) => boolean): [string, Protected] | undefined {
  seedLibrary();
  const target =
    kind === 'file' ? [...library.values()].find((file) => isLive(file) && match(file)) : [...albumStore.values()].find((album) => !album.deleted && match(album));
  if (!target) return undefined;
  const entry: Protected = {
    id: target.id,
    kind,
    visibility: target.visibility === 'link' ? 'password' : target.visibility,
    password: target.password ?? '',
    unlockTtl: target.unlockTtl,
    passwordExpired: target.passwordExpiresAt !== null && target.passwordExpiresAt <= now(),
    accessVersion: target.accessVersion,
    payload: (origin) => (kind === 'file' ? publicFile(origin, target as StoredFile) : publicAlbum(origin, target as StoredAlbum)),
  };
  return [target.vanity, entry];
}

export function mockApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith(MOCK_API_PREFIX)) return next();
    const [rawPath = '', search = ''] = url.slice(MOCK_API_PREFIX.length).split('?', 2);
    const path = rawPath || '/';
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    route(req, res, path, origin, new URLSearchParams(search)).catch((error: unknown) => {
      if (error instanceof HttpError) {
        send(res, error.status, { code: error.code, message: error.message, status: error.status, ...error.details });
      } else {
        send(res, 500, { code: 'INTERNAL', message: String(error), status: 500 });
      }
    });
  };
}
