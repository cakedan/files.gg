/**
 * files.gg API client for the dashboard and the files.gg viewer's lazy chunks.
 *
 * - Base URL: same-origin `/api` (milestone-6 §13.1), the Worker's `files.gg/api/*`
 *   passthrough. `VITE_API_URL` overrides it only for unusual local setups.
 * - Auth: the session is the HttpOnly `__Host-filesgg_session` cookie, which JavaScript
 *   never sees; requests use `credentials: "same-origin"` so the browser sends it.
 *   Every non-GET request carries `X-Filesgg-Csrf: 1` (§3.6). `X-Fingerprint` from
 *   localStorage `filesgg.fingerprint` identifies anonymous uploads while signed out.
 * - Signed-in state comes from `GET /auth/session` (lib/session.ts); this module only
 *   remembers the last answer, so it knows whether to send the fingerprint.
 * - Errors: non-2xx responses throw `ApiError` with the `{ code, message, status, ... }`
 *   body. A `401` on a signed-in call, `403 CSRF` and `403 ACCOUNT_PENDING_DELETION` are
 *   also announced to `onAuthEvent` listeners (the dashboard's session layer).
 *
 * Response shapes follow docs/redesign/contracts/milestone-2.md to milestone-6.md (later
 * milestones win): snake_case payloads, times in epoch seconds, and URLs ready to use.
 */

import type { AlbumPart, ReportReason } from './reportTypes';
import { getItem, setItem } from './storage';

/** Same-origin: the dashboard and the files.gg viewer never call api.files.gg directly. */
export const DEFAULT_API_URL = '/api';
/** The API's public origin, used by tools (ShareX, curl) and by custom-domain viewers. */
export const PUBLIC_API_URL = 'https://api.files.gg';

export const FINGERPRINT_KEY = 'filesgg.fingerprint';
export const CSRF_HEADER = 'X-Filesgg-Csrf';

/**
 * The API origin. A path (the default `/api`, or the dev mock's prefix) is resolved
 * against the page's origin.
 */
export function apiBaseUrl(value: string | undefined = import.meta.env.VITE_API_URL): string {
  let base = value?.trim() || DEFAULT_API_URL;
  if (base.startsWith('/') && typeof window !== 'undefined') base = window.location.origin + base;
  return base.replace(/\/+$/, '');
}

/** Error codes produced by the client itself rather than the API. */
export const CLIENT_ERROR = {
  network: 'NETWORK_ERROR',
  invalidResponse: 'INVALID_RESPONSE',
} as const;

/** A string code such as `FILE_TOO_LARGE`, or null when the body had none. */
export type ApiErrorCode = string | null;

export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** API error code (`FILE_TOO_LARGE`, `UNLOCK_EXPIRED`, …), or null. */
  readonly code: ApiErrorCode;
  /** The parsed error body, for extra fields such as `limit` and `used`. */
  readonly body: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/** Builds an ApiError from a failed response. Never throws. */
export async function parseApiError(response: Response): Promise<ApiError> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return apiErrorFromText(response.status, response.statusText, '');
  }
  return apiErrorFromText(response.status, response.statusText, text);
}

/** Builds an ApiError from a status and raw body (shared with the XHR upload path). */
export function apiErrorFromText(status: number, statusText: string, text: string): ApiError {
  const fallback = statusText || `Request failed with status ${status}`;
  let body: unknown = text || undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON (an HTML error page from a proxy, for example).
  }

  if (typeof body === 'object' && body !== null) {
    const { code, message } = body as { code?: unknown; message?: unknown };
    const parsedCode = typeof code === 'string' && code ? code : null;
    const parsedMessage = typeof message === 'string' && message ? message : fallback;
    return new ApiError(status, parsedCode, parsedMessage, body);
  }
  return new ApiError(status, null, fallback, body);
}

const stored = (key: string): string | null => getItem(key) || null;

// ---------------------------------------------------------------------------
// Session state (milestone-6 §3, §13.1). The cookie is invisible to scripts; this is
// only the last answer of `GET /auth/session`, kept so the client knows whether to send
// the anonymous fingerprint and whether a 401 means "you were signed out".
// ---------------------------------------------------------------------------

let signedIn: boolean | null = null;

/** `true` or `false` once `GET /auth/session` has answered; `null` before. */
export const signedInState = (): boolean | null => signedIn;

export function setSignedInState(value: boolean | null): void {
  signedIn = value;
}

export type AuthEvent =
  /** A signed-in call got `401`: the server already cleared the cookie. */
  | { type: 'unauthorized' }
  /** `403 CSRF`: a client bug, never normal use. */
  | { type: 'csrf'; error: ApiError }
  /** `403 ACCOUNT_PENDING_DELETION`: the account was locked (in another tab, say). */
  | { type: 'pending-deletion' };

const authListeners = new Set<(event: AuthEvent) => void>();

