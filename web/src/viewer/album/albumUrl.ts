/**
 * Album URLs (milestone-6 §20.2): `/a/<vanity>`, with the item open in the lightbox as
 * `?item=<n>` (1-based). The vanity is always the last path segment, so there is no
 * `/a/<vanity>/<n>` any more. Other query parameters (dev `?fixture=`) and the fragment
 * (`#pw=`, `#t=`) are kept as they are.
 */

import { shareUrl } from '../urls';

export interface AlbumPath {
  vanity: string;
  /** 0-based item index, or null for the album itself. */
  index: number | null;
}

/** `?item=<n>` as a 0-based index, or null when it's absent or not a positive integer. */
export function parseAlbumItem(search: string): number | null {
  const item = new URLSearchParams(search).get('item');
  if (item === null || !/^[1-9][0-9]{0,8}$/.test(item)) return null;
  return Number(item) - 1;
}

export function parseAlbumPath(pathname: string, search = ''): AlbumPath | null {
  const match = /^\/a\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let vanity: string;
  try {
    vanity = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return { vanity, index: parseAlbumItem(search) };
}

/**
 * The URL for the album or one of its items: `/a/<vanity>`, then the query with `item`
 * set (or removed), then `hash`. Every other query parameter is kept.
 */
export function albumPath(vanity: string, index: number | null, search = '', hash = ''): string {
  const params = new URLSearchParams(search);
  if (index === null) params.delete('item');
  else params.set('item', String(index + 1));
  const query = params.toString();
  return `/a/${encodeURIComponent(vanity)}${query ? `?${query}` : ''}${hash}`;
}

/** Canonical share URL for the album (on a custom domain, on this domain: see shareUrl). */
export function albumShareUrl(vanity: string, url: string | undefined, origin: string = window.location.origin): string {
  return url ? shareUrl(url) : `${origin}${albumPath(vanity, null)}`;
}

/** Index within bounds, or null. */
export function clampIndex(index: number | null, count: number): number | null {
  if (index === null || count <= 0 || !Number.isInteger(index) || index < 0 || index >= count) return null;
  return index;
}

/** Carousel step: stops at the ends rather than wrapping. */
export function stepIndex(index: number, count: number, direction: 1 | -1): number {
  return Math.min(count - 1, Math.max(0, index + direction));
}
