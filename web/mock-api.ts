/**
 * In-memory mock of the Milestone 2, 3, 4 and 6 APIs (docs/redesign/contracts/milestone-2.md,
 * milestone-3.md, milestone-4.md, milestone-6.md) for `npm run dev`, mounted same-origin at
 * /api like the real `files.gg/api/*` passthrough. It never runs in a build.
 *
 * Implements: fingerprint, limits, single and chunked uploads, unlock, refresh, view and
 * owner passes (Milestone 2, at `/access/unlock|refresh|view/files|albums/<vanity>`, §20.1); the owner file library, bulk delete / expiry / access,
 * albums and their items, public album reads (Milestone 3); scan states, NSFW, reports,
 * My reports, notices and appeals, badges, restrictions, and every `/admin/*` endpoint
 * with seeded cases of each kind (Milestone 4); accounts (Milestone 6): cookie sessions
 * (`filesgg_session`, the contract's plain-http dev name) with CSRF checks, email and
 * password sign-in, register, verify, forgot and reset, a mock Discord with PKCE, re-auth,
 * settings, sessions, data exports, account deletion with its grace period, upload keys
 * (and uploads with them), premium limits, custom domains with time-driven statuses,
 * domain-only mode, the admin premium, domain and account actions, and view limits
 * (§19: `view_limit` on uploads and PATCH, `POST /access/open/files/<vanity>` with
 * unique-viewer counting, the `expire` and `private` actions, and unlock counting on
 * password files; `cf-connecting-ip` picks the viewer, like the API's abuse IP hash).
 *
 * Seeded accounts sign in at /app/login with the password `mock-password`. Email links
 * (verify, reset) are printed to the dev server's console.
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
 * MOCK_PROCESSING_MS (default 1500), MOCK_SCAN_MS (default 2500: how long a new upload
 * stays `pending`), MOCK_DERIVE_MS (default 6000: how long it then stays `processing`).
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { domainToASCII } from 'node:url';

import type { Connect } from 'vite';

import { cleanDisplayName, DISPLAY_NAME_REASON_TEXT, displayNameProblem, normalizeUsername, USERNAME_REASON_TEXT, usernameProblem } from './src/lib/usernames.ts';

export const MOCK_API_PREFIX = '/api';
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
  uploadKeyId: string | null;
}

const sessions = new Map<string, Session>();
const attempts = new Map<string, number[]>();

const WORDS = ['amber', 'tunnel', 'oxide', 'violet', 'harbor', 'quartz', 'meadow', 'cobalt', 'ember', 'lantern', 'willow', 'orbit', 'saffron', 'glacier', 'pebble', 'falcon'];
const passphrase = () => Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]).join('-');
const vanity = () => randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 7) || 'abc1234';
const snowflake = () => String(BigInt(Date.now() - 1550102400000) << 22n | BigInt(randomInt(4096)));

interface Caller {
  key: string;
  anonymous: boolean;
  /** The signed-in persona (session cookie or upload key), or null. */
  user: Persona | null;
  fingerprint: string | null;
  /** The live web session (cookie), or null. */
  session: WebSession | null;
  /** The upload key that authenticated this request, or null. */
  uploadKey: StoredKey | null;
}

/**
 * Who is calling (milestone-6 §3.4, §7.4): a valid `Authorization: Key` (upload endpoints
 * only; checked in `route`), else the session cookie, else anonymous with `X-Fingerprint`.
 * `Authorization` never signs anyone in.
 */
function owner(req: IncomingMessage): Caller {
  const keyMatch = /^Key\s+(\S+)$/.exec(String(req.headers.authorization ?? ''));
  const key = keyMatch ? findKey(keyMatch[1]!) : null;
  if (key && keyState(key) === 'active') {
    const user = USERS.get(key.userId)!;
    return { key: keyOfUser(user.id), anonymous: false, user, fingerprint: null, session: null, uploadKey: key };
  }
  const session = liveSession(sessionToken(req));
  if (session) {
    const user = USERS.get(session.userId)!;
    return { key: keyOfUser(user.id), anonymous: false, user, fingerprint: null, session, uploadKey: null };
  }
  const fingerprint = req.headers['x-fingerprint'];
  return { key: `fp:${String(fingerprint ?? 'none')}`, anonymous: true, user: null, fingerprint: fingerprint ? String(fingerprint) : null, session: null, uploadKey: null };
}

/** milestone-6 §9.2: Cloudflare's per-request body limit caps single-request uploads. */
const PROXY_BODY_LIMIT_BYTES = 100_000_000;
const GiB = 1024 * MB;

function limitsFor(anonymous: boolean, key: string) {
  if (anonymous) {
    return {
      storage: { used: usageOf(key), limit: null },
      max_file_size_single: 25 * MB,
      max_file_size_single_configured: 25 * MB,
      max_file_size_chunked: 25 * MB,
      max_expiry: 21 * DAY,
      allow_no_expiry: false,
      anonymous: true,
      album_max_files: ANONYMOUS_ALBUM_MAX_FILES,
      albums_max: null,
      nsfw_allowed: false,
      premium: false,
      custom_domains: { used: 0, limit: 0 },
      upload_keys: { used: 0, limit: 0 },
    };
  }
  const userId = userIdOfKey(key);
  const premium = userId ? isPremium(userId) : false;
  const single = premium ? 500 * MB : 100 * MB;
  return {
    storage: { used: usageOf(key), limit: premium ? 100 * GiB : STORAGE_LIMIT },
    max_file_size_single: Math.min(single, PROXY_BODY_LIMIT_BYTES - MB),
    max_file_size_single_configured: single,
    max_file_size_chunked: premium ? 5 * GiB : GiB,
    max_expiry: null,
    allow_no_expiry: true,
    anonymous: false,
    album_max_files: ALBUM_MAX_FILES,
    albums_max: ALBUMS_MAX,
    nsfw_allowed: !activeRestriction(userId, 'uploads') && !activeRestriction(userId, 'suspended'),
    premium,
    custom_domains: { used: userId ? countedDomains(userId).length : 0, limit: premium ? PREMIUM_CUSTOM_DOMAINS : 0 },
    upload_keys: { used: userId ? activeKeys(userId).length : 0, limit: UPLOAD_KEYS_MAX },
  };
}

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
  // milestone-6 §7.5: no credential and no Turnstile token at all is a tool upload.
  if (anonymous && fields.turnstile_token === undefined) {
    throw new HttpError(401, 'UPLOAD_KEY_REQUIRED', 'Create a free account to upload with ShareX.');
  }
  if (anonymous && fields.turnstile_token !== TURNSTILE_DUMMY_TOKEN) {
    throw new HttpError(403, 'CAPTCHA_INVALID', 'Human verification failed.');
  }
  // Milestone 4 §4.3: adult content needs an account.
  if (anonymous && String(fields.nsfw) === 'true') {
    throw new HttpError(403, 'NSFW_REQUIRES_ACCOUNT', 'Sign in to upload sensitive media.');
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
  // Milestone 6 §19.3: view limits, anonymous uploads included (but never `private`).
  readViewLimit(fields.view_limit);
  readViewLimitAction(fields.view_limit_action, anonymous);
}

// ---------------------------------------------------------------------------
// View limits (milestone-6 §19)
// ---------------------------------------------------------------------------

type ViewLimitAction = 'expire' | 'private';

/** `view_limit` from an upload or PATCH body: undefined when absent, null to remove, else 1–1000. */
function readViewLimit(value: unknown): number | null | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === null || value === 'null') return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new HttpError(400, 'INVALID_PARAMETERS', 'view_limit must be a whole number from 1 to 1000.', { errors: { view_limit: 'Use a whole number from 1 to 1,000.' } });
  }
  return limit;
}

function readViewLimitAction(value: unknown, anonymous: boolean): ViewLimitAction | undefined {
  if (value === undefined || value === '') return undefined;
  if (value !== 'expire' && value !== 'private') {
    throw new HttpError(400, 'INVALID_PARAMETERS', 'view_limit_action must be expire or private.', { errors: { view_limit_action: 'Pick expire or private.' } });
  }
  // §19.3: an anonymous upload has no owner library to keep a private file in.
  if (value === 'private' && anonymous) throw new HttpError(400, 'PRIVATE_REQUIRES_ACCOUNT', 'Private files need an account.');
  return value;
}

/** The viewer: the API uses the abuse IP hash (milestone-4 §1); the mock uses the IP. */
const viewerOf = (req: IncomingMessage) => `ip:${ipOf(req)}`;

/** §19.4: the owner and staff are served without counting. */
const servedFree = (who: Caller, file: StoredFile) => (!who.anonymous && who.key === file.owner) || Boolean(who.user?.staff);

/**
 * Counts `viewer` once (§19.4). Returns true when this viewer is the last one: they get
 * the file, and the action fires after their response is built (`fireViewLimit`).
 */
function countView(file: StoredFile, viewer: string): boolean {
  if (file.viewLimit === null || file.viewers.has(viewer)) return false;
  file.viewers.add(viewer);
  return file.viewers.size >= file.viewLimit;
}

/**
 * `expire` keeps the file live for the last viewer's signed URLs (up to 1 h), then it
 * expires; nobody new gets in meanwhile (`limitUsedUp`). `private` hides it and bumps
 * `access_version` (revoking signed URLs).
 */
function fireViewLimit(file: StoredFile) {
  if (file.viewLimitAction === 'private') {
    file.visibility = 'private';
    file.password = null;
    file.accessVersion++;
  } else {
    file.expiresAt = Math.min(file.expiresAt ?? Number.POSITIVE_INFINITY, now() + 3600);
  }
}

/** §19.4: once the limit is used up, a viewer who isn't counted yet gets the normal missing state. */
const limitUsedUp = (file: StoredFile, viewer: string) =>
  file.viewLimit !== null && file.viewers.size >= file.viewLimit && !file.viewers.has(viewer);

/** `view_limit: { remaining }` on a public payload (§19.6), or nothing without a limit. */
const viewLimitPayload = (file: StoredFile) =>
  file.viewLimit === null ? {} : { view_limit: { remaining: Math.max(0, file.viewLimit - file.viewers.size) } };

/** The upload response: the file payload (contract §4, signed for the uploader), plus a generated password once. The file joins the library. */
function fileObject(origin: string, owner: string, filename: string, size: number, fields: Record<string, unknown>, anonymous: boolean) {
  const visibility = String(fields.visibility ?? 'link');
  const generated = visibility === 'password' && String(fields.generate_password) === 'true' ? passphrase() : undefined;
  const stored = storeUpload(owner, filename, size, fields, anonymous, generated);
  // Milestone 4 §6.2: upload responses carry the owner `safety` too.
  const payload: Record<string, unknown> = { ...withOwnerLinks(stored, ownerSigned(stored, publicFile(origin, stored))), safety: ownerSafety(stored) };
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
  // ---- Milestone 4 (the mock keeps the per-hash scan on the file) ----
  scanState: ScanState;
  scanReason: string | null;
  /** A pending scan resolves to `scanOutcome` at this time (ms). */
  scanReadyAtMs: number;
  scanOutcome: ScanOutcome | null;
  moderation: 'visible' | 'hidden' | 'removed';
  moderationRule: string | null;
  /** Hidden automatically (report thresholds): the owner sees `review`. */
  moderationAuto?: boolean;
  nsfwMarked: boolean;
  nsfwAuto: boolean;
  nsfwScore: number | null;
  nsfwOverride: 'nsfw' | 'safe' | null;
  nsfwOverrideSource: 'moderator' | 'reports' | null;
  nsfwReview: 'none' | 'open' | 'done';
  /** The latest notice about this file. */
  noticeId: string | null;
  warnings: string[];
  linkWarnings: string[];
  findings: Array<{ check: string; code: string; detail: string }>;
  deletedReason: string | null;
  deletedAtMs: number | null;
  // ---- Milestone 6 §19: view limits ----
  /** 1–1000 unique viewers, or null for no limit. */
  viewLimit: number | null;
  viewLimitAction: 'expire' | 'private';
  /** Viewer keys counted so far (the API keeps the abuse IP hash). `views_used` is its size. */
  viewers: Set<string>;
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
  // ---- Milestone 4 ----
  nsfw: boolean;
  nsfwSource: 'owner' | 'moderator' | null;
  moderation: 'visible' | 'hidden' | 'removed';
  moderationRule: string | null;
  noticeId: string | null;
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
      return { waveform: { url: waveformSvg(hue / 36), width: 1600, height: 240 }, peaks: { url: `${MOCK_API_PREFIX}/peaks/${file.id}.json` } };
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
  /** Milestone 4 state (scan, moderation, NSFW), on top of `passed` and `visible`. */
  safety?: Partial<StoredFile>;
  /** A fixed vanity, for the viewer's dev fixtures. */
  vanity?: string;
  /** Milestone 6 §19: a view limit, its action and how many viewers already used it. */
  viewLimit?: { limit: number; action?: 'expire' | 'private'; used?: number };
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
    // Milestone 6 §19: view limits. The viewer's `limited` and `limited-password` fixtures use these vanities.
    photo(2, 'limited-photo', 400, 600, 0.2, { vanity: 'limited1', viewLimit: { limit: 3, used: 1 } }),
    { name: 'limited-notes', ext: 'pdf', size: 17_113, daysAgo: 0.4, cdn: fixture('sample.pdf'), media: { pages: 8 }, vanity: 'limitedpw', visibility: 'password', viewLimit: { limit: 5, action: 'private', used: 2 } },
    // The `private` action already fired: private, with the hint to raise the limit.
    photo(3, 'burned-after-reading', 600, 600, 2.5, { visibility: 'private', viewLimit: { limit: 2, action: 'private', used: 2 } }),
  ];
}

/** Defaults for the Milestone 4 fields: scanned, passed, visible, not NSFW. */
const safeDefaults = (): Pick<
  StoredFile,
  | 'scanState' | 'scanReason' | 'scanReadyAtMs' | 'scanOutcome' | 'moderation' | 'moderationRule' | 'nsfwMarked' | 'nsfwAuto' | 'nsfwScore'
  | 'nsfwOverride' | 'nsfwOverrideSource' | 'nsfwReview' | 'noticeId' | 'warnings' | 'linkWarnings' | 'findings' | 'deletedReason' | 'deletedAtMs'
  | 'viewLimit' | 'viewLimitAction' | 'viewers'
> => ({
  scanState: 'passed',
  scanReason: null,
  scanReadyAtMs: 0,
  scanOutcome: null,
  moderation: 'visible',
  moderationRule: null,
  nsfwMarked: false,
  nsfwAuto: false,
  nsfwScore: 0.02,
  nsfwOverride: null,
  nsfwOverrideSource: null,
  nsfwReview: 'none',
  noticeId: null,
  warnings: [],
  linkWarnings: [],
  findings: [],
  deletedReason: null,
  deletedAtMs: null,
  viewLimit: null,
  viewLimitAction: 'expire',
  viewers: new Set(),
});

function makeSeedFile(seed: SeedFile, ownerKey: string, nowMs: number): StoredFile {
  const createdMs = Math.round(nowMs - seed.daysAgo * 86_400_000);
  const mimetype = seed.mimetype ?? MIMETYPES[seed.ext] ?? 'application/octet-stream';
  const id = nextId(createdMs);
  const file: StoredFile = {
    id,
    vanity: seed.vanity ?? vanity(),
    owner: ownerKey,
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
    ...safeDefaults(),
    ...seed.safety,
  };
  file.owner = ownerKey;
  if (seed.viewLimit) {
    file.viewLimit = seed.viewLimit.limit;
    file.viewLimitAction = seed.viewLimit.action ?? 'expire';
    file.viewers = new Set(Array.from({ length: seed.viewLimit.used ?? 0 }, (_, i) => `seed-viewer-${i}`));
  }
  // A non-browser image (HEIC) with a `display` preview counts as an image (contract §4).
  if (mimetype === 'image/heic') {
    file.kind = 'image';
    file.assets.display = { url: placeholder('IMG_4032 (display)', 30, 1600, 1200, 'photo'), width: 1600, height: 1200 };
  }
  if (!seed.processing) file.assets = { ...placeholderAssets(file), ...file.assets, ...seed.assets };
  if (!file.cdn) file.cdn = file.kind === 'text' ? `${MOCK_API_PREFIX}/raw/${file.vanity}` : file.assets.display?.url ?? file.assets['thumb-2x']?.url ?? fixture('archive.zip');
  return file;
}

let seeded = false;

function seedLibrary(): void {
  if (seeded) return;
  seeded = true;
  const nowMs = Date.now();
  const byName = new Map<string, StoredFile>();
  for (const seed of [...seedFiles(), ...safetySeedFiles()]) {
    const file = makeSeedFile(seed, seed.safety?.owner ?? USER_KEY, nowMs);
    library.set(file.id, file);
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
      nsfw: false,
      nsfwSource: null,
      moderation: 'visible',
      moderationRule: null,
      noticeId: null,
      ...extra,
    });
    return id;
  };
  album(
    'Lisbon, November',
    'Five days of trams, stairs and pastries. Full set: https://files.gg',
    'auto',
    ['lisbon-tram', 'alfama-stairs', 'pastel-de-nata', 'tagus-panorama', 'belem-tower', 'sunset-timelapse', 'beach-day', 'meme-dump', 'scan-in-progress', 'limited-photo'],
    { coverFileId: byName.get('tagus-panorama')!.id },
    0.5,
  );
  album('Tones', '', 'auto', ['01 Low tone', '02 Middle tone', '03 High tone'], {}, 3);
  album('Client drafts', 'For review.', 'list', ['files-gg-sample', 'invoice-2026-11', 'lisbon-tram'], { visibility: 'password', password: 'files.gg', showName: true }, 8);
  const spamAlbum = album('FREE GIFT CARDS', 'Click here: https://example.com/free', 'grid', ['spam-flyer'], { owner: 'user:77' }, 6);
  seedSafety(byName, spamAlbum);
  seedAccounts();
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
    nsfw: nsfwOf(file),
    warnings: file.warnings,
    link_warnings: file.linkWarnings,
  };
}

/** A protected file's payload signed for its owner: the file grant, 1 h (contract §6). */
function ownerSigned<T extends Record<string, unknown>>(file: StoredFile, payload: T): T {
  // Milestone 6 §19.4: a view-limited file is served like a protected one.
  if (file.visibility === 'link' && file.viewLimit === null) return payload;
  return signFile(payload, { expires: now() + OWNER_URL_TTL, grant: `file:${file.id}:${file.accessVersion}` });
}

function ownerFile(origin: string, file: StoredFile): Record<string, unknown> {
  return {
    ...withOwnerLinks(file, ownerSigned(file, publicFile(origin, file, true))),
    access_version: file.accessVersion,
    unlock_ttl: file.unlockTtl,
    password_expires_at: file.passwordExpiresAt,
    show_name_when_locked: file.showName,
    albums: ownAlbums(file.owner)
      .filter((album) => album.items.some((item) => item.fileId === file.id))
      .map((album) => ({ id: album.id, vanity: album.vanity, title: album.title })),
    safety: ownerSafety(file),
    // Milestone 6 §19.6.
    view_limit: file.viewLimit,
    view_limit_action: file.viewLimitAction,
    views_used: file.viewers.size,
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

/**
 * Contract §4: a link album shows only link items; a protected one shows every live item.
 * Milestone 4 §6.4: and only items whose effective state is `ok` or `flagged`.
 */
const shownIn = (album: StoredAlbum, file: StoredFile | undefined) =>
  isLive(file) &&
  (album.visibility !== 'link' || file.visibility === 'link') &&
  ['ok', 'flagged'].includes(fileState(file)) &&
  // Milestone 6 §19.6: opening an album can't count each item.
  file.viewLimit === null;

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
    nsfw: albumNsfw(album),
    safety: albumSafety(album),
  });
}