/** Subscribes to session failures seen by any request. Returns the unsubscribe function. */
export function onAuthEvent(listener: (event: AuthEvent) => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

/** Announces the session-level failures in an API error (also used by the XHR upload path). */
export function reportApiFailure(error: ApiError, path: string): void {
  let event: AuthEvent | null = null;
  if (error.status === 401 && signedIn === true && !path.startsWith('/auth/')) event = { type: 'unauthorized' };
  else if (error.status === 403 && error.code === 'CSRF') {
    console.error(`files.gg: ${path} was refused as a cross-site request (403 CSRF). This is a bug in the web app.`);
    event = { type: 'csrf', error };
  } else if (error.code === 'ACCOUNT_PENDING_DELETION') event = { type: 'pending-deletion' };
  if (event) for (const listener of [...authListeners]) listener(event);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Headers for a call to `/api`: the anonymous fingerprint while signed out, and the CSRF
 * header on every state-changing method (§3.6). Never a credential: the cookie is the
 * browser's. Storage failures simply mean "no fingerprint".
 */
export function authHeaders(method = 'GET'): Record<string, string> {
  const headers: Record<string, string> = {};
  const fingerprint = stored(FINGERPRINT_KEY);
  // The fingerprint identifies anonymous uploads, so it is only sent while signed out.
  // Fingerprint files are claimed on sign-in, which also deletes it (§4.2).
  if (fingerprint && signedIn !== true) headers['X-Fingerprint'] = fingerprint;
  if (!SAFE_METHODS.has(method.toUpperCase())) headers[CSRF_HEADER] = '1';
  return headers;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  query?: Record<string, QueryValue>;
  /** Plain objects are sent as JSON; FormData/Blob/strings are sent as-is. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Send the anonymous fingerprint (while signed out). Defaults to true. */
  auth?: boolean;
  /** Defaults to `same-origin` (the session cookie). `omit` also drops the CSRF header. */
  credentials?: RequestCredentials;
}

/** `GET /auth/session` (§3.4): never 401; `user` is null when signed out. */
export interface SessionResponse {
  user: User | null;
}

/** Asks who is signed in, and remembers the answer for the fingerprint and 401 handling. */
export async function fetchSession(signal?: AbortSignal): Promise<User | null> {
  const response = await request<SessionResponse | undefined>('/auth/session', { signal });
  const user = response?.user ?? null;
  setSignedInState(user !== null);
  return user;
}

let sessionCheck: Promise<boolean> | null = null;

/** The known sign-in state, asking `GET /auth/session` once if nobody has yet. */
async function knownSignedIn(): Promise<boolean> {
  if (signedIn !== null) return signedIn;
  sessionCheck ??= fetchSession()
    .then((user) => user !== null)
    .catch(() => false)
    .finally(() => {
      sessionCheck = null;
    });
  return sessionCheck;
}

/**
 * Anonymous uploads and limits need a fingerprint (milestone-2 §6). Signed in, there's
 * none. Signed out, reuses the stored one, or asks the API for a new one.
 */
export async function ensureFingerprint(): Promise<string | null> {
  if (await knownSignedIn()) return null;
  const existing = stored(FINGERPRINT_KEY);
  if (existing) return existing;
  const { fingerprint } = await request<{ fingerprint: string }>('/auth/fingerprint', { auth: false });
  const value = String(fingerprint);
  setItem(FINGERPRINT_KEY, value);
  return value;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>, base: string = apiBaseUrl()): string {
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function isRawBody(body: unknown): body is BodyInit {
  return (
    typeof body === 'string' ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer
  );
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, signal, auth = true, credentials = 'same-origin' } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const standard = authHeaders(method);
  if (auth && standard['X-Fingerprint']) headers['X-Fingerprint'] = standard['X-Fingerprint'];
  // Same-origin writes prove where they came from (§3.6); a credential-less call needs no proof.
  if (credentials !== 'omit' && standard[CSRF_HEADER]) headers[CSRF_HEADER] = standard[CSRF_HEADER];
  Object.assign(headers, options.headers);

  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (isRawBody(body)) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), { method, headers, body: payload, signal: signal ?? null, credentials });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError(0, CLIENT_ERROR.network, "Couldn't reach files.gg. Check your connection and try again.");
  }

  if (!response.ok) {
    const error = await parseApiError(response);
    reportApiFailure(error, path);
    throw error;
  }
  if (response.status === 204 || method === 'HEAD') {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, CLIENT_ERROR.invalidResponse, 'The server sent an invalid response.', text);
  }
}

// ---------------------------------------------------------------------------
// Shapes (PLAN.md Phase 1). Fields marked "planned" are not returned yet.
// ---------------------------------------------------------------------------

/** A linked login method (milestone-6 §2.1, §5.6). Only Discord for now. */
export interface Identity {
  provider: 'discord';
  username: string | null;
  display_name: string | null;
  /** `cdn.discordapp.com`, loaded only in Settings → Login methods. */
  avatar_url: string | null;
  created_at: number;
  last_used_at: number | null;
}

