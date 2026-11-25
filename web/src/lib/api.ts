/**
 * files.gg API client for the dashboard.
 *
 * - Base URL: `VITE_API_URL`, default https://api.files.gg.
 * - Auth: `Authorization` from localStorage `token`; `X-Fingerprint` from
 *   localStorage `fingerprint` (anonymous uploads). Same keys and JSON encoding
 *   as the old Mithril app, so sessions carry over on the same origin.
 * - Errors: non-2xx responses throw `ApiError` with the `{ code, message }` body.
 *
 * Response shapes follow docs/redesign/PLAN.md (Phase 1); endpoints marked
 * "planned" don't exist on the API yet.
 */

import { getLegacyString, setLegacyString } from './storage';

export const DEFAULT_API_URL = 'https://api.files.gg';

export const TOKEN_KEY = 'token';
export const FINGERPRINT_KEY = 'fingerprint';

/**
 * The API origin. A path such as `/__mock-api` (the dev mock, see vite.plugins.ts)
 * is resolved against the page's origin.
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

export type ApiErrorCode = string | number | null;

export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** API error code (numeric today, string codes like FILE_TOO_LARGE planned), or null. */
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
    const parsedCode = typeof code === 'string' || typeof code === 'number' ? code : null;
    const parsedMessage = typeof message === 'string' && message ? message : fallback;
    return new ApiError(status, parsedCode, parsedMessage, body);
  }
  return new ApiError(status, null, fallback, body);
}

export const hasToken = (): boolean => Boolean(getLegacyString(TOKEN_KEY));

/** Auth headers from localStorage. Storage failures simply mean "no header". */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getLegacyString(TOKEN_KEY);
  if (token) {
    headers.Authorization = token;
  }
  const fingerprint = getLegacyString(FINGERPRINT_KEY);
  // Like the old app: the fingerprint identifies anonymous uploads, so it is only
  // sent while signed out. Fingerprint files are claimed on login.
  if (fingerprint && !token) {
    headers['X-Fingerprint'] = fingerprint;
  }
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
  /** Defaults to true. */
  auth?: boolean;
}

/**
 * Anonymous uploads and limits need a fingerprint (contract §6). Reuses the old
 * app's stored one, or asks the API for a new one (`GET /auth/fingerprint`).
 */
export async function ensureFingerprint(): Promise<string | null> {
  if (hasToken()) return null;
  const existing = getLegacyString(FINGERPRINT_KEY);
  if (existing) return existing;
  const { fingerprint } = await request<{ fingerprint: string | number }>('/auth/fingerprint', { auth: false });
  const value = String(fingerprint);
  setLegacyString(FINGERPRINT_KEY, value);
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
  const { method = 'GET', query, body, signal, auth = true } = options;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(auth ? authHeaders() : {}),
    ...options.headers,
  };

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
    response = await fetch(buildUrl(path, query), { method, headers, body: payload, signal: signal ?? null });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError(0, CLIENT_ERROR.network, "Couldn't reach files.gg. Check your connection and try again.");
  }

  if (!response.ok) {
    throw await parseApiError(response);
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

/** `GET /users/@me`. Discriminators are being dropped for unique usernames. */
export interface Me {
  id: string;
  username: string;
  /** planned: optional free-text name. */
  display_name?: string | null;
  flags: number;
  bot?: boolean;
  email: string | null;
  verified: boolean;
  /** planned: set when a username clashed in the migration and must be re-picked. */
  needs_username?: boolean;
}

/** One file, as `File.to_dict()` returns it, plus the Milestone 2 fields. */
export interface UserFile {
  id: string;
  vanity: string;
  mimetype: string;
  extension: string;
  /** Name without the extension. */
  name: string;
  /** `name` + `.` + `extension`. */
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Milliseconds. */
  duration: number | null;
  urls: { main: string; cdn: string };
  views: number;
  /** Epoch seconds, or null when the file never expires (contract §6). */
  expires_at?: number | null;
  visibility?: Visibility;
}

export type FileSort = 'newest' | 'oldest' | 'largest' | 'name';
export type FileTypeFilter = 'image' | 'video' | 'audio' | 'text' | 'other';

export interface MyFilesParams {
  query?: string;
  sort_by?: FileSort;
  type?: FileTypeFilter;
  temporary?: boolean;
  offset?: number;
  limit?: number;
}

/**
 * `GET /users/@me/files` (planned). `count`/`size` describe the matched set
 * (search applied); `total` describes everything the user owns.
 */
export interface MyFilesResponse {
  count: number;
  items: UserFile[];
  size: number;
  total: { count: number; size: number };
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

/** `POST /{files|albums}/<vanity>/unlock`: the token plus the full payload (`file` or `album`). */
export interface UnlockResponse extends AccessGrant {
  file?: unknown;
  album?: unknown;
}

/** `GET /{files|albums}/<vanity>/view` with `X-Filesgg-Access`. */
export interface ViewResponse {
  file?: unknown;
  album?: unknown;
  expires_at: number;
}

const accessBase = (kind: AccessKind, vanity: string) =>
  `/${kind === 'album' ? 'albums' : 'files'}/${vanity.split('/').map(encodeURIComponent).join('/')}`;

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
}

/** `POST /files` response, and `file` in a completed upload session. */
export interface UploadedFile extends UserFile {
  expires_at: number | null;
  visibility: Visibility;
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

export const api = {
  me: (signal?: AbortSignal) => request<Me>('/users/@me', { signal }),
  myFiles: (params: MyFilesParams = {}, signal?: AbortSignal) =>
    request<MyFilesResponse>('/users/@me/files', { query: { limit: 25, ...params }, signal }),
  myLimits: (signal?: AbortSignal) => request<MyLimitsResponse>('/users/@me/limits', { signal }),

  unlock: (kind: AccessKind, vanity: string, password: string, turnstileToken: string) =>
    request<UnlockResponse>(`${accessBase(kind, vanity)}/unlock`, {
      method: 'POST',
      body: { password, turnstile_token: turnstileToken },
      auth: false,
    }),
  /**
   * Contract §5 defines this for files only. Albums use the symmetric
   * `/albums/<vanity>/unlock/refresh`, which still needs adding to the contract.
   */
  refreshUnlock: (kind: AccessKind, vanity: string, token: string) =>
    request<AccessGrant>(`${accessBase(kind, vanity)}/unlock/refresh`, { method: 'POST', body: { token }, auth: false }),
  view: (kind: AccessKind, vanity: string, token: string) =>
    request<ViewResponse>(`${accessBase(kind, vanity)}/view`, { headers: { 'X-Filesgg-Access': token }, auth: false }),

  createUpload: (body: UploadParams & { filename: string; size: number }) =>
    request<UploadSession>('/uploads', { method: 'POST', body }),
  uploadStatus: (id: string, signal?: AbortSignal) =>
    request<UploadStatus>(`/uploads/${encodeURIComponent(id)}`, { signal }),
  completeUpload: (id: string) =>
    request<{ status: UploadSessionStatus }>(`/uploads/${encodeURIComponent(id)}/complete`, { method: 'POST' }),
  abortUpload: (id: string) => request<void>(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