function ownerAlbum(origin: string, album: StoredAlbum) {
  const items = albumItems(album);
  return {
    ...albumSummary(origin, album),
    description: album.description,
    nsfw: albumNsfw(album),
    nsfw_marked: album.nsfw,
    link_warnings: [],
    ...ownerSignedAlbum(album, { download_url: albumZip(album) }),
    expires_at: album.expiresAt,
    count: items.filter((item) => item.shown).length,
    access_version: album.accessVersion,
    unlock_ttl: album.unlockTtl,
    password_expires_at: album.passwordExpiresAt,
    show_name_when_locked: album.showName,
    cover_file_id: album.coverFileId,
    items: items.map((item, position) => ({
      ...ownerFile(origin, item.file),
      position,
      caption: item.caption,
      shown: item.shown,
      // Milestone 6 §19.6: why a view-limited file isn't shown.
      ...(!item.shown && item.file.viewLimit !== null ? { hidden_reason: 'view_limit' } : {}),
    })),
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
    nsfw: albumNsfw(album),
    visibility: album.visibility,
    cover,
    // §4.6: a public NSFW album omits its collage.
    collage: albumNsfw(album) ? null : collage,
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
    derivedAtMs: createdMs + env('MOCK_SCAN_MS', 2500) + env('MOCK_DERIVE_MS', 6000),
    views: 0,
    deleted: false,
    ...safeDefaults(),
    // Milestone 4 §2.1: every new upload is pending until its scan finishes.
    scanState: 'pending',
    scanReadyAtMs: createdMs + env('MOCK_SCAN_MS', 2500),
    scanOutcome: scanOutcomeFor(filename),
    nsfwMarked: !anonymous && String(fields.nsfw) === 'true',
    viewLimit: readViewLimit(fields.view_limit) ?? null,
    viewLimitAction: readViewLimitAction(fields.view_limit_action, anonymous) ?? 'expire',
  };
  if (kind === 'text') file.cdn = `${MOCK_API_PREFIX}/raw/${file.vanity}`;
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
  let match: RegExpExecArray | null;
  seedLibrary();
  tickSafety();
  authenticate(req, res, method, path);
  const who = owner(req);
  gate(who, method, path);

  if (method === 'GET' && path === '/auth/fingerprint') {
    return send(res, 200, { fingerprint: String(BigInt(Date.now()) * 1000n + BigInt(randomInt(1000))) });
  }
  if (await accountRoute(req, res, path, origin, query, who)) return;
  checkUploadRestrictions(who, method, path);
  if (await safetyRoute(req, res, path, origin, query, who)) return;
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
    checkKeyUpload(who, fields);
    checkUpload(who.anonymous, who.key, file.size, fields, false);
    return send(res, 200, fileObject(origin, who.key, file.filename, file.size, fields, who.anonymous));
  }

  // ---- Chunked ----
  if (method === 'POST' && path === '/uploads') {
    const body = await readJson(req);
    const size = Number(body.size);
    checkKeyUpload(who, body);
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
      uploadKeyId: who.uploadKey?.id ?? null,
    };
    sessions.set(id, session);
    return send(res, 201, { upload_id: id, chunk_size: CHUNK_SIZE, chunk_count: session.chunkCount, expires_at: session.expiresAt });
  }
  if ((match = /^\/uploads\/([^/]+)(?:\/(chunks)\/(\d+)|\/(complete))?$/.exec(path))) {
    const session = sessions.get(match[1]!);
    // §7.5: a key's session answers only that key (or the owner's session cookie).
    if (!session || session.owner !== who.key || (who.uploadKey && session.uploadKeyId !== who.uploadKey.id)) throw new HttpError(404, 'UNKNOWN_UPLOAD', 'Unknown upload.');
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

  // ---- Open a view-limited file (milestone-6 §19.4). The vanity is the last path segment. ----
  if ((match = /^\/access\/open\/files\/(.+)$/.exec(path)) && method === 'POST') {
    const vanityName = decodeURIComponent(match[1]!);
    const body = await readJson(req);
    // The order of checks: Turnstile (action `view`), the rate limit, the file's own access, then counting.
    if (body.turnstile_token !== TURNSTILE_DUMMY_TOKEN) throw new HttpError(403, 'CAPTCHA_INVALID', 'Human verification failed.');
    const bucketKey = `open:${vanityName}:${ipOf(req)}`;
    const recent = (attempts.get(bucketKey) ?? []).filter((t) => t > Date.now() - 60_000);
    if (recent.length >= 30) {
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts.', { retry_after: Math.ceil((recent[0]! + 60_000 - Date.now()) / 1000) });
    }
    attempts.set(bucketKey, [...recent, Date.now()]);
    const file = [...library.values()].find((each) => isLive(each) && each.vanity === vanityName);
    if (!file) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
    checkPublicState('file', file.id);
    const free = servedFree(who, file);
    if (!free && limitUsedUp(file, viewerOf(req))) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
    // Private files open only for their owner (so they never count).
    if (file.visibility === 'private' && !free) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
    if (file.visibility === 'password' && !free) {
      const claims = verifyToken(String(req.headers['x-filesgg-access'] ?? ''));
      if (!claims || claims.k !== 'file' || claims.t !== file.id || claims.e <= now() || claims.v !== file.accessVersion) {
        throw new HttpError(401, 'UNLOCK_REQUIRED', 'Unlock this file first.');
      }
    }
    const last = free ? false : countView(file, viewerOf(req));
    // Signed for 1 h, or until the file expires, whichever is earlier.
    const e = Math.min(now() + 3600, file.expiresAt ?? Number.POSITIVE_INFINITY);
    const payload = signFile({ ...publicFile(origin, file), ...viewLimitPayload(file) }, { expires: e, grant: `file:${file.id}:${file.accessVersion}` });
    // The last viewer gets the file; the action fires right after their response is built.
    if (last) fireViewLimit(file);
    return send(res, 200, { file: payload, expires_at: e });
  }

  // ---- Unlock, refresh, view (contract §5), at milestone-6 §20.1's paths: the vanity is last ----
  if ((match = /^\/access\/(unlock|refresh|view)\/(files|albums)\/(.+)$/.exec(path))) {
    const action = match[1]!;
    const kind = match[2] === 'albums' ? 'album' : 'file';
    const vanityName = decodeURIComponent(match[3]!);
    const entry = PROTECTED[vanityName] ?? libraryProtected(kind, (target) => target.vanity === vanityName)?.[1];
    if (!entry || entry.kind !== kind) throw new HttpError(404, kind === 'album' ? 'UNKNOWN_ALBUM' : 'UNKNOWN_FILE', 'Unknown file.');
    checkPublicState(kind, entry.id);
    const key = kind === 'album' ? 'album' : 'file';
    // Milestone 6 §19: a view-limited library file (a password one counts its unlock).
    const limited = kind === 'file' && !PROTECTED[vanityName] ? library.get(entry.id) : undefined;
    // Unlock, view and refresh all return the payload with URLs signed until the token expires (milestone-3 §3).
    const granted = (token: string, e: number) => {
      const grant = `${kind}:${entry.id}:${entry.accessVersion}`;
      const payload = { ...entry.payload(origin), ...(limited ? viewLimitPayload(limited) : {}) };
      return { token, expires_at: e, [key]: kind === 'album' ? signAlbum(payload, e, grant) : signFile(payload, { expires: e, grant }) };
    };

    if (action === 'view' && method === 'GET') {
      const token = String(req.headers['x-filesgg-access'] ?? '');
      const claims = verifyToken(token);
      const valid = claims && claims.k === kind && claims.t === entry.id && claims.e > now() && claims.v === entry.accessVersion;
      if (!valid) {
        if (entry.visibility === 'private') throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
        throw new HttpError(401, 'UNLOCK_EXPIRED', 'Access expired.');
      }
      return send(res, 200, granted(token, claims.e));
    }

    if (action === 'refresh' && method === 'POST') {
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

    if (action === 'unlock' && method === 'POST') {
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
      if (limited && !servedFree(who, limited) && limitUsedUp(limited, viewerOf(req))) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
      if (body.password !== entry.password) throw new HttpError(401, 'WRONG_PASSWORD', 'Wrong password.');
      attempts.delete(bucketKey);
      // §19.4: a successful unlock of a view-limited password file is the view.
      const last = limited && !servedFree(who, limited) ? countView(limited, viewerOf(req)) : false;
      const u = now();
      const e = u + Math.min(entry.unlockTtl, 3600);
      const response = granted(signToken({ e, k: kind, s: 'unlock', t: entry.id, u, v: entry.accessVersion }), e);
      if (last && limited) fireViewLimit(limited);
      return send(res, 200, response);
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
    // milestone-6 §10.9: `{ domain_id }` puts the pass on one of your serving domains.
    const passBody = await readJson(req);
    let base = origin;
    if (passBody.domain_id !== undefined && passBody.domain_id !== null) {
      const domain = ownDomain(who.user!.id, String(passBody.domain_id));
      if (!domainServing(domain)) throw new HttpError(409, 'DOMAIN_NOT_ACTIVE', 'That domain isn’t active.');
      base = `https://${domain.hostname}`;
    }
    const u = now();
    const token = signToken({ e: u + 3600, k: kind, s: 'owner', t: entry.id, u, v: entry.accessVersion });
    const url = kind === 'album' ? `${base}/a/${name}#t=${token}` : `${base}/${name}#t=${token}`;
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
  if (method === 'POST' && path === '/users/@me/files/nsfw') {
    const body = await readJson(req);
    if (who.anonymous) throw new HttpError(403, 'NSFW_REQUIRES_ACCOUNT', 'Sign in to mark files as sensitive.');
    const items: StoredFile[] = [];
    const skipped: string[] = [];
    for (const id of idList(body.file_ids, 100)) {
      const file = library.get(id);
      if (!isLive(file) || file.owner !== who.key || (!body.nsfw && nsfwLocked(file))) skipped.push(id);
      else {
        file.nsfwMarked = Boolean(body.nsfw);
        items.push(file);
      }
    }
    send(res, 200, { items: items.map((file) => ownerFile(origin, file)), skipped });
    return true;
  }
  if (method === 'POST' && (match = /^\/users\/@me\/files\/([^/]+)\/nsfw-review$/.exec(path))) {
    const file = ownedFile(who.key, match[1]!);
    if (nsfwSourceOf(file) !== 'auto' || file.nsfwReview !== 'none') throw new HttpError(409, 'APPEAL_NOT_ALLOWED', 'A review was already requested for this file.');
    const body = await readJson(req);
    file.nsfwReview = 'open';
    addFlag(caseFor('file', file.id), 'owner', 'nsfw_review', { message: cleanText(body.message, 2000) || null });
    send(res, 202, { status: 'open' });
    return true;
  }
  if (method === 'GET' && (match = /^\/users\/@me\/files\/([^/]+)$/.exec(path))) {
    const file = library.get(match[1]!);
    // §2.5: a file rejected after scanning answers 410 UPLOAD_REJECTED for 24 h.
    if (file && file.owner === who.key && file.deleted && file.deletedReason && REJECTION_CODES.has(file.deletedReason) && Date.now() - (file.deletedAtMs ?? 0) < DAY * 1000) {
      throw new HttpError(410, 'UPLOAD_REJECTED', rejectionText(file.deletedReason), { reason: file.deletedReason });
    }
    send(res, 200, ownerFile(origin, ownedFile(who.key, match[1]!)));
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
      if (body.nsfw !== undefined) {
        if (who.anonymous) throw new HttpError(403, 'NSFW_REQUIRES_ACCOUNT', 'Sign in to mark files as sensitive.');
        if (!body.nsfw && nsfwLocked(file)) throw new HttpError(409, 'NSFW_LOCKED', 'This file was marked as sensitive by files.gg, so it can’t be unmarked. Ask for a review instead.');
        file.nsfwMarked = Boolean(body.nsfw);
      }
      if (body.expires_in !== undefined) applyExpiry(file, body.expires_in, who.anonymous);
      else if (sent.has('expires_at')) applyExpiry(file, body.expires_at === null ? null : Number(body.expires_at) - now(), who.anonymous);
      // Milestone 6 §19.3: set, raise, lower (above views_used) or remove; never resets the count.
      if (sent.has('view_limit') || sent.has('view_limit_action')) {
        if (who.anonymous) throw new HttpError(403, 'FORBIDDEN', 'Anonymous uploads can set a view limit only at upload.');
        const limit = readViewLimit(body.view_limit);
        const action = readViewLimitAction(body.view_limit_action, false);
        if (limit !== undefined && limit !== null && limit <= file.viewers.size) {
          throw new HttpError(400, 'VIEW_LIMIT_TOO_LOW', 'The view limit must be greater than the views already used.', {
            views_used: file.viewers.size,
            errors: { view_limit: `Set a limit above ${file.viewers.size}.` },
          });
        }
        if (limit !== undefined) file.viewLimit = limit;
        if (action) file.viewLimitAction = action;
      }
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
      nsfw: false,
      nsfwSource: null,
      moderation: 'visible',
      moderationRule: null,
      noticeId: null,
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
        if (body.nsfw !== undefined) {
          album.nsfw = Boolean(body.nsfw);
          album.nsfwSource = album.nsfw ? 'owner' : null;
        }
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
    if (!album || album.visibility === 'private' || pendingDeletion(userIdOfKey(album.owner))) throw new HttpError(404, 'UNKNOWN_ALBUM', 'Unknown album.');
    if (album.moderation !== 'visible') throw new HttpError(410, 'ALBUM_REMOVED', 'This album was removed.', { reason: publicReason(album.moderation === 'hidden', album.moderationRule) });
    if (album.visibility === 'password') {
      send(res, 200, { vanity: album.vanity, protected: 'password', ...(album.showName && album.title ? { title: album.title } : {}) });
      return true;
    }
    const payload = publicAlbum(origin, album);
    // §6.4: nothing shown yet, but items pending: the payload with `items: []` and `pending_count`.
    const pendingCount = albumItems(album).filter((item) => fileState(item.file) === 'pending').length;
    if (payload.items.length === 0 && pendingCount === 0) throw new HttpError(404, 'UNKNOWN_ALBUM', 'Unknown album.');
    send(res, 200, { ...payload, pending_count: pendingCount });
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
function deleteFile(file: StoredFile, reason: string | null = null) {
  file.deleted = true;
  file.deletedReason = reason;
  file.deletedAtMs = Date.now();
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

// ---------------------------------------------------------------------------
// Milestone 4: trust & safety (milestone-4 contract §2, §4, §6–§9)
// ---------------------------------------------------------------------------

type ScanState = 'pending' | 'passed' | 'flagged' | 'held' | 'blocked';
type SafetyState = 'ok' | 'pending' | 'flagged' | 'hidden' | 'removed' | 'blocked';

/** What a pending scan turns into (picked from the filename at upload, see `scanOutcomeFor`). */
interface ScanOutcome {
  state: Exclude<ScanState, 'pending'>;
  reason: string | null;
  nsfwAuto?: boolean;
  warnings?: string[];
  /** The `deleted_reason` when an anonymous upload gets this outcome (§2.5). */
  rejectAnonymous?: string;
}

interface Persona {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  createdAt: number;
  staff: { role: 'moderator' | 'admin'; child_safety: boolean } | null;
  // Milestone 6 (§1.1, §2.1)
  emailVerified: boolean;
  pendingEmail: string | null;
  /** Plain text: the mock compares it directly. Null: no password (Discord only). */
  password: string | null;
  needsUsername: boolean;
  usernameChangedAt: number | null;
  showNameOnAlbums: boolean;
  domainOnly: boolean;
  deletionRequestedAt: number | null;
  deletionScheduledFor: number | null;
}

/** Every seeded account signs in with this password (milestone-6 mock). */
export const MOCK_PASSWORD = 'mock-password';

const persona = (id: string, username: string, displayName: string, daysOld: number, staff: Persona['staff'] = null, extra: Partial<Persona> = {}): Persona => ({
  id,
  username,
  displayName,
  email: `${username}@example.com`,
  createdAt: now() - daysOld * DAY,
  staff,
  emailVerified: true,
  pendingEmail: null,
  password: MOCK_PASSWORD,
  needsUsername: false,
  usernameChangedAt: null,
  showNameOnAlbums: false,
  domainOnly: false,
  deletionRequestedAt: null,
  deletionScheduledFor: null,
  ...extra,
});

/** Seeded accounts (milestone-6 mock): sign in by email with `MOCK_PASSWORD`. */
const USERS = new Map<string, Persona>(
  [
    persona('42', 'mockuser', 'Mock User', 400, { role: 'admin', child_safety: true }, { email: 'mock@example.com', usernameChangedAt: now() - 10 * DAY }),
    persona('43', 'modmary', 'Mary', 300, { role: 'moderator', child_safety: false }),
    persona('45', 'member', 'Member', 90, null, { emailVerified: false }),
    persona('46', 'restricted', 'Restricted member', 60),
    persona('47', 'suspended', 'Suspended member', 30),
    persona('48', 'priya', 'Priya', 60, null, { email: 'premium@example.com' }),
    persona('49', 'leaving', 'Leaving', 200, null, { deletionRequestedAt: now() - 5 * DAY, deletionScheduledFor: now() + 9 * DAY }),
    persona('50', 'discordonly', 'Discord only', 20, null, { email: null, emailVerified: false, password: null, displayName: null }),
    persona('77', 'tracker99', 'tracker99', 2),
    persona('78', 'quietfox', 'quietfox', 180),
    persona('79', 'reporterbee', 'reporterbee', 45),
  ].map((user) => [user.id, user]),
);

const userIdOfKey = (key: string): string | null => (key.startsWith('user:') ? key.slice(5) : null);
const keyOfUser = (id: string) => (id === '42' ? USER_KEY : `user:${id}`);

const RULE_TEXT: Record<string, string> = {
  ncii: 'Intimate images shared without consent',
  violence: 'Violence, terrorism or credible threats',
  malware: 'Malware or harmful software',
  phishing: 'Phishing or scams',
  adult_unmarked: 'Adult content that wasn’t marked as sensitive',
  copyright: 'Copyright infringement',
  harassment: 'Harassment',
  private_info: 'Sharing someone’s private information',
  spam: 'Spam',
  other: 'Breaking the Terms of Service',
};
const RULES = ['csam', ...Object.keys(RULE_TEXT)];

const REASON_PRIORITY: Record<string, number> = {
  csam: 0,
  ncii: 0,
  violence: 1,
  malware: 1,
  adult_unmarked: 2,
  copyright: 2,
  harassment: 2,
  spam: 3,
  other: 3,
  bug: 3,
};
/** §5.8: scanner findings open cases at these priorities. */
const FLAG_PRIORITY: Record<string, number> = {
  csam_match: 0,
  pdq_near_match: 1,
  malware: 1,
  web_risk: 1,
  hash_list: 1,
  blocked_type: 1,
  archive_bomb: 1,
  pdf_dangerous: 1,
  unwanted_software: 2,
  pdf_javascript: 3,
  polyglot_archive: 3,
  nsfw_review: 3,
};
/** `REPORT_THRESHOLDS` (§13); `csam` and `ncii` act at 1. */
const REPORT_THRESHOLDS: Record<string, number> = { csam: 1, ncii: 1, violence: 2, malware: 2, adult_unmarked: 2, harassment: 3, spam: 3 };
const REASONS_FOR: Record<string, string[]> = {
  file: ['csam', 'ncii', 'violence', 'malware', 'adult_unmarked', 'copyright', 'harassment', 'spam', 'other'],
  album: ['csam', 'ncii', 'violence', 'malware', 'adult_unmarked', 'copyright', 'harassment', 'spam', 'other'],
  user: ['csam', 'ncii', 'violence', 'harassment', 'spam', 'other'],
  bug: ['bug'],
  // milestone-6 §10.12: `malware` covers phishing.
  domain: ['malware', 'spam', 'harassment', 'other'],
};

export const REJECTION_CODES = new Set(['NSFW_REQUIRES_ACCOUNT', 'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT', 'MALWARE_DETECTED', 'FILE_TYPE_NOT_ALLOWED', 'FILE_BLOCKED']);
const rejectionText = (code: string) =>
  ({
    NSFW_REQUIRES_ACCOUNT: 'Sign in to upload sensitive media.',
    ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT: 'Sign in to upload encrypted archives.',
    MALWARE_DETECTED: 'This file looks like malware, so it wasn’t uploaded.',
    FILE_TYPE_NOT_ALLOWED: 'This file contains a type that isn’t allowed on files.gg.',
    FILE_BLOCKED: 'This file can’t be uploaded.',
  })[code] ?? 'This upload was rejected.';

interface StoredReport {
  id: string;
  kind: 'file' | 'album' | 'user' | 'bug' | 'domain';
  fileId: string | null;
  albumId: string | null;
  userId: string | null;
  /** milestone-6 §10.12: domain reports (and URL reports resolved through a custom domain). */
  domainId: string | null;
  /** The target's vanity at the time, so the reporter's view survives deletion. */
  targetVanity: string | null;
  albumPart: 'whole' | 'title' | 'description' | 'captions' | null;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed';
  reporterUserId: string | null;
  fingerprint: string | null;
  contactEmail: string | null;
  details: string;
  dmca: Record<string, unknown> | null;
  caseId: string;
  reopenCount: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** The last status change the reporter hasn't necessarily seen. */
  statusChangedAt: number;
}

interface StoredMessage {
  id: string;
  reportId: string;
  authorUserId: string | null;
  isStaff: boolean;
  body: string;
  createdAt: number;
}

interface StoredFlag {
  id: string;
  source: 'scan' | 'rescan' | 'reports' | 'owner';
  reason: string;
  details: Record<string, unknown> | null;
  createdAt: number;
  resolvedAt: number | null;
}

type CaseKind = 'file' | 'album' | 'user' | 'hash' | 'bug' | 'appeal' | 'domain';

interface StoredCase {
  id: string;
  kind: CaseKind;
  status: 'open' | 'closed';
  /** file, album, user or hash (a file id: the mock keeps one hash per file), the bug report, or the notice. */
  targetId: string;
  basePriority: number;
  childSafety: boolean;
  /** A hash-matched (CSAM) case: never displayable (§3.6). */
  hashMatched: boolean;
  needsSecondReview: boolean;
  assigneeId: string | null;
  claimedAt: number | null;
  outcome: 'actioned' | 'dismissed' | null;
  outcomeReason: string | null;
  cybertipReportId: string | null;
  cybertipFiledAt: number | null;
  flags: StoredFlag[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

interface AuditRow {
  id: string;
  actorUserId: string | null;
  actorKind: 'staff' | 'system' | 'cli';
  action: string;
  rule: string | null;
  fileId: string | null;
  albumId: string | null;
  userId: string | null;
  hashId: string | null;
  /** milestone-6 §1.3: `moderation_actions.domain_id`. */
  domainId: string | null;
  reportId: string | null;
  caseId: string | null;
  warningId: string | null;
  note: string | null;
  details: Record<string, unknown> | null;
  reversesActionId: string | null;
  childSafety: boolean;
  createdAt: number;
}

interface StoredNotice {
  id: string;
  userId: string;
  actionId: string;
  action: string;
  rule: string;
  message: string | null;
  target: { kind: 'file' | 'album' | 'account' | 'domain'; id: string; vanity?: string | null; name?: string | null; hostname?: string | null };
  appealable: boolean;
  strike: boolean;
  acknowledgedAt: number | null;
  appealState: 'none' | 'open' | 'granted' | 'denied';
  appealMessage: string | null;
  counterNotice: Record<string, unknown> | null;
  appealReply: string | null;
  appealedAt: number | null;
  decidedAt: number | null;
  createdAt: number;
}

interface StoredRestriction {
  id: string;
  userId: string;
  kind: 'uploads' | 'suspended';
  rule: string;
  actionId: string | null;
  startsAt: number;
  endsAt: number | null;
  liftedAt: number | null;
  noticeId: string | null;
}

interface StoredBan {
  id: string;
  kind: 'fingerprint' | 'ip';
  source: Record<string, string>;
  /** What the ban matches: a fingerprint, or a stand-in for the IP hash. */
  value: string;
  rule: string;
  note: string | null;
  actionId: string;
  createdAt: number;
  expiresAt: number | null;
  liftedAt: number | null;
}

const reports = new Map<string, StoredReport>();
const reportMessages: StoredMessage[] = [];
/** `<report id>:<user id>` → last read (epoch s). */
const reportReads = new Map<string, number>();
const cases = new Map<string, StoredCase>();
const auditLog: AuditRow[] = [];
const notices = new Map<string, StoredNotice>();
const restrictionStore: StoredRestriction[] = [];
const banStore: StoredBan[] = [];
const rateBuckets = new Map<string, number[]>();

const safetyId = () => nextId();

// ---- Effective state and NSFW (§2.4, §4.4) ----

function fileState(file: StoredFile): SafetyState {
  if (file.scanState === 'blocked') return 'blocked';
  if (file.moderation === 'removed') return 'removed';
  if (file.moderation === 'hidden' || file.scanState === 'held') return 'hidden';
  if (file.scanState === 'pending') return 'pending';
  return file.scanState === 'flagged' ? 'flagged' : 'ok';
}

const isCsamFile = (file: StoredFile) => file.scanReason === 'csam_match' || file.moderationRule === 'csam';
const nsfwOf = (file: StoredFile) => file.nsfwOverride === 'nsfw' || (file.nsfwOverride === null && (file.nsfwMarked || file.nsfwAuto));

function nsfwSourceOf(file: StoredFile): string | null {
  if (file.nsfwOverride) return file.nsfwOverrideSource;
  if (file.nsfwMarked) return 'uploader';
  return file.nsfwAuto ? 'auto' : null;
}

/** §4.5 and §14.4: only the uploader's own mark can be taken back. */
function nsfwLocked(file: StoredFile): boolean {
  const source = nsfwSourceOf(file);
  return (source !== null && source !== 'uploader') || (file.nsfwMarked && file.nsfwAuto);
}

/** Public removed-page reason (§2.4). */
function publicReason(hidden: boolean, rule: string | null): string {
  if (hidden) return 'review';
  if (rule === 'copyright') return 'copyright';
  if (rule === 'malware' || rule === 'phishing') return 'malware';
  return 'terms';
}

/** The owner `safety` (§6.2). CSAM only ever shows `review` or `FILE_BLOCKED`, and no notice. */
function ownerSafety(file: StoredFile) {
  const state = fileState(file);
  const csam = isCsamFile(file);
  let reason: string | null = null;
  if (state === 'hidden' || state === 'removed') {
    reason = csam || file.scanState === 'held' || file.moderationAuto ? 'review' : file.moderationRule;
  } else if (state === 'blocked') {
    reason = csam ? 'FILE_BLOCKED' : file.scanReason;
  } else if (state === 'flagged') {
    reason = file.scanReason;
  }
  return {
    state,
    reason,
    notice_id: csam ? null : file.noticeId,
    nsfw_source: nsfwSourceOf(file),
    nsfw_locked: nsfwLocked(file),
    nsfw_review: file.nsfwReview,
  };
}

const albumNsfw = (album: StoredAlbum) => album.nsfw || albumItems(album).some((item) => item.shown && nsfwOf(item.file));

function albumSafety(album: StoredAlbum) {
  if (album.moderation === 'visible') return { state: 'ok', reason: null, notice_id: null };
  return { state: album.moderation, reason: album.moderationRule === 'csam' ? 'review' : album.moderationRule, notice_id: album.moderationRule === 'csam' ? null : album.noticeId };
}

/** Unlock and `/view` answer for the state first (§12: FILE_PENDING, FILE_REMOVED, ALBUM_REMOVED). */
function checkPublicState(kind: 'file' | 'album', id: string) {
  // milestone-6 §8.8: an account with a pending deletion has its content offline, as missing.
  const ownerKey = kind === 'album' ? albumStore.get(id)?.owner : library.get(id)?.owner;
  if (ownerKey && pendingDeletion(userIdOfKey(ownerKey))) {
    throw new HttpError(404, kind === 'album' ? 'UNKNOWN_ALBUM' : 'UNKNOWN_FILE', kind === 'album' ? 'Unknown album.' : 'Unknown file.');
  }
  if (kind === 'album') {
    const album = albumStore.get(id);
    if (album && album.moderation !== 'visible') {
      throw new HttpError(410, 'ALBUM_REMOVED', 'This album was removed.', { reason: publicReason(album.moderation === 'hidden', album.moderationRule) });
    }
    return;
  }
  const file = library.get(id);
  if (!file) return;
  const state = fileState(file);
  if (state === 'pending') throw new HttpError(409, 'FILE_PENDING', 'This file is still being checked.', { retry_after: 5 });
  if (state === 'hidden' || state === 'removed') {
    throw new HttpError(410, 'FILE_REMOVED', 'This file was removed.', { reason: publicReason(state === 'hidden', file.moderationRule) });
  }
  if (state === 'blocked') throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
}

// ---- Restrictions and bans (§8.4, §9.3) ----

function activeRestriction(userId: string | null, kind: 'uploads' | 'suspended'): StoredRestriction | null {
  if (!userId) return null;
  return restrictionStore.find((r) => r.userId === userId && r.kind === kind && r.liftedAt === null && (r.endsAt === null || r.endsAt > now())) ?? null;
}

const restrictionsOf = (userId: string) =>
  restrictionStore
    .filter((r) => r.userId === userId && r.liftedAt === null && (r.endsAt === null || r.endsAt > now()))
    .map((r) => ({ kind: r.kind, until: r.endsAt, notice_id: r.noticeId }));

const isBanned = (fingerprint: string | null) =>
  banStore.some((ban) => ban.liftedAt === null && (ban.expiresAt === null || ban.expiresAt > now()) && (ban.value === `fp:${fingerprint}` || ban.value === 'ip:127.0.0.1'));

/** §2.5 step 5: bans and restrictions stop uploads and album creation. */
function checkUploadRestrictions(who: Caller, method: string, path: string) {
  const creating = method === 'POST' && (path === '/files' || path === '/uploads' || path === '/users/@me/albums');
  if (!creating) return;
  const restriction = who.user ? activeRestriction(who.user.id, 'uploads') : null;
  if (restriction) throw new HttpError(403, 'UPLOADS_RESTRICTED', 'Uploads are restricted on your account.', { until: restriction.endsAt });
  if (who.anonymous && isBanned(who.fingerprint)) throw new HttpError(403, 'BANNED', 'Uploads from this device or network aren’t allowed.');
}

// ---- Scanning (§2) ----

/**
 * Mock scan results, by filename: `eicar`/`malware` (blocked, malware), `badtype` (blocked
 * type), `blocked` (blocked hash), `held` (PDQ near-match), `nsfw` (classified adult),
 * `encrypted` (encrypted archive warning), `pua` (flagged unwanted software). Anything
 * else passes. Anonymous uploads that are blocked, NSFW or encrypted are rejected (§2.5).
 */
export function scanOutcomeFor(filename: string): ScanOutcome {
  const name = filename.toLowerCase();
  if (/eicar|malware/.test(name)) return { state: 'blocked', reason: 'malware', rejectAnonymous: 'MALWARE_DETECTED' };
  if (name.includes('badtype')) return { state: 'blocked', reason: 'blocked_type', rejectAnonymous: 'FILE_TYPE_NOT_ALLOWED' };
  if (name.includes('blocked')) return { state: 'blocked', reason: 'hash_list', rejectAnonymous: 'FILE_BLOCKED' };
  if (name.includes('held')) return { state: 'held', reason: 'pdq_near_match' };
  if (name.includes('nsfw')) return { state: 'passed', reason: null, nsfwAuto: true, rejectAnonymous: 'NSFW_REQUIRES_ACCOUNT' };
  if (name.includes('encrypted')) return { state: 'passed', reason: null, warnings: ['encrypted_archive'], rejectAnonymous: 'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT' };
  if (name.includes('pua')) return { state: 'flagged', reason: 'unwanted_software', warnings: ['unwanted_software'] };
  return { state: 'passed', reason: null };
}

/** Resolves every pending scan whose time has come. Called on each request. */
function tickSafety() {
  for (const file of library.values()) {
    if (!file.deleted && file.scanState === 'pending' && file.scanOutcome && Date.now() >= file.scanReadyAtMs) finishScan(file);
  }
}

function finishScan(file: StoredFile) {
  const outcome = file.scanOutcome!;
  file.scanOutcome = null;
  file.scanState = outcome.state;
  file.scanReason = outcome.reason;
  file.nsfwAuto = Boolean(outcome.nsfwAuto);
  file.nsfwScore = outcome.nsfwAuto ? 0.93 : file.kind === 'image' || file.kind === 'video' ? 0.03 : null;
  file.warnings = outcome.warnings ?? [];
  if (outcome.reason) {
    const check = ['malware', 'unwanted_software'].includes(outcome.reason) ? 'clamav' : outcome.reason === 'pdq_near_match' ? 'pdq' : 'hash_list';
    file.findings = [{ check, code: outcome.reason, detail: outcome.reason === 'malware' ? 'Win.Test.EICAR_HDB-1' : outcome.reason === 'unwanted_software' ? 'PUA.Win.Packer.Upx-1' : outcome.reason }];
  }
  // Seeded files waiting for their scan get their previews now (derive runs after scan).
  if (!Number.isFinite(file.derivedAtMs)) {
    file.derivedAtMs = Date.now() + env('MOCK_DERIVE_MS', 6000);
    file.assets = placeholderAssets(file);
  }
  const anonymous = file.owner.startsWith('fp:');
  const rejected = outcome.state === 'blocked' || outcome.nsfwAuto || outcome.warnings?.includes('encrypted_archive');
  if (anonymous && outcome.rejectAnonymous && rejected) {
    deleteFile(file, outcome.rejectAnonymous);
    return;
  }
  if (outcome.state === 'passed') return;
  const action = outcome.state === 'blocked' ? 'scan_block' : outcome.state === 'held' ? 'scan_hold' : 'scan_flag';
  const scanCase = caseFor('file', file.id);
  addFlag(scanCase, 'scan', outcome.reason ?? 'scan', null);
  const row = logAction(null, 'system', action, { rule: outcome.reason === 'malware' ? 'malware' : null, fileId: file.id, hashId: file.id, caseId: scanCase.id });
  const userId = userIdOfKey(file.owner);
  if (outcome.state === 'blocked' && userId) {
    file.noticeId = createNotice(userId, row, 'scan_block', outcome.reason === 'malware' ? 'malware' : 'other', fileTarget(file)).id;
  }
}

// ---- Audit log, notices and cases ----

interface AuditFields {
  rule?: string | null;
  fileId?: string | null;
  albumId?: string | null;
  userId?: string | null;
  hashId?: string | null;
  domainId?: string | null;
  reportId?: string | null;
  caseId?: string | null;
  warningId?: string | null;
  note?: string | null;
  details?: Record<string, unknown> | null;
  reversesActionId?: string | null;
  childSafety?: boolean;
  at?: number;
}

function logAction(actorUserId: string | null, actorKind: AuditRow['actorKind'], action: string, fields: AuditFields = {}): AuditRow {
  const row: AuditRow = {
    id: safetyId(),
    actorUserId,
    actorKind,
    action,
    rule: fields.rule ?? null,
    fileId: fields.fileId ?? null,
    albumId: fields.albumId ?? null,
    userId: fields.userId ?? null,
    hashId: fields.hashId ?? null,
    domainId: fields.domainId ?? null,
    reportId: fields.reportId ?? null,
    caseId: fields.caseId ?? null,
    warningId: fields.warningId ?? null,
    note: fields.note ?? null,
    details: fields.details ?? null,
    reversesActionId: fields.reversesActionId ?? null,
    childSafety: fields.childSafety ?? (fields.caseId ? Boolean(cases.get(fields.caseId)?.childSafety) : false),
    createdAt: fields.at ?? now(),
  };
  auditLog.push(row);
  return row;
}

/** §8.1: which actions are appealable and count as strikes. */
const NOTICE_META: Record<string, { appealable: boolean; strike: boolean }> = {
  hide: { appealable: true, strike: false },
  auto_hide: { appealable: false, strike: false },
  remove: { appealable: true, strike: true },
  delete: { appealable: true, strike: true },
  mark_nsfw: { appealable: true, strike: false },
  auto_nsfw: { appealable: true, strike: false },
  scan_block: { appealable: true, strike: false },
  adult_unmarked: { appealable: true, strike: true },
  block_hash: { appealable: true, strike: false },
  restrict_uploads: { appealable: true, strike: false },
  suspend_user: { appealable: true, strike: false },
  // Milestone 6 (§10.12, §11.4)
  disable_domain: { appealable: true, strike: false },
  set_domain_scope: { appealable: true, strike: false },
  reset_username: { appealable: true, strike: false },
  revoke_upload_keys: { appealable: false, strike: false },
};

const fileTarget = (file: StoredFile) => ({ kind: 'file' as const, id: file.id, vanity: file.vanity, name: `${file.name}${file.extension ? `.${file.extension}` : ''}` });
const albumTarget = (album: StoredAlbum) => ({ kind: 'album' as const, id: album.id, vanity: album.vanity, name: album.title || 'Untitled album' });

function createNotice(userId: string, row: AuditRow, action: string, rule: string, target: StoredNotice['target'], message: string | null = null, at = now()): StoredNotice {
  const meta = NOTICE_META[action] ?? { appealable: true, strike: false };
  const notice: StoredNotice = {
    id: safetyId(),
    userId,
    actionId: row.id,
    action,
    rule,
    message: action === 'auto_hide' ? (message ?? 'Hidden while we review a report.') : message,
    target,
    appealable: rule !== 'csam' && meta.appealable,
    strike: meta.strike,
    acknowledgedAt: null,
    appealState: 'none',
    appealMessage: null,
    counterNotice: null,
    appealReply: null,
    appealedAt: null,
    decidedAt: null,
    createdAt: at,
  };
  notices.set(notice.id, notice);
  row.warningId = notice.id;
  return notice;
}

function noticePayload(notice: StoredNotice) {
  const csam = notice.rule === 'csam';
  return {
    id: notice.id,
    action: notice.action,
    rule: notice.rule,
    rule_text: csam ? null : (RULE_TEXT[notice.rule] ?? null),
    message: csam ? 'Your account has been suspended.' : notice.message,
    target: notice.target,
    created_at: notice.createdAt,
    acknowledged_at: notice.acknowledgedAt,
    appeal: {
      state: notice.appealState,
      can_appeal: notice.appealable && notice.appealState === 'none',
      appealed_at: notice.appealedAt,
      decided_at: notice.decidedAt,
      message: notice.appealReply,
    },
  };
}

function findOpenCase(kind: CaseKind, targetId: string) {
  return [...cases.values()].find((c) => c.status === 'open' && c.kind === kind && c.targetId === targetId) ?? null;
}

/** The target's open case, or a new one (§9.2: one open case per target). */
function caseFor(kind: CaseKind, targetId: string, extra: Partial<StoredCase> = {}): StoredCase {
  const existing = kind === 'bug' || kind === 'appeal' ? null : findOpenCase(kind, targetId);
  if (existing) {
    if (extra.childSafety) existing.childSafety = true;
    existing.updatedAt = now();
    return existing;
  }
  const created: StoredCase = {
    id: safetyId(),
    kind,
    status: 'open',
    targetId,
    basePriority: 3,
    childSafety: false,
    hashMatched: false,
    needsSecondReview: false,
    assigneeId: null,
    claimedAt: null,
    outcome: null,
    outcomeReason: null,
    cybertipReportId: null,
    cybertipFiledAt: null,
    flags: [],
    createdAt: now(),
    updatedAt: now(),
    closedAt: null,
    ...extra,
  };
  cases.set(created.id, created);
  return created;
}

function addFlag(target: StoredCase, source: StoredFlag['source'], reason: string, details: Record<string, unknown> | null, at = now()) {
  target.flags.push({ id: safetyId(), source, reason, details, createdAt: at, resolvedAt: null });
  target.updatedAt = now();
}

const caseReports = (c: StoredCase) => [...reports.values()].filter((report) => report.caseId === c.id);

function casePriority(c: StoredCase): number {
  const parts = [
    c.basePriority,
    ...caseReports(c).filter((r) => r.status === 'open').map((r) => REASON_PRIORITY[r.reason] ?? 3),
    ...c.flags.filter((f) => f.resolvedAt === null).map((f) => FLAG_PRIORITY[f.reason] ?? 3),
  ];
  return Math.min(...parts);
}

/** The reporter key for "distinct reporters" (§7.4). */
const reporterKey = (r: StoredReport) => (r.reporterUserId ? `user:${r.reporterUserId}` : `anon:${r.fingerprint ?? 'none'}`);

function distinctReporters(list: StoredReport[]) {
  return new Set(list.map(reporterKey)).size;
}

// ---- Seed: content in every state, reports, cases, notices and staff (§11.2 "mock-api.ts") ----

function safetySeedFiles(): SeedFile[] {
  const photo = (n: number, name: string, daysAgo: number, safety: Partial<StoredFile>, extra: Partial<SeedFile> = {}): SeedFile => ({
    name,
    ext: 'png',
    size: Math.round((0.8 + n * 0.3) * MB),
    daysAgo,
    cdn: fixture(`photo-${n}.png`),
    width: 600,
    height: 400,
    assets: { thumb: { url: fixture(`photo-${n}.png`), width: 320, height: 213 }, 'thumb-2x': { url: fixture(`photo-${n}.png`), width: 640, height: 427 } },
    safety,
    ...extra,
  });
  const other = (key: string) => ({ owner: key });
  return [
    // Mock User's own files (the dashboard states).
    photo(3, 'beach-day', 1.5, { nsfwMarked: true }),
    photo(4, 'night-shoot', 1.6, { nsfwAuto: true, nsfwScore: 0.91 }),
    photo(2, 'meme-dump', 2.5, { moderation: 'hidden', moderationRule: 'harassment' }),
    photo(1, 'scan-in-progress', 0.0104, { scanState: 'pending', scanReadyAtMs: Date.now() + 90_000, scanOutcome: { state: 'passed', reason: null } }, { processing: true }),
    { name: 'leaked-episode', ext: 'mp4', size: 380 * MB, daysAgo: 9, width: 1280, height: 720, duration: 1_320_000, media: { playable: true }, safety: { moderation: 'removed', moderationRule: 'copyright' } },
    { name: 'cracked-tool', ext: 'zip', size: 4.2 * MB, daysAgo: 36, safety: { scanState: 'blocked', scanReason: 'malware', findings: [{ check: 'clamav', code: 'malware', detail: 'Win.Trojan.Agent-1234' }] } },
    { name: 'backup-encrypted', ext: 'zip', size: 12 * MB, daysAgo: 38, safety: { warnings: ['encrypted_archive'] } },
    // Other people's files, for the admin queue.
    { name: 'free-robux', ext: 'zip', size: 1.1 * MB, daysAgo: 1, safety: { ...other('user:77'), scanState: 'flagged', scanReason: 'unwanted_software', warnings: ['unwanted_software'], findings: [{ check: 'clamav', code: 'unwanted_software', detail: 'PUA.Win.Packer.Upx-1' }] } },
    photo(5, 'spam-flyer', 6, other('user:77')),
    photo(1, 'totally-legit', 0.2, { ...other('user:77'), moderation: 'hidden', moderationRule: 'csam', moderationAuto: true }),
    photo(2, 'stolen-art', 5, { ...other('user:77'), moderation: 'removed', moderationRule: 'copyright' }),
    photo(3, 'private-photo', 0.4, { ...other('user:78'), moderation: 'hidden', moderationRule: 'ncii', moderationAuto: true }, { ext: 'jpg' }),
    { name: 'quiet-notes', ext: 'pdf', size: 220_000, daysAgo: 12, cdn: fixture('sample.pdf'), media: { pages: 8 }, assets: { thumb: { url: fixture('pdf-thumb.png'), width: 240, height: 310 } }, safety: { ...other('user:78'), moderation: 'removed', moderationRule: 'spam' } },
    { name: 'invoice-urgent', ext: 'pdf', size: 90_000, daysAgo: 0.8, cdn: fixture('sample.pdf'), media: { pages: 1 }, safety: { ...other('fp:5550001'), scanState: 'flagged', scanReason: 'pdf_javascript', findings: [{ check: 'pdf', code: 'pdf_javascript', detail: '/OpenAction /JavaScript' }] }, expiresIn: 20 * DAY },
    photo(4, 'blocked-upload', 0.1, { ...other('fp:5550002'), scanState: 'blocked', scanReason: 'csam_match' }, { expiresIn: 20 * DAY }),
  ];
}

function seedSafety(byName: Map<string, StoredFile>, spamAlbumId: string) {
  const file = (name: string) => byName.get(name)!;
  const t = now();
  const ago = (days: number) => t - Math.round(days * DAY);
  const spamAlbum = albumStore.get(spamAlbumId)!;

  // Notices for Mock User's own files.
  const memeRow = logAction('43', 'staff', 'hide', { rule: 'harassment', fileId: file('meme-dump').id, note: 'Targets a named person.', at: ago(2) });
  file('meme-dump').noticeId = createNotice('42', memeRow, 'hide', 'harassment', fileTarget(file('meme-dump')), 'This meme names and targets a private person.', ago(2)).id;
  const episodeRow = logAction('43', 'staff', 'remove', { rule: 'copyright', fileId: file('leaked-episode').id, note: 'DMCA notice from the studio.', at: ago(1) });
  file('leaked-episode').noticeId = createNotice('42', episodeRow, 'remove', 'copyright', fileTarget(file('leaked-episode')), 'Removed after a copyright notice from the rights holder.', ago(1)).id;
  const toolRow = logAction(null, 'system', 'scan_block', { rule: 'malware', fileId: file('cracked-tool').id, hashId: file('cracked-tool').id, at: ago(36) });
  const toolNotice = createNotice('42', toolRow, 'scan_block', 'malware', fileTarget(file('cracked-tool')), null, ago(36));
  Object.assign(toolNotice, { acknowledgedAt: ago(35), appealState: 'denied', appealMessage: 'It’s a game mod, not malware.', appealedAt: ago(35), decidedAt: ago(34), appealReply: 'ClamAV and our own review agree this archive contains a trojan, so it stays blocked.' });
  file('cracked-tool').noticeId = toolNotice.id;

  // Mock User's reports (My reports).
  const robux = file('free-robux');
  const robuxCase = caseFor('file', robux.id, { createdAt: ago(0.9) });
  addFlag(robuxCase, 'scan', 'unwanted_software', { signature: 'PUA.Win.Packer.Upx-1' }, ago(0.95));
  const r1 = addReport({ kind: 'file', fileId: robux.id, targetVanity: robux.vanity, reason: 'malware', reporterUserId: '42', details: 'The download asks for my Roblox password.', caseId: robuxCase.id, createdAt: ago(0.9) });
  addMessage(r1, null, true, 'Thanks for the report. We’re checking this file now.', ago(0.5));

  const albumCaseOld = caseFor('album', spamAlbum.id, { createdAt: ago(5) });
  const r2 = addReport({ kind: 'album', albumId: spamAlbum.id, targetVanity: spamAlbum.vanity, albumPart: 'title', reason: 'spam', reporterUserId: '42', details: '', caseId: albumCaseOld.id, createdAt: ago(5) });
  dismiss(r2, ago(3));
  addMessage(r2, null, true, 'We looked at this album and didn’t find anything that breaks the Terms.', ago(3));
  closeCase(albumCaseOld, 'dismissed', 'Title is clickbait but not spam.', ago(3));
  const albumCase = caseFor('album', spamAlbum.id, { createdAt: ago(0.3) });
  addReport({ kind: 'album', albumId: spamAlbum.id, targetVanity: spamAlbum.vanity, albumPart: 'description', reason: 'spam', reporterUserId: '79', details: 'Links to a gift card scam.', caseId: albumCase.id, createdAt: ago(0.3) });

  const art = file('stolen-art');
  const artCase = caseFor('file', art.id, { createdAt: ago(6) });
  const r3 = addReport({
    kind: 'file', fileId: art.id, targetVanity: art.vanity, reason: 'copyright', reporterUserId: '42', details: 'This is my illustration, posted without permission.', caseId: artCase.id, createdAt: ago(6),
    dmca: { name: 'Mock User', address: '1 Example Street, Lisbon', phone: '+351 000 000 000', email: 'mock@example.com', work: 'My illustration "Harbour at dusk"', urls: [`https://files.gg/${art.vanity}`], good_faith: true, accurate_and_authorised: true, signature: 'Mock User' },
  });
  const artRow = logAction('43', 'staff', 'remove', { rule: 'copyright', fileId: art.id, caseId: artCase.id, reportId: r3.id, at: ago(5) });
  art.noticeId = createNotice('77', artRow, 'remove', 'copyright', fileTarget(art), null, ago(5)).id;
  resolve(r3, ago(5));
  addMessage(r3, null, true, 'Thanks. We removed the file and notified the uploader.', ago(5));
  closeCase(artCase, 'actioned', 'Valid DMCA notice.', ago(5));

  const userCase = caseFor('user', '77', { createdAt: ago(41) });
  const r4 = addReport({ kind: 'user', userId: '77', targetVanity: null, reason: 'harassment', reporterUserId: '42', details: 'Keeps uploading files about me.', caseId: userCase.id, createdAt: ago(41) });
  resolve(r4, ago(40));
  addMessage(r4, null, true, 'We’ve taken action on this account.', ago(40));
  closeCase(userCase, 'actioned', 'Warned the user.', ago(40));
  const userCaseOpen = caseFor('user', '77', { createdAt: ago(0.6) });
  addReport({ kind: 'user', userId: '77', targetVanity: null, reason: 'spam', reporterUserId: '79', details: 'New account posting scam files.', caseId: userCaseOpen.id, createdAt: ago(0.6) });

  const bugCase = caseFor('bug', 'pending', { createdAt: ago(0.2) });
  const r5 = addReport({ kind: 'bug', targetVanity: null, reason: 'bug', reporterUserId: '42', details: 'The album page flickers when I reorder on Safari.', caseId: bugCase.id, createdAt: ago(0.2) });
  bugCase.targetId = r5.id;

  const legit = file('totally-legit');
  const csamCase = caseFor('file', legit.id, { childSafety: true, createdAt: ago(0.2) });
  addReport({ kind: 'file', fileId: legit.id, targetVanity: legit.vanity, reason: 'csam', reporterUserId: '42', details: '', caseId: csamCase.id, createdAt: ago(0.2) });
  logAction(null, 'system', 'auto_hide', { rule: 'csam', fileId: legit.id, caseId: csamCase.id, childSafety: true, at: ago(0.2) });

  // Reports by others.
  const privatePhoto = file('private-photo');
  const nciiCase = caseFor('file', privatePhoto.id, { createdAt: ago(0.4), assigneeId: '43', claimedAt: ago(0.1) });
  const r7 = addReport({ kind: 'file', fileId: privatePhoto.id, targetVanity: privatePhoto.vanity, reason: 'ncii', fingerprint: '6660001', contactEmail: 'someone@example.com', details: 'This is me. I never agreed to this being shared.', caseId: nciiCase.id, createdAt: ago(0.4) });
  const nciiRow = logAction(null, 'system', 'auto_hide', { rule: 'ncii', fileId: privatePhoto.id, caseId: nciiCase.id, reportId: r7.id, at: ago(0.4) });
  privatePhoto.noticeId = createNotice('78', nciiRow, 'auto_hide', 'ncii', fileTarget(privatePhoto), null, ago(0.4)).id;
  logAction('43', 'staff', 'claim', { caseId: nciiCase.id, at: ago(0.1) });

  // Scanner cases.
  const invoice = file('invoice-urgent');
  addFlag(caseFor('file', invoice.id, { createdAt: ago(0.8) }), 'scan', 'pdf_javascript', { keywords: ['/OpenAction', '/JavaScript'] }, ago(0.8));
  const blocked = file('blocked-upload');
  const hashCase = caseFor('hash', blocked.id, { basePriority: 0, childSafety: true, hashMatched: true, createdAt: ago(0.1) });
  addFlag(hashCase, 'scan', 'csam_match', { matcher: 'standin' }, ago(0.1));
  logAction(null, 'system', 'csam_match', { hashId: blocked.id, fileId: blocked.id, caseId: hashCase.id, details: { matcher: 'standin', vendor_refs: ['standin-0-1a2b3c4d'] }, at: ago(0.1) });
  logAction(null, 'system', 'preserve_evidence', { hashId: blocked.id, caseId: hashCase.id, at: ago(0.1) });
  banStore.push({ id: safetyId(), kind: 'fingerprint', source: { file_id: blocked.id }, value: 'fp:5550002', rule: 'csam', note: null, actionId: logAction(null, 'system', 'ban', { rule: 'csam', caseId: hashCase.id, at: ago(0.1) }).id, createdAt: ago(0.1), expiresAt: null, liftedAt: null });

  // An appeal by quietfox against a removal by Mock User: SAME_MODERATOR for Mock User.
  const notes = file('quiet-notes');
  const notesRow = logAction('42', 'staff', 'remove', { rule: 'spam', fileId: notes.id, note: 'Looked like SEO spam.', at: ago(4) });
  const notesNotice = createNotice('78', notesRow, 'remove', 'spam', fileTarget(notes), null, ago(4));
  Object.assign(notesNotice, { acknowledgedAt: ago(3.5), appealState: 'open', appealMessage: 'These are my lecture notes for a class. Nothing here is spam.', appealedAt: ago(3) });
  notes.noticeId = notesNotice.id;
  caseFor('appeal', notesNotice.id, { basePriority: 2, needsSecondReview: true, createdAt: ago(3) });

  // A ban made by staff, and the restricted and suspended personas.
  banStore.push({ id: safetyId(), kind: 'ip', source: { report_id: r7.id }, value: 'ip:seed', rule: 'ncii', note: 'Repeat uploads.', actionId: logAction('43', 'staff', 'ban', { rule: 'ncii', at: ago(0.3) }).id, createdAt: ago(0.3), expiresAt: t + 14 * DAY, liftedAt: null });
  const restrictRow = logAction(null, 'system', 'restrict_uploads', { rule: 'spam', userId: '46', at: ago(18) });
  const restrictNotice = createNotice('46', restrictRow, 'restrict_uploads', 'spam', { kind: 'account', id: '46' }, 'Three upheld warnings in 90 days.', ago(18));
  restrictionStore.push({ id: safetyId(), userId: '46', kind: 'uploads', rule: 'spam', actionId: restrictRow.id, startsAt: ago(18), endsAt: ago(18) + 30 * DAY, liftedAt: null, noticeId: restrictNotice.id });
  const suspendRow = logAction('42', 'staff', 'suspend_user', { rule: 'spam', userId: '47', at: ago(2) });
  const suspendNotice = createNotice('47', suspendRow, 'suspend_user', 'spam', { kind: 'account', id: '47' }, 'Repeated spam after an upload restriction.', ago(2));
  restrictionStore.push({ id: safetyId(), userId: '47', kind: 'suspended', rule: 'spam', actionId: suspendRow.id, startsAt: ago(2), endsAt: null, liftedAt: null, noticeId: suspendNotice.id });
}

interface ReportInput {
  kind: StoredReport['kind'];
  fileId?: string | null;
  albumId?: string | null;
  userId?: string | null;
  domainId?: string | null;
  targetVanity: string | null;
  albumPart?: StoredReport['albumPart'];
  reason: string;
  reporterUserId?: string | null;
  fingerprint?: string | null;
  contactEmail?: string | null;
  details: string;
  dmca?: Record<string, unknown> | null;
  caseId: string;
  createdAt?: number;
}

function addReport(input: ReportInput): StoredReport {
  const at = input.createdAt ?? now();
  const report: StoredReport = {
    id: safetyId(),
    kind: input.kind,
    fileId: input.fileId ?? null,
    albumId: input.albumId ?? null,
    userId: input.userId ?? null,
    domainId: input.domainId ?? null,
    targetVanity: input.targetVanity,
    albumPart: input.kind === 'album' ? (input.albumPart ?? 'whole') : null,
    reason: input.reason,
    status: 'open',
    reporterUserId: input.reporterUserId ?? null,
    fingerprint: input.fingerprint ?? null,
    contactEmail: input.contactEmail ?? null,
    details: input.details,
    dmca: input.dmca ?? null,
    caseId: input.caseId,
    reopenCount: 0,
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    statusChangedAt: 0,
  };
  reports.set(report.id, report);
  if (report.reporterUserId) reportReads.set(`${report.id}:${report.reporterUserId}`, at);
  return report;
}

function addMessage(report: StoredReport, authorUserId: string | null, isStaff: boolean, body: string, at = now()): StoredMessage {
  const message: StoredMessage = { id: safetyId(), reportId: report.id, authorUserId, isStaff, body, createdAt: at };
  reportMessages.push(message);
  report.updatedAt = at;
  return message;
}

function resolve(report: StoredReport, at = now()) {
  Object.assign(report, { status: 'resolved', resolvedAt: at, updatedAt: at, statusChangedAt: at });
}

function dismiss(report: StoredReport, at = now()) {
  Object.assign(report, { status: 'dismissed', resolvedAt: at, updatedAt: at, statusChangedAt: at });
}

function closeCase(c: StoredCase, outcome: 'actioned' | 'dismissed', reason: string, at = now()) {
  Object.assign(c, { status: 'closed', outcome, outcomeReason: reason, closedAt: at, updatedAt: at, assigneeId: null });
  for (const flag of c.flags) flag.resolvedAt ??= at;
}

// ---- The reporter's view (§7.5, §7.6) ----

const REPORT_CLOSE_AFTER = 30 * DAY;
const REPORT_REOPEN_WITHIN = 14 * DAY;

const reportClosed = (r: StoredReport) => r.status !== 'open' && r.resolvedAt !== null && now() - r.resolvedAt > REPORT_CLOSE_AFTER;

function reportView(origin: string, r: StoredReport, viewerId: string) {
  const lastRead = reportReads.get(`${r.id}:${viewerId}`) ?? 0;
  const messages = reportMessages.filter((m) => m.reportId === r.id);
  const closed = reportClosed(r);
  const unread = closed ? 0 : messages.filter((m) => m.isStaff && m.createdAt > lastRead).length + (r.statusChangedAt > lastRead ? 1 : 0);
  const target =
    r.kind === 'file'
      ? { type: 'file', vanity: r.targetVanity, url: `${origin}/${r.targetVanity}`, part: null }
      : r.kind === 'album'
        ? { type: 'album', vanity: r.targetVanity, url: `${origin}/a/${r.targetVanity}`, part: r.albumPart }
        : r.kind === 'user'
          ? { type: 'user', id: r.userId, url: null, part: null }
          : r.kind === 'domain'
            ? { type: 'domain', hostname: domainStore.get(r.domainId ?? '')?.hostname ?? null, url: null, part: null }
            : { type: 'bug', url: null, part: null };
  return {
    id: r.id,
    kind: r.kind,
    target,
    reason: r.reason,
    status: r.status,
    closed,
    escalated: r.reason === 'csam',
    can_reopen: r.status === 'dismissed' && r.reopenCount === 0 && !closed && r.resolvedAt !== null && now() - r.resolvedAt <= REPORT_REOPEN_WITHIN,
    unread,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    resolved_at: r.resolvedAt,
    last_message_at: messages.length ? Math.max(...messages.map((m) => m.createdAt)) : null,
  };
}

function ownReport(userId: string, id: string): StoredReport {
  const report = reports.get(id);
  if (!report || report.reporterUserId !== userId) throw new HttpError(404, 'UNKNOWN_REPORT', 'Unknown report.');
  return report;
}

function rateLimit(scope: string, key: string, max: number, code: string, message: string) {
  const bucket = `${scope}:${key}`;
  const recent = (rateBuckets.get(bucket) ?? []).filter((at) => at > Date.now() - 3600_000);
  if (recent.length >= max) {
    throw new HttpError(429, code, message, { retry_after: Math.ceil((recent[0]! + 3600_000 - Date.now()) / 1000) });
  }
  recent.push(Date.now());
  rateBuckets.set(bucket, recent);
}

/** `url` targets (§7.3): files.gg/<vanity>[.<ext>][/report], files.gg/a/<vanity>[/<n>][/report] and CDN paths. */
function resolveUrlTarget(raw: string): { type: 'file' | 'album'; vanity: string; item?: number } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'INVALID_REPORT_TARGET', 'That isn’t a files.gg link.');
  }
  // milestone-6 §20.2: the report pages are `/report/<vanity>` and `/report/a/<vanity>`, and an
  // album item is `/a/<vanity>?item=<n>`. Nothing comes after a vanity.
  const parts = url.pathname.split('/').filter(Boolean);
  const reportPage = parts[0] === 'report' && parts.length > 1;
  if (reportPage) parts.shift();
  const bare = (segment: string) => segment.replace(/\.[^.]+$/, '');
  if (parts[0] === 'a' && parts[1]) {
    if (parts.length > 2) throw new HttpError(400, 'INVALID_REPORT_TARGET', 'That isn’t a files.gg link.');
    const item = reportPage ? null : url.searchParams.get('item');
    return { type: 'album', vanity: parts[1], ...(item && /^[1-9][0-9]*$/.test(item) ? { item: Number(item) } : {}) };
  }
  if (parts[0] === 'files' && parts[1]) return { type: 'file', vanity: bare(parts.slice(1).join('/')) };
  if (parts[0] === 'previews' && parts[2]) return { type: 'file', vanity: bare(parts.slice(2).join('/')) };
  if (parts.length >= 1 && /^(files\.gg|cdn\.files\.gg|localhost(:\d+)?)$/.test(url.host)) return { type: 'file', vanity: bare(parts.join('/')) };
  throw new HttpError(400, 'INVALID_REPORT_TARGET', 'That isn’t a files.gg link.');
}

const DMCA_FIELDS = ['name', 'address', 'phone', 'email', 'work', 'urls', 'good_faith', 'accurate_and_authorised', 'signature'];
const COUNTER_FIELDS = ['name', 'address', 'phone', 'email', 'material', 'mistake_statement', 'jurisdiction_consent', 'service_consent', 'signature'];

function missingFields(value: unknown, fields: string[]): Record<string, string> {
  const object = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const given = object[field];
    const ok = Array.isArray(given) ? given.length > 0 : typeof given === 'boolean' ? given : typeof given === 'string' && given.trim() !== '';
    if (!ok) errors[field] = typeof given === 'boolean' || field.includes('_') ? 'This statement is required.' : 'This field is required.';
  }
  return errors;
}

/** `POST /reports` and `POST /reports/anonymous` (§7.3, §7.4). */
async function submitReport(req: IncomingMessage, res: ServerResponse, origin: string, who: Caller, anonymousRoute: boolean) {
  const body = await readJson(req);
  if (anonymousRoute && body.turnstile_token !== TURNSTILE_DUMMY_TOKEN) throw new HttpError(403, 'CAPTCHA_INVALID', 'Human verification failed.');
  const reporterId = anonymousRoute ? null : who.user?.id ?? null;
  if (!anonymousRoute && !reporterId) throw new HttpError(401, 'UNAUTHORIZED', 'Unauthorized');
  const reason = String(body.reason ?? '');
  let target = (body.target ?? {}) as Record<string, unknown>;
  if (target.type === 'url') {
    const resolved = resolveUrlTarget(String(target.url ?? ''));
    target = resolved.item ? { type: 'album-item', vanity: resolved.vanity, item: resolved.item } : resolved;
  }
  let kind: StoredReport['kind'];
  let fileTargetRow: StoredFile | undefined;
  let albumTargetRow: StoredAlbum | undefined;
  let userTarget: string | null = null;
  let domainTargetRow: StoredDomain | undefined;
  if (target.type === 'file' || target.type === 'album-item') {
    kind = 'file';
    if (target.type === 'album-item') {
      const album = [...albumStore.values()].find((each) => each.vanity === target.vanity && !each.deleted);
      const item = album ? albumItems(album).filter((each) => each.shown)[Number(target.item) - 1] : undefined;
      fileTargetRow = item?.file;
    } else {
      fileTargetRow = [...library.values()].find((each) => each.vanity === String(target.vanity) && isLive(each));
    }
    if (!fileTargetRow || (fileTargetRow.visibility === 'private' && fileTargetRow.owner !== who.key) || fileState(fileTargetRow) === 'blocked') {
      throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
    }
  } else if (target.type === 'album') {
    kind = 'album';
    albumTargetRow = [...albumStore.values()].find((each) => each.vanity === String(target.vanity) && !each.deleted);
    if (!albumTargetRow || (albumTargetRow.visibility === 'private' && albumTargetRow.owner !== who.key)) throw new HttpError(404, 'UNKNOWN_ALBUM', 'Unknown album.');
  } else if (target.type === 'user') {
    if (anonymousRoute) throw new HttpError(400, 'INVALID_REPORT_TARGET', 'Sign in to report an account.');
    kind = 'user';
    userTarget = String(target.id ?? '');
    if (!USERS.has(userTarget)) throw new HttpError(400, 'INVALID_REPORT_TARGET', 'Unknown account.');
  } else if (target.type === 'domain') {
    kind = 'domain';
    const hostname = String(target.hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
    domainTargetRow = [...domainStore.values()].find((each) => each.hostname === hostname && !each.deletedAt);
    if (!domainTargetRow) throw new HttpError(400, 'INVALID_REPORT_TARGET', 'That domain isn’t on files.gg.');
  } else if (target.type === 'bug') {
    kind = 'bug';
  } else {
    throw new HttpError(400, 'INVALID_REPORT_TARGET', 'Unknown report target.');
  }
  if (!REASONS_FOR[kind]!.includes(reason)) throw new HttpError(400, 'INVALID_REPORT_TARGET', 'That reason doesn’t apply to this target.');
  const ownerKey = fileTargetRow?.owner ?? albumTargetRow?.owner ?? (userTarget ? keyOfUser(userTarget) : domainTargetRow ? keyOfUser(domainTargetRow.userId) : null);
  if (ownerKey && ownerKey === who.key) throw new HttpError(400, 'CANNOT_REPORT_YOURSELF', 'You can’t report your own content.');
  const details = cleanText(body.details, 2000).trim();
  if (['other', 'bug', 'copyright'].includes(reason) && !details) {
    throw new HttpError(400, 'DETAILS_REQUIRED', 'Add some details.', { errors: { details: 'Tell us what’s wrong.' } });
  }
  if (reason === 'copyright') {
    const errors = missingFields(body.dmca, DMCA_FIELDS);
    if (Object.keys(errors).length) throw new HttpError(400, 'DMCA_FIELDS_REQUIRED', 'Fill in every field of the copyright notice.', { errors });
  }
  const key = reporterId ? `user:${reporterId}` : `fp:${who.fingerprint ?? 'none'}`;
  if (reason !== 'csam') rateLimit('report', key, 10, 'MAX_REPORTS', 'Too many reports. Try again later.');

  const targetId = fileTargetRow?.id ?? albumTargetRow?.id ?? userTarget ?? domainTargetRow?.id ?? null;
  const duplicate = [...reports.values()].find(
    (r) => r.status === 'open' && (r.fileId ?? r.albumId ?? r.userId ?? r.domainId) === targetId && targetId !== null && (reporterId ? r.reporterUserId === reporterId : r.fingerprint === who.fingerprint && !r.reporterUserId),
  );
  if (duplicate) {
    if (reporterId) {
      if (details) addMessage(duplicate, reporterId, false, details);
      return send(res, 200, { report: reportView(origin, duplicate, reporterId), duplicate: true, ...(duplicate.reason === 'csam' ? { escalated: true } : {}) });
    }
    return send(res, 200, { id: duplicate.id, status: 'open', ...(duplicate.reason === 'csam' ? { escalated: true } : {}) });
  }

  const caseKind: CaseKind = kind;
  const reportCase = caseFor(caseKind, targetId ?? 'pending', { childSafety: reason === 'csam' });
  const report = addReport({
    kind,
    fileId: fileTargetRow?.id ?? null,
    albumId: albumTargetRow?.id ?? null,
    userId: userTarget,
    domainId: domainTargetRow?.id ?? null,
    targetVanity: fileTargetRow?.vanity ?? albumTargetRow?.vanity ?? null,
    albumPart: kind === 'album' ? (String(target.part ?? 'whole') as StoredReport['albumPart']) : null,
    reason,
    reporterUserId: reporterId,
    fingerprint: reporterId ? null : who.fingerprint,
    contactEmail: reporterId ? null : (cleanText(body.contact_email, 254) || null),
    details,
    dmca: reason === 'copyright' ? (body.dmca as Record<string, unknown>) : null,
    caseId: reportCase.id,
  });
  if (kind === 'bug') reportCase.targetId = report.id;
  applyReportEffects(reportCase, report, fileTargetRow, albumTargetRow);
  const escalated = reason === 'csam' ? { escalated: true } : {};
  if (reporterId) return send(res, 201, { report: reportView(origin, report, reporterId), ...escalated });
  return send(res, 201, { id: report.id, status: 'open', ...escalated });
}

/** §7.4 step 5: hide or mark NSFW once enough distinct reporters agree. */
function applyReportEffects(c: StoredCase, report: StoredReport, file?: StoredFile, album?: StoredAlbum) {
  // milestone-6 §10.12: domain reports never act on their own.
  if (report.kind === 'user' || report.kind === 'bug' || report.kind === 'domain') return;
  const same = caseReports(c).filter((r) => r.status === 'open' && r.reason === report.reason);
  const threshold = REPORT_THRESHOLDS[report.reason];
  if (!threshold || distinctReporters(same) < threshold) return;
  if (report.reason === 'adult_unmarked' && file) {
    file.nsfwOverride = 'nsfw';
    file.nsfwOverrideSource = 'reports';
    const row = logAction(null, 'system', 'auto_nsfw', { rule: 'adult_unmarked', fileId: file.id, caseId: c.id });
    const ownerId = userIdOfKey(file.owner);
    if (ownerId) file.noticeId = createNotice(ownerId, row, 'auto_nsfw', 'adult_unmarked', fileTarget(file)).id;
    return;
  }
  if (report.reason === 'adult_unmarked' || report.reason === 'copyright' || report.reason === 'other') return;
  const csam = report.reason === 'csam';
  const hideFile = (target: StoredFile) => {
    if (target.moderation !== 'visible') return;
    Object.assign(target, { moderation: 'hidden', moderationRule: report.reason, moderationAuto: true });
    const row = logAction(null, 'system', 'auto_hide', { rule: report.reason, fileId: target.id, caseId: c.id, reportId: report.id, childSafety: csam });
    const ownerId = userIdOfKey(target.owner);
    if (ownerId && !csam) target.noticeId = createNotice(ownerId, row, 'auto_hide', report.reason, fileTarget(target)).id;
  };
  if (file) hideFile(file);
  if (album && album.moderation === 'visible') {
    Object.assign(album, { moderation: 'hidden', moderationRule: report.reason });
    const row = logAction(null, 'system', 'auto_hide', { rule: report.reason, albumId: album.id, caseId: c.id, reportId: report.id, childSafety: csam });
    const ownerId = userIdOfKey(album.owner);
    if (ownerId && !csam) album.noticeId = createNotice(ownerId, row, 'auto_hide', report.reason, albumTarget(album)).id;
    // §7.4 (chosen): a CSAM report on an album hides every item in it too.
    if (csam) for (const item of albumItems(album)) hideFile(item.file);
  }
}

// ---- Staff (§9) ----

/** Staff URLs (§10.3): `staff=<id>&expires=…&sig=…`, grant `staff:<staff id>:<file id>`, at most 10 minutes. */
export function signStaffUrl(url: string, staffId: string, fileId: string, expires: number): string {
  if (!/^https?:\/\//.test(url)) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('staff', staffId);
  parsed.searchParams.set('expires', String(expires));
  parsed.searchParams.set('sig', cdnSignature(parsed.pathname, expires, `staff:${staffId}:${fileId}`));
  return parsed.toString();
}

const STAFF_URL_TTL = 600;

/** Non-staff get the same 404 as an unknown route (§9.1). */
const unknownRoute = (method: string, path: string) => new HttpError(404, 'NOT_FOUND', `Mock API has no ${method} ${path}`);
const forbidden = () => new HttpError(403, 'FORBIDDEN', 'You don’t have permission to do that.');

const isAdmin = (user: Persona) => user.staff?.role === 'admin';
const hasChildSafety = (user: Persona) => Boolean(user.staff?.child_safety);

/** A file tied to a child-safety case: only child-safety staff may open its media (§9.1). */
const childSafetyFile = (file: StoredFile) => isCsamFile(file) || [...cases.values()].some((c) => c.childSafety && (c.targetId === file.id));

function canSeeCase(user: Persona, c: StoredCase) {
  return !c.childSafety || hasChildSafety(user);
}

function caseTarget(c: StoredCase) {
  const fileSummary = (file: StoredFile | undefined, type = 'file') =>
    file
      ? { type, id: file.id, vanity: file.vanity, name: `${file.name}${file.extension ? `.${file.extension}` : ''}`, state: file.deleted ? 'deleted' : fileState(file) }
      : { type, id: c.targetId, vanity: null, name: null, state: 'deleted' };
  switch (c.kind) {
    case 'file':
      return fileSummary(library.get(c.targetId));
    case 'hash':
      return fileSummary(library.get(c.targetId), 'hash');
    case 'album': {
      const album = albumStore.get(c.targetId);
      return { type: 'album', id: c.targetId, vanity: album?.vanity ?? null, name: album?.title || 'Untitled album', state: album?.deleted ? 'deleted' : album?.moderation === 'visible' ? 'ok' : album?.moderation ?? 'deleted' };
    }
    case 'user': {
      const user = USERS.get(c.targetId);
      const state = activeRestriction(c.targetId, 'suspended') ? 'suspended' : activeRestriction(c.targetId, 'uploads') ? 'restricted' : 'ok';
      return { type: 'user', id: c.targetId, vanity: null, name: user?.username ?? null, state };
    }
    case 'bug':
      return { type: 'bug', id: c.targetId, vanity: null, name: null, state: 'ok' };
    case 'domain': {
      const domain = domainStore.get(c.targetId);
      return { type: 'domain', id: c.targetId, vanity: null, name: domain?.hostname ?? null, state: domain ? (domain.deletedAt ? 'deleted' : domainStatus(domain)) : 'deleted' };
    }
    case 'appeal': {
      const notice = notices.get(c.targetId);
      if (notice?.target.kind === 'file') return fileSummary(library.get(notice.target.id));
      if (notice?.target.kind === 'album') return { type: 'album', id: notice.target.id, vanity: notice.target.vanity ?? null, name: notice.target.name ?? null, state: albumStore.get(notice.target.id)?.moderation ?? 'deleted' };
      if (notice?.target.kind === 'domain') {
        const domain = domainStore.get(notice.target.id);
        return { type: 'domain', id: notice.target.id, vanity: null, name: domain?.hostname ?? notice.target.hostname ?? null, state: domain ? domainStatus(domain) : 'deleted' };
      }
      return { type: 'user', id: notice?.userId ?? '', vanity: null, name: USERS.get(notice?.userId ?? '')?.username ?? null, state: 'ok' };
    }
  }
}

function caseSummary(c: StoredCase) {
  const open = caseReports(c).filter((r) => r.status === 'open');
  const reasons: Record<string, number> = {};
  for (const report of open) reasons[report.reason] = (reasons[report.reason] ?? 0) + 1;
  const assignee = c.assigneeId ? USERS.get(c.assigneeId) : undefined;
  return {
    id: c.id,
    kind: c.kind,
    priority: casePriority(c),
    status: c.status,
    target: caseTarget(c),
    reasons,
    report_count: open.length,
    distinct_reporters: distinctReporters(open),
    flags: c.flags.filter((flag) => flag.resolvedAt === null).map((flag) => flag.reason),
    assignee: assignee ? { id: assignee.id, username: assignee.username } : null,
    needs_second_review: c.needsSecondReview,
    child_safety: c.childSafety,
    created_at: c.createdAt,
    age_seconds: now() - c.createdAt,
  };
}

function auditPayload(row: AuditRow) {
  const actor = row.actorUserId ? USERS.get(row.actorUserId) : undefined;
  const target = row.fileId
    ? { type: 'file', id: row.fileId }
    : row.albumId
      ? { type: 'album', id: row.albumId }
      : row.userId
        ? { type: 'user', id: row.userId }
        : row.hashId
          ? { type: 'hash', id: row.hashId }
          : row.domainId
            ? { type: 'domain', id: row.domainId }
            : row.caseId
            ? { type: 'case', id: row.caseId }
            : null;
  return {
    id: row.id,
    actor: { id: row.actorUserId, username: actor?.username ?? null, kind: row.actorKind },
    action: row.action,
    rule: row.rule,
    target,
    case_id: row.caseId,
    report_id: row.reportId,
    warning_id: row.warningId,
    note: row.note,
    details: row.details,
    reverses_action_id: row.reversesActionId,
    created_at: row.createdAt,
  };
}

function staffUrlsFor(origin: string, user: Persona, file: StoredFile) {
  if (file.scanReason === 'csam_match') return undefined;
  if (childSafetyFile(file) && !hasChildSafety(user)) return undefined;
  const expires = now() + STAFF_URL_TTL;
  const previews = Object.fromEntries(Object.entries(file.assets).map(([kind, asset]) => [kind, signStaffUrl(abs(origin, asset.url), user.id, file.id, expires)]));
  logAction(user.id, 'staff', 'view_content', { fileId: file.id, details: { kinds: ['content', ...Object.keys(previews)] }, childSafety: childSafetyFile(file) });
  return { content: signStaffUrl(abs(origin, file.cdn), user.id, file.id, expires), previews, expires_at: expires };
}

/** The owner payload, stripped of every URL for hash-matched content (§3.6). */
function staffFilePayload(origin: string, file: StoredFile) {
  const payload = ownerFile(origin, file);
  if (file.scanReason !== 'csam_match') return payload;
  return { ...payload, cdn_url: '', assets: {}, thumbnail: null, hover_url: null };
}

function ownerOfKey(key: string) {
  const userId = userIdOfKey(key);
  const user = userId ? USERS.get(userId) : undefined;
  return user
    ? { user_id: user.id, username: user.username, fingerprint: null, account_created_at: user.createdAt, anonymous: false }
    : { user_id: null, username: null, fingerprint: key.startsWith('fp:') ? key.slice(3) : null, account_created_at: null, anonymous: true };
}

function staffReport(r: StoredReport) {
  const reporter = r.reporterUserId ? USERS.get(r.reporterUserId) : undefined;
  return {
    id: r.id,
    reason: r.reason,
    status: r.status,
    details: r.details,
    album_part: r.albumPart,
    dmca: r.dmca,
    created_at: r.createdAt,
    reporter: reporter
      ? { user_id: reporter.id, signed_in: true, account_age_days: Math.floor((now() - reporter.createdAt) / DAY) }
      : { signed_in: false },
    messages: reportMessages
      .filter((m) => m.reportId === r.id)
      .map((m) => ({ id: m.id, author: m.isStaff ? 'staff' : 'reporter', author_name: m.isStaff ? (USERS.get(m.authorUserId ?? '')?.username ?? null) : null, body: m.body, created_at: m.createdAt })),
  };
}

function adminFileDetail(origin: string, user: Persona, file: StoredFile) {
  const fileCases = [...cases.values()].filter((c) => (c.kind === 'file' || c.kind === 'hash') && c.targetId === file.id && canSeeCase(user, c));
  const findings = file.scanReason === 'csam_match' ? [] : file.findings;
  return {
    file: staffFilePayload(origin, file),
    owner: ownerOfKey(file.owner),
    deleted: file.deleted,
    moderation_state: file.moderation,
    moderation_rule: file.moderationRule,
    scan_state: file.scanState,
    scan: { findings, warnings: file.warnings, link_warnings: file.linkWarnings, cleared: [] },
    nsfw_score: file.nsfwScore,
    same_hash: { count: 1, ...(isAdmin(user) ? { ids: [file.id] } : {}) },
    albums: [...albumStore.values()].filter((album) => !album.deleted && album.items.some((item) => item.fileId === file.id)).map((album) => ({ id: album.id, vanity: album.vanity, title: album.title })),
    reports: [...reports.values()].filter((r) => r.fileId === file.id && canSeeCase(user, cases.get(r.caseId)!)).map(staffReport),
    cases: fileCases.map(caseSummary),
    actions: auditLog.filter((row) => (row.fileId === file.id || row.hashId === file.id) && (!row.childSafety || hasChildSafety(user))).map(auditPayload).reverse(),
    hash_matched: file.scanReason === 'csam_match',
    staff_urls: staffUrlsFor(origin, user, file),
  };
}

function adminAlbumDetail(origin: string, user: Persona, album: StoredAlbum) {
  return {
    album: {
      ...ownerAlbum(origin, album),
      items: albumItems(album).map((item, position) => ({
        ...staffFilePayload(origin, item.file),
        position,
        caption: item.caption,
        shown: item.shown,
        staff_urls: staffUrlsFor(origin, user, item.file),
      })),
    },
    owner: ownerOfKey(album.owner),
    deleted: album.deleted,
    moderation_state: album.moderation,
    moderation_rule: album.moderationRule,
    nsfw_marked: album.nsfw,
    nsfw_source: album.nsfwSource,
    reports: [...reports.values()].filter((r) => r.albumId === album.id && canSeeCase(user, cases.get(r.caseId)!)).map(staffReport),
    cases: [...cases.values()].filter((c) => c.kind === 'album' && c.targetId === album.id && canSeeCase(user, c)).map(caseSummary),
    actions: auditLog.filter((row) => row.albumId === album.id && (!row.childSafety || hasChildSafety(user))).map(auditPayload).reverse(),
  };
}

function adminUserDetail(origin: string, viewer: Persona, user: Persona) {
  const key = keyOfUser(user.id);
  const userNotices = [...notices.values()].filter((notice) => notice.userId === user.id);
  const strikeWindow = now() - 90 * DAY;
  const files = [...library.values()].filter((file) => file.owner === key && !file.deleted).sort((a, b) => b.createdMs - a.createdMs);
  return {
    user: { id: user.id, username: user.username, display_name: user.displayName, email: user.email, created_at: user.createdAt, verified: user.emailVerified, email_verified: user.emailVerified },
    staff: user.staff,
    restrictions: restrictionStore.filter((r) => r.userId === user.id).map((r) => ({ id: r.id, kind: r.kind, rule: r.rule, starts_at: r.startsAt, ends_at: r.endsAt, lifted_at: r.liftedAt, notice_id: r.noticeId })),
    warnings: {
      count: userNotices.length,
      strikes: userNotices.filter((notice) => notice.strike && notice.appealState !== 'granted' && notice.createdAt > strikeWindow).length,
      items: userNotices.map(noticePayload).reverse(),
    },
    counts: {
      files: files.length,
      albums: ownAlbums(key).length,
      reports_made: [...reports.values()].filter((r) => r.reporterUserId === user.id).length,
      reports_against: [...reports.values()].filter((r) => r.userId === user.id || library.get(r.fileId ?? '')?.owner === key || albumStore.get(r.albumId ?? '')?.owner === key).length,
    },
    files: files.slice(0, 50).map((file) => staffFilePayload(origin, file)),
    actions: auditLog.filter((row) => row.userId === user.id).map(auditPayload).reverse(),
    cases: [...cases.values()].filter((c) => c.kind === 'user' && c.targetId === user.id && canSeeCase(viewer, c)).map(caseSummary),
    // Milestone 6 (§9.3): never tokens, hashes or secrets.
    premium: premiumOf(user.id),
    entitlements: entitlementStore.filter((each) => each.userId === user.id).sort((a, b) => b.grantedAt - a.grantedAt || Number(BigInt(b.id) - BigInt(a.id))).map(entitlementPayload),
    identities: identityStore
      .filter((each) => each.userId === user.id)
      .map((each) => ({ provider: 'discord', provider_user_id: each.discordId, username: each.username, linked_at: each.createdAt })),
    sessions: { active: [...webSessions.values()].filter((each) => each.userId === user.id && sessionLive(each)).length },
    upload_keys: keyStore.filter((each) => each.userId === user.id).map(keyObject),
    domains: [...domainStore.values()].filter((each) => each.userId === user.id && !each.deletedAt).map(domainObject),
    deletion: deletionOf(user),
  };
}

function caseDetail(origin: string, user: Persona, c: StoredCase) {
  let targetDetail: unknown = null;
  let appeal: unknown = null;
  if (c.kind === 'file' || c.kind === 'hash') {
    const file = library.get(c.targetId);
    if (file) targetDetail = adminFileDetail(origin, user, file);
  } else if (c.kind === 'album') {
    const album = albumStore.get(c.targetId);
    if (album) targetDetail = adminAlbumDetail(origin, user, album);
  } else if (c.kind === 'user') {
    const target = USERS.get(c.targetId);
    if (target) targetDetail = adminUserDetail(origin, user, target);
  } else if (c.kind === 'domain') {
    const domain = domainStore.get(c.targetId);
    if (domain) targetDetail = adminDomainDetail(user, domain);
  } else if (c.kind === 'appeal') {
    const notice = notices.get(c.targetId)!;
    const original = auditLog.find((row) => row.id === notice.actionId);
    appeal = {
      notice: noticePayload(notice),
      user: { id: notice.userId, username: USERS.get(notice.userId)?.username ?? null },
      message: notice.appealMessage,
      counter_notice: notice.counterNotice,
      original_action: original ? auditPayload(original) : null,
    };
    if (notice.target.kind === 'file' && library.get(notice.target.id)) targetDetail = adminFileDetail(origin, user, library.get(notice.target.id)!);
    else if (notice.target.kind === 'album' && albumStore.get(notice.target.id)) targetDetail = adminAlbumDetail(origin, user, albumStore.get(notice.target.id)!);
    else if (notice.target.kind === 'domain' && domainStore.get(notice.target.id)) targetDetail = adminDomainDetail(user, domainStore.get(notice.target.id)!);
    else if (USERS.get(notice.userId)) targetDetail = adminUserDetail(origin, user, USERS.get(notice.userId)!);
  }
  const relevant = (row: AuditRow) =>
    row.caseId === c.id ||
    (c.kind === 'file' || c.kind === 'hash'
      ? row.fileId === c.targetId
      : c.kind === 'album'
        ? row.albumId === c.targetId
        : c.kind === 'user'
          ? row.userId === c.targetId
          : c.kind === 'domain'
            ? row.domainId === c.targetId
            : false);
  return {
    ...caseSummary(c),
    reports: caseReports(c).map(staffReport),
    flags: c.flags.map((flag) => ({ id: flag.id, source: flag.source, reason: flag.reason, details: flag.details, created_at: flag.createdAt, resolved_at: flag.resolvedAt })),
    actions: auditLog.filter((row) => relevant(row) && (!row.childSafety || hasChildSafety(user))).map(auditPayload).reverse(),
    target_detail: targetDetail,
    appeal,
    hash_matched: c.hashMatched,
    outcome: c.outcome,
    outcome_reason: c.outcomeReason,
    cybertip_report_id: c.cybertipReportId,
    cybertip_filed_at: c.cybertipFiledAt,
    claimed_at: c.claimedAt,
    closed_at: c.closedAt,
    updated_at: c.updatedAt,
  };
}

function adminSummary(user: Persona) {
  const visible = [...cases.values()].filter((c) => c.status === 'open' && canSeeCase(user, c));
  const byPriority = (p: number) => visible.filter((c) => casePriority(c) === p).length;
  const p0 = visible.filter((c) => casePriority(c) === 0);
  return {
    open: { p0: byPriority(0), p1: byPriority(1), p2: byPriority(2), p3: byPriority(3) },
    unassigned: visible.filter((c) => !c.assigneeId).length,
    mine: visible.filter((c) => c.assigneeId === user.id).length,
    past_goal: {
      p0: p0.filter((c) => now() - c.createdAt > DAY).length,
      other: visible.filter((c) => casePriority(c) > 0 && now() - c.createdAt > 7 * DAY).length,
    },
    appeals: visible.filter((c) => c.kind === 'appeal').length,
    bugs: visible.filter((c) => c.kind === 'bug').length,
    scans_stalled: [...library.values()].filter((file) => !file.deleted && file.scanState === 'pending' && Date.now() - file.createdMs > 600_000).length,
    cybertip_unrecorded: hasChildSafety(user) ? [...cases.values()].filter((c) => c.childSafety && c.hashMatched && !c.cybertipReportId).length : 0,
    newest_p0_at: p0.length ? Math.max(...p0.map((c) => c.createdAt)) : null,
  };
}

function badgesFor(user: Persona) {
  const mine = [...reports.values()].filter((r) => r.reporterUserId === user.id);
  return {
    reports_unread: mine.reduce((sum, r) => sum + reportView('', r, user.id).unread, 0),
    notices_unacknowledged: [...notices.values()].filter((notice) => notice.userId === user.id && notice.acknowledgedAt === null).length,
    restrictions: restrictionsOf(user.id),
    staff: user.staff
      ? (() => {
          const summary = adminSummary(user);
          const open = summary.open.p0 + summary.open.p1 + summary.open.p2 + summary.open.p3;
          return { open, p0: summary.open.p0, mine: summary.mine };
        })()
      : null,
  };
}

// ---- Admin actions (§9.3) ----

const RULE_REQUIRED = new Set(['hide', 'remove', 'delete', 'mark_nsfw', 'block_hash', 'restrict_uploads', 'suspend_user', 'confirm_csam', 'disable_domain', 'set_domain_scope', 'reset_username']);
const TARGETS: Record<string, string[]> = {
  hide: ['file', 'album'],
  unhide: ['file', 'album'],
  remove: ['file', 'album'],
  restore: ['file', 'album'],
  mark_nsfw: ['file', 'album'],
  unmark_nsfw: ['file', 'album'],
  delete: ['file', 'album'],
  block_hash: ['hash', 'file'],
  unblock_hash: ['hash', 'file'],
  clear_flag: ['hash', 'file'],
  confirm_csam: ['file', 'hash'],
  restrict_uploads: ['user'],
  unrestrict_uploads: ['user'],
  suspend_user: ['user'],
  unsuspend_user: ['user'],
  // Milestone 6 (§10.12, §11.4)
  disable_domain: ['domain'],
  enable_domain: ['domain'],
  set_domain_scope: ['domain'],
  revoke_sessions: ['user'],
  revoke_upload_keys: ['user'],
  reset_username: ['user'],
};

interface ActionInput {
  action: string;
  target: { type: string; id: string };
  rule: string | null;
  note: string | null;
  message: string | null;
  notify: boolean;
  caseId: string | null;
  duration: number | null;
  holdDays: number | null;
  alsoBlockHash: boolean;
  reversesActionId?: string | null;
  /** `revoke_upload_keys`: `{ key_id }` for one key. */
  details?: Record<string, unknown> | null;
}

function runAction(actor: Persona, input: ActionInput): { row: AuditRow; noticeIds: string[] } {
  const { action, target } = input;
  if (!TARGETS[action] || !TARGETS[action].includes(target.type)) throw new HttpError(400, 'INVALID_ACTION', 'That action doesn’t apply to this target.');
  if (RULE_REQUIRED.has(action) && (!input.rule || !RULES.includes(input.rule))) throw new HttpError(400, 'INVALID_ACTION', 'Pick a rule for this action.');
  if ((action === 'suspend_user' || action === 'unsuspend_user') && !isAdmin(actor)) throw forbidden();
  if (action === 'confirm_csam' && !hasChildSafety(actor)) throw forbidden();
  if (action === 'restrict_uploads' && input.duration !== null && input.duration > 30 * DAY && !isAdmin(actor)) throw forbidden();

  const file = target.type === 'file' || target.type === 'hash' ? library.get(target.id) : undefined;
  const album = target.type === 'album' ? albumStore.get(target.id) : undefined;
  const user = target.type === 'user' ? USERS.get(target.id) : undefined;
  const domain = target.type === 'domain' ? domainStore.get(target.id) : undefined;
  if (target.type === 'domain' && (!domain || domain.deletedAt)) throw new HttpError(404, 'UNKNOWN_DOMAIN', 'Unknown domain.');
  if ((target.type === 'file' || target.type === 'hash') && !file) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
  if (target.type === 'album' && !album) throw new HttpError(404, 'UNKNOWN_ALBUM', 'Unknown album.');
  if (target.type === 'user' && !user) throw new HttpError(404, 'UNKNOWN_USER', 'Unknown user.');
  if (file && childSafetyFile(file) && !hasChildSafety(actor)) throw forbidden();
  if (file && isCsamFile(file) && ['unblock_hash', 'clear_flag', 'unhide', 'restore'].includes(action) && file.scanReason === 'csam_match') {
    throw new HttpError(400, 'INVALID_ACTION', 'CSAM blocks can’t be lifted.');
  }

  const csam = action === 'confirm_csam' || input.rule === 'csam';
  const row = logAction(actor.id, 'staff', action, {
    rule: input.rule,
    fileId: file?.id ?? null,
    hashId: target.type === 'hash' ? target.id : null,
    albumId: album?.id ?? null,
    userId: user?.id ?? null,
    domainId: domain?.id ?? null,
    caseId: input.caseId,
    note: input.note,
    reversesActionId: input.reversesActionId ?? null,
    childSafety: csam || (file ? childSafetyFile(file) : false),
    details: {
      ...(input.duration ? { duration: input.duration } : {}),
      ...(action === 'delete' ? { hold_days: Math.min(365, input.holdDays ?? 90), also_block_hash: input.alsoBlockHash } : {}),
      ...(action === 'revoke_upload_keys' && input.details?.key_id ? { key_id: String(input.details.key_id) } : {}),
    },
  });
  const noticeIds: string[] = [];
  const notifyOwner = (ownerKey: string, noticeTarget: StoredNotice['target'], kind = action) => {
    const ownerId = userIdOfKey(ownerKey);
    if (!ownerId || !input.notify || csam || !NOTICE_META[kind]) return null;
    const notice = createNotice(ownerId, row, kind, input.rule ?? 'other', noticeTarget, input.message);
    noticeIds.push(notice.id);
    return notice.id;
  };

  if (file) {
    switch (action) {
      case 'hide':
      case 'remove':
        Object.assign(file, { moderation: action === 'hide' ? 'hidden' : 'removed', moderationRule: input.rule, moderationAuto: false });
        file.noticeId = notifyOwner(file.owner, fileTarget(file)) ?? file.noticeId;
        break;
      case 'unhide':
      case 'restore':
        Object.assign(file, { moderation: 'visible', moderationRule: null, moderationAuto: false });
        break;
      case 'mark_nsfw':
      case 'unmark_nsfw':
        Object.assign(file, { nsfwOverride: action === 'mark_nsfw' ? 'nsfw' : 'safe', nsfwOverrideSource: 'moderator' });
        if (file.nsfwReview === 'open') file.nsfwReview = 'done';
        if (action === 'mark_nsfw') file.noticeId = notifyOwner(file.owner, fileTarget(file)) ?? file.noticeId;
        break;
      case 'delete':
        notifyOwner(file.owner, fileTarget(file));
        deleteFile(file, 'moderator');
        if (input.alsoBlockHash) Object.assign(file, { scanState: 'blocked', scanReason: 'hash_list' });
        break;
      case 'block_hash':
        Object.assign(file, { scanState: 'blocked', scanReason: 'hash_list' });
        file.noticeId = notifyOwner(file.owner, fileTarget(file)) ?? file.noticeId;
        break;
      case 'unblock_hash':
      case 'clear_flag':
        if (action === 'clear_flag' && !['flagged', 'held'].includes(file.scanState)) throw new HttpError(400, 'INVALID_ACTION', 'This file has no open flag.');
        Object.assign(file, { scanState: 'passed', scanReason: null, findings: [] });
        for (const c of cases.values()) if (c.targetId === file.id) for (const flag of c.flags) flag.resolvedAt ??= now();
        break;
      case 'confirm_csam': {
        Object.assign(file, { scanState: 'blocked', scanReason: 'csam_match' });
        const hashCase = caseFor('hash', file.id, { basePriority: 0, childSafety: true, hashMatched: true });
        addFlag(hashCase, 'reports', 'csam_match', { source: 'staff' });
        const ownerId = userIdOfKey(file.owner);
        if (ownerId && !activeRestriction(ownerId, 'suspended')) {
          restrictionStore.push({ id: safetyId(), userId: ownerId, kind: 'suspended', rule: 'csam', actionId: row.id, startsAt: now(), endsAt: null, liftedAt: null, noticeId: null });
        }
        logAction(null, 'system', 'preserve_evidence', { hashId: file.id, caseId: hashCase.id, childSafety: true });
        break;
      }
    }
  } else if (album) {
    switch (action) {
      case 'hide':
      case 'remove':
        Object.assign(album, { moderation: action === 'hide' ? 'hidden' : 'removed', moderationRule: input.rule });
        album.noticeId = notifyOwner(album.owner, albumTarget(album)) ?? album.noticeId;
        break;
      case 'unhide':
      case 'restore':
        Object.assign(album, { moderation: 'visible', moderationRule: null });
        break;
      case 'mark_nsfw':
      case 'unmark_nsfw':
        Object.assign(album, { nsfw: action === 'mark_nsfw', nsfwSource: action === 'mark_nsfw' ? 'moderator' : null });
        if (action === 'mark_nsfw') notifyOwner(album.owner, albumTarget(album));
        break;
      case 'delete':
        notifyOwner(album.owner, albumTarget(album));
        album.deleted = true;
        break;
    }
  } else if (user) {
    const lift = (kind: 'uploads' | 'suspended') => {
      const active = activeRestriction(user.id, kind);
      if (!active) throw new HttpError(400, 'INVALID_ACTION', kind === 'uploads' ? 'Uploads aren’t restricted.' : 'This account isn’t suspended.');
      if (active.rule === 'csam') throw new HttpError(400, 'INVALID_ACTION', 'CSAM suspensions can’t be lifted.');
      active.liftedAt = now();
    };
    switch (action) {
      case 'restrict_uploads':
      case 'suspend_user': {
        const kind = action === 'restrict_uploads' ? 'uploads' : 'suspended';
        const duration = input.duration ?? (kind === 'uploads' ? 30 * DAY : null);
        const noticeId = notifyOwner(keyOfUser(user.id), { kind: 'account', id: user.id });
        restrictionStore.push({ id: safetyId(), userId: user.id, kind, rule: input.rule ?? 'other', actionId: row.id, startsAt: now(), endsAt: duration === null ? null : now() + duration, liftedAt: null, noticeId });
        break;
      }
      case 'unrestrict_uploads':
        lift('uploads');
        break;
      case 'unsuspend_user':
        lift('suspended');
        break;
      case 'revoke_sessions':
        revokeSessions(user.id, 'staff');
        break;
      case 'revoke_upload_keys': {
        const keyId = input.details?.key_id ? String(input.details.key_id) : null;
        const list = activeKeys(user.id).filter((each) => !keyId || each.id === keyId);
        if (keyId && list.length === 0) throw new HttpError(404, 'UNKNOWN_UPLOAD_KEY', 'Unknown upload key.');
        for (const each of list) Object.assign(each, { revokedAt: now(), revokedReason: 'staff' });
        notifyOwner(keyOfUser(user.id), { kind: 'account', id: user.id });
        break;
      }
      case 'reset_username': {
        holdUsername(user.username, user.id);
        Object.assign(user, { username: `u${user.id}`, needsUsername: true });
        notifyOwner(keyOfUser(user.id), { kind: 'account', id: user.id });
        break;
      }
    }
  } else if (domain) {
    const noticeTarget = { kind: 'domain' as const, id: domain.id, name: domain.hostname, hostname: domain.hostname };
    switch (action) {
      case 'disable_domain':
        if (domain.status === 'disabled') throw new HttpError(400, 'INVALID_ACTION', 'This domain is already disabled.');
        Object.assign(domain, { statusBeforeDisable: domain.status, status: 'disabled', disabledReason: input.rule, disabledActionId: row.id, isDefault: false });
        notifyOwner(keyOfUser(domain.userId), noticeTarget);
        break;
      case 'enable_domain':
        if (domain.status !== 'disabled') throw new HttpError(400, 'INVALID_ACTION', 'This domain isn’t disabled.');
        Object.assign(domain, { status: domain.statusBeforeDisable ?? 'pending_cert', disabledReason: null, disabledActionId: null, lastCheckedAt: now() });
        break;
      case 'set_domain_scope':
        if (domain.scope === 'own') throw new HttpError(400, 'INVALID_ACTION', 'This domain already shows only its owner’s files.');
        domain.scope = 'own';
        notifyOwner(keyOfUser(domain.userId), noticeTarget);
        break;
    }
  }
  return { row, noticeIds };
}

/** What granting an appeal runs (§8.2, §9.4). */
const REVERSAL: Record<string, string> = {
  hide: 'unhide',
  auto_hide: 'unhide',
  remove: 'restore',
  mark_nsfw: 'unmark_nsfw',
  auto_nsfw: 'unmark_nsfw',
  scan_block: 'unblock_hash',
  block_hash: 'unblock_hash',
  restrict_uploads: 'unrestrict_uploads',
  suspend_user: 'unsuspend_user',
};

function decideAppeal(actor: Persona, c: StoredCase, decision: string, message: string) {
  const notice = notices.get(c.targetId)!;
  const original = auditLog.find((row) => row.id === notice.actionId);
  // §9.4: not the moderator who acted, while another eligible staff member exists.
  const others = [...USERS.values()].filter((user) => user.staff && user.id !== actor.id && (notice.action !== 'suspend_user' || isAdmin(user)));
  if (original?.actorUserId === actor.id && others.length > 0) {
    throw new HttpError(409, 'SAME_MODERATOR', 'Another moderator has to decide this appeal, since you took the original action.');
  }
  if (decision !== 'grant' && decision !== 'deny') throw new HttpError(400, 'BAD_REQUEST', 'decision must be grant or deny.');
  if (decision === 'grant') {
    const reverse = REVERSAL[notice.action];
    if (reverse) {
      const type = notice.target.kind === 'account' ? 'user' : notice.target.kind === 'file' && reverse === 'unblock_hash' ? 'hash' : notice.target.kind;
      runAction(actor, {
        action: reverse,
        target: { type, id: notice.target.kind === 'account' ? notice.userId : notice.target.id },
        rule: notice.rule,
        note: 'Appeal granted.',
        message: null,
        notify: false,
        caseId: c.id,
        duration: null,
        holdDays: null,
        alsoBlockHash: false,
        reversesActionId: notice.actionId,
      });
    }
    notice.strike = false;
  }
  Object.assign(notice, { appealState: decision === 'grant' ? 'granted' : 'denied', appealReply: message || null, decidedAt: now() });
  logAction(actor.id, 'staff', decision === 'grant' ? 'appeal_granted' : 'appeal_denied', { caseId: c.id, warningId: notice.id, note: message || null });
  closeCase(c, decision === 'grant' ? 'actioned' : 'dismissed', message || decision);
}

const CANNED_CLOSE = {
  actioned: 'Thanks for your report. We’ve taken action.',
  dismissed: 'Thanks for your report. We looked into it and didn’t find anything that breaks our Terms.',
};

function cursorPage<T>(items: T[], query: URLSearchParams, max = 100) {
  const offset = Math.max(0, Number(query.get('cursor') ?? 0) || 0);
  const limit = Math.min(max, Math.max(1, Number(query.get('limit') ?? 50) || 50));
  const page = items.slice(offset, offset + limit);
  return { items: page, next_cursor: offset + limit < items.length ? String(offset + limit) : null };
}

/** Lookup (§9.6): a vanity, a files.gg or CDN URL, a user id, an exact email or a username. */
function lookup(origin: string, user: Persona, raw: string) {
  const q = raw.trim();
  if (!q) return { files: [], albums: [], users: [], domains: [] };
  let vanityQuery = q;
  let albumOnly = false;
  if (/^https?:\/\//.test(q)) {
    try {
      const resolved = resolveUrlTarget(q);
      vanityQuery = resolved.vanity;
      albumOnly = resolved.type === 'album';
    } catch {
      vanityQuery = '';
    }
  }
  const lower = vanityQuery.toLowerCase();
  const files = albumOnly
    ? []
    : [...library.values()]
        .filter((file) => file.vanity.toLowerCase() === lower || file.id === q || `${file.name}.${file.extension}`.toLowerCase().includes(lower))
        .filter((file) => !childSafetyFile(file) || hasChildSafety(user))
        .slice(0, 10)
        .map((file) => ({ ...staffFilePayload(origin, file), owner: ownerOfKey(file.owner), deleted: file.deleted }));
  const albums = [...albumStore.values()]
    .filter((album) => album.vanity.toLowerCase() === lower || album.id === q || (!albumOnly && album.title.toLowerCase().includes(lower)))
    .slice(0, 10)
    .map((album) => ({ ...albumSummary(origin, album), owner: ownerOfKey(album.owner), deleted: album.deleted }));
  const byKey = keyStore.find((each) => each.prefix === q)?.userId;
  const byDiscord = identityStore.find((each) => each.discordId === q)?.userId;
  const users = [...USERS.values()]
    .filter((each) => each.id === q || each.id === byKey || each.id === byDiscord || (each.email ?? '').toLowerCase() === q.toLowerCase() || each.username.toLowerCase() === q.toLowerCase())
    .slice(0, 10)
    .map((each) => ({ id: each.id, username: each.username, email: each.email, created_at: each.createdAt, staff: each.staff, restrictions: restrictionsOf(each.id) }));
  const host = q.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  const domains = [...domainStore.values()].filter((each) => !each.deletedAt && host && each.hostname === host).map((each) => adminDomainSummary(each));
  return { files: lower ? files : [], albums: lower ? albums : [], users, domains };
}

// ---- Routes: badges, reports, notices (§7, §8) and admin (§9) ----

async function safetyRoute(req: IncomingMessage, res: ServerResponse, path: string, origin: string, query: URLSearchParams, who: Caller): Promise<boolean> {
  const method = req.method ?? 'GET';
  let match: RegExpExecArray | null;
  const signedIn = () => {
    if (!who.user) throw new HttpError(401, 'UNAUTHORIZED', 'Unauthorized');
    return who.user;
  };

  if (method === 'POST' && (path === '/reports' || path === '/reports/anonymous')) {
    await submitReport(req, res, origin, who, path === '/reports/anonymous');
    return true;
  }
  if (method === 'GET' && path === '/users/@me/badges') {
    send(res, 200, badgesFor(signedIn()));
    return true;
  }

  // ---- My reports (§7.6) ----
  if (method === 'GET' && path === '/users/@me/reports') {
    const user = signedIn();
    const status = query.get('status');
    const text = (query.get('query') ?? '').toLowerCase();
    const list = [...reports.values()]
      .filter((r) => r.reporterUserId === user.id)
      .filter((r) => !status || r.status === status)
      .map((r) => reportView(origin, r, user.id))
      .filter((r) => !text || `${r.target.vanity ?? ''} ${r.target.url ?? ''}`.toLowerCase().includes(text))
      .sort((a, b) => b.created_at - a.created_at);
    const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 25) || 25));
    send(res, 200, { count: list.length, items: list.slice(offset, offset + limit) });
    return true;
  }
  if ((match = /^\/users\/@me\/reports\/([^/]+)(\/messages)?$/.exec(path))) {
    const user = signedIn();
    const report = ownReport(user.id, match[1]!);
    if (match[2]) {
      if (method === 'GET') {
        const items = reportMessages
          .filter((m) => m.reportId === report.id)
          .map((m) => ({ id: m.id, author: m.isStaff ? 'staff' : 'you', body: m.body, created_at: m.createdAt }));
        reportReads.set(`${report.id}:${user.id}`, now());
        send(res, 200, { items });
        return true;
      }
      if (method === 'POST') {
        if (reportClosed(report)) throw new HttpError(409, 'REPORT_CLOSED', 'This report is closed.');
        const body = cleanText((await readJson(req)).body, 2000).trim();
        if (!body) throw new HttpError(400, 'BAD_REQUEST', 'Write a message first.');
        rateLimit('report_message', `user:${user.id}`, 30, 'MAX_MESSAGES', 'Too many messages. Try again later.');
        const message = addMessage(report, user.id, false, body);
        reportReads.set(`${report.id}:${user.id}`, now());
        send(res, 201, { id: message.id, author: 'you', body: message.body, created_at: message.createdAt });
        return true;
      }
    } else {
      if (method === 'GET') {
        send(res, 200, reportView(origin, report, user.id));
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        const view = reportView(origin, report, user.id);
        if (body.status !== 'open' || !view.can_reopen) throw new HttpError(409, 'REOPEN_NOT_ALLOWED', 'This report can’t be reopened.');
        Object.assign(report, { status: 'open', reopenCount: report.reopenCount + 1, updatedAt: now() });
        // It rejoins (or reopens) the target's case.
        const targetId = report.fileId ?? report.albumId ?? report.userId ?? report.domainId ?? report.id;
        report.caseId = caseFor(report.kind, targetId).id;
        reportReads.set(`${report.id}:${user.id}`, now());
        send(res, 200, reportView(origin, report, user.id));
        return true;
      }
    }
  }

  // ---- Notices and appeals (§8.2) ----
  if (method === 'GET' && path === '/users/@me/warnings') {
    const user = signedIn();
    const all = [...notices.values()].filter((notice) => notice.userId === user.id).sort((a, b) => b.createdAt - a.createdAt);
    const list = query.get('unacknowledged') === 'true' ? all.filter((notice) => notice.acknowledgedAt === null) : all;
    const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 25) || 25));
    send(res, 200, { count: list.length, unacknowledged: all.filter((notice) => notice.acknowledgedAt === null).length, items: list.slice(offset, offset + limit).map(noticePayload) });
    return true;
  }
  if (method === 'POST' && path === '/users/@me/warnings/acknowledge') {
    const user = signedIn();
    const ids = idList((await readJson(req)).ids, 100);
    const acknowledged = ids.filter((id) => {
      const notice = notices.get(id);
      if (!notice || notice.userId !== user.id) return false;
      notice.acknowledgedAt ??= now();
      return true;
    });
    send(res, 200, { acknowledged });
    return true;
  }
  if (method === 'POST' && (match = /^\/users\/@me\/warnings\/([^/]+)\/appeal$/.exec(path))) {
    const user = signedIn();
    const notice = notices.get(match[1]!);
    if (!notice || notice.userId !== user.id) throw new HttpError(404, 'UNKNOWN_WARNING', 'Unknown notice.');
    if (!notice.appealable || notice.appealState !== 'none') throw new HttpError(409, 'APPEAL_NOT_ALLOWED', 'This notice can’t be appealed.');
    const body = await readJson(req);
    const message = cleanText(body.message, 2000).trim();
    if (!message) throw new HttpError(400, 'BAD_REQUEST', 'Explain why you’re appealing.', { errors: { message: 'Explain why you’re appealing.' } });
    if (notice.rule === 'copyright') {
      const errors = missingFields(body.counter_notice, COUNTER_FIELDS);
      if (Object.keys(errors).length) throw new HttpError(400, 'DMCA_FIELDS_REQUIRED', 'Fill in every field of the counter-notice.', { errors });
      notice.counterNotice = body.counter_notice as Record<string, unknown>;
    }
    Object.assign(notice, { appealState: 'open', appealMessage: message, appealedAt: now(), acknowledgedAt: notice.acknowledgedAt ?? now() });
    caseFor('appeal', notice.id, { basePriority: 2, needsSecondReview: true });
    send(res, 200, noticePayload(notice));
    return true;
  }

  // ---- Admin (§9): non-staff get the same 404 as an unknown route ----
  if (!path.startsWith('/admin/')) return false;
  const staff = who.user?.staff ? who.user : null;
  if (!staff) throw unknownRoute(method, path);
  const adminOnly = () => {
    if (!isAdmin(staff)) throw forbidden();
  };
  const visibleCase = (id: string) => {
    const c = cases.get(id);
    if (!c || !canSeeCase(staff, c)) throw new HttpError(404, 'UNKNOWN_CASE', 'Unknown case.');
    return c;
  };

  if (await accountAdminRoute(req, res, path, query, staff)) return true;
  if (method === 'GET' && path === '/admin/summary') {
    send(res, 200, adminSummary(staff));
    return true;
  }
  if (method === 'GET' && path === '/admin/cases') {
    const status = query.get('status') ?? 'open';
    const priority = query.get('priority');
    const reason = query.get('reason');
    const kind = query.get('kind');
    const assignee = query.get('assignee');
    const second = query.get('needs_second_review');
    const list = [...cases.values()]
      .filter((c) => canSeeCase(staff, c))
      .filter((c) => status === 'all' || c.status === status)
      .filter((c) => priority === null || casePriority(c) === Number(priority))
      .filter((c) => !kind || c.kind === kind)
      .filter((c) => !reason || caseReports(c).some((r) => r.reason === reason) || c.flags.some((flag) => flag.reason === reason))
      .filter((c) => !assignee || (assignee === 'me' ? c.assigneeId === staff.id : assignee === 'none' ? !c.assigneeId : c.assigneeId === assignee))
      .filter((c) => second === null || c.needsSecondReview === (second === 'true'))
      .sort((a, b) => casePriority(a) - casePriority(b) || a.createdAt - b.createdAt);
    const page = cursorPage(list, query);
    send(res, 200, { items: page.items.map(caseSummary), next_cursor: page.next_cursor });
    return true;
  }
  if ((match = /^\/admin\/cases\/([^/]+)(?:\/(claim|release|messages|close|appeal|cybertip))?$/.exec(path))) {
    const c = visibleCase(match[1]!);
    const sub = match[2];
    if (!sub && method === 'GET') {
      send(res, 200, caseDetail(origin, staff, c));
      return true;
    }
    if (!sub && method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.needs_second_review === 'boolean') c.needsSecondReview = body.needs_second_review;
      c.updatedAt = now();
      logAction(staff.id, 'staff', 'flag_second_review', { caseId: c.id, details: { needs_second_review: c.needsSecondReview } });
      send(res, 200, caseDetail(origin, staff, c));
      return true;
    }
    if (method !== 'POST') return false;
    const body = await readJson(req);
    if (sub === 'claim') {
      if (c.assigneeId && c.assigneeId !== staff.id && !(body.force === true && isAdmin(staff))) {
        throw new HttpError(409, 'CASE_CLAIMED', 'Someone else is working on this case.', { assignee_id: c.assigneeId });
      }
      Object.assign(c, { assigneeId: staff.id, claimedAt: now(), updatedAt: now() });
      logAction(staff.id, 'staff', 'claim', { caseId: c.id, details: body.force ? { force: true } : null });
    } else if (sub === 'release') {
      Object.assign(c, { assigneeId: null, claimedAt: null, updatedAt: now() });
      logAction(staff.id, 'staff', 'release', { caseId: c.id });
    } else if (sub === 'messages') {
      const report = reports.get(String(body.report_id ?? ''));
      if (!report || report.caseId !== c.id) throw new HttpError(404, 'UNKNOWN_REPORT', 'Unknown report.');
      const text = cleanText(body.body, 2000).trim();
      if (!text) throw new HttpError(400, 'BAD_REQUEST', 'Write a message first.');
      const message = addMessage(report, staff.id, true, text);
      logAction(staff.id, 'staff', 'staff_message', { caseId: c.id, reportId: report.id });
      send(res, 201, { id: message.id, author: 'staff', author_name: staff.username, body: message.body, created_at: message.createdAt });
      return true;
    } else if (sub === 'close') {
      const outcome = body.outcome === 'actioned' ? 'actioned' : body.outcome === 'dismissed' ? 'dismissed' : null;
      if (!outcome) throw new HttpError(400, 'BAD_REQUEST', 'outcome must be actioned or dismissed.');
      if (c.status === 'closed') throw new HttpError(409, 'BAD_REQUEST', 'This case is already closed.');
      const reporterMessage = cleanText(body.reporter_message, 2000).trim() || CANNED_CLOSE[outcome];
      for (const report of caseReports(c).filter((r) => r.status === 'open')) {
        if (outcome === 'actioned') resolve(report);
        else dismiss(report);
        if (report.reporterUserId && report.reason !== 'csam') addMessage(report, staff.id, true, reporterMessage);
      }
      closeCase(c, outcome, cleanText(body.reason, 2000));
      logAction(staff.id, 'staff', 'close_case', { caseId: c.id, note: cleanText(body.reason, 2000) || null, details: { outcome } });
    } else if (sub === 'appeal') {
      if (c.kind !== 'appeal' || c.status !== 'open') throw new HttpError(400, 'INVALID_ACTION', 'This isn’t an open appeal.');
      decideAppeal(staff, c, String(body.decision ?? ''), cleanText(body.message, 2000).trim());
    } else if (sub === 'cybertip') {
      if (!hasChildSafety(staff)) throw forbidden();
      if (!c.childSafety) throw new HttpError(400, 'INVALID_ACTION', 'Only child-safety cases have CyberTipline reports.');
      const reportId = cleanText(body.report_id, 100).trim();
      if (!reportId) throw new HttpError(400, 'BAD_REQUEST', 'Enter the CyberTipline report number.');
      Object.assign(c, { cybertipReportId: reportId, cybertipFiledAt: now(), updatedAt: now() });
      logAction(staff.id, 'staff', 'cybertip_filed', { caseId: c.id, details: { report_id: reportId }, childSafety: true });
    }
    send(res, 200, caseDetail(origin, staff, c));
    return true;
  }
  if (method === 'POST' && path === '/admin/actions') {
    const body = await readJson(req);
    const target = (body.target ?? {}) as { type?: string; id?: string };
    const caseId = body.case_id ? String(body.case_id) : null;
    if (caseId) visibleCase(caseId);
    const { row, noticeIds } = runAction(staff, {
      action: String(body.action ?? ''),
      target: { type: String(target.type ?? ''), id: String(target.id ?? '') },
      rule: body.rule ? String(body.rule) : null,
      note: body.note ? cleanText(body.note, 2000) : null,
      message: body.message ? cleanText(body.message, 2000) : null,
      notify: body.notify !== false,
      caseId,
      duration: typeof body.duration === 'number' ? body.duration : null,
      holdDays: typeof body.hold_days === 'number' ? body.hold_days : null,
      alsoBlockHash: body.also_block_hash === true,
      details: typeof body.details === 'object' && body.details !== null ? (body.details as Record<string, unknown>) : null,
    });
    send(res, 200, { action: auditPayload(row), notice_ids: noticeIds });
    return true;
  }
  if (path === '/admin/bans' && method === 'POST') {
    const body = await readJson(req);
    const kind = body.kind === 'ip' ? 'ip' : body.kind === 'fingerprint' ? 'fingerprint' : null;
    if (!kind) throw new HttpError(400, 'INVALID_ACTION', 'kind must be fingerprint or ip.');
    if (!body.rule || !RULES.includes(String(body.rule))) throw new HttpError(400, 'INVALID_ACTION', 'Pick a rule for this ban.');
    const duration = typeof body.duration === 'number' ? body.duration : null;
    if ((duration === null || duration > 30 * DAY) && !isAdmin(staff)) throw forbidden();
    const from = (body.from ?? {}) as Record<string, string>;
    let value: string | null = null;
    let createdMs = Date.now();
    if (from.file_id) {
      const file = library.get(from.file_id);
      if (!file) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
      createdMs = file.createdMs;
      value = kind === 'fingerprint' ? (file.owner.startsWith('fp:') ? file.owner : null) : `ip:file:${file.id}`;
    } else if (from.report_id) {
      const report = reports.get(from.report_id);
      if (!report) throw new HttpError(404, 'UNKNOWN_REPORT', 'Unknown report.');
      createdMs = report.createdAt * 1000;
      value = kind === 'fingerprint' ? (report.fingerprint ? `fp:${report.fingerprint}` : null) : `ip:report:${report.id}`;
    } else if (from.fingerprint && kind === 'fingerprint') {
      value = `fp:${from.fingerprint}`;
    }
    if (!value) throw new HttpError(400, 'INVALID_ACTION', kind === 'fingerprint' ? 'That source has no fingerprint.' : 'That source has no IP hash.');
    if (kind === 'ip' && Date.now() - createdMs > 30 * DAY * 1000) throw new HttpError(400, 'INVALID_ACTION', 'The IP hash for that source is older than 30 days and was deleted.');
    const row = logAction(staff.id, 'staff', 'ban', { rule: String(body.rule), note: body.note ? cleanText(body.note, 2000) : null, details: { kind, from, duration } });
    const ban: StoredBan = { id: safetyId(), kind, source: from, value, rule: String(body.rule), note: body.note ? cleanText(body.note, 2000) : null, actionId: row.id, createdAt: now(), expiresAt: duration === null ? null : now() + duration, liftedAt: null };
    banStore.push(ban);
    send(res, 201, banPayload(ban));
    return true;
  }
  if (path === '/admin/bans' && method === 'GET') {
    const active = query.get('active') !== 'false';
    const list = banStore.filter((ban) => !active || (ban.liftedAt === null && (ban.expiresAt === null || ban.expiresAt > now()))).reverse();
    const page = cursorPage(list, query);
    send(res, 200, { items: page.items.map(banPayload), next_cursor: page.next_cursor });
    return true;
  }
  if (method === 'DELETE' && (match = /^\/admin\/bans\/([^/]+)$/.exec(path))) {
    adminOnly();
    const ban = banStore.find((each) => each.id === match![1]);
    if (!ban) throw new HttpError(404, 'NOT_FOUND', 'Unknown ban.');
    ban.liftedAt ??= now();
    logAction(staff.id, 'staff', 'unban', { reversesActionId: ban.actionId });
    send(res, 200, banPayload(ban));
    return true;
  }
  if (method === 'GET' && path === '/admin/audit') {
    const filters = ['actor_id', 'action', 'file_id', 'album_id', 'user_id', 'case_id'] as const;
    // §9.5: moderators only see the rows of a case or target they open.
    if (!isAdmin(staff) && !['case_id', 'file_id', 'album_id', 'user_id'].some((name) => query.get(name))) throw forbidden();
    const column: Record<(typeof filters)[number], keyof AuditRow> = { actor_id: 'actorUserId', action: 'action', file_id: 'fileId', album_id: 'albumId', user_id: 'userId', case_id: 'caseId' };
    const rows = auditLog
      .filter((row) => !row.childSafety || hasChildSafety(staff))
      .filter((row) => filters.every((name) => !query.get(name) || String(row[column[name]]) === query.get(name)))
      .slice()
      .reverse();
    const page = cursorPage(rows, query);
    send(res, 200, { items: page.items.map(auditPayload), next_cursor: page.next_cursor });
    return true;
  }
  if (method === 'GET' && path === '/admin/lookup') {
    send(res, 200, lookup(origin, staff, query.get('q') ?? ''));
    return true;
  }
  if (method === 'GET' && (match = /^\/admin\/(files|albums|users)\/([^/]+)$/.exec(path))) {
    const id = match[2]!;
    if (match[1] === 'files') {
      const file = library.get(id);
      if (!file || (childSafetyFile(file) && !hasChildSafety(staff))) throw new HttpError(404, 'UNKNOWN_FILE', 'Unknown file.');
      send(res, 200, adminFileDetail(origin, staff, file));
    } else if (match[1] === 'albums') {
      const album = albumStore.get(id);
      if (!album) throw new HttpError(404, 'UNKNOWN_ALBUM', 'Unknown album.');
      send(res, 200, adminAlbumDetail(origin, staff, album));
    } else {
      const user = USERS.get(id);
      if (!user) throw new HttpError(404, 'UNKNOWN_USER', 'Unknown user.');
      send(res, 200, adminUserDetail(origin, staff, user));
    }
    return true;
  }
  if (method === 'POST' && path === '/admin/rescans') {
    adminOnly();
    const body = await readJson(req);
    const checks = Array.isArray(body.checks) ? body.checks.map(String) : [];
    if (checks.length === 0) throw new HttpError(400, 'BAD_REQUEST', 'Pick at least one check.');
    const kinds = Array.isArray(body.kinds) ? body.kinds.map(String) : null;
    const after = typeof body.uploaded_after === 'number' ? body.uploaded_after : null;
    const queued = [...library.values()].filter((file) => !file.deleted && (!kinds || kinds.includes(file.kind)) && (after === null || file.createdMs / 1000 >= after)).length;
    logAction(staff.id, 'staff', 'rescan', { details: { checks, kinds, uploaded_after: after, queued } });
    send(res, 202, { queued });
    return true;
  }
  if (method === 'GET' && path === '/admin/staff') {
    adminOnly();
    const items = [...USERS.values()]
      .filter((user) => user.staff)
      .map((user) => ({ user_id: user.id, username: user.username, role: user.staff!.role, child_safety: user.staff!.child_safety, granted_at: user.createdAt + DAY }));
    send(res, 200, { items });
    return true;
  }
  throw unknownRoute(method, path);
}