/** The user object (milestone-6 §2.1): `GET /users/@me`, `/auth/session` and sign-in responses. */
export interface User {
  id: string;
  username: string;
  display_name: string | null;
  /** Null for Discord-only accounts that never added one. */
  email: string | null;
  email_verified: boolean;
  /** An email change waiting for its link (§8.4). */
  pending_email: string | null;
  has_password: boolean;
  /** Set by a staff username reset (§11.4): the dashboard asks for a new name. */
  needs_username: boolean;
  created_at: number;
  username_changed_at: number | null;
  /** Null when a rename is allowed now (§2.2 cooldown). */
  username_change_available_at: number | null;
  identities: Identity[];
  settings: { show_name_on_albums: boolean; domain_only: boolean };
  premium: { active: boolean; expires_at: number | null };
  /** Set while a deletion is pending (§8.8). */
  deletion: { requested_at: number; scheduled_for: number } | null;
  /** Milestone 4 (§8.3): present for staff, null otherwise. */
  staff: StaffInfo | null;
  /** Milestone 4 (§8.3): active upload restrictions and suspensions. */
  restrictions: Restriction[];
}

/** @deprecated The Milestone 6 name is `User`. */
export type Me = User;

/** The public user object (album owner lines, report targets shown to staff). */
export interface PublicUser {
  id: string;
  username: string;
  display_name: string | null;
}

/** `sort_by` (milestone-3 contract §6). `-created` is the default. */
export const FILE_SORTS = ['-created', 'created', '-size', 'size', 'name', '-name'] as const;
export type FileSort = (typeof FILE_SORTS)[number];
/** `type` filter, by `kind` (`other` is `kind: "file"`). */
export const FILE_TYPE_FILTERS = ['image', 'video', 'audio', 'text', 'pdf', 'other'] as const;
export type FileTypeFilter = (typeof FILE_TYPE_FILTERS)[number];

export interface MyFilesParams {
  query?: string | undefined;
  sort_by?: FileSort | undefined;
  type?: FileTypeFilter | undefined;
  visibility?: Visibility | undefined;
  /** Only files with an `expires_at`. */
  temporary?: boolean | undefined;
  offset?: number | undefined;
  /** 1–100, default 25. */
  limit?: number | undefined;
}

/**
 * `GET /users/@me/files`. `count`/`size` describe the matched set (search and
 * filters applied); `total` describes everything the user owns.
 */
export interface MyFilesResponse {
  count: number;
  items: OwnerFile[];
  size: number;
  total: { count: number; size: number };
}

// ---------------------------------------------------------------------------
// Milestone 3: media, owner files and albums (milestone-3 contract §4, §6)
// ---------------------------------------------------------------------------

export type FileKind = 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'file';

/** Preview kinds (contract §3), the keys of `assets`. */
export const PREVIEW_KINDS = ['thumb', 'thumb-2x', 'display', 'poster', 'cover', 'waveform', 'peaks', 'hover'] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

/**
 * One ready preview. The URL is ready to use (contract §4): plain for `link` files,
 * signed (`expires=…&sig=…`, 1 h in owner payloads) for protected ones. Never changed here.
 */
export interface MediaAsset {
  url: string;
  width?: number | undefined;
  height?: number | undefined;
}

export interface Thumbnail extends MediaAsset {
  type: 'thumb' | 'poster' | 'cover' | 'waveform' | (string & {});
}

/** `probe` output (contract §2). Every key is optional; `snippet` is owner-only. */
export interface FileMedia {
  width?: number;
  height?: number;
  /** Milliseconds. */
  duration?: number;
  framecount?: number;
  fps?: number;
  playable?: boolean;
  has_audio?: boolean;
  codecs?: string[];
  container?: string;
  tags?: { title?: string; artist?: string; album?: string; track?: number };
  pages?: number;
  lines?: number;
  language?: string | null;
  /** First ~12 lines of a text file. Only in the owner list. */
  snippet?: string;
}

/**
 * The file payload (contract §4). One shape everywhere: `/files/<vanity>`, upload
 * responses, unlock, view, refresh, album items and the owner list.
 */
