import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';

import { accountApi } from '../../lib/accountApi';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { safeNext, useSession } from '../../lib/session';

/** Shown after a sign-in that moved this browser's anonymous uploads into the account (§4.2). */
export const CLAIMED_TOAST = 'Signed in. Files you uploaded from this browser are now in your account.';

/** The toast after a sign-in: the claim note only when there was a guest and nothing blocks claiming. */
export function signedInToast(hadGuest: boolean, pendingDeletion: boolean): string | undefined {
  return hadGuest && !pendingDeletion ? CLAIMED_TOAST : undefined;
}

/** `GET /auth/config`: Discord is hidden when the API has no Discord app (§15). */
export function useAuthConfig() {
  return useQuery({ queryKey: ['auth', 'config'], queryFn: ({ signal }) => accountApi.config(signal), staleTime: Infinity, retry: false });
}

/** The validated `?next=` (§6.1), as a path below `/app`. */
export function useNext(): string | null {
  const [params] = useSearchParams();
  return safeNext(params.get('next'));
}

/** Auth-page wording for the shared codes (§13.2). */
export function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CAPTCHA_INVALID') return 'Couldn’t verify you’re human. Try again.';
    if (error.code === 'TOO_MANY_ATTEMPTS') {
      const wait = (error.body as { retry_after?: unknown } | undefined)?.retry_after;
      if (typeof wait === 'number' && wait > 0) {
        const minutes = Math.max(1, Math.ceil(wait / 60));
        return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
      }
      return 'Too many attempts. Try again later.';
    }
  }
  if (error instanceof Error && error.message.startsWith('turnstile')) return 'Couldn’t verify you’re human. Try again.';
  return errorMessage(error);
}

/** Where a signed-in visitor of the sign-in and register pages goes: `next` or the dashboard (§6.1). Null signed out. */
export function useSignedInTarget(): string | null {
  const session = useSession();
  const next = useNext();
  return session.data ? (next ?? '/') : null;
}

/** Tokens already taken from the address bar, by path (StrictMode renders twice). */
const fragmentTokens = new Map<string, string | null>();

/**
 * Email links carry their token in the fragment (§2.5, §6.1): read once, then removed
 * from the address bar with `replaceState`, so it never lands in history or a Referer.
 */
export function readFragmentToken(): string | null {
  const { pathname, search, hash } = window.location;
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  if (token) {
    fragmentTokens.set(pathname, token);
    window.history.replaceState(window.history.state, '', pathname + search);
  }
  return fragmentTokens.get(pathname) ?? null;
}

/** Test hook. */
export const forgetFragmentTokens = () => fragmentTokens.clear();
