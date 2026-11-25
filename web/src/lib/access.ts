/**
 * Signed access tokens on the client (contract §1, §5): storing unlock tokens per
 * vanity, refresh timing, appending `?t=` to media URLs, and the `#pw=` / `#t=`
 * fragments. The token is opaque here except for reading its claims (never trusted
 * for anything but timing: the CDN and API verify the signature).
 */

import type { AccessGrant, AccessKind } from './api';
import { getItem, removeItem, setItem } from './storage';

// ---------------------------------------------------------------------------
// Storage: one unlock token per vanity, until it expires
// ---------------------------------------------------------------------------

export const accessStorageKey = (kind: AccessKind, vanity: string) => `filesgg.access.${kind}.${vanity}`;

/** The stored unlock token for this vanity, or null (expired ones are dropped). */
export function loadAccess(kind: AccessKind, vanity: string, nowMs: number = Date.now()): AccessGrant | null {
  const raw = getItem(accessStorageKey(kind, vanity));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AccessGrant>;
    if (typeof parsed.token === 'string' && typeof parsed.expires_at === 'number' && parsed.expires_at * 1000 > nowMs) {
      return { token: parsed.token, expires_at: parsed.expires_at };
    }
  } catch {
    // Corrupt entry: fall through and drop it.
  }
  removeItem(accessStorageKey(kind, vanity));
  return null;
}

export function saveAccess(kind: AccessKind, vanity: string, grant: AccessGrant): void {
  setItem(accessStorageKey(kind, vanity), JSON.stringify({ token: grant.token, expires_at: grant.expires_at }));
}

export function clearAccess(kind: AccessKind, vanity: string): void {
  removeItem(accessStorageKey(kind, vanity));
}

// ---------------------------------------------------------------------------
// Refresh timing
// ---------------------------------------------------------------------------

/** Refresh this long before expiry (or at half the remaining life, if shorter). */
export const REFRESH_LEAD_MS = 5 * 60 * 1000;
/** Media URLs switch to a newer token only when theirs has less than this left. */
export const URL_SWAP_LEAD_MS = 2 * 60 * 1000;
/** After a failed refresh (network), try again after this long. */
export const REFRESH_RETRY_MS = 30 * 1000;

/** Milliseconds until the token should be refreshed; 0 means now. */
export function refreshDelay(expiresAt: number, nowMs: number): number {
  const remaining = expiresAt * 1000 - nowMs;
  if (remaining <= 0) return 0;
  return Math.max(0, remaining - Math.min(REFRESH_LEAD_MS, remaining / 2));
}

/**
 * Whether a refresh got anywhere. The server caps tokens at `u + unlock_ttl` and the
 * password expiry; once it returns the same (or an earlier) expiry, stop asking and
 * let the token run out.
 */
export const refreshExtended = (previous: AccessGrant, next: AccessGrant): boolean => next.expires_at > previous.expires_at;

/**
 * Media URLs keep the token they were built with (changing them would reload images,
 * restart video and re-open PDFs). They move to the freshest token only when theirs
 * is about to expire. Returns the delay until that swap.
 */
export function urlSwapDelay(urlExpiresAt: number, nowMs: number): number {
  return Math.max(0, urlExpiresAt * 1000 - URL_SWAP_LEAD_MS - nowMs);
}

// ---------------------------------------------------------------------------
// Claims (contract §1), read without verification, for timing and routing only
// ---------------------------------------------------------------------------

export interface TokenClaims {
  k: AccessKind;
  t: string;
  s: 'unlock' | 'owner';
  v: number;
  u: number;
  e: number;
}

function base64UrlDecode(input: string): string | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function readTokenClaims(token: string): TokenClaims | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const json = base64UrlDecode(body);
  if (!json) return null;
  try {
    const claims = JSON.parse(json) as Partial<TokenClaims>;
    if ((claims.k === 'file' || claims.k === 'album') && typeof claims.e === 'number' && typeof claims.t === 'string') {
      return claims as TokenClaims;
    }
  } catch {
    // Not a token.
  }
  return null;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Sets `t=<token>` on a URL, keeping its other parameters (`download=true` and so on). */
export function appendToken(url: string, token: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('t', token);
    return parsed.toString();
  } catch {
    const [base = '', hash] = url.split('#', 2);
    const joined = `${base}${base.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
    return hash === undefined ? joined : `${joined}#${hash}`;
  }
}

interface Tokenisable {
  cdnUrl: string;
  thumbnail?: { url: string } | undefined;
  hover_url?: string | undefined;
  visibility?: string | undefined;
}

/**
 * The payload with `?t=` on every media URL: `cdnUrl` (so Download and Raw, which
 * derive from it, carry it too), the thumbnail and the hover clip. `link` files are
 * public, so they never get a token. The share `url` is never touched.
 */
export function withAccessToken<T extends Tokenisable>(file: T, token: string): T {
  if (file.visibility === 'link') return file;
  return {
    ...file,
    cdnUrl: appendToken(file.cdnUrl, token),
    thumbnail: file.thumbnail ? { ...file.thumbnail, url: appendToken(file.thumbnail.url, token) } : file.thumbnail,
    hover_url: file.hover_url ? appendToken(file.hover_url, token) : file.hover_url,
  };
}

export function albumWithAccessToken<
  A extends { items: T[]; cover?: { url: string } | undefined; accessToken?: string | undefined },
  T extends Tokenisable,
>(album: A, token: string): A {
  return {
    ...album,
    accessToken: token,
    cover: album.cover ? { ...album.cover, url: appendToken(album.cover.url, token) } : album.cover,
    items: album.items.map((item) => withAccessToken(item, token)),
  };
}

// ---------------------------------------------------------------------------
// Fragments: #pw=<password> and #t=<owner pass>
// ---------------------------------------------------------------------------

export interface FragmentSecrets {
  password?: string;
  ownerPass?: string;
  /** The fragment with both removed (`#page=3` and the like survive). */
  rest: string;
}

export function readFragmentSecrets(hash: string): FragmentSecrets {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const password = params.get('pw') ?? undefined;
  const ownerPass = params.get('t') ?? undefined;
  params.delete('pw');
  params.delete('t');
  const rest = params.toString();
  return {
    ...(password ? { password } : {}),
    ...(ownerPass ? { ownerPass } : {}),
    rest: rest ? `#${rest}` : '',
  };
}

/**
 * Reads and immediately strips `#pw=` / `#t=` from the address bar with
 * replaceState, so a password or pass never lingers in the URL or history entry.
 */
export function takeFragmentSecrets(loc: Location = window.location, history: History = window.history): FragmentSecrets {
  const secrets = readFragmentSecrets(loc.hash);
  if (secrets.password !== undefined || secrets.ownerPass !== undefined) {
    history.replaceState(history.state, '', `${loc.pathname}${loc.search}${secrets.rest}`);
  }
  return secrets;
}

/**
 * Which file or album a page URL is for, from the path: `/a/<vanity>[/<n>]` is an
 * album; anything else is a file vanity (everything before the first `.`, so
 * multi-segment ShareX vanities like `/abcd/xyz.png` work).
 */
export function targetFromPath(pathname: string): { kind: AccessKind; vanity: string } | null {
  const album = /^\/a\/([^/]+)/.exec(pathname);
  if (album) return { kind: 'album', vanity: decodeURIComponent(album[1]!) };
  const path = pathname.replace(/^\/+/, '');
  const vanity = path.split('.')[0]?.replace(/\/+$/, '') ?? '';
  if (!vanity || vanity.endsWith('.html')) return null;
  return { kind: 'file', vanity: decodeURIComponent(vanity) };
}
