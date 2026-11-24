/**
 * Album URLs: `/a/<vanity>` and `/a/<vanity>/<n>`, where n is the 1-based item
 * opened in the lightbox (PLAN.md "Albums").
 */

export interface AlbumPath {
  vanity: string;
  /** 0-based item index, or null for the album itself. */
  index: number | null;
}

export function parseAlbumPath(pathname: string): AlbumPath | null {
  const match = /^\/a\/([^/]+)(?:\/(\d+))?\/?$/.exec(pathname);
  if (!match) return null;
  const n = match[2] ? Number(match[2]) : null;
  return { vanity: decodeURIComponent(match[1]!), index: n !== null && n >= 1 ? n - 1 : null };
}

/** Path for the album or one of its items. `search` (e.g. dev `?fixture=`) is kept. */
export function albumPath(vanity: string, index: number | null, search = ''): string {
  const base = `/a/${encodeURIComponent(vanity)}`;
  return `${index === null ? base : `${base}/${index + 1}`}${search}`;
}

/** Canonical share URL for the album. */
export function albumShareUrl(vanity: string, url: string | undefined, origin: string = window.location.origin): string {
  return url ?? `${origin}${albumPath(vanity, null)}`;
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