// ===========================================================================
// Milestone 6: accounts (docs/redesign/contracts/milestone-6.md)
// ===========================================================================

/** The contract's test `SECRET_KEY` (§16.3): signs OAuth `state`, sign-up tokens and mock Discord codes. */
const SECRET_KEY = 'test-secret-key';
/** §3.2: the plain-http dev name (`SESSION_COOKIE_INSECURE`). */
export const SESSION_COOKIE = 'filesgg_session';
const SESSION_IDLE = 30 * DAY;
const SESSION_MAX = 180 * DAY;
const SESSIONS_MAX = 50;
const REAUTH_SECONDS = 600;
const USERNAME_COOLDOWN = 30 * DAY;
const USERNAME_HOLD = 30 * DAY;
const DELETION_GRACE = 14 * DAY;
const UPLOAD_KEYS_MAX = 20;
const PREMIUM_CUSTOM_DOMAINS = 5;
const AUTH_REQUEST_MAX_BYTES = 65536;
const API_PUBLIC_URL = 'https://api.files.gg';
const CUSTOM_DOMAIN_TARGET = 'domains.files.gg';
const DOMAIN_PENDING_HOURS = 72;
const EXPORT_KEEP = 7 * DAY;
const EXPORT_READY_AFTER = 3;
const KEY_EXPIRIES = new Set([30 * DAY, 90 * DAY, 365 * DAY]);

