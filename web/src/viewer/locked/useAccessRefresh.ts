import { useEffect, useRef, useState } from 'react';

import {
  clearAccess,
  REFRESH_RETRY_MS,
  refreshDelay,
  refreshExtended,
  saveAccess,
  urlSwapDelay,
} from '../../lib/access';
import { api, ApiError, type AccessGrant, type AccessKind } from '../../lib/api';

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
  /** Both refresh (contract §5; owner passes cap at u + 12 h). Only unlock tokens are stored. */
  scope: 'unlock' | 'owner';
  onExpired: () => void;
}

/**
 * Keeps an access token alive while the viewer is open:
 * - refreshes it (`/unlock/refresh`) shortly before it expires, until the server's
 *   cap (`u + unlock_ttl`, password expiry) stops extending it;
 * - stores each new token for the vanity;
 * - `UNLOCK_EXPIRED`, or reaching the expiry, calls `onExpired` (back to the lock screen);
 * - returns the token for media URLs, which moves to a newer token only when its
 *   own is about to expire, so media doesn't reload on every refresh.
 */
export function useAccessRefresh(initial: AccessGrant, { kind, vanity, scope, onExpired }: Options): AccessGrant {
  const [fresh, setFresh] = useState(initial);
  const [urlGrant, setUrlGrant] = useState(initial);
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
    const id = schedule(
      retryAt ?? Date.now() + refreshDelay(fresh.expires_at, Date.now()),
      () => {
        api
          .refreshUnlock(kind, vanity, fresh.token)
          .then((next) => {
            if (cancelled) return;
            if (!refreshExtended(fresh, next)) setCapped(true);
            setRetryAt(null);
            setFresh(next);
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
      fresh.expires_at * 1000,
      () => {
        if (scope === 'unlock') clearAccess(kind, vanity);
        expiredRef.current();
      },
      () => setTick((n) => n + 1),
    );
    return () => window.clearTimeout(id);
  }, [fresh, kind, vanity, scope, tick]);

  // Move media URLs to the newest token only when theirs is about to run out.
  useEffect(() => {
    if (urlGrant.token === fresh.token) return;
    const id = schedule(
      Date.now() + urlSwapDelay(urlGrant.expires_at, Date.now()),
      () => setUrlGrant(fresh),
      () => setTick((n) => n + 1),
    );
    return () => window.clearTimeout(id);
  }, [fresh, urlGrant, tick]);

  return urlGrant;
}
