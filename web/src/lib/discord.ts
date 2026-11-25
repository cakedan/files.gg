/**
 * Discord sign-in with PKCE (milestone-6 §5.2). The browser makes and keeps the
 * verifier; the API signs `state` and holds the client secret. What the callback page
 * needs is kept in sessionStorage `filesgg.oauth`: `{ verifier, state, purpose, next }`.
 */

import { accountApi, type DiscordPurpose } from './accountApi';
import { getSessionItem, removeSessionItem, setSessionItem } from './storage';

export const OAUTH_KEY = 'filesgg.oauth';

export interface StoredOAuth {
  verifier: string;
  state: string;
  purpose: DiscordPurpose;
  /** A dashboard path below `/app` to return to. */
  next: string | null;
  /** Set once a `prompt=none` attempt has been retried without it (§5.2 step 6). */
  retried?: boolean;
}

/** Base64url without padding (RFC 7636 appendix A). */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url: 43 characters. */
export function makeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** `code_challenge` for S256: base64url(SHA-256(ASCII verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function loadOAuth(): StoredOAuth | null {
  const raw = getSessionItem(OAUTH_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredOAuth>;
    if (typeof value.verifier !== 'string' || typeof value.state !== 'string' || !['login', 'link', 'reauth'].includes(String(value.purpose))) return null;
    return { verifier: value.verifier, state: value.state, purpose: value.purpose!, next: typeof value.next === 'string' ? value.next : null, retried: value.retried === true };
  } catch {
    return null;
  }
}

export const saveOAuth = (value: StoredOAuth) => setSessionItem(OAUTH_KEY, JSON.stringify(value));
export const clearOAuth = () => removeSessionItem(OAUTH_KEY);

/** Full-page navigations, in one place so tests can watch them. */
export const browser = {
  assign: (url: string) => window.location.assign(url),
};

/** Drops `prompt` from Discord's authorize URL, for the one retry after a `prompt=none` failure. */
export function withoutPrompt(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('prompt');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Starts Discord: a fresh verifier, `POST /auth/discord/authorize`, the stored state, then
 * the redirect. Throws `ApiError`s (rate limits, `ACCOUNT_SUSPENDED` for a link, …).
 */
export async function startDiscord(purpose: DiscordPurpose, next: string | null, { retry = false }: { retry?: boolean } = {}): Promise<void> {
  const verifier = makeVerifier();
  const challenge = await pkceChallenge(verifier);
  const { url, state } = await accountApi.discordAuthorize(purpose, challenge);
  saveOAuth({ verifier, state, purpose, next, retried: retry });
  browser.assign(retry ? withoutPrompt(url) : url);
}