// ---- Tokens (§7.1) ----

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** zlib's CRC-32 (IEEE) of an ASCII string, unsigned. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) crc = CRC_TABLE[(crc ^ text.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function base62(value: number, width: number): string {
  let out = '';
  let n = value;
  do {
    out = BASE62[n % 62] + out;
    n = Math.floor(n / 62);
  } while (n > 0);
  return out.padStart(width, '0');
}

/** `fgg_` (upload key) or `fgs_` (session) + 30 random base62 + the 6-character checksum. */
export function makeToken(prefix: 'fgg_' | 'fgs_'): string {
  const random = Array.from({ length: 30 }, () => BASE62[randomInt(62)]).join('');
  return `${prefix}${random}${base62(crc32(prefix + random), 6)}`;
}

/** Format and checksum only (§7.1): a typo never reaches the store. */
export function tokenValid(token: string, prefix?: 'fgg_' | 'fgs_'): boolean {
  if (!/^fg[gs]_[0-9A-Za-z]{36}$/.test(token)) return false;
  if (prefix && !token.startsWith(prefix)) return false;
  return base62(crc32(token.slice(0, 34)), 6) === token.slice(34);
}

// ---- Signed, labelled tokens (§5.4) ----

export function signLabelled(claims: Record<string, unknown>, label: string, secret = SECRET_KEY): string {
  const sorted = Object.fromEntries(Object.keys(claims).sort().map((key) => [key, claims[key]]));
  const body = b64url(JSON.stringify(sorted));
  return `${body}.${createHmac('sha256', secret).update(`${label}\n${body}`).digest('base64url')}`;
}