export interface FilePayload {
  id: string;
  vanity: string;
  kind: FileKind;
  mimetype: string;
  extension: string;
  /** Name without the extension. */
  name: string;
  /** `name` + `.` + `extension`. */
  filename: string;
  size: number;
  width?: number | null;
  height?: number | null;
  /** Milliseconds. */
  duration?: number | null;
  framecount?: number | null;
  /** The share link, `https://files.gg/<vanity>.<ext>`. */
  url: string;
  /** The file on the CDN, ready to use (signed when protected). Download adds `?download=true`. */
  cdn_url: string;
  /**
   * Milestone 6 (§10.9), owner payloads only: the bytes on the link domain (the default
   * custom domain when it's serving), signed like `cdn_url`. "Copy direct link".
   */
  direct_url?: string;
  /** Epoch seconds. */
  uploaded_at: number;
  /** Epoch seconds, or null when the file never expires. */
  expires_at: number | null;
  visibility: Visibility;
  media?: FileMedia | null;
  /** True while `probe`/`derive` haven't finished. */
  processing?: boolean;
  assets?: Partial<Record<PreviewKind, MediaAsset>>;
  thumbnail?: Thumbnail | null;
  hover_url?: string | null;
  /** Milestone 4 (§4.4): computed from the uploader's mark, the classifier and overrides. */
  nsfw?: boolean;
  views?: number;
  /** Milestone 4 (§6.1): scan warnings shown to visitors (`encrypted_archive`, …). */
  warnings?: string[];
  /** Milestone 4 (§6.1): up to 20 URLs Web Risk flagged. */
  link_warnings?: string[];
}

/**
 * The owner file (contract §6): the payload plus the access settings, `media.snippet`
 * and the albums it's in. Every URL in it is signed for 1 h, so refetch before then.
 */
export interface OwnerFile extends FilePayload {
  access_version: number;
  /** Seconds. */
  unlock_ttl: number;
  /** Epoch seconds, or null. */
  password_expires_at: number | null;
  show_name_when_locked: boolean;
  albums: AlbumRef[];
  /** Milestone 4 (§6.2). A payload without it is treated as `ok`. */
  safety?: OwnerSafety;
  /** Milestone 6 (§19.6): 1–1000 unique viewers, or null (or absent) for no limit. */
  view_limit?: number | null;
  view_limit_action?: ViewLimitAction;
  /** Unique viewers counted so far. Never reset by changing the limit. */
  views_used?: number;
}

export interface AlbumRef {
  id: string;
  vanity: string;
  title: string;
}

/** A generated password comes back once (contract M2 §6). */
export interface GeneratedPassword {
  password?: string;
  url_with_password?: string;
}

export type AlbumLayout = 'auto' | 'grid' | 'list' | 'tracklist';
export const ALBUM_LAYOUTS: readonly AlbumLayout[] = ['auto', 'grid', 'list', 'tracklist'];

export interface Collage extends MediaAsset {
  width: number;
  height: number;
}

/** `GET /users/@me/albums` items. */
export interface OwnerAlbumSummary {
  id: string;
  vanity: string;
  url: string;
  title: string;
  layout: AlbumLayout;
  visibility: Visibility;
  count: number;
  cover?: Thumbnail | null;
  collage?: Collage | null;
  /** Epoch seconds. */
  created_at: number;
  updated_at: number;
  /** Milestone 4: the album's mark or any shown item's (§4.4). */
  nsfw?: boolean;
  /** Milestone 4 (§6.2). */
  safety?: AlbumSafety;
}

export interface OwnerAlbumItem extends OwnerFile {
  position: number;
  caption: string;
  /** False when the public album page hides it (contract §4). */
  shown: boolean;
  /** Milestone 6 §19.6: `view_limit` when it's hidden because the file is view-limited. */
  hidden_reason?: string | null;
}

/** `GET /users/@me/albums/<id>`: every item (≤ 500), hidden ones included. */
export interface OwnerAlbum extends Omit<OwnerAlbumSummary, 'count'> {
  description: string;
  nsfw?: boolean;
  /** "Download all": `https://cdn.files.gg/albums/download/<vanity>.zip`, signed when protected. */
  download_url?: string;
  /** Epoch seconds, or null (anonymous albums). */
  expires_at?: number | null;
  count?: number;
  access_version: number;
  unlock_ttl: number;
  password_expires_at: number | null;
  show_name_when_locked: boolean;
  cover_file_id: string | null;
  items: OwnerAlbumItem[];
  /** Milestone 4 (§6.2): the explicit mark (`albums.nsfw`), by the owner or staff. */
  nsfw_marked?: boolean;
  link_warnings?: string[];
}

