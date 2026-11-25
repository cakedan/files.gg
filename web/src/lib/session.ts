/**
 * Signed-in state (milestone-6 §13.1). The session is an HttpOnly cookie that scripts
 * never see, so "am I signed in?" is `GET /auth/session`, held in one TanStack query:
 * stale after 60 s and refetched on focus. Tabs stay in step through a BroadcastChannel:
 * after a sign-in, a sign-out or a `401`, the tab posts `"session-changed"` and every
 * other tab refetches.
 */

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { fetchSession, FINGERPRINT_KEY, setSignedInState, type User } from './api';
import { removeItem } from './storage';

export const SESSION_QUERY_KEY = ['auth', 'session'] as const;
export const SESSION_STALE_MS = 60_000;
export const SESSION_CHANNEL = 'filesgg-session';
export const SESSION_CHANGED = 'session-changed';

/** The signed-in user, or `null` signed out. `data` is undefined until the first answer. */
export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: SESSION_STALE_MS,
    refetchOnWindowFocus: true,
  });
}

/** Writes a user (from a sign-in or a settings change) into the session query. */
export function setSessionUser(client: QueryClient, user: User | null): void {
  setSignedInState(user !== null);
  client.setQueryData(SESSION_QUERY_KEY, user);
}

/** Tells the other tabs to refetch their session. */
export function broadcastSessionChange(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.postMessage(SESSION_CHANGED);
    channel.close();
  } catch {
    // Channels can be unavailable (some privacy modes); tabs then catch up on focus.
  }
}

/**
 * A different account (or none) in this tab: everything cached belonged to the old one.
 * The session query is kept and refetched, so nothing renders as signed out meanwhile.
 */
export function resetAccountCache(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0] });
}

/** Refetches the session when another tab signs in or out, and clears the cache if the account changed. */
export function useSessionSync(): void {
  const client = useQueryClient();
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(SESSION_CHANNEL);
    } catch {
      return;
    }
    channel.onmessage = (event: MessageEvent) => {
      if (event.data !== SESSION_CHANGED) return;
      const before = client.getQueryData<User | null>(SESSION_QUERY_KEY);
      void client.fetchQuery({ queryKey: SESSION_QUERY_KEY, queryFn: ({ signal }) => fetchSession(signal), staleTime: 0 }).then((after) => {
        if ((before?.id ?? null) !== (after?.id ?? null)) resetAccountCache(client);
      });
    };
    return () => channel.close();
  }, [client]);
}

/**
 * After any successful sign-in (password, register, reset, Discord): the anonymous
 * fingerprint is gone (its uploads were claimed, §4.2), the cache belonged to someone
 * else, and the other tabs need to know.
 */
export function useCompleteSignIn() {
  const client = useQueryClient();
  return useCallback(
    (user: User) => {
      removeItem(FINGERPRINT_KEY);
      resetAccountCache(client);
      setSessionUser(client, user);
      broadcastSessionChange();
    },
    [client],
  );
}

/** After sign-out (or a 401): no user, nothing cached, other tabs told. */
export function signedOut(client: QueryClient): void {
  resetAccountCache(client);
  setSessionUser(client, null);
  broadcastSessionChange();
}

/** `next` must be a dashboard path (§6.1): `/app/…`, no `//`, no scheme. Returns the path below `/app`. */
export function safeNext(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/^\/app(\/|$)/.test(value) || value.includes('//') || value.includes('\\') || /\p{Cc}/u.test(value)) return null;
  const inner = value.slice('/app'.length) || '/';
  return inner.startsWith('/') ? inner : null;
}

/** The sign-in link for a dashboard page (`/app/login?next=/app/files`). */
export const loginPath = (next?: string) => (next && next !== '/' ? `/login?next=${encodeURIComponent(`/app${next}`)}` : '/login');