export function verifyLabelled(token: string, label: string, secret = SECRET_KEY, at = now()): Record<string, unknown> | null {
  const [body, signature, extra] = String(token).split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(`${label}\n${body}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof claims.e === 'number' && claims.e > at ? claims : null;
  } catch {
    return null;
  }
}

/** §5.2: `base64url_nopad(SHA-256(verifier))`. */
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

// ---- Small helpers ----

const ipOf = (req: IncomingMessage) => String(req.headers['cf-connecting-ip'] ?? req.socket?.remoteAddress ?? 'ip');
const validEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const sameEmail = (a: string | null, b: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const escapeHtml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const bad = (code: string, message: string, details: Record<string, unknown> = {}, status = 400) => new HttpError(status, code, message, details);
const invalid = (field: string, message: string) => bad('INVALID_PARAMETERS', message, { errors: { [field]: message } });

/** Failure-only counters (login, re-auth): 1-hour windows. */
const failureBuckets = new Map<string, number[]>();
function checkFailures(bucket: string, max: number) {
  const recent = (failureBuckets.get(bucket) ?? []).filter((at) => at > Date.now() - 3600_000);
  failureBuckets.set(bucket, recent);
  if (recent.length >= max) throw bad('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.', { retry_after: Math.ceil((recent[0]! + 3600_000 - Date.now()) / 1000) }, 429);
}
const countFailure = (bucket: string) => failureBuckets.set(bucket, [...(failureBuckets.get(bucket) ?? []), Date.now()]);

function requireTurnstile(body: Record<string, unknown>) {
  if (body.turnstile_token !== TURNSTILE_DUMMY_TOKEN) throw bad('CAPTCHA_INVALID', 'Human verification failed.', {}, 403);
}

/** §4.8: the auth and password endpoints take at most 64 KiB. */
async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body: Buffer;
  try {
    body = await readBody(req, AUTH_REQUEST_MAX_BYTES);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'FILE_TOO_LARGE') throw bad('REQUEST_TOO_LARGE', 'This request is too large.', { limit: AUTH_REQUEST_MAX_BYTES }, 413);
    throw error;
  }
  try {
    return body.length ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {};
  } catch {
    throw bad('BAD_REQUEST', 'Invalid JSON.');
  }
}

// ---- Stores ----

interface WebSession {
  id: string;
  token: string;
  userId: string;
  method: 'password' | 'discord' | 'register' | 'reset';
  createdAt: number;
  authenticatedAt: number;
  lastUsedAt: number;
  expiresAt: number;
  maxExpiresAt: number;
  userAgent: string | null;
  country: string | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

interface StoredIdentity {
  userId: string;
  discordId: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

interface StoredKey {
  id: string;
  userId: string;
  name: string;
  secret: string;
  prefix: string;
  scopes: string[];
  domainId: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

type DomainStatus = 'pending_dns' | 'pending_cert' | 'active' | 'failing' | 'failed' | 'paused' | 'disabled';

interface StoredDomain {
  id: string;
  userId: string;
  hostname: string;
  status: DomainStatus;
  statusReason: string | null;
  /** A domain added in this dev session: its status moves on by itself (§10.3, sped up). */
  auto: boolean;
  createdAt: number;
  verifiedAt: number | null;
  lastCheckedAt: number | null;
  failingSince: number | null;
  disabledReason: string | null;
  disabledActionId: string | null;
  statusBeforeDisable: DomainStatus | null;
  isDefault: boolean;
  scope: 'own' | 'any';
  verifyToken: string;
  cfHostnameId: string | null;
  deletedAt: number | null;
}

interface StoredEntitlement {
  id: string;
  userId: string;
  kind: 'premium';
  grantedBy: string | null;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  note: string | null;
}

interface StoredExport {
  id: string;
  userId: string;
  createdAt: number;
}

interface EmailToken {
  token: string;
  purpose: 'verify_email' | 'reset_password';
  userId: string;
  email: string;
  expiresAt: number;
  usedAt: number | null;
}

const webSessions = new Map<string, WebSession>();
const identityStore: StoredIdentity[] = [
  { userId: '42', discordId: '80351110224678912', username: 'mockuser', displayName: 'Mock User', avatar: 'a_1b2c3d4e5f', createdAt: now() - 300 * DAY, lastUsedAt: now() - 2 * DAY },
  { userId: '50', discordId: '80351110224678913', username: 'discordonly', displayName: null, avatar: null, createdAt: now() - 20 * DAY, lastUsedAt: now() - DAY },
];
const keyStore: StoredKey[] = [];
const domainStore = new Map<string, StoredDomain>();
const entitlementStore: StoredEntitlement[] = [];
const exportStore: StoredExport[] = [];
const emailTokens: EmailToken[] = [];
const usernameHolds = new Map<string, { userId: string; heldUntil: number }>();
const domainChecks = new Map<string, number>();
const domainAdds = new Map<string, number[]>();

// ---- Sessions (§3) ----

function sessionToken(req: IncomingMessage): string | null {
  const header = String(req.headers.cookie ?? '');
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

const sessionLive = (session: WebSession) =>
  session.revokedAt === null && session.expiresAt > now() && session.maxExpiresAt > now() && USERS.has(session.userId);

function liveSession(token: string | null): WebSession | null {
  if (!token || !tokenValid(token, 'fgs_')) return null;
  const session = webSessions.get(token);
  if (!session || !sessionLive(session)) return null;
  if (now() - session.lastUsedAt > 600) {
    session.lastUsedAt = now();
    session.expiresAt = Math.min(now() + SESSION_IDLE, session.maxExpiresAt);
  }
  return session;
}

function createSession(userId: string, method: WebSession['method'], req: IncomingMessage | null): WebSession {
  const active = [...webSessions.values()].filter((each) => each.userId === userId && sessionLive(each)).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  for (const oldest of active.slice(0, Math.max(0, active.length - SESSIONS_MAX + 1))) Object.assign(oldest, { revokedAt: now(), revokedReason: 'limit' });
  const at = now();
  const session: WebSession = {
    id: nextId(),
    token: makeToken('fgs_'),
    userId,
    method,
    createdAt: at,
    authenticatedAt: at,
    lastUsedAt: at,
    expiresAt: at + SESSION_IDLE,
    maxExpiresAt: at + SESSION_MAX,
    userAgent: req ? String(req.headers['user-agent'] ?? '').slice(0, 256) || null : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/140.0',
    country: req ? (String(req.headers['cf-ipcountry'] ?? '') || 'GB').slice(0, 2) : 'GB',
    revokedAt: null,
    revokedReason: null,
  };
  webSessions.set(session.token, session);
  return session;
}

const setSessionCookie = (res: ServerResponse, session: WebSession) =>
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${session.maxExpiresAt - now()}`);
const clearSessionCookie = (res: ServerResponse) => res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

/** Ends every live session of the account except `keep`; returns how many. */
function revokeSessions(userId: string, reason: string, keep: WebSession | null = null): number {
  let count = 0;
  for (const session of webSessions.values()) {
    if (session.userId === userId && session !== keep && sessionLive(session)) {
      Object.assign(session, { revokedAt: now(), revokedReason: reason });
      count++;
    }
  }
  return count;
}

/** Test hook: a fresh session for a seeded account, as the `Cookie` header value. */
export function mockSessionCookie(userId: string): string {
  if (!USERS.has(userId)) throw new Error(`No mock user ${userId}`);
  return `${SESSION_COOKIE}=${createSession(userId, 'password', null).token}`;
}

/** Test hook: moves a session's last proof of identity `seconds` into the past (re-auth). */
export function mockAgeSession(cookie: string, seconds: number): void {
  const session = webSessions.get(cookie.replace(`${SESSION_COOKIE}=`, ''));
  if (session) session.authenticatedAt -= seconds;
}

/** Test hook: the newest emailed token for a purpose. */
export function mockLastEmailToken(purpose: EmailToken['purpose']): string | null {
  return [...emailTokens].reverse().find((each) => each.purpose === purpose)?.token ?? null;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** §8.3: browser family and OS from a small fixed table. */
function deviceOf(userAgent: string | null): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent ?? ''))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent ?? ''))?.[1];
  return browser && system ? `${browser} on ${system}` : browser ?? system ?? 'Unknown device';
}

