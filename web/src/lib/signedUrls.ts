/**
 * Signed CDN URLs (milestone-3 contract §3, §4). Payloads arrive with their URLs ready
 * to use: plain for `link` files, `?expires=…&sig=…` for protected ones. Clients never
 * build, sign or change them (except adding `?download=true`), so this only reads them:
 * when do the URLs a payload is showing stop working?
 *
 * A fresh payload (an unlock refresh, a refetched owner list) carries new signatures
 * for the same files. Swapping to it at once would reload every image and restart every
 * video, so `useSignedValue` keeps showing the old payload until its URLs are about to
 * expire, then moves to the newest one.
 */

import { useEffect, useMemo, useState } from 'react';

/** Move to fresher URLs once the ones on screen have less than this left. */
export const URL_SWAP_LEAD_MS = 2 * 60 * 1000;

/** setTimeout overflows past ~24.8 days, and signed URLs may last 31; re-check daily. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

/** `expires` (epoch seconds) from a signed URL's query, or null for a plain URL. */
export function signedUrlExpiry(url: string): number | null {
  const query = url.indexOf('?');
  if (query < 0 || !url.includes('sig=', query)) return null;
  const params = new URLSearchParams(url.slice(query + 1).split('#', 1)[0]);
  if (!params.has('sig')) return null;
  const expires = Number(params.get('expires'));
  return Number.isFinite(expires) && expires > 0 ? expires : null;
}

const looksSigned = (value: string) => value.includes('sig=') && value.includes('expires=');

/**
 * The earliest `expires` among the signed URLs anywhere in a payload (file, album and
 * its items, owner list), or null when none of its URLs are signed.
 */
export function earliestUrlExpiry(value: unknown): number | null {
  let earliest: number | null = null;
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      if (!looksSigned(node)) return;
      const expires = signedUrlExpiry(node);
      if (expires !== null && (earliest === null || expires < earliest)) earliest = expires;
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object' && node !== null) {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return earliest;
}

/** Milliseconds until URLs expiring at `expiresAt` (epoch seconds) should be replaced; 0 means now. */
export function urlSwapDelay(expiresAt: number | null, nowMs: number): number {
  if (expiresAt === null) return 0;
  return Math.max(0, expiresAt * 1000 - URL_SWAP_LEAD_MS - nowMs);
}

/** A URL without its signature (`expires`, `sig`), to compare what it points at. */
export function unsignedUrl(url: string): string {
  if (!looksSigned(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('expires');
    parsed.searchParams.delete('sig');
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The payload as JSON with every signature removed: equal keys mean only signatures differ. */
export function unsignedKey(value: unknown): string {
  return JSON.stringify(value, (_key, node: unknown) => (typeof node === 'string' ? unsignedUrl(node) : node));
}

export interface SignedValueOptions {
  /**
   * `true`: a change to anything but the signatures (a rename, new previews, another
   * access level) shows at once. `false` (the viewer after a refresh): the newest value
   * waits until the shown URLs are about to expire, whatever changed.
   */
  showChangesAtOnce?: boolean;
}

/**
 * Returns the value to render: the first one it was given, then the newest `next` once
 * the shown value's signed URLs are within `URL_SWAP_LEAD_MS` of expiring. Values with
 * no signed URLs (public files) are never held.
 */
export function useSignedValue<T>(next: T, { showChangesAtOnce = false }: SignedValueOptions = {}): T {
  const [shown, setShown] = useState(next);
  const [recheck, setRecheck] = useState(0);
  const nextKey = useMemo(() => (showChangesAtOnce ? unsignedKey(next) : ''), [next, showChangesAtOnce]);
  const shownKey = useMemo(() => (showChangesAtOnce ? unsignedKey(shown) : ''), [shown, showChangesAtOnce]);
  const expiresAt = useMemo(() => earliestUrlExpiry(shown), [shown]);

  // Something other than the signatures changed: show it now (a render-time update).
  const changed = showChangesAtOnce && shown !== next && nextKey !== shownKey;
  if (changed) setShown(next);

  useEffect(() => {
    if (shown === next) return;
    const delay = urlSwapDelay(expiresAt, Date.now());
    const id = window.setTimeout(
      () => (delay > MAX_TIMER_MS ? setRecheck((n) => n + 1) : setShown(next)),
      Math.min(delay, MAX_TIMER_MS),
    );
    return () => window.clearTimeout(id);
  }, [next, shown, expiresAt, recheck]);

  return changed ? next : shown;
}
