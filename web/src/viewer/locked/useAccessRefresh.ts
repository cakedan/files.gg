import { useEffect, useRef, useState } from 'react';

import { clearAccess, REFRESH_RETRY_MS, refreshDelay, refreshExtended, saveAccess } from '../../lib/access';
import { api, ApiError, type AccessGrant, type AccessKind } from '../../lib/api';
import { useSignedValue } from '../../lib/signedUrls';
import { contentFrom, type Content } from './content';

/** setTimeout overflows past ~24.8 days; long waits re-check once a day instead. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

function schedule(at: number, run: () => void, recheck: () => void): number {
  const delay = at - Date.now();
  if (delay > MAX_TIMER_MS) return window.setTimeout(recheck, MAX_TIMER_MS);
  return window.setTimeout(run, Math.max(0, delay));
}

interface Options {
  kind: AccessKind;
  vanity: string;
  /** Both refresh (owner passes cap at u + 12 h). Only unlock tokens are stored. */
  scope: 'unlock' | 'owner';
  onExpired: () => void;
}

interface Unlocked {
  grant: AccessGrant;
  content: Content;
}

/**
 * Keeps an unlock (or owner pass) alive while the viewer is open:
 * - refreshes the token (`/unlock/refresh`) shortly before it expires, until the
 *   server's cap (`u + unlock_ttl`, password expiry) stops extending it;
 * - stores each new token for the vanity;
 * - `UNLOCK_EXPIRED`, or reaching the expiry, calls `onExpired` (back to the lock screen);
 * - returns the content to render. Each refresh brings the payload again with freshly
 *   signed URLs; the page keeps the URLs it has until they're about to expire, then
 *   moves to the newest payload, so a refresh never reloads media.
 */
export function useAccessRefresh(initial: Unlocked, { kind, vanity, scope, onExpired }: Options): Content {
  const [fresh, setFresh] = useState(initial);
  const [capped, setCapped] = useState(false);
  const [tick, setTick] = useState(0);
  /** After a failed (network) refresh: when to try again. */
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const expiredRef = useRef(onExpired);
  useEffect(() => {
    expiredRef.current = onExpired;
  });

  // Refresh before expiry.
  useEffect(() => {
    if (capped) return;
    let cancelled = false;
    const { grant } = fresh;
    const id = schedule(
      retryAt ?? Date.now() + refreshDelay(grant.expires_at, Date.now()),
      () => {
        api
          .refreshUnlock(kind, vanity, grant.token)
          .then((response) => {
            if (cancelled) return;
            const next = { token: response.token, expires_at: response.expires_at };
            if (!refreshExtended(grant, next)) setCapped(true);
            setRetryAt(null);
            setFresh((current) => ({ grant: next, content: contentFrom(kind, response) ?? current.content }));
            if (scope === 'unlock') saveAccess(kind, vanity, next);
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            if (error instanceof ApiError && error.status === 401) {
              if (scope === 'unlock') clearAccess(kind, vanity);
              expiredRef.current();
            } else {
              setRetryAt(Date.now() + REFRESH_RETRY_MS);
            }
          });
      },
      () => setTick((n) => n + 1),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [fresh, capped, kind, vanity, scope, tick, retryAt]);

  // Hard stop at expiry.
  useEffect(() => {
    const id = schedule(
      fresh.grant.expires_at * 1000,
      () => {
        if (scope === 'unlock') clearAccess(kind, vanity);
        expiredRef.current();
      },
      () => setTick((n) => n + 1),
    );
    return () => window.clearTimeout(id);
  }, [fresh, kind, vanity, scope, tick]);

  // The URLs on screen stay until they're about to expire.
  return useSignedValue(fresh.content);
}