// ---- Account state ----

function activeEntitlement(userId: string): StoredEntitlement | null {
  return entitlementStore.find((each) => each.userId === userId && each.kind === 'premium' && each.revokedAt === null && (each.expiresAt === null || each.expiresAt > now())) ?? null;
}
const isPremium = (userId: string) => activeEntitlement(userId) !== null;
const premiumOf = (userId: string) => ({ active: isPremium(userId), expires_at: activeEntitlement(userId)?.expiresAt ?? null });
const pendingDeletion = (userId: string | null) => Boolean(userId && USERS.get(userId)?.deletionRequestedAt);
const deletionOf = (user: Persona) => (user.deletionRequestedAt ? { requested_at: user.deletionRequestedAt, scheduled_for: user.deletionScheduledFor } : null);
const identityOf = (userId: string) => identityStore.find((each) => each.userId === userId) ?? null;
const methodsOf = (user: Persona) => [...(user.password ? ['password'] : []), ...(identityOf(user.id) ? ['discord'] : [])];

function discordAvatarUrl(id: string, avatar: string | null): string {
  if (!avatar) return `https://cdn.discordapp.com/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`;
  return `https://cdn.discordapp.com/avatars/${id}/${avatar}.webp?size=64${avatar.startsWith('a_') ? '&animated=true' : ''}`;
}

const identityPayload = (identity: StoredIdentity) => ({
  provider: 'discord',
  username: identity.username,
  display_name: identity.displayName,
  avatar_url: discordAvatarUrl(identity.discordId, identity.avatar),
  created_at: identity.createdAt,
  last_used_at: identity.lastUsedAt,
});

function usernameAvailableAt(user: Persona): number | null {
  if (user.needsUsername || user.usernameChangedAt === null) return null;
  const at = user.usernameChangedAt + USERNAME_COOLDOWN;
  return at > now() ? at : null;
}

/** §2.1. */
function userObject(user: Persona) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    email: user.email,
    email_verified: user.emailVerified,
    pending_email: user.pendingEmail,
    has_password: user.password !== null,
    needs_username: user.needsUsername,
    created_at: user.createdAt,
    username_changed_at: user.usernameChangedAt,
    username_change_available_at: usernameAvailableAt(user),
    identities: identityStore.filter((each) => each.userId === user.id).map(identityPayload),
    settings: { show_name_on_albums: user.showNameOnAlbums, domain_only: user.domainOnly },
    premium: premiumOf(user.id),
    deletion: deletionOf(user),
    staff: user.staff,
    restrictions: restrictionsOf(user.id),
  };
}

function usernameTaken(name: string, forUserId: string | null): boolean {
  if ([...USERS.values()].some((each) => each.username === name && each.id !== forUserId)) return true;
  const hold = usernameHolds.get(name);
  return Boolean(hold && hold.heldUntil > now() && hold.userId !== forUserId);
}
const holdUsername = (name: string, userId: string) => usernameHolds.set(name, { userId, heldUntil: now() + USERNAME_HOLD });
const emailTaken = (email: string, exceptId: string | null = null) => [...USERS.values()].some((each) => each.id !== exceptId && sameEmail(each.email, email));
const userByEmail = (email: string) => [...USERS.values()].find((each) => sameEmail(each.email, email)) ?? null;

/** §2.6: the username/email checks win over length, as the contract's vectors show. */
function passwordProblem(password: string, username: string, email: string | null): 'too_short' | 'matches_username' | 'matches_email' | null {
  const lower = password.toLowerCase();
  if (lower === username.toLowerCase()) return 'matches_username';
  if (email && lower === email.toLowerCase()) return 'matches_email';
  if ([...password].length < 8) return 'too_short';
  return null;
}
const PASSWORD_TEXT = {
  too_short: 'Use at least 8 characters.',
  matches_username: 'Your password can’t be your username.',
  matches_email: 'Your password can’t be your email.',
};

interface FieldProblem {
  field: string;
  code: string;
  reason?: string;
  message: string;
}

/** One problem: its own code (plus `errors`); several: `INVALID_PARAMETERS { errors }` (§4.3). */
function throwFieldProblems(problems: FieldProblem[]) {
  if (problems.length === 0) return;
  const errors = Object.fromEntries(problems.map((each) => [each.field, each.message]));
  if (problems.length === 1) {
    const [only] = problems;
    throw bad(only!.code, only!.message, { ...(only!.reason ? { reason: only!.reason } : {}), errors });
  }
  throw bad('INVALID_PARAMETERS', 'Some fields need fixing.', { errors });
}

function usernameProblems(raw: unknown, field = 'username'): { name: string; problems: FieldProblem[] } {
  const name = normalizeUsername(String(raw ?? ''));
  const reason = usernameProblem(name);
  return { name, problems: reason ? [{ field, code: 'USERNAME_INVALID', reason, message: USERNAME_REASON_TEXT[reason] }] : [] };
}

function displayNameProblems(raw: unknown): { value: string | null; problems: FieldProblem[] } {
  if (raw === undefined || raw === null) return { value: null, problems: [] };
  const reason = displayNameProblem(String(raw));
  const value = cleanDisplayName(String(raw)) || null;
  return { value, problems: reason ? [{ field: 'display_name', code: 'DISPLAY_NAME_INVALID', reason, message: DISPLAY_NAME_REASON_TEXT[reason] }] : [] };
}

function sendEmailToken(purpose: EmailToken['purpose'], user: Persona, email: string, origin: string) {
  const token = randomBytes(32).toString('base64url');
  emailTokens.push({ token, purpose, userId: user.id, email, expiresAt: now() + (purpose === 'verify_email' ? DAY : 3600), usedAt: null });
  const link = `${origin}/app/${purpose === 'verify_email' ? 'verify' : 'reset'}#token=${token}`;
  if (!process.env.VITEST) console.info(`[mock-api] email to ${email}: ${link}`);
}

/** §4.2: fingerprint files and albums move into the account (never one pending deletion). */
function claimFingerprint(req: IncomingMessage, user: Persona): number {
  const fingerprint = req.headers['x-fingerprint'];
  if (!fingerprint || user.deletionRequestedAt) return 0;
  const from = `fp:${String(fingerprint)}`;
  const to = keyOfUser(user.id);
  let claimed = 0;
  for (const file of library.values()) {
    if (file.owner === from && !file.deleted) {
      file.owner = to;
      claimed++;
    }
  }
  for (const album of albumStore.values()) if (album.owner === from && !album.deleted) album.owner = to;
  return claimed;
}

/** A successful sign-in: one browser, one session (§4.1), the claim (§4.2) and the cookie. */
function signIn(req: IncomingMessage, res: ServerResponse, user: Persona, method: WebSession['method']) {
  const previous = liveSession(sessionToken(req));
  if (previous) Object.assign(previous, { revokedAt: now(), revokedReason: 'logout' });
  claimFingerprint(req, user);
  const session = createSession(user.id, method, req);
  setSessionCookie(res, session);
  return { expires_at: session.expiresAt, user: userObject(user) };
}

function newUser(fields: Partial<Persona> & { username: string }): Persona {
  const user: Persona = {
    id: nextId(),
    displayName: null,
    email: null,
    createdAt: now(),
    staff: null,
    emailVerified: false,
    pendingEmail: null,
    password: null,
    needsUsername: false,
    usernameChangedAt: null,
    showNameOnAlbums: false,
    domainOnly: false,
    deletionRequestedAt: null,
    deletionScheduledFor: null,
    ...fields,
  };
  USERS.set(user.id, user);
  return user;
}

// ---- Authentication, CSRF and the account locks (§3.4, §3.6, §8.8, §11.1) ----

const isUploadPath = (method: string, path: string) =>
  (method === 'POST' && (path === '/files' || path === '/uploads')) || /^\/uploads\/[^/]+(?:\/chunks\/\d+|\/complete)?$/.test(path);

function checkCsrf(req: IncomingMessage) {
  const refuse = () => bad('CSRF', 'This request didn’t come from files.gg.', {}, 403);
  if (req.headers['x-filesgg-csrf'] !== '1') throw refuse();
  const origin = req.headers.origin;
  const host = String(req.headers.host ?? '');
  if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) throw refuse();
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') throw refuse();
}

/** Upload keys, CSRF and dead cookies, before any route runs. */
function authenticate(req: IncomingMessage, res: ServerResponse, method: string, path: string) {
  const authorization = req.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Key\s+(\S+)$/.exec(String(authorization));
    if (!match) throw bad('UNAUTHORIZED', 'Upload keys use `Authorization: Key fgg_…`.', {}, 401);
    if (path.startsWith('/admin')) throw unknownRoute(method, path);
    if (!isUploadPath(method, path)) throw bad('UPLOAD_KEY_NOT_ALLOWED', 'Upload keys can only upload files.', {}, 403);
    const key = findKey(match[1]!);
    if (!key || keyState(key) !== 'active') throw bad('UPLOAD_KEY_INVALID', 'This upload key isn’t valid.', {}, 401);
    const keyOwner = USERS.get(key.userId)!;
    if (keyOwner.deletionRequestedAt) throw bad('ACCOUNT_PENDING_DELETION', 'This account is being deleted.', { scheduled_for: keyOwner.deletionScheduledFor }, 403);
    // A key request is authenticated by the key: the cookie is ignored and needs no CSRF header.
    return;
  }
  const token = sessionToken(req);
  const write = method !== 'GET' && method !== 'HEAD';
  if (write && (token || (method === 'POST' && path.startsWith('/auth/')))) checkCsrf(req);
  if (token && !liveSession(token)) {
    clearSessionCookie(res);
    if (path.startsWith('/auth/') || path === '/users/@me/username/check') return;
    if (path.startsWith('/users/@me') || path.startsWith('/admin') || path === '/reports') throw bad('UNAUTHORIZED', 'Your session has ended. Sign in again.', {}, 401);
  }
}

function pendingAllowed(method: string, path: string) {
  return (
    path.startsWith('/auth/') ||
    (method === 'GET' && path === '/users/@me') ||
    path === '/users/@me/delete' ||
    path === '/users/@me/delete/cancel' ||
    path.startsWith('/users/@me/sessions') ||
    path.startsWith('/users/@me/exports')
  );
}

