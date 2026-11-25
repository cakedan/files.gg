/**
 * Unlock tokens on the client (milestone-2 §5, milestone-3 §3): storing them per vanity,
 * refresh timing, and the `#pw=` / `#t=` fragments. A token is the visitor's proof for
 * the API only (`X-Filesgg-Access` on `/access/view/…`, the body of `/access/refresh/…`);
 * it never goes into a CDN URL. Media URLs arrive signed in the payloads (lib/signedUrls.ts).
 * The token is opaque here except for reading its claims, for timing only.
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
 * Pasting a `#pw=` / `#t=` link into a tab already on that page is a same-document
 * hash change: no reload, so the load-time `takeFragmentSecrets` never sees it. This
 * strips it the same way and hands it on. Returns the unsubscribe function.
 */
export function watchFragmentSecrets(
  onSecrets: (secrets: FragmentSecrets) => void,
  win: Window = window,
): () => void {
  const handle = () => {
    const secrets = takeFragmentSecrets(win.location, win.history);
    if (secrets.password !== undefined || secrets.ownerPass !== undefined) onSecrets(secrets);
  };
  win.addEventListener('hashchange', handle);
  return () => win.removeEventListener('hashchange', handle);
}

/**
 * Which file or album a page URL is for, from the path: `/a/<vanity>` is an
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
