import type { AlbumData, AlbumItem, FileData } from '../types';

export type ResolvedLayout = 'grid' | 'list' | 'tracklist';

/**
 * PLAN.md "Album page": `auto` is a grid, except that an album whose every item
 * is audio becomes a tracklist. An explicit `grid` or `list` is respected; an
 * explicit `tracklist` only applies when every item is audio (otherwise grid).
 */
export function chooseLayout(album: Pick<AlbumData, 'layout' | 'items'>): ResolvedLayout {
  const allAudio = album.items.length > 0 && album.items.every((item) => item.kind === 'audio');
  switch (album.layout) {
    case 'grid':
    case 'list':
      return album.layout;
    case 'tracklist':
    case 'auto':
      return allAudio ? 'tracklist' : 'grid';
  }
}

/** Aspect ratios outside this range are clamped so one panorama can't wreck a row. */
export const MIN_ASPECT = 0.5;
export const MAX_ASPECT = 2.5;

/** Width ÷ height of an item's tile: thumbnail, then media, then a sensible default per kind. */
export function itemAspect(item: Pick<FileData, 'kind' | 'width' | 'height' | 'thumbnail'>): number {
  const thumb = item.thumbnail;
  let aspect: number | undefined;
  if (item.width && item.height) aspect = item.width / item.height;
  else if (thumb?.width && thumb.height) aspect = thumb.width / thumb.height;
  if (aspect === undefined) {
    aspect = item.kind === 'pdf' ? 0.77 : item.kind === 'video' ? 16 / 9 : 1;
  }
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

export interface JustifiedTile {
  /** Index into the input array. */
  index: number;
  width: number;
  height: number;
}

export interface JustifiedRow {
  tiles: JustifiedTile[];
  height: number;
}

export interface JustifyOptions {
  containerWidth: number;
  targetHeight: number;
  gap: number;
  /** The last row is never stretched taller than this (defaults to targetHeight). */
  maxLastRowHeight?: number;
}

/**
 * Justified rows (Flickr / imgur style): fill each row with items at their aspect
 * ratio until it reaches the container width at `targetHeight`, then scale the row
 * so it exactly fills the width. The last, incomplete row keeps the target height.
 * Widths are floored and the remainder goes to the last tile, so rows never
 * overflow the container by a rounding pixel.
 */
export function justifyRows(aspects: readonly number[], options: JustifyOptions): JustifiedRow[] {
  const { containerWidth, targetHeight, gap } = options;
  const maxLast = options.maxLastRowHeight ?? targetHeight;
  if (containerWidth <= 0 || aspects.length === 0) return [];

  const rows: JustifiedRow[] = [];
  let start = 0;
  while (start < aspects.length) {
    let sum = 0;
    let end = start;
    // Add items until the row at targetHeight is at least as wide as the container.
    while (end < aspects.length) {
      sum += aspects[end]!;
      end++;
      const width = sum * targetHeight + gap * (end - start - 1);
      if (width >= containerWidth) break;
    }
    const count = end - start;
    const available = containerWidth - gap * (count - 1);
    const fills = sum * targetHeight + gap * (count - 1) >= containerWidth;
    let height = fills ? available / sum : Math.min(targetHeight, maxLast);
    // A single very wide item on its own: cap its height at the container width.
    height = Math.min(height, available / sum);
    const tiles: JustifiedTile[] = [];
    let used = 0;
    for (let i = start; i < end; i++) {
      const isLast = i === end - 1;
      let width = Math.floor(aspects[i]! * height);
      if (isLast && fills) width = Math.max(1, Math.floor(available - used));
      tiles.push({ index: i, width, height: Math.round(height) });
      used += width;
    }
    rows.push({ tiles, height: Math.round(height) });
    start = end;
  }
  return rows;
}

/** Target row height by container width: smaller tiles on phones. */
export const targetRowHeight = (containerWidth: number): number =>
  containerWidth < 480 ? 140 : containerWidth < 900 ? 190 : 240;

/** Common artist across tracks, "Various artists" when they differ, null when untagged. */
export function albumArtist(items: readonly AlbumItem[]): string | null {
  const artists = new Set(items.map((item) => item.media?.tags?.artist).filter((a): a is string => Boolean(a)));
  if (artists.size === 0) return null;
  return artists.size === 1 ? [...artists][0]! : 'Various artists';
}

/** Album name from tags when every tagged track agrees. */
export function albumName(items: readonly AlbumItem[]): string | null {
  const names = new Set(items.map((item) => item.media?.tags?.album).filter((a): a is string => Boolean(a)));
  return names.size === 1 ? [...names][0]! : null;
}

/** "Artist" tag title, or the filename without its extension. */
export function trackTitle(item: Pick<FileData, 'filename' | 'extension' | 'media'>): string {
  const title = item.media?.tags?.title;
  if (title) return title;
  const suffix = item.extension ? `.${item.extension}` : '';
  return suffix && item.filename.endsWith(suffix) ? item.filename.slice(0, -suffix.length) : item.filename;
}