function suspendedAllowed(method: string, path: string) {
  return (
    path.startsWith('/auth/') ||
    (method === 'GET' && (path === '/users/@me' || path === '/users/@me/badges')) ||
    path.startsWith('/users/@me/warnings') ||
    ((method === 'GET' || method === 'DELETE') && path.startsWith('/users/@me/sessions')) ||
    (method === 'PUT' && path === '/users/@me/password') ||
    path.startsWith('/users/@me/exports')
  );
}

function gate(who: Caller, method: string, path: string) {
  const user = who.user;
  if (!user) return;
  if (user.deletionRequestedAt && !pendingAllowed(method, path)) {
    throw bad('ACCOUNT_PENDING_DELETION', 'Your account is being deleted. Keep it to use files.gg again.', { scheduled_for: user.deletionScheduledFor }, 403);
  }
  const suspension = activeRestriction(user.id, 'suspended');
  if (suspension && !suspendedAllowed(method, path)) throw bad('ACCOUNT_SUSPENDED', 'Your account has been suspended.', { until: suspension.endsAt }, 403);
}

function requireSession(who: Caller): { user: Persona; session: WebSession } {
  if (!who.user || !who.session) throw bad('UNAUTHORIZED', 'Sign in first.', {}, 401);
  return { user: who.user, session: who.session };
}

/** §3.5: a password or Discord proof within the last 10 minutes. */
function requireFresh(user: Persona, session: WebSession) {
  if (now() - session.authenticatedAt > REAUTH_SECONDS) throw bad('REAUTH_REQUIRED', 'Confirm it’s you first.', { methods: methodsOf(user) }, 403);
}

// ---- Upload keys (§7) ----

function findKey(secret: string): StoredKey | null {
  if (!tokenValid(secret, 'fgg_')) return null;
  return keyStore.find((each) => each.secret === secret) ?? null;
}
const keyState = (key: StoredKey): 'active' | 'revoked' | 'expired' =>
  key.revokedAt !== null ? 'revoked' : key.expiresAt !== null && key.expiresAt <= now() ? 'expired' : 'active';
const activeKeys = (userId: string) => keyStore.filter((each) => each.userId === userId && keyState(each) === 'active');

function keyObject(key: StoredKey) {
  const domain = key.domainId ? domainStore.get(key.domainId) : undefined;
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    domain: domain && !domain.deletedAt ? { id: domain.id, hostname: domain.hostname } : null,
    created_at: key.createdAt,
    expires_at: key.expiresAt,
    last_used_at: key.lastUsedAt,
    revoked_at: key.revokedAt,
    state: keyState(key),
  };
}

function addKey(userId: string, fields: Partial<StoredKey> & { name: string }): StoredKey {
  const secret = makeToken('fgg_');
  const key: StoredKey = {
    id: nextId(),
    userId,
    secret,
    prefix: secret.slice(0, 12),
    scopes: ['files:upload'],
    domainId: null,
    createdAt: now(),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    ...fields,
  };
  keyStore.push(key);
  return key;
}

/** §7.2, §7.6: `album=` needs `albums:append`; 600 uploads an hour per key. */
function checkKeyUpload(who: Caller, fields: Record<string, unknown>) {
  const key = who.uploadKey;
  if (!key) return;
  if (fields.album !== undefined && !key.scopes.includes('albums:append')) {
    throw bad('UPLOAD_KEY_SCOPE', 'This upload key can’t add to albums.', { scope: 'albums:append' }, 403);
  }
  rateLimit('upload_key', `key:${key.id}`, 600, 'TOO_MANY_UPLOADS', 'This key has uploaded a lot. Try again later.');
  if (key.lastUsedAt === null || now() - key.lastUsedAt >= 60) key.lastUsedAt = now();
}

// ---- Domains (§10) ----

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.br', 'co.za', 'com.mx', 'com.tr']);

/** §10.1, simplified: a tiny public-suffix table instead of the PSL snapshot. */
export function normalizeHostname(raw: string): { hostname: string } | { reason: string } {
  const host = raw.trim().replace(/\.$/, '').toLowerCase();
  if (!host) return { reason: 'syntax' };
  if (host.includes('*')) return { reason: 'wildcard' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return { reason: 'ip' };
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253) return { reason: 'syntax' };
  const labels = ascii.split('.');
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return { reason: 'syntax' };
  if (ascii === 'files.gg' || ascii.endsWith('.files.gg') || ascii === 'localhost' || ascii.endsWith('.localhost')) return { reason: 'reserved' };
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length === 1 || TWO_LABEL_SUFFIXES.has(ascii)) return { reason: 'public_suffix' };
  if (labels.length === 2 || (labels.length === 3 && TWO_LABEL_SUFFIXES.has(lastTwo))) return { reason: 'apex' };
  return { hostname: ascii };
}

/** The status now: new domains move on by themselves (20 s per step), and losing premium pauses. */
function domainStatus(domain: StoredDomain): DomainStatus {
  if (domain.auto && (domain.status === 'pending_dns' || domain.status === 'pending_cert')) {
    const age = now() - domain.createdAt;
    if (age >= 40) {
      Object.assign(domain, { status: 'active', auto: false, verifiedAt: domain.createdAt + 40, lastCheckedAt: domain.createdAt + 40 });
    } else {
      domain.status = age >= 20 ? 'pending_cert' : 'pending_dns';
    }
  }
  if (domain.status !== 'failed' && domain.status !== 'disabled' && !isPremium(domain.userId)) return 'paused';
  return domain.status;
}

const domainServing = (domain: StoredDomain) =>
  !domain.deletedAt && ['active', 'failing'].includes(domainStatus(domain)) && !pendingDeletion(domain.userId);

const CLOUDFLARE_STATES: Record<DomainStatus, { status: string; ssl_status: string }> = {
  pending_dns: { status: 'pending', ssl_status: 'initializing' },
  pending_cert: { status: 'active', ssl_status: 'pending_validation' },
  active: { status: 'active', ssl_status: 'active' },
  failing: { status: 'active', ssl_status: 'active' },
  failed: { status: 'moved', ssl_status: 'expired' },
  paused: { status: 'active', ssl_status: 'active' },
  disabled: { status: 'active', ssl_status: 'active' },
};

function domainObject(domain: StoredDomain) {
  const status = domainStatus(domain);
  const cnameOk = !['pending_dns', 'failed'].includes(status);
  const txtOk = !['pending_dns', 'failing', 'failed'].includes(status);
  return {
    id: domain.id,
    hostname: domain.hostname,
    status,
    status_reason: status === 'paused' ? 'premium_ended' : domain.statusReason,
    serving: domainServing(domain),
    is_default: domain.isDefault,
    scope: domain.scope,
    records: [
      { type: 'CNAME', name: domain.hostname, value: CUSTOM_DOMAIN_TARGET, ok: cnameOk },
      { type: 'TXT', name: `_filesgg-verify.${domain.hostname}`, value: `filesgg-verify=${domain.verifyToken}`, ok: txtOk },
    ],
    cloudflare: domain.status === 'failed' && domain.statusReason === 'dns_timeout' ? { status: 'pending', ssl_status: 'initializing' } : CLOUDFLARE_STATES[status],
    created_at: domain.createdAt,
    verified_at: domain.verifiedAt,
    last_checked_at: domain.lastCheckedAt,
    pending_until: status === 'pending_dns' || status === 'pending_cert' ? domain.createdAt + DOMAIN_PENDING_HOURS * 3600 : null,
    failing_since: status === 'failing' ? domain.failingSince : null,
    disabled_reason: status === 'disabled' ? domain.disabledReason : null,
  };
}

const userDomains = (userId: string) => [...domainStore.values()].filter((each) => each.userId === userId && !each.deletedAt);
const countedDomains = (userId: string) => userDomains(userId).filter((each) => each.status !== 'disabled');
const defaultServingDomain = (userId: string) => userDomains(userId).find((each) => each.isDefault && domainServing(each)) ?? null;

function ownDomain(userId: string, id: string): StoredDomain {
  const domain = domainStore.get(id);
  if (!domain || domain.userId !== userId || domain.deletedAt) throw bad('UNKNOWN_DOMAIN', 'Unknown domain.', {}, 404);
  return domain;
}

function addDomain(userId: string, hostname: string, fields: Partial<StoredDomain> = {}): StoredDomain {
  const domain: StoredDomain = {
    id: nextId(),
    userId,
    hostname,
    status: 'pending_dns',
    statusReason: null,
    auto: false,
    createdAt: now(),
    verifiedAt: null,
    lastCheckedAt: now(),
    failingSince: null,
    disabledReason: null,
    disabledActionId: null,
    statusBeforeDisable: null,
    isDefault: false,
    scope: 'own',
    verifyToken: base32(randomBytes(16)),
    cfHostnameId: randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-'),
    deletedAt: null,
    ...fields,
  };
  domainStore.set(domain.id, domain);
  return domain;
}

function domainOnlyState(user: Persona) {
  const anyServing = userDomains(user.id).some(domainServing);
  const effective = user.domainOnly && isPremium(user.id) && anyServing;
  return { enabled: user.domainOnly, effective, paused: user.domainOnly && !effective };
}

function domainOnlyAffected(user: Persona) {
  const key = keyOfUser(user.id);
  return {
    affected_files: ownFiles(key).filter((file) => file.visibility !== 'private').length,
    affected_albums: ownAlbums(key).filter((album) => album.visibility !== 'private').length,
  };
}

/** §10.9: owner payloads link to the default serving domain, and gain `direct_url`. */
function withOwnerLinks<T extends Record<string, unknown>>(file: StoredFile, payload: T): T & { direct_url: string } {
  const userId = userIdOfKey(file.owner);
  const domain = userId ? defaultServingDomain(userId) : null;
  if (!domain) return { ...payload, direct_url: String(payload.cdn_url) };
  const ext = file.extension ? `.${file.extension}` : '';
  let search = '';
  try {
    search = new URL(String(payload.cdn_url), 'http://localhost').search;
  } catch {
    // A data: URL: nothing to carry over.
  }
  return { ...payload, url: `https://${domain.hostname}/${file.vanity}${ext}`, direct_url: `https://${domain.hostname}/files/${file.vanity}${ext}${search}` };
}

// ---- Entitlements and exports ----

function entitlementPayload(entitlement: StoredEntitlement) {
  const person = (id: string | null) => {
    const user = id ? USERS.get(id) : undefined;
    return user ? { id: user.id, username: user.username } : null;
  };
  return {
    id: entitlement.id,
    kind: entitlement.kind,
    active: entitlement.revokedAt === null && (entitlement.expiresAt === null || entitlement.expiresAt > now()),
    granted_at: entitlement.grantedAt,
    granted_by: person(entitlement.grantedBy),
    expires_at: entitlement.expiresAt,
    revoked_at: entitlement.revokedAt,
    revoked_by: person(entitlement.revokedBy),
    note: entitlement.note,
  };
}

function exportPayload(item: StoredExport) {
  const age = now() - item.createdAt;
  const readyAt = item.createdAt + EXPORT_READY_AFTER;
  const expiresAt = readyAt + EXPORT_KEEP;
  const status = now() >= expiresAt ? 'expired' : age >= EXPORT_READY_AFTER ? 'ready' : age >= 1 ? 'running' : 'queued';
  const ready = status === 'ready' || status === 'expired';
  return { id: item.id, status, created_at: item.createdAt, ready_at: ready ? readyAt : null, expires_at: ready ? expiresAt : null, size: status === 'ready' ? EMPTY_ZIP.length : null };
}

/** A valid empty ZIP (just the end-of-central-directory record). */
const EMPTY_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

// ---- Mock Discord (§5) ----

interface MockDiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  email: string | null;
  verified: boolean;
}

/** The accounts the mock Discord consent page offers. */
export const MOCK_DISCORD_USERS: readonly MockDiscordUser[] = [
  { id: '80351110224678912', username: 'mockuser', global_name: 'Mock User', avatar: 'a_1b2c3d4e5f', email: 'mock@example.com', verified: true },
  { id: '80351110224678913', username: 'discordonly', global_name: null, avatar: null, email: null, verified: false },
  { id: '80351110224678914', username: 'newdiscord', global_name: 'New Discord', avatar: null, email: 'new.discord@example.com', verified: true },
  { id: '80351110224678915', username: 'unverifieddiscord', global_name: 'Unverified', avatar: null, email: 'unverified.discord@example.com', verified: false },
  { id: '80351110224678916', username: 'noemaildiscord', global_name: null, avatar: null, email: null, verified: false },
  { id: '80351110224678917', username: 'takendiscord', global_name: 'Taken', avatar: null, email: 'member@example.com', verified: true },
];

const DISCORD_CODE_LABEL = 'filesgg-mock-discord-code-1';
const STATE_LABEL = 'filesgg-oauth-state-1';
const SIGNUP_LABEL = 'filesgg-discord-signup-1';

/** Test hook: the code the mock Discord page hands back for one of its accounts. */
export function mockDiscordCode(discordId: string, codeChallenge: string): string {
  return signLabelled({ c: codeChallenge, d: discordId, e: now() + 600 }, DISCORD_CODE_LABEL);
}

/** §5.5: the Discord name if valid and free, else `_2` … `_9`, else `user_` + 6 digits. */
function suggestUsername(discordName: string): string {
  const base = normalizeUsername(discordName);
  if (!usernameProblem(base) && !usernameTaken(base, null)) return base;
  for (let n = 2; n <= 9; n++) {
    const name = `${base.slice(0, 30)}_${n}`;
    if (!usernameProblem(name) && !usernameTaken(name, null)) return name;
  }
  return `user_${String(randomInt(1_000_000)).padStart(6, '0')}`;
}