export interface MyAlbumsParams {
  query?: string | undefined;
  sort_by?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface MyAlbumsResponse {
  count: number;
  items: OwnerAlbumSummary[];
}

/** Access fields shared by file and album `PATCH`, and the bulk access call. */
export interface AccessParams {
  visibility?: Visibility;
  password?: string;
  generate_password?: boolean;
  unlock_ttl?: UnlockTtl;
  /** Epoch seconds, or null for "never" (`PATCH` only). */
  password_expires_at?: number | null;
  password_expires_in?: number;
  show_name_when_locked?: boolean;
}

export interface PatchFileBody extends AccessParams {
  /** Renames the name only; the extension stays. */
  filename?: string;
  /** Milestone 4 (§4.5): mark or unmark as sensitive. */
  nsfw?: boolean;
  /** Milestone 6 (§19.3): set, raise or lower (above `views_used`), or null to remove. */
  view_limit?: number | null;
  view_limit_action?: ViewLimitAction;
}

export interface PatchAlbumBody extends AccessParams {
  /** Milestone 4 (§4.5): the album's own mark. */
  nsfw?: boolean;
  title?: string;
  description?: string;
  layout?: AlbumLayout;
  cover_file_id?: string | null;
}

export interface CreateAlbumBody {
  title?: string;
  description?: string;
  layout?: AlbumLayout;
  file_ids: string[];
  cover_file_id?: string;
}

/** `POST /users/@me/{files|albums}/<id>/pass`: `url` is `https://files.gg/<vanity>#t=<token>`. */
export interface OwnerPass extends AccessGrant {
  url: string;
}

/** `GET /users/@me/limits` (contract §6). Anonymous callers get the anonymous values. */
export interface MyLimitsResponse {
  storage: { used: number; limit: number | null };
  max_file_size_single: number;
  max_file_size_chunked: number;
  /** Seconds, or null for no maximum. */
  max_expiry: number | null;
  allow_no_expiry: boolean;
  anonymous: boolean;
  /** Milestone 3: 500, or 50 anonymous. */
  album_max_files?: number;
  /** Milestone 3: 1000, or null anonymous. */
  albums_max?: number | null;
  /** Milestone 4 (§13): true signed in and not restricted, false anonymous. */
  nsfw_allowed?: boolean;
  /** Milestone 6 (§9.2): premium raises storage, chunked and single-request limits. */
  premium?: boolean;
  /** The single-request limit before the proxy's body cap (§9.2, §9.5). */
  max_file_size_single_configured?: number;
  custom_domains?: { used: number; limit: number };
  upload_keys?: { used: number; limit: number };
}

// ---------------------------------------------------------------------------
// Access (contract §5)
// ---------------------------------------------------------------------------

export type Visibility = 'link' | 'password' | 'private';
export type AccessKind = 'file' | 'album';

export interface AccessGrant {
  token: string;
  /** Epoch seconds. */
  expires_at: number;
}

/**
 * `POST /access/unlock/…`, `GET /access/view/…` and `POST /access/refresh/…` (milestone-3 §3): the
 * payload (`file` or `album`) with URLs signed for this visitor, plus the token for the
 * API and its expiry.
 */
export interface UnlockResponse extends AccessGrant {
  file?: unknown;
  album?: unknown;
}

export type ViewResponse = UnlockResponse;

/**
 * Milestone 6 §19.4: opening a view-limited file. `file` is the payload with URLs signed
 * for 1 h (or until the file expires), `view_limit: { remaining }` included. There is no
 * token: the viewer refreshes by opening again, which never counts the same viewer twice.
 */
export interface OpenResponse {
  file?: unknown;
  /** Epoch seconds: when the signed URLs stop working. */
  expires_at: number;
}

/** The access routes' actions (milestone-6 §20.1). */
export type AccessAction = 'unlock' | 'refresh' | 'view' | 'open';

/**
 * The access routes (milestone-6 §20.1): the vanity is always the last path segment, so a
 * multi-segment vanity made of words (`unlock/view`) can never be read as an action:
 * `/access/<action>/files|albums/<vanity>`.
 */
export const accessPath = (action: AccessAction, kind: AccessKind, vanity: string) =>
  `/access/${action}/${kind === 'album' ? 'albums' : 'files'}/${vanity.split('/').map(encodeURIComponent).join('/')}`;

/** The open route (milestone-6 §19.4): `POST /access/open/files/<vanity>`. */
export const openPath = (vanity: string) => accessPath('open', 'file', vanity);

// ---------------------------------------------------------------------------
// Uploads (contract §6)
// ---------------------------------------------------------------------------

/** Seconds, per contract §6 `unlock_ttl`. */
export const UNLOCK_TTLS = [600, 3600, 86400, 604800, 2592000] as const;
export type UnlockTtl = (typeof UNLOCK_TTLS)[number];

/** Optional upload fields shared by `POST /files` and `POST /uploads`. */
export interface UploadParams {
  expires_in?: number;
  visibility?: Visibility;
  password?: string;
  generate_password?: boolean;
  unlock_ttl?: UnlockTtl;
  password_expires_in?: number;
  /** Anonymous uploads only, action `upload`. */
  turnstile_token?: string;
  /** Milestone 3: append to one of your albums (by vanity) once stored. */
  album?: string;
  /** Milestone 4 (§4.3): adult content. Signed in only. */
  nsfw?: boolean;
  /** Milestone 6 (§19.3): unique viewers before the action fires, 1–1000. */
  view_limit?: number;
  /** `private` needs an account (`400 PRIVATE_REQUIRES_ACCOUNT`). */
  view_limit_action?: ViewLimitAction;
}

/** Milestone 6 (§19.1): what happens at the limit. */
export type ViewLimitAction = 'expire' | 'private';

/** `POST /files` response, and `file` in a completed upload session: the file payload plus a generated password. */
export interface UploadedFile extends FilePayload {
  /** Milestone 4 (§6.2): upload responses carry the owner `safety` too. */
  safety?: OwnerSafety;
  /** Only with `generate_password`, shown once. */
  password?: string;
  /** `https://files.gg/<vanity>#pw=<password>`, only with `generate_password`. */
  url_with_password?: string;
}

export interface UploadSession {
  upload_id: string;
  chunk_size: number;
  chunk_count: number;
  /** Epoch seconds. */
  expires_at: number;
}

export type UploadSessionStatus = 'open' | 'processing' | 'complete' | 'failed';

export interface UploadStatus {
  status: UploadSessionStatus;
  received: number[];
  size: number;
  file?: UploadedFile;
  error?: string;
}

// ---------------------------------------------------------------------------
// Milestone 4: trust & safety (milestone-4 contract §6–§8). The admin calls (§9)
// live in src/app/admin/adminApi.ts, so they ship in the admin chunk only.
// ---------------------------------------------------------------------------

/** The owner's effective file state (§2.4, §6.2). `flagged` is public; owners only see its `warnings`. */
export type SafetyState = 'ok' | 'pending' | 'flagged' | 'hidden' | 'removed' | 'blocked';
export type NsfwSource = 'uploader' | 'auto' | 'moderator' | 'reports';
export type NsfwReview = 'none' | 'open' | 'done';

/** `safety` on owner files and upload responses (§6.2). */
export interface OwnerSafety {
  state: SafetyState;
  /**
   * The rule (§8.1) for `hidden` and `removed` (`review` when held or auto-hidden), the
   * scan reason code (§2.3) for `flagged` and `blocked`. CSAM only ever shows `review`
   * or `FILE_BLOCKED`.
   */
  reason: string | null;
  /** The notice explaining it, when there is one. */
  notice_id: string | null;
  nsfw_source: NsfwSource | null;
  /** True when the uploader can't unmark (§4.5). */
  nsfw_locked: boolean;
  nsfw_review: NsfwReview;
}

export interface AlbumSafety {
  state: 'ok' | 'hidden' | 'removed';
  reason: string | null;
  notice_id: string | null;
}

/** `reason` in `410 UPLOAD_REJECTED` (§2.5, §11.2). */
export const UPLOAD_REJECTION_REASONS = [
  'NSFW_REQUIRES_ACCOUNT',
  'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT',
  'ENCRYPTED_PDF_REQUIRES_ACCOUNT',
  'MALWARE_DETECTED',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_BLOCKED',
] as const;
export type UploadRejectionReason = (typeof UPLOAD_REJECTION_REASONS)[number];

export interface StaffInfo {
  role: 'moderator' | 'admin';
  child_safety: boolean;
}

/** §8.3 / §8.4. `until` is epoch seconds, or null until lifted. */
export interface Restriction {
  kind: 'uploads' | 'suspended';
  until: number | null;
  notice_id?: string | null;
}

/** `GET /users/@me/badges` (§8.3). */
export interface Badges {
  reports_unread: number;
  notices_unacknowledged: number;
  restrictions: Restriction[];
  /** Staff only; `p0` counts child-safety P0s only for child-safety staff. */
  staff: { open: number; p0: number; mine: number } | null;
}

// ---- Reports (§7) ----

export { REPORT_REASONS, type AlbumPart, type DmcaNotice, type ReportReason } from './reportTypes';

export const REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
/** Milestone 6 adds `domain` reports (§10.12). */
export type ReportKind = 'file' | 'album' | 'user' | 'domain' | 'bug';

/** The reporter's view of the target: never the uploader, the filename or its state (§7.5). */
export interface ReportTarget {
  type: ReportKind;
  vanity?: string | null;
  /** User reports. */
  id?: string | null;
  /** Domain reports (milestone-6 §10.12). */
  hostname?: string | null;
  url: string | null;
  part: AlbumPart | null;
}

/** A report as its (signed-in) reporter sees it (§7.5). */
export interface Report {
  id: string;
  kind: ReportKind;
  target: ReportTarget;
  reason: ReportReason;
  status: ReportStatus;
  /** 30 days after `resolved_at`: read only. */
  closed: boolean;
  /** `csam` reports: staff never post details into the thread. */
  escalated: boolean;
  can_reopen: boolean;
  unread: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  last_message_at: number | null;
}

export interface ReportMessage {
  id: string;
  /** Staff always show as "files.gg staff" (§7.6). */
  author: 'you' | 'staff';
  body: string;
  created_at: number;
}

export interface MyReportsParams {
  status?: ReportStatus | undefined;
  /** Matches the target vanity or URL. */
  query?: string | undefined;
  offset?: number | undefined;
  /** 1–100, default 25. */
  limit?: number | undefined;
}

export interface MyReportsResponse {
  count: number;
  items: Report[];
}

// ---- Notices and appeals (§8) ----

export type AppealState = 'none' | 'open' | 'granted' | 'denied';

export interface Notice {
  id: string;
  /** The moderation action (`hide`, `remove`, `scan_block`, `suspend_user`, …). */
  action: string;
  rule: string;
  /** Null for rules that are never shown (CSAM). */
  rule_text: string | null;
  message: string | null;
  /** Milestone 6: `domain` notices carry the `hostname` (§11.5). */
  target: { kind: 'file' | 'album' | 'account' | 'domain'; id: string; vanity?: string | null; name?: string | null; hostname?: string | null };
  created_at: number;
  acknowledged_at: number | null;
  appeal: {
    state: AppealState;
    can_appeal: boolean;
    appealed_at: number | null;
    decided_at: number | null;
    /** Staff's reply to a decided appeal. */
    message: string | null;
  };
}

export interface NoticesParams {
  unacknowledged?: boolean | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface NoticesResponse {
  count: number;
  unacknowledged: number;
  items: Notice[];
}

/** 17 U.S.C. § 512(g)(3): required to appeal a `copyright` notice (§8.2). */
export interface CounterNotice {
  name: string;
  address: string;
  phone: string;
  email: string;
  /** What was removed and where it was. */
  material: string;
  mistake_statement: true;
  jurisdiction_consent: true;
  service_consent: true;
  signature: string;
}

export interface AppealBody {
  message: string;
  counter_notice?: CounterNotice;
}

const fileUrl = (id: string) => `/users/@me/files/${encodeURIComponent(id)}`;
const reportUrl = (id: string) => `/users/@me/reports/${encodeURIComponent(id)}`;
const albumUrl = (id: string) => `/users/@me/albums/${encodeURIComponent(id)}`;

export const api = {
  /** `GET /auth/session`: the user, or null when signed out. */
  session: fetchSession,
  me: (signal?: AbortSignal) => request<User>('/users/@me', { signal }),
  myLimits: (signal?: AbortSignal) => request<MyLimitsResponse>('/users/@me/limits', { signal }),

  // Owner files (milestone-3 contract §6)
  myFiles: (params: MyFilesParams = {}, signal?: AbortSignal) =>
    request<MyFilesResponse>('/users/@me/files', { query: { limit: 25, ...params }, signal }),
  updateFile: (id: string, body: PatchFileBody) =>
    request<OwnerFile & GeneratedPassword>(fileUrl(id), { method: 'PATCH', body }),
  deleteFile: (id: string) => request<void>(fileUrl(id), { method: 'DELETE' }),
  /** At most 100 ids; ids you don't own are skipped. */
  deleteFiles: (fileIds: string[]) =>
    request<{ deleted: string[] }>('/users/@me/files/delete', { method: 'POST', body: { file_ids: fileIds } }),
  /** `expiresIn: null` is Keep forever (signed in only). */
  setFilesExpiry: (fileIds: string[], expiresIn: number | null) =>
    request<{ items: OwnerFile[] }>('/users/@me/files/expiry', { method: 'POST', body: { file_ids: fileIds, expires_in: expiresIn } }),
  /** One generated password is shared by the batch and returned once. */
  setFilesAccess: (fileIds: string[], access: AccessParams & { visibility: Visibility }) =>
    request<{ items: OwnerFile[]; password?: string }>('/users/@me/files/access', {
      method: 'POST',
      body: { file_ids: fileIds, ...access },
    }),
  /** `domainId`: open on one of your serving custom domains (§10.9). */
  filePass: (id: string, domainId?: string) =>
    request<OwnerPass>(`${fileUrl(id)}/pass`, { method: 'POST', ...(domainId ? { body: { domain_id: domainId } } : {}) }),

  // Albums
  createAlbum: (body: CreateAlbumBody) => request<OwnerAlbum>('/users/@me/albums', { method: 'POST', body }),
  myAlbums: (params: MyAlbumsParams = {}, signal?: AbortSignal) =>
    request<MyAlbumsResponse>('/users/@me/albums', { query: { ...params }, signal }),
  album: (id: string, signal?: AbortSignal) => request<OwnerAlbum>(albumUrl(id), { signal }),
  updateAlbum: (id: string, body: PatchAlbumBody) =>
    request<OwnerAlbum & GeneratedPassword>(albumUrl(id), { method: 'PATCH', body }),
  deleteAlbum: (id: string, deleteFiles = false) =>
    request<void>(albumUrl(id), { method: 'DELETE', query: { delete_files: deleteFiles || undefined } }),
  /** Sets the exact list and order. */
  setAlbumFiles: (id: string, fileIds: string[]) =>
    request<OwnerAlbum>(`${albumUrl(id)}/files`, { method: 'PUT', body: { file_ids: fileIds } }),
  /** Appends (or inserts at `position`); files already in the album are skipped. */
  addAlbumFiles: (id: string, fileIds: string[], position?: number) =>
    request<OwnerAlbum>(`${albumUrl(id)}/files`, {
      method: 'POST',
      body: position === undefined ? { file_ids: fileIds } : { file_ids: fileIds, position },
    }),
  removeAlbumFile: (id: string, fileId: string) =>
    request<OwnerAlbum>(`${albumUrl(id)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }),
  setAlbumCaption: (id: string, fileId: string, caption: string) =>
    request<OwnerAlbum>(`${albumUrl(id)}/files/${encodeURIComponent(fileId)}`, { method: 'PATCH', body: { caption } }),
  albumPass: (id: string, domainId?: string) =>
    request<OwnerPass>(`${albumUrl(id)}/pass`, { method: 'POST', ...(domainId ? { body: { domain_id: domainId } } : {}) }),

  unlock: (kind: AccessKind, vanity: string, password: string, turnstileToken: string) =>
    request<UnlockResponse>(accessPath('unlock', kind, vanity), {
      method: 'POST',
      body: { password, turnstile_token: turnstileToken },
      auth: false,
    }),
  /** A new token and the payload again, with freshly signed URLs (milestone-3 §3). */
  refreshUnlock: (kind: AccessKind, vanity: string, token: string) =>
    request<UnlockResponse>(accessPath('refresh', kind, vanity), { method: 'POST', body: { token }, auth: false }),
  view: (kind: AccessKind, vanity: string, token: string) =>
    request<ViewResponse>(accessPath('view', kind, vanity), { headers: { 'X-Filesgg-Access': token }, auth: false }),
  /**
   * Milestone 6 §19.4: opens a view-limited file (Turnstile action `view`). Same-origin with
   * the session cookie, so the owner and staff are served without counting.
   */
  openFile: (vanity: string, turnstileToken: string) =>
    request<OpenResponse>(openPath(vanity), { method: 'POST', body: { turnstile_token: turnstileToken }, auth: false }),

  createUpload: (body: UploadParams & { filename: string; size: number }) =>
    request<UploadSession>('/uploads', { method: 'POST', body }),
  uploadStatus: (id: string, signal?: AbortSignal) =>
    request<UploadStatus>(`/uploads/${encodeURIComponent(id)}`, { signal }),
  completeUpload: (id: string) =>
    request<{ status: UploadSessionStatus }>(`/uploads/${encodeURIComponent(id)}/complete`, { method: 'POST' }),
  abortUpload: (id: string) => request<void>(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Milestone 4: owner safety and NSFW (§6.2, §4.5)
  /** `410 UPLOAD_REJECTED { reason }` for 24 h after a rejection (§2.5). */
  myFile: (id: string, signal?: AbortSignal) => request<OwnerFile>(fileUrl(id), { signal }),
  setFileNsfw: (id: string, nsfw: boolean) => request<OwnerFile>(fileUrl(id), { method: 'PATCH', body: { nsfw } }),
  /** At most 100 ids; ids you don't own, or can't unmark, are skipped. */
  setFilesNsfw: (fileIds: string[], nsfw: boolean) =>
    request<{ items: OwnerFile[]; skipped: string[] }>('/users/@me/files/nsfw', { method: 'POST', body: { file_ids: fileIds, nsfw } }),
  /** `202`; once per file (`409 APPEAL_NOT_ALLOWED` after). */
  requestNsfwReview: (id: string, message?: string) =>
    request<void>(`${fileUrl(id)}/nsfw-review`, { method: 'POST', body: message ? { message } : {} }),
  badges: (signal?: AbortSignal) => request<Badges>('/users/@me/badges', { signal }),

  // Reports (§7); sending one is `sendReport` in reports.ts (the viewer's report chunk).
  myReports: (params: MyReportsParams = {}, signal?: AbortSignal) =>
    request<MyReportsResponse>('/users/@me/reports', { query: { limit: 25, ...params }, signal }),
  myReport: (id: string, signal?: AbortSignal) => request<Report>(reportUrl(id), { signal }),
  /** Oldest first. Marks the report read. */
  reportMessages: (id: string, signal?: AbortSignal) =>
    request<{ items: ReportMessage[] }>(`${reportUrl(id)}/messages`, { signal }),
  sendReportMessage: (id: string, body: string) =>
    request<ReportMessage>(`${reportUrl(id)}/messages`, { method: 'POST', body: { body } }),
  /** Only from `dismissed`, once, within 14 days (`409 REOPEN_NOT_ALLOWED`). */
  reopenReport: (id: string) => request<Report>(reportUrl(id), { method: 'PATCH', body: { status: 'open' } }),

  // Notices and appeals (§8)
  notices: (params: NoticesParams = {}, signal?: AbortSignal) =>
    request<NoticesResponse>('/users/@me/warnings', { query: { ...params }, signal }),
  acknowledgeNotices: (ids: string[]) =>
    request<{ acknowledged: string[] }>('/users/@me/warnings/acknowledge', { method: 'POST', body: { ids } }),
  appealNotice: (id: string, body: AppealBody) =>
    request<Notice>(`/users/@me/warnings/${encodeURIComponent(id)}/appeal`, { method: 'POST', body }),
};
