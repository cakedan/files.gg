/**
 * The Discord callback's pure parts (milestone-6 §5.2): reading the query once, and the
 * first outcome that needs no request.
 */

import type { StoredOAuth } from '../../lib/discord';

export const EXPIRED_TEXT = 'This sign-in link expired. Try again.';
export const CANCELLED_TEXT = 'Discord sign-in was cancelled.';
export const FAILED_TEXT = 'Discord couldn’t sign you in. Try again.';

export interface CallbackQuery {
  code: string | null;
  state: string | null;
  error: string | null;
}

/** Read once per page load: the query is removed from the address bar straight away. */
let captured: CallbackQuery | null = null;

export function captureQuery(): CallbackQuery {
  if (captured) return captured;
  const params = new URLSearchParams(window.location.search);
  captured = { code: params.get('code'), state: params.get('state'), error: params.get('error') };
  if (window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname);
  return captured;
}

/** Test hook. */
export const forgetDiscordQuery = () => {
  captured = null;
};

export type FirstStep =
  /** Stop with this message; nothing is sent (a `state` mismatch, a cancel, a missing code). */
  | { kind: 'stop'; message: string }
  /** §5.2 step 6: retry once without `prompt`. */
  | { kind: 'retry' }
  | { kind: 'callback'; code: string };

/** What to do first, before any request. A `state` that doesn't match the stored one sends nothing. */
export function firstStep(oauth: StoredOAuth | null, query: CallbackQuery): FirstStep {
  if (!oauth || !query.state || query.state !== oauth.state) return { kind: 'stop', message: EXPIRED_TEXT };
  if (query.error) {
    // Anything but a cancel after `prompt=none` (login and re-auth) is retried once, without it.
    if (query.error !== 'access_denied' && oauth.purpose !== 'link' && !oauth.retried) return { kind: 'retry' };
    return { kind: 'stop', message: query.error === 'access_denied' ? CANCELLED_TEXT : FAILED_TEXT };
  }
  if (!query.code) return { kind: 'stop', message: EXPIRED_TEXT };
  return { kind: 'callback', code: query.code };
}