function discordConsentPage(query: URLSearchParams): string {
  const redirect = query.get('redirect_uri') ?? '/app/auth/discord';
  const state = query.get('state') ?? '';
  const challenge = query.get('code_challenge') ?? '';
  const link = (params: Record<string, string>) => `${redirect}?${new URLSearchParams(params).toString()}`;
  const rows = MOCK_DISCORD_USERS.map((user) => {
    const email = user.email ? `${user.email}${user.verified ? '' : ' (unverified)'}` : 'no email';
    const href = link({ code: mockDiscordCode(user.id, challenge), state });
    return `<li><a href="${escapeHtml(href)}" style="display:block;padding:12px 14px;border:1px solid #2b2f36;border-radius:8px;color:#e6e8eb;text-decoration:none"><strong>${escapeHtml(user.global_name ?? user.username)}</strong> <span style="color:#9aa1ab">@${escapeHtml(user.username)} · ${escapeHtml(email)}</span></a></li>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Discord</title></head>
<body style="margin:0;background:#111316;color:#e6e8eb;font:15px/1.5 system-ui,sans-serif">
<main style="max-width:480px;margin:40px auto;padding:0 16px">
<h1 style="font-size:20px">Mock Discord</h1>
<p style="color:#9aa1ab">files.gg wants to know who you are (${escapeHtml(query.get('scope') ?? 'identify email')}). Pick an account. This page stands in for Discord in local development.</p>
<ul style="list-style:none;padding:0;display:flex;flex-direction:column;gap:8px">${rows}</ul>
<p><a href="${escapeHtml(link({ error: 'access_denied', state }))}" style="color:#9aa1ab">Cancel</a></p>
</main></body></html>`;
}

// ---- Routes ----

async function accountRoute(req: IncomingMessage, res: ServerResponse, path: string, origin: string, query: URLSearchParams, who: Caller): Promise<boolean> {
  const method = req.method ?? 'GET';
  let match: RegExpExecArray | null;
  const ip = ipOf(req);

  // ---- Auth (§3–§5) ----
  if (method === 'GET' && path === '/auth/config') {
    send(res, 200, { discord: true });
    return true;
  }
  if (method === 'GET' && path === '/auth/session') {
    send(res, 200, { user: who.session && who.user ? userObject(who.user) : null });
    return true;
  }
  if (method === 'POST' && path === '/auth/login') {
    const body = await readSmallJson(req);
    const email = String(body.email ?? '').trim();
    const accountBucket = `login_account:${email.toLowerCase()}`;
    checkFailures(`login_ip:${ip}`, 30);
    checkFailures(accountBucket, 10);
    requireTurnstile(body);
    const user = email ? userByEmail(email) : null;
    if (!user || user.password === null || body.password !== user.password) {
      countFailure(`login_ip:${ip}`);
      countFailure(accountBucket);
      throw bad('INVALID_CREDENTIALS', 'Wrong email or password.');
    }
    send(res, 200, signIn(req, res, user, 'password'));
    return true;
  }
  if (method === 'POST' && path === '/auth/register') {
    const body = await readSmallJson(req);
    rateLimit('register', `ip:${ip}`, 5, 'TOO_MANY_ATTEMPTS', 'Too many accounts from here. Try again later.');
    if (isBanned(who.fingerprint)) throw bad('BANNED', 'Accounts can’t be created from this device or network.', {}, 403);
    const email = String(body.email ?? '').trim();
    const { name, problems } = usernameProblems(body.username);
    const display = displayNameProblems(body.display_name);
    const password = String(body.password ?? '');
    problems.push(...display.problems);
    if (!validEmail(email)) problems.push({ field: 'email', code: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
    const passwordReason = passwordProblem(password, name, email);
    if (passwordReason) problems.push({ field: 'password', code: 'INVALID_PASSWORD', reason: passwordReason, message: PASSWORD_TEXT[passwordReason] });
    throwFieldProblems(problems);
    requireTurnstile(body);
    if (emailTaken(email)) throw bad('EMAIL_TAKEN', 'An account already uses this email.', { errors: { email: 'An account already uses this email.' } }, 409);
    if (usernameTaken(name, null)) throw bad('USERNAME_TAKEN', 'That username is taken.', { errors: { username: 'That username is taken.' } }, 409);
    const user = newUser({ username: name, displayName: display.value, email, password });
    const result = signIn(req, res, user, 'register');
    sendEmailToken('verify_email', user, email, origin);
    send(res, 201, result);
    return true;
  }
  if (method === 'POST' && path === '/auth/logout') {
    if (who.session) Object.assign(who.session, { revokedAt: now(), revokedReason: 'logout' });
    clearSessionCookie(res);
    send(res, 204);
    return true;
  }
  if (method === 'POST' && path === '/auth/verify') {
    const body = await readSmallJson(req);
    const token = emailTokens.find((each) => each.token === String(body.token ?? '') && each.purpose === 'verify_email');
    const user = token ? USERS.get(token.userId) : undefined;
    if (!token || !user || token.usedAt !== null || token.expiresAt <= now()) throw bad('INVALID_TOKEN', 'This link is invalid or has expired.');
    token.usedAt = now();
    if (sameEmail(token.email, user.email)) {
      user.emailVerified = true;
    } else if (sameEmail(token.email, user.pendingEmail)) {
      if (emailTaken(token.email, user.id)) {
        user.pendingEmail = null;
        throw bad('EMAIL_TAKEN', 'An account already uses this email.', {}, 409);
      }
      Object.assign(user, { email: user.pendingEmail, emailVerified: true, pendingEmail: null });
    } else {
      throw bad('INVALID_TOKEN', 'This link is invalid or has expired.');
    }
    send(res, 204);
    return true;
  }
  if (method === 'POST' && path === '/auth/verify/resend') {
    const { user } = requireSession(who);
    const target = user.pendingEmail ?? (!user.emailVerified ? user.email : null);
    if (!target) throw bad('NOTHING_TO_VERIFY', 'Your email is already verified.', {}, 409);
    rateLimit('verify_resend', `user:${user.id}`, 5, 'TOO_MANY_ATTEMPTS', 'Too many emails. Try again later.');
    sendEmailToken('verify_email', user, target, origin);
    send(res, 204);
    return true;
  }
  if (method === 'POST' && path === '/auth/forgot') {
    const body = await readSmallJson(req);
    requireTurnstile(body);
    const email = String(body.email ?? '').trim();
    const user = email ? userByEmail(email) : null;
    // No enumeration (§4.4): every outcome is 204, rate-limited sends included.
    const ipBucket = `forgot_ip:${ip}`;
    const accountBucket = `forgot_account:${email.toLowerCase()}`;
    try {
      checkFailures(ipBucket, 10);
      checkFailures(accountBucket, 3);
      countFailure(ipBucket);
      if (user?.email) {
        countFailure(accountBucket);
        sendEmailToken('reset_password', user, user.email, origin);
      }
    } catch {
      // Rate limited: nothing is sent.
    }
    send(res, 204);
    return true;
  }
  if (method === 'POST' && path === '/auth/forgot/reset') {
    const body = await readSmallJson(req);
    requireTurnstile(body);
    const token = emailTokens.find((each) => each.token === String(body.token ?? '') && each.purpose === 'reset_password');
    const user = token ? USERS.get(token.userId) : undefined;
    if (!token || !user || token.usedAt !== null || token.expiresAt <= now() || !sameEmail(token.email, user.email)) {
      throw bad('INVALID_TOKEN', 'This link is invalid or has expired.');
    }
    const password = String(body.password ?? '');
    const reason = passwordProblem(password, user.username, user.email);
    if (reason) throw bad('INVALID_PASSWORD', PASSWORD_TEXT[reason], { reason, errors: { password: PASSWORD_TEXT[reason] } });
    if (password === user.password) throw bad('SAME_PASSWORD', 'That’s your current password.', { errors: { password: 'That’s your current password.' } });
    Object.assign(user, { password, emailVerified: true });
    token.usedAt = now();
    revokeSessions(user.id, 'password_reset');
    send(res, 200, signIn(req, res, user, 'reset'));
    return true;
  }
  if (method === 'POST' && path === '/auth/reauth') {
    const { user, session } = requireSession(who);
    const body = await readSmallJson(req);
    const bucket = `reauth:${user.id}`;
    checkFailures(bucket, 10);
    if (!user.password || body.password !== user.password) {
      countFailure(bucket);
      throw bad('INVALID_CREDENTIALS', 'That password isn’t right.');
    }
    session.authenticatedAt = now();
    send(res, 204);
    return true;
  }

  // ---- Discord (§5) ----
  if (method === 'GET' && path === '/__discord/authorize') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(discordConsentPage(query));
    return true;
  }
  if (method === 'POST' && path === '/auth/discord/authorize') {
    const body = await readSmallJson(req);
    const purpose = String(body.purpose ?? '');
    if (!['login', 'link', 'reauth'].includes(purpose)) throw invalid('purpose', 'purpose must be login, link or reauth.');
    const challenge = String(body.code_challenge ?? '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw invalid('code_challenge', 'code_challenge must be an S256 challenge.');
    let userId: string | null = null;
    if (purpose !== 'login') {
      const { user } = requireSession(who);
      if (purpose === 'link' && activeRestriction(user.id, 'suspended')) throw bad('ACCOUNT_SUSPENDED', 'Your account has been suspended.', {}, 403);
      userId = user.id;
    }
    const at = now();
    const state = signLabelled({ c: challenge, e: at + 600, i: at, n: randomBytes(16).toString('base64url'), p: purpose, u: userId }, STATE_LABEL);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'mock',
      scope: 'identify email',
      redirect_uri: `${origin}/app/auth/discord`,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: purpose === 'link' ? 'consent' : 'none',
    });
    send(res, 200, { url: `${origin}${MOCK_API_PREFIX}/__discord/authorize?${params.toString().replace(/\+/g, '%20')}`, state });
    return true;
  }
  if (method === 'POST' && path === '/auth/discord/callback') {
    const body = await readSmallJson(req);
    rateLimit('discord', `ip:${ip}`, 30, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
    const stateError = () => bad('INVALID_OAUTH_STATE', 'This sign-in link expired. Try again.');
    const state = verifyLabelled(String(body.state ?? ''), STATE_LABEL);
    if (!state || !['login', 'link', 'reauth'].includes(String(state.p))) throw stateError();
    const purpose = String(state.p);
    if (purpose !== 'login' && (!who.session || !who.user || who.user.id !== state.u)) throw stateError();
    if (pkceChallenge(String(body.code_verifier ?? '')) !== state.c) throw stateError();
    if (purpose === 'login') requireTurnstile(body);
    const code = verifyLabelled(String(body.code ?? ''), DISCORD_CODE_LABEL);
    const discordUser = code && code.c === state.c ? MOCK_DISCORD_USERS.find((each) => each.id === code.d) : undefined;
    if (!discordUser) throw bad('DISCORD_CODE_INVALID', 'Discord didn’t accept the sign-in. Try again.');
    const identity = identityStore.find((each) => each.discordId === discordUser.id && USERS.has(each.userId));
    if (purpose === 'login') {
      if (identity) {
        Object.assign(identity, { username: discordUser.username, displayName: discordUser.global_name, avatar: discordUser.avatar, lastUsedAt: now() });
        send(res, 200, { status: 'signed_in', ...signIn(req, res, USERS.get(identity.userId)!, 'discord') });
        return true;
      }
      const inUse = Boolean(discordUser.email && discordUser.verified && emailTaken(discordUser.email));
      const usable = Boolean(discordUser.email && discordUser.verified && !inUse);
      send(res, 200, {
        status: 'signup_required',
        signup_token: signLabelled(
          { a: discordUser.avatar, d: discordUser.id, e: now() + 900, g: discordUser.global_name, m: discordUser.email, mv: discordUser.verified, n: discordUser.username },
          SIGNUP_LABEL,
        ),
        suggested_username: suggestUsername(discordUser.username),
        discord: { id: discordUser.id, username: discordUser.username, display_name: discordUser.global_name, avatar_url: discordAvatarUrl(discordUser.id, discordUser.avatar) },
        email: { address: discordUser.email, usable, reason: usable ? null : !discordUser.email ? 'missing' : inUse ? 'in_use' : 'unverified' },
      });
      return true;
    }
    const { user, session } = requireSession(who);
    if (purpose === 'link') {
      if (identity && identity.userId !== user.id) throw bad('IDENTITY_IN_USE', 'That Discord account is linked to another files.gg account.', {}, 409);
      if (identity) {
        send(res, 200, { status: 'linked', identity: identityPayload(identity) });
        return true;
      }
      if (identityOf(user.id)) throw bad('IDENTITY_ALREADY_LINKED', 'Your account already has a Discord account linked.', {}, 409);
      const linked: StoredIdentity = { userId: user.id, discordId: discordUser.id, username: discordUser.username, displayName: discordUser.global_name, avatar: discordUser.avatar, createdAt: now(), lastUsedAt: now() };
      identityStore.push(linked);
      send(res, 200, { status: 'linked', identity: identityPayload(linked) });
      return true;
    }
    if (!identity || identity.userId !== user.id) throw bad('IDENTITY_MISMATCH', 'That isn’t the Discord account linked to files.gg.', {}, 403);
    identity.lastUsedAt = now();
    session.authenticatedAt = now();
    send(res, 200, { status: 'reauthenticated' });
    return true;
  }
  if (method === 'POST' && path === '/auth/discord/signup') {
    const body = await readSmallJson(req);
    requireTurnstile(body);
    rateLimit('register', `ip:${ip}`, 5, 'TOO_MANY_ATTEMPTS', 'Too many accounts from here. Try again later.');
    if (isBanned(who.fingerprint)) throw bad('BANNED', 'Accounts can’t be created from this device or network.', {}, 403);
    const claims = verifyLabelled(String(body.signup_token ?? ''), SIGNUP_LABEL);
    if (!claims) throw bad('INVALID_SIGNUP_TOKEN', 'This sign-up expired. Continue with Discord again.');
    const discordId = String(claims.d);
    if (identityStore.some((each) => each.discordId === discordId && USERS.has(each.userId))) {
      throw bad('IDENTITY_IN_USE', 'That Discord account is linked to another files.gg account.', {}, 409);
    }
    const discordEmail = typeof claims.m === 'string' ? claims.m : null;
    const verified = claims.mv === true;
    if (discordEmail && verified && emailTaken(discordEmail)) {
      throw bad('DISCORD_EMAIL_IN_USE', 'An account already uses this email. Sign in with your password, then link Discord in Settings.', {}, 409);
    }
    const { name, problems } = usernameProblems(body.username);
    const display = displayNameProblems(body.display_name);
    throwFieldProblems([...problems, ...display.problems]);
    if (usernameTaken(name, null)) throw bad('USERNAME_TAKEN', 'That username is taken.', { errors: { username: 'That username is taken.' } }, 409);
    const usable = Boolean(discordEmail && verified);
    const user = newUser({ username: name, displayName: display.value, email: usable ? discordEmail : null, emailVerified: usable });
    identityStore.push({ userId: user.id, discordId, username: String(claims.n), displayName: typeof claims.g === 'string' ? claims.g : null, avatar: typeof claims.a === 'string' ? claims.a : null, createdAt: now(), lastUsedAt: now() });
    send(res, 201, signIn(req, res, user, 'discord'));
    return true;
  }

  // ---- Profile (§8.1) ----
  if (method === 'GET' && path === '/users/@me/username/check') {
    rateLimit('username_check', `ip:${ip}`, 60, 'TOO_MANY_ATTEMPTS', 'Too many checks. Try again later.');
    const name = normalizeUsername(query.get('username') ?? '');
    const reason = usernameProblem(name) ?? (usernameTaken(name, who.user?.id ?? null) ? 'taken' : null);
    send(res, 200, reason ? { username: name, available: false, reason } : { username: name, available: true });
    return true;
  }
  if (!path.startsWith('/users/@me')) return false;

  if (path === '/users/@me' && method === 'GET') {
    const { user } = requireSession(who);
    send(res, 200, userObject(user));
    return true;
  }
  if (path === '/users/@me' && method === 'PATCH') {
    const { user } = requireSession(who);
    const body = await readJson(req);
    if (body.display_name !== undefined) {
      const display = displayNameProblems(body.display_name);
      throwFieldProblems(display.problems);
      user.displayName = display.value;
    }
    const settings = (body.settings ?? {}) as Record<string, unknown>;
    if (typeof settings.show_name_on_albums === 'boolean') user.showNameOnAlbums = settings.show_name_on_albums;
    send(res, 200, userObject(user));
    return true;
  }
  if (path === '/users/@me/username' && method === 'PUT') {
    const { user } = requireSession(who);
    const body = await readJson(req);
    const { name, problems } = usernameProblems(body.username);
    throwFieldProblems(problems);
    if (name === user.username) {
      send(res, 200, userObject(user));
      return true;
    }
    const availableAt = usernameAvailableAt(user);
    if (availableAt !== null) throw bad('USERNAME_COOLDOWN', 'You changed your username recently.', { available_at: availableAt }, 409);
    if (usernameTaken(name, user.id)) throw bad('USERNAME_TAKEN', 'That username is taken.', { errors: { username: 'That username is taken.' } }, 409);
    holdUsername(user.username, user.id);
    Object.assign(user, { username: name, usernameChangedAt: now(), needsUsername: false });
    send(res, 200, userObject(user));
    return true;
  }

  // ---- Login methods (§5.6, §8.2) ----
  if (path === '/users/@me/identities' && method === 'GET') {
    const { user } = requireSession(who);
    send(res, 200, { items: identityStore.filter((each) => each.userId === user.id).map(identityPayload) });
    return true;
  }
  if (path === '/users/@me/identities/discord' && method === 'DELETE') {
    const { user, session } = requireSession(who);
    const identity = identityOf(user.id);
    if (!identity) throw bad('UNKNOWN_IDENTITY', 'No Discord account is linked.', {}, 404);
    requireFresh(user, session);
    if (!user.password || !user.email || !user.emailVerified) {
      throw bad('LAST_LOGIN_METHOD', 'Add a password and verify your email first, so you can still sign in.', {}, 409);
    }
    identityStore.splice(identityStore.indexOf(identity), 1);
    send(res, 204);
    return true;
  }

  // ---- Sessions (§8.3) ----
  if (path === '/users/@me/sessions' && method === 'GET') {
    const { user, session: current } = requireSession(who);
    const items = [...webSessions.values()]
      .filter((each) => each.userId === user.id && sessionLive(each))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || Number(BigInt(b.id) - BigInt(a.id)))
      .map((each) => ({
        id: each.id,
        current: each === current,
        method: each.method,
        created_at: each.createdAt,
        last_used_at: each.lastUsedAt,
        expires_at: each.expiresAt,
        device: deviceOf(each.userAgent),
        country: each.country,
      }));
    send(res, 200, { items });
    return true;
  }
  if (path === '/users/@me/sessions' && method === 'DELETE') {
    const { user } = requireSession(who);
    const revoked = revokeSessions(user.id, 'everywhere');
    clearSessionCookie(res);
    send(res, 200, { revoked });
    return true;
  }
  if ((match = /^\/users\/@me\/sessions\/([^/]+)$/.exec(path)) && method === 'DELETE') {
    const { user, session: current } = requireSession(who);
    const target = [...webSessions.values()].find((each) => each.id === match![1] && each.userId === user.id && sessionLive(each));
    if (!target) throw bad('UNKNOWN_SESSION', 'That session has already ended.', {}, 404);
    Object.assign(target, { revokedAt: now(), revokedReason: target === current ? 'logout' : 'user' });
    if (target === current) clearSessionCookie(res);
    send(res, 204);
    return true;
  }

  // ---- Email and password (§8.4, §8.5) ----
  if (path === '/users/@me/email' && method === 'POST') {
    const { user, session } = requireSession(who);
    const body = await readSmallJson(req);
    requireFresh(user, session);
    const email = String(body.email ?? '').trim();
    if (!validEmail(email)) throw bad('INVALID_EMAIL', 'Enter a valid email address.', { errors: { email: 'Enter a valid email address.' } });
    if (sameEmail(email, user.email)) throw invalid('email', 'That’s already your email.');
    if (emailTaken(email, user.id)) throw bad('EMAIL_TAKEN', 'An account already uses this email.', { errors: { email: 'An account already uses this email.' } }, 409);
    if (!user.email) Object.assign(user, { email, emailVerified: false, pendingEmail: null });
    else user.pendingEmail = email;
    sendEmailToken('verify_email', user, email, origin);
    send(res, 202, { pending_email: user.pendingEmail });
    return true;
  }
  if (path === '/users/@me/email/pending' && method === 'DELETE') {
    const { user } = requireSession(who);
    user.pendingEmail = null;
    send(res, 204);
    return true;
  }
  if (path === '/users/@me/password' && method === 'PUT') {
    const { user, session } = requireSession(who);
    const body = await readSmallJson(req);
    if (user.password !== null) {
      const bucket = `reauth:${user.id}`;
      checkFailures(bucket, 10);
      if (body.current_password !== user.password) {
        countFailure(bucket);
        throw bad('INVALID_CREDENTIALS', 'Your current password isn’t right.', { errors: { current_password: 'Your current password isn’t right.' } });
      }
      session.authenticatedAt = now();
    } else {
      requireFresh(user, session);
      if (!user.email || !user.emailVerified) throw bad('EMAIL_NOT_VERIFIED', 'Verify your email before setting a password.', {}, 403);
    }
    const password = String(body.new_password ?? '');
    const reason = passwordProblem(password, user.username, user.email);
    if (reason) throw bad('INVALID_PASSWORD', PASSWORD_TEXT[reason], { reason, errors: { new_password: PASSWORD_TEXT[reason] } });
    if (password === user.password) throw bad('SAME_PASSWORD', 'That’s your current password.', { errors: { new_password: 'That’s your current password.' } });
    user.password = password;
    revokeSessions(user.id, 'password_change', session);
    send(res, 204);
    return true;
  }

  // ---- Data export (§8.7) ----
  if (path === '/users/@me/exports' && method === 'GET') {
    const { user } = requireSession(who);
    send(res, 200, { items: exportStore.filter((each) => each.userId === user.id).sort((a, b) => b.createdAt - a.createdAt).map(exportPayload) });
    return true;
  }
  if (path === '/users/@me/exports' && method === 'POST') {
    const { user } = requireSession(who);
    const last = exportStore.filter((each) => each.userId === user.id).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (last && now() - last.createdAt < DAY) throw bad('EXPORT_LIMIT', 'You can request one export a day.', { retry_after: last.createdAt + DAY - now() }, 429);
    const item: StoredExport = { id: nextId(), userId: user.id, createdAt: now() };
    exportStore.push(item);
    send(res, 202, { export: exportPayload(item) });
    return true;
  }
  if ((match = /^\/users\/@me\/exports\/([^/]+)\/download$/.exec(path)) && method === 'GET') {
    const { user } = requireSession(who);
    const item = exportStore.find((each) => each.id === match![1] && each.userId === user.id);
    const status = item ? exportPayload(item).status : 'unknown';
    if (!item || status === 'expired' || status === 'unknown') throw bad('UNKNOWN_EXPORT', 'This export doesn’t exist or has expired.', {}, 404);
    if (status !== 'ready') throw bad('EXPORT_NOT_READY', 'This export isn’t ready yet.', {}, 409);
    const day = new Date(item.createdAt * 1000).toISOString().slice(0, 10);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="filesgg-export-${user.username}-${day}.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(EMPTY_ZIP);
    return true;
  }

  // ---- Deleting the account (§8.8) ----
  if (path === '/users/@me/delete' && method === 'POST') {
    const { user, session } = requireSession(who);
    const body = await readSmallJson(req);
    if (user.deletionRequestedAt) throw bad('ACCOUNT_DELETE_NOT_ALLOWED', 'Your account is already being deleted.', { reason: 'pending' }, 409);
    if (user.staff) throw bad('ACCOUNT_DELETE_NOT_ALLOWED', 'Staff accounts can’t be deleted.', { reason: 'staff' }, 409);
    if (normalizeUsername(String(body.confirm_username ?? '')) !== user.username) throw invalid('confirm_username', 'Type your username to confirm.');
    requireFresh(user, session);
    Object.assign(user, { deletionRequestedAt: now(), deletionScheduledFor: now() + DELETION_GRACE });
    revokeSessions(user.id, 'deletion_requested', session);
    send(res, 202, { deletion: deletionOf(user) });
    return true;
  }
  if (path === '/users/@me/delete/cancel' && method === 'POST') {
    const { user } = requireSession(who);
    Object.assign(user, { deletionRequestedAt: null, deletionScheduledFor: null });
    send(res, 200, userObject(user));
    return true;
  }

  // ---- Upload keys (§7.3) ----
  if (path === '/users/@me/upload-keys' && method === 'GET') {
    const { user } = requireSession(who);
    const items = keyStore
      .filter((each) => each.userId === user.id && (keyState(each) === 'active' || now() - (each.revokedAt ?? each.expiresAt ?? now()) <= 30 * DAY))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(keyObject);
    send(res, 200, { items, limit: UPLOAD_KEYS_MAX });
    return true;
  }
  if (path === '/users/@me/upload-keys' && method === 'POST') {
    const { user } = requireSession(who);
    const body = await readJson(req);
    const name = cleanDisplayName(String(body.name ?? '')).slice(0, 64) || 'Upload key';
    const scopes = body.scopes === undefined ? ['files:upload'] : Array.isArray(body.scopes) ? [...new Set(body.scopes.map(String))] : null;
    if (!scopes || !scopes.includes('files:upload') || scopes.some((scope) => scope !== 'files:upload' && scope !== 'albums:append')) {
      throw invalid('scopes', 'scopes must include files:upload, and may add albums:append.');
    }
    const expiresIn = body.expires_in ?? null;
    if (expiresIn !== null && !KEY_EXPIRIES.has(Number(expiresIn))) throw invalid('expires_in', 'expires_in must be 30, 90 or 365 days, or null.');
    let domainId: string | null = null;
    if (body.domain_id !== undefined && body.domain_id !== null) {
      const domain = domainStore.get(String(body.domain_id));
      if (!domain || domain.userId !== user.id || domain.deletedAt) throw bad('UNKNOWN_DOMAIN', 'Unknown domain.');
      domainId = domain.id;
    }
    if (activeKeys(user.id).length >= UPLOAD_KEYS_MAX) throw bad('UPLOAD_KEY_LIMIT', `You can have up to ${UPLOAD_KEYS_MAX} active upload keys.`, { limit: UPLOAD_KEYS_MAX });
    const key = addKey(user.id, { name, scopes, domainId, expiresAt: expiresIn === null ? null : now() + Number(expiresIn) });
    const sharex = {
      Version: '17.0.0',
      Name: `files.gg (${name})`,
      DestinationType: 'ImageUploader, TextUploader, FileUploader',
      RequestMethod: 'POST',
      RequestURL: `${API_PUBLIC_URL}/files`,
      Headers: { Authorization: `Key ${key.secret}` },
      Body: 'MultipartFormData',
      FileFormName: 'file',
      URL: '{json:url}',
      ErrorMessage: '{json:message}',
    };
    const curl = `curl -H "Authorization: Key ${key.secret}" \\\n     -F "file=@photo.png" \\\n     ${API_PUBLIC_URL}/files`;
    send(res, 201, { key: keyObject(key), secret: key.secret, sharex, curl });
    return true;
  }
  if ((match = /^\/users\/@me\/upload-keys\/([^/]+)$/.exec(path)) && (method === 'PATCH' || method === 'DELETE')) {
    const { user } = requireSession(who);
    const key = keyStore.find((each) => each.id === match![1] && each.userId === user.id);
    if (!key) throw bad('UNKNOWN_UPLOAD_KEY', 'Unknown upload key.', {}, 404);
    if (method === 'DELETE') {
      if (key.revokedAt === null) Object.assign(key, { revokedAt: now(), revokedReason: 'owner' });
      send(res, 204);
      return true;
    }
    const body = await readJson(req);
    if (body.scopes !== undefined || body.expires_in !== undefined) throw invalid('scopes', 'Scopes and expiry can’t change. Make a new key.');
    if (body.name !== undefined) key.name = cleanDisplayName(String(body.name)).slice(0, 64) || key.name;
    if (body.domain_id !== undefined) {
      if (body.domain_id === null) key.domainId = null;
      else {
        const domain = domainStore.get(String(body.domain_id));
        if (!domain || domain.userId !== user.id || domain.deletedAt) throw bad('UNKNOWN_DOMAIN', 'Unknown domain.');
        key.domainId = domain.id;
      }
    }
    send(res, 200, keyObject(key));
    return true;
  }

  // ---- Domains (§10.5, §10.6, §10.13) ----
  if (path === '/users/@me/domains' && method === 'GET') {
    const { user } = requireSession(who);
    send(res, 200, {
      items: userDomains(user.id).sort((a, b) => a.createdAt - b.createdAt).map(domainObject),
      limit: isPremium(user.id) ? PREMIUM_CUSTOM_DOMAINS : 0,
      domain_only: domainOnlyState(user),
    });
    return true;
  }
  if (path === '/users/@me/domains' && method === 'POST') {
    const { user } = requireSession(who);
    const body = await readJson(req);
    if (!isPremium(user.id)) throw bad('PREMIUM_REQUIRED', 'Custom domains need premium.', {}, 403);
    if (!user.email || !user.emailVerified) throw bad('DOMAIN_REQUIREMENTS', 'Verify your email to add a domain.', { reason: 'email_not_verified' }, 403);
    if (now() - user.createdAt < 7 * DAY) throw bad('DOMAIN_REQUIREMENTS', 'Your account is too new to add a domain.', { reason: 'account_too_new', available_at: user.createdAt + 7 * DAY }, 403);
    checkDomainAdds(user.id);
    if (countedDomains(user.id).length >= PREMIUM_CUSTOM_DOMAINS) throw bad('DOMAIN_LIMIT_REACHED', `You can add up to ${PREMIUM_CUSTOM_DOMAINS} domains.`, { limit: PREMIUM_CUSTOM_DOMAINS });
    const result = normalizeHostname(String(body.hostname ?? ''));
    if ('reason' in result) throw bad('INVALID_HOSTNAME', 'That hostname can’t be used.', { reason: result.reason, errors: { hostname: 'That hostname can’t be used.' } });
    if ([...domainStore.values()].some((each) => each.hostname === result.hostname && !each.deletedAt)) throw bad('DOMAIN_TAKEN', 'That domain is already on files.gg.', {}, 409);
    domainAdds.set(user.id, [...(domainAdds.get(user.id) ?? []), now()]);
    const domain = addDomain(user.id, result.hostname, { auto: true });
    send(res, 201, domainObject(domain));
    return true;
  }
  if ((match = /^\/users\/@me\/domains\/([^/]+)\/(verify|retry)$/.exec(path)) && method === 'POST') {
    const { user } = requireSession(who);
    const domain = ownDomain(user.id, match[1]!);
    if (match[2] === 'verify') {
      const last = domainChecks.get(domain.id) ?? 0;
      if (now() - last < 60) throw bad('DOMAIN_CHECK_RATE_LIMITED', 'You can check once a minute.', { retry_after: last + 60 - now() }, 429);
      domainChecks.set(domain.id, now());
      domain.lastCheckedAt = now();
      send(res, 200, domainObject(domain));
      return true;
    }
    if (domain.status !== 'failed') throw bad('DOMAIN_NOT_FAILED', 'Only a failed domain can be retried.', {}, 409);
    if (!isPremium(user.id)) throw bad('PREMIUM_REQUIRED', 'Custom domains need premium.', {}, 403);
    checkDomainAdds(user.id);
    domainAdds.set(user.id, [...(domainAdds.get(user.id) ?? []), now()]);
    Object.assign(domain, { status: 'pending_dns', statusReason: null, auto: true, createdAt: now(), lastCheckedAt: now(), failingSince: null });
    send(res, 200, domainObject(domain));
    return true;
  }
  if ((match = /^\/users\/@me\/domains\/([^/]+)$/.exec(path)) && (method === 'PATCH' || method === 'DELETE')) {
    const { user } = requireSession(who);
    const domain = ownDomain(user.id, match[1]!);
    if (method === 'DELETE') {
      if (domain.status === 'disabled') throw bad('DOMAIN_DISABLED', 'files.gg disabled this domain, so it can’t be removed.', {}, 409);
      Object.assign(domain, { deletedAt: now(), isDefault: false });
      for (const key of keyStore) if (key.domainId === domain.id) key.domainId = null;
      send(res, 204);
      return true;
    }
    const body = await readJson(req);
    if (body.default === true) {
      if (!['active', 'failing'].includes(domainStatus(domain))) throw bad('DOMAIN_NOT_ACTIVE', 'Only an active domain can be the default.', {}, 409);
      for (const other of userDomains(user.id)) other.isDefault = other === domain;
    } else if (body.default === false) {
      domain.isDefault = false;
    }
    if (body.scope !== undefined) {
      if (body.scope !== 'own' && body.scope !== 'any') throw invalid('scope', 'scope must be own or any.');
      if (body.scope === 'any' && body.confirm !== true) throw invalid('confirm', 'Confirm that other people’s files will be viewable on your domain.');
      domain.scope = body.scope;
    }
    send(res, 200, domainObject(domain));
    return true;
  }
  if (path === '/users/@me/domain-only/preview' && method === 'GET') {
    const { user } = requireSession(who);
    send(res, 200, domainOnlyAffected(user));
    return true;
  }
  if (path === '/users/@me/domain-only' && method === 'PUT') {
    const { user } = requireSession(who);
    const body = await readJson(req);
    if (!isPremium(user.id)) throw bad('PREMIUM_REQUIRED', 'Domain-only mode needs premium.', {}, 403);
    const enabled = body.enabled === true;
    if (enabled && !user.domainOnly) {
      if (!userDomains(user.id).some(domainServing)) throw bad('DOMAIN_ONLY_NOT_AVAILABLE', 'Add a working domain first.', {}, 409);
      if (body.confirm !== true) throw invalid('confirm', 'Confirm that files.gg links will stop working.');
    }
    user.domainOnly = enabled;
    send(res, 200, { ...domainOnlyState(user), ...domainOnlyAffected(user) });
    return true;
  }
  return false;
}

/** `domain_add`: 10 adds and retries a day per user (§10.13). */
function checkDomainAdds(userId: string) {
  const recent = (domainAdds.get(userId) ?? []).filter((at) => at > now() - DAY);
  domainAdds.set(userId, recent);
  if (recent.length >= 10) throw bad('TOO_MANY_ATTEMPTS', 'You’ve added a lot of domains today. Try again tomorrow.', { retry_after: recent[0]! + DAY - now() }, 429);
}

// ---- Admin (§9.3, §10.12) ----

const adminDomainSummary = (domain: StoredDomain) => ({
  ...domainObject(domain),
  owner: { id: domain.userId, username: USERS.get(domain.userId)?.username ?? null },
  cf_hostname_id: domain.cfHostnameId,
});

function adminDomainDetail(viewer: Persona, domain: StoredDomain) {
  return {
    ...adminDomainSummary(domain),
    cases: [...cases.values()].filter((c) => c.kind === 'domain' && c.targetId === domain.id && canSeeCase(viewer, c)).map(caseSummary),
    actions: auditLog.filter((row) => row.domainId === domain.id).map(auditPayload).reverse(),
  };
}

async function accountAdminRoute(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, staff: Persona): Promise<boolean> {
  const method = req.method ?? 'GET';
  let match: RegExpExecArray | null;
  if (method === 'GET' && path === '/admin/domains') {
    const q = (query.get('q') ?? '').trim().toLowerCase();
    const status = query.get('status');
    const list = [...domainStore.values()]
      .filter((each) => !each.deletedAt && (!q || each.hostname.includes(q)) && (!status || domainStatus(each) === status))
      .sort((a, b) => b.createdAt - a.createdAt);
    const page = cursorPage(list, query);
    send(res, 200, { items: page.items.map(adminDomainSummary), next_cursor: page.next_cursor });
    return true;
  }
  if (method === 'GET' && (match = /^\/admin\/domains\/([^/]+)$/.exec(path))) {
    const domain = domainStore.get(match[1]!);
    if (!domain) throw bad('UNKNOWN_DOMAIN', 'Unknown domain.', {}, 404);
    send(res, 200, adminDomainDetail(staff, domain));
    return true;
  }
  if ((match = /^\/admin\/users\/([^/]+)\/entitlements(?:\/([^/]+))?$/.exec(path))) {
    if (!isAdmin(staff)) throw forbidden();
    const user = USERS.get(match[1]!);
    if (!user) throw bad('UNKNOWN_USER', 'Unknown user.', {}, 404);
    const body = await readJson(req);
    const note = cleanText(body.note, 2000).trim();
    if (!note) throw invalid('note', 'Add a note for the audit log.');
    const expiresAt = body.expires_at === undefined || body.expires_at === null ? null : Number(body.expires_at);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now())) throw invalid('expires_at', 'The expiry must be in the future.');
    const audit = (action: string, entitlement: StoredEntitlement) =>
      logAction(staff.id, 'staff', action, { userId: user.id, note, details: { entitlement_id: entitlement.id, kind: entitlement.kind, expires_at: entitlement.expiresAt } });
    if (!match[2] && method === 'POST') {
      if ((body.kind ?? 'premium') !== 'premium') throw invalid('kind', 'kind must be premium.');
      if (activeEntitlement(user.id)) throw bad('ENTITLEMENT_EXISTS', 'This account already has premium. Change its expiry instead.', {}, 409);
      const entitlement: StoredEntitlement = { id: nextId(), userId: user.id, kind: 'premium', grantedBy: staff.id, grantedAt: now(), expiresAt, revokedAt: null, revokedBy: null, note };
      entitlementStore.push(entitlement);
      audit('grant_entitlement', entitlement);
      send(res, 201, entitlementPayload(entitlement));
      return true;
    }
    const entitlement = match[2] ? entitlementStore.find((each) => each.id === match![2] && each.userId === user.id) : undefined;
    if (match[2] && (method === 'PATCH' || method === 'DELETE')) {
      if (!entitlement || entitlement.revokedAt !== null) throw bad('UNKNOWN_ENTITLEMENT', 'Unknown entitlement.', {}, 404);
      if (method === 'PATCH') {
        Object.assign(entitlement, { expiresAt, note });
        audit('change_entitlement', entitlement);
      } else {
        Object.assign(entitlement, { revokedAt: now(), revokedBy: staff.id, note });
        audit('revoke_entitlement', entitlement);
      }
      send(res, 200, entitlementPayload(entitlement));
      return true;
    }
  }
  return false;
}

// ---- Seed (milestone-6 mock accounts) ----

function seedAccounts() {
  const at = now();
  entitlementStore.push({ id: nextId((at - 30 * DAY) * 1000), userId: '48', kind: 'premium', grantedBy: '42', grantedAt: at - 30 * DAY, expiresAt: null, revokedAt: null, revokedBy: null, note: 'Early supporter.' });
  logAction('42', 'staff', 'grant_entitlement', { userId: '48', note: 'Early supporter.', details: { kind: 'premium', expires_at: null }, at: at - 30 * DAY });

  addKey('42', { name: 'Laptop ShareX', scopes: ['files:upload', 'albums:append'], createdAt: at - 30 * DAY, lastUsedAt: at - 2 * 3600 });
  addKey('42', { name: 'Old phone', createdAt: at - 120 * DAY, lastUsedAt: at - 40 * DAY, revokedAt: at - 3 * DAY, revokedReason: 'owner' });
  exportStore.push({ id: nextId((at - 2 * DAY) * 1000), userId: '42', createdAt: at - 2 * DAY });

  const old = at - 50 * DAY;
  const active = addDomain('48', 'i.priya.example', { status: 'active', isDefault: true, createdAt: old, verifiedAt: old + 600, lastCheckedAt: at - 3600 });
  addDomain('48', 'cdn.priya.example', { status: 'pending_dns', createdAt: at - 3 * 3600, lastCheckedAt: at - 600 });
  addDomain('48', 'img.priya.example', { status: 'pending_cert', createdAt: at - 2 * 3600, lastCheckedAt: at - 300 });
  addDomain('48', 'old.priya.example', { status: 'failing', createdAt: old, verifiedAt: old + 600, failingSince: at - DAY, lastCheckedAt: at - 1800 });
  addDomain('48', 'dead.priya.example', { status: 'failed', statusReason: 'dns_timeout', createdAt: at - 10 * DAY, lastCheckedAt: at - 7 * DAY, cfHostnameId: null });
  const disabled = addDomain('48', 'bad.priya.example', { status: 'disabled', statusBeforeDisable: 'active', disabledReason: 'phishing', createdAt: old, verifiedAt: old + 600, lastCheckedAt: at - 2 * DAY });
  const row = logAction('43', 'staff', 'disable_domain', { rule: 'phishing', domainId: disabled.id, at: at - 2 * DAY });
  disabled.disabledActionId = row.id;
  createNotice('48', row, 'disable_domain', 'phishing', { kind: 'domain', id: disabled.id, name: disabled.hostname, hostname: disabled.hostname }, null, at - 2 * DAY);

  const domainCase = caseFor('domain', active.id);
  domainCase.createdAt = at - 3600;
  addReport({ kind: 'domain', domainId: active.id, targetVanity: null, reason: 'malware', reporterUserId: '79', details: 'This domain shows a copy of a bank login page.', caseId: domainCase.id, createdAt: at - 3600 });
}

function banPayload(ban: StoredBan) {
  return { id: ban.id, kind: ban.kind, source: ban.source, rule: ban.rule, note: ban.note, created_at: ban.createdAt, expires_at: ban.expiresAt, lifted_at: ban.liftedAt };
}

export function mockApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? '';
    if (url !== MOCK_API_PREFIX && !url.startsWith(`${MOCK_API_PREFIX}/`) && !url.startsWith(`${MOCK_API_PREFIX}?`)) return next();
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
