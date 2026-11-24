/**
 * Pure state logic for the PDF viewer: zoom, pages, rotation, layout, the lazy
 * render window, deep-link hashes, keyboard mapping and search matching.
 * No DOM and no pdf.js here, so all of it is unit-tested directly.
 */

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

/** Manual zoom range (toolbar, keys, wheel, pinch): 50–400%. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
/** Fit width / fit page may go below 50% so a page still fits a phone screen. */
export const FIT_MIN = 0.1;
/** Preset steps for +/− and the zoom menu (1 = 100%). */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
/** pdf.js convention: 100% means 1 PDF point = 1/72 in shown at 96 CSS px per inch. */
export const PDF_TO_CSS = 96 / 72;

export type ZoomMode = { kind: 'fit-width' } | { kind: 'fit-page' } | { kind: 'scale'; value: number };

export const FIT_WIDTH: ZoomMode = { kind: 'fit-width' };
export const FIT_PAGE: ZoomMode = { kind: 'fit-page' };

export const clampZoom = (scale: number): number =>
  Number.isFinite(scale) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale)) : 1;

/** Rounds to 2 decimals so the UI never shows 99.99999%. */
const tidy = (scale: number) => Math.round(scale * 100) / 100;

export function zoomIn(scale: number): number {
  const next = ZOOM_STEPS.find((step) => step > scale + 0.001);
  return next ?? ZOOM_MAX;
}

export function zoomOut(scale: number): number {
  const prev = [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001);
  // Already below 50% (a fit mode on a phone): stay put rather than jump up.
  return prev ?? Math.min(scale, ZOOM_MIN);
}

/** Ctrl/⌘ + wheel: smooth exponential zoom, clamped. Negative deltaY zooms in. */
export function wheelZoom(scale: number, deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-200, Math.min(200, pixels));
  const next = scale * Math.exp(-clamped * 0.0025);
  // Zooming out from below 50% (fit on a phone) never jumps up to 50%.
  return tidy(Math.min(ZOOM_MAX, Math.max(Math.min(ZOOM_MIN, scale), next)));
}

/** Pinch: scale at the start of the gesture times the finger-distance ratio. */
export function pinchZoom(startScale: number, startDistance: number, distance: number): number {
  if (startDistance <= 0 || distance <= 0) return startScale;
  const next = startScale * (distance / startDistance);
  return tidy(Math.min(ZOOM_MAX, Math.max(Math.min(ZOOM_MIN, startScale), next)));
}

export interface Size {
  width: number;
  height: number;
}

/** Page size in CSS px at 100%, after rotation. `size` is the PDF page size in points. */
export function rotatedSize(size: Size, rotation: number): Size {
  const quarter = ((rotation % 360) + 360) % 180 === 90;
  return quarter ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}

/** Space kept around pages inside the scroll area, in CSS px. */
export const PAGE_GUTTER = 12;

/** Resolves a zoom mode to a numeric scale for the given page (points) and viewport. */
export function resolveScale(mode: ZoomMode, page: Size, rotation: number, viewport: Size): number {
  if (mode.kind === 'scale') return clampZoom(mode.value);
  const { width, height } = rotatedSize(page, rotation);
  if (width <= 0 || height <= 0 || viewport.width <= 0) return 1;
  const fit = (value: number) => Math.floor(Math.min(ZOOM_MAX, Math.max(FIT_MIN, value)) * 1000) / 1000;
  const fitWidth = (viewport.width - PAGE_GUTTER * 2) / (width * PDF_TO_CSS);
  if (mode.kind === 'fit-width') return fit(fitWidth);
  const fitHeight = (viewport.height - PAGE_GUTTER * 2) / (height * PDF_TO_CSS);
  return fit(Math.min(fitWidth, fitHeight));
}

export function zoomLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

// ---------------------------------------------------------------------------
// Pages and rotation
// ---------------------------------------------------------------------------

export const clampPage = (page: number, total: number): number =>
  total <= 0 ? 1 : Math.min(total, Math.max(1, Math.round(Number.isFinite(page) ? page : 1)));

/** The page jump box: accepts "7", " 7 ", "7/12". Returns null for anything else. */
export function parsePageInput(input: string, total: number): number | null {
  const match = /^\s*(\d+)\s*(?:\/\s*\d*\s*)?$/.exec(input);
  if (!match) return null;
  return clampPage(Number(match[1]), total);
}

export const rotate = (rotation: number, direction: 1 | -1 = 1): number => (((rotation + direction * 90) % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Layout and the lazy render window
// ---------------------------------------------------------------------------

/** Vertical gap between pages, CSS px. */
export const PAGE_GAP = 12;

export interface PageBox {
  top: number;
  width: number;
  height: number;
}

export interface Layout {
  pages: PageBox[];
  /** Total scroll height including gutters. */
  height: number;
  /** Widest page, for horizontal scrolling when zoomed in. */
  width: number;
}

/** Stacks pages vertically. `sizes` are PDF page sizes in points (unrotated). */
export function computeLayout(sizes: Size[], scale: number, rotation: number): Layout {
  let top = PAGE_GUTTER;
  let width = 0;
  const pages = sizes.map((size) => {
    const r = rotatedSize(size, rotation);
    const box = {
      top,
      width: Math.floor(r.width * PDF_TO_CSS * scale),
      height: Math.floor(r.height * PDF_TO_CSS * scale),
    };
    top += box.height + PAGE_GAP;
    width = Math.max(width, box.width);
    return box;
  });
  return { pages, height: top - PAGE_GAP + PAGE_GUTTER, width: width + PAGE_GUTTER * 2 };
}

export interface Visibility {
  /** 1-based, inclusive. 0 when nothing is visible. */
  first: number;
  last: number;
  /** The page that covers the most of the viewport (1-based). */
  current: number;
}

/** Which pages intersect the viewport. Binary search, so 500-page documents stay cheap. */
export function visiblePages(layout: Layout, scrollTop: number, viewportHeight: number): Visibility {
  const { pages } = layout;
  if (pages.length === 0) return { first: 0, last: 0, current: 1 };
  const bottom = scrollTop + viewportHeight;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const page = pages[mid]!;
    if (page.top + page.height < scrollTop) lo = mid + 1;
    else hi = mid;
  }
  let last = lo;
  while (last + 1 < pages.length && pages[last + 1]!.top < bottom) last++;
  let current = lo;
  let best = -1;
  for (let i = lo; i <= last; i++) {
    const page = pages[i]!;
    const shown = Math.min(bottom, page.top + page.height) - Math.max(scrollTop, page.top);
    if (shown > best + 0.5) {
      best = shown;
      current = i;
    }
  }
  return { first: lo + 1, last: last + 1, current: current + 1 };
}

/** Pages rendered beyond the visible ones (PLAN.md: "the visible pages plus 2"). */
export const RENDER_BUFFER = 2;
/** Rendered pages further than this from the visible range release their canvases. */
export const RELEASE_DISTANCE = 6;

/**
 * The next set of pages that should hold a canvas: the visible range ±RENDER_BUFFER,
 * plus already-rendered pages still within RELEASE_DISTANCE (hysteresis, so scrolling
 * back and forth doesn't re-render constantly). Everything else is released.
 */
export function nextRenderSet(previous: ReadonlySet<number>, visible: Visibility, total: number): Set<number> {
  const next = new Set<number>();
  if (visible.first === 0 || total === 0) return next;
  const from = Math.max(1, visible.first - RENDER_BUFFER);
  const to = Math.min(total, visible.last + RENDER_BUFFER);
  for (let page = from; page <= to; page++) next.add(page);
  for (const page of previous) {
    if (page >= visible.first - RELEASE_DISTANCE && page <= visible.last + RELEASE_DISTANCE && page <= total) {
      next.add(page);
    }
  }
  return next;
}

export const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean =>
  a.size === b.size && [...a].every((value) => b.has(value));

/** Pages are centred in the viewport; a page wider than it starts at the gutter and scrolls. */
export const pageLeft = (pageWidth: number, viewportWidth: number): number =>
  Math.max(PAGE_GUTTER, Math.floor((viewportWidth - pageWidth) / 2));

/** scrollTop that puts the top of `page` at the top of the viewport. */
export const scrollTopForPage = (layout: Layout, page: number): number =>
  Math.max(0, (layout.pages[page - 1]?.top ?? 0) - PAGE_GUTTER);

/**
 * Keeps the reader's place across a zoom or rotation: the page at the viewport's
 * centre stays at the same relative position.
 */
export function anchorScroll(before: Layout, after: Layout, scrollTop: number, viewportHeight: number): number {
  const centre = scrollTop + viewportHeight / 2;
  const index = Math.max(0, visiblePages(before, centre, 1).first - 1);
  const old = before.pages[index];
  const next = after.pages[index];
  if (!old || !next) return scrollTop;
  const fraction = old.height > 0 ? (centre - old.top) / old.height : 0;
  return Math.max(0, next.top + fraction * next.height - viewportHeight / 2);
}

// ---------------------------------------------------------------------------
// Deep links: #page=N&zoom=…
// ---------------------------------------------------------------------------

export interface PdfHash {
  page?: number | undefined;
  zoom?: ZoomMode | undefined;
}

/**
 * Parses pdf.js-style open parameters: `#page=3`, `#page=3&zoom=150`,
 * `#zoom=page-fit`, `#page=2&zoom=125,0,792` (the left/top offsets are ignored).
 */
export function parsePdfHash(hash: string): PdfHash {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const result: PdfHash = {};
  const page = Number(params.get('page'));
  if (Number.isInteger(page) && page >= 1) result.page = page;
  const zoom = params.get('zoom')?.split(',')[0]?.trim();
  if (zoom === 'page-width' || zoom === 'auto') result.zoom = FIT_WIDTH;
  else if (zoom === 'page-fit') result.zoom = FIT_PAGE;
  else if (zoom && Number.isFinite(Number(zoom)) && Number(zoom) > 0) {
    result.zoom = { kind: 'scale', value: clampZoom(Number(zoom) / 100) };
  }
  return result;
}

/** Inverse of parsePdfHash. Fit width is the default, so it is left out. */
export function formatPdfHash(page: number, zoom: ZoomMode): string {
  let hash = `#page=${page}`;
  if (zoom.kind === 'fit-page') hash += '&zoom=page-fit';
  else if (zoom.kind === 'scale') hash += `&zoom=${Math.round(zoom.value * 100)}`;
  return hash;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export type PdfKeyAction = 'prev' | 'next' | 'first' | 'last' | 'zoom-in' | 'zoom-out' | 'fullscreen' | 'search';

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export { isEditableTarget } from '../../lib/dom';

/**
 * Maps a key press to a viewer action. Returns null for keys the viewer leaves
 * alone, including everything typed into an editable element.
 */
export function pdfKeyAction(event: KeyInput, editable: boolean): PdfKeyAction | null {
  const mod = Boolean(event.ctrlKey || event.metaKey);
  if (mod && !event.altKey && event.key.toLowerCase() === 'f') return 'search';
  if (editable || mod || event.altKey) return null;
  switch (event.key) {
    case 'ArrowLeft':
    case 'PageUp':
      return 'prev';
    case 'ArrowRight':
    case 'PageDown':
      return 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case '+':
    case '=':
      return 'zoom-in';
    case '-':
    case '_':
      return 'zoom-out';
    case 'f':
    case 'F':
      return event.shiftKey ? null : 'fullscreen';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A position inside a page's text items (the same items the text layer renders). */
export interface TextPosition {
  item: number;
  offset: number;
}

export interface PageMatch {
  begin: TextPosition;
  /** Exclusive. */
  end: TextPosition;
}

export interface SearchMatch extends PageMatch {
  /** 1-based page number. */
  page: number;
}

const fold = (text: string) => {
  const lower = text.toLowerCase();
  // Keep offsets aligned: fall back to the original when lowercasing changes length.
  return lower.length === text.length ? lower : text;
};

/**
 * Finds every case-insensitive occurrence of `query` in one page's text items.
 * Items are joined with a space where the PDF ends a line (`hasEOL`), so a phrase
 * split across lines still matches.
 */
export function findInPage(items: ReadonlyArray<{ str: string; hasEOL?: boolean }>, query: string): PageMatch[] {
  const needle = fold(query.trim().replace(/\s+/g, ' '));
  if (!needle) return [];
  let text = '';
  const starts: number[] = [];
  items.forEach((item) => {
    starts.push(text.length);
    text += fold(item.str);
    if (item.hasEOL && !/\s$/.test(item.str)) text += ' ';
  });
  const haystack = text.replace(/\s/g, ' ');
  const locate = (index: number): TextPosition => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    const offset = Math.min(index - starts[lo]!, items[lo]?.str.length ?? 0);
    return { item: lo, offset };
  };
  const matches: PageMatch[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    // Exclusive end inside the item holding the last matched character.
    const last = locate(index + needle.length - 1);
    const end = { item: last.item, offset: Math.min(last.offset + 1, items[last.item]?.str.length ?? 0) };
    matches.push({ begin: locate(index), end });
    from = index + needle.length;
  }
  return matches;
}

/** Next/previous match index with wrap-around. -1 when there are no matches. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}

/** The first match at or after `page`, so a new search starts where the reader is. */
export function firstMatchFrom(matches: ReadonlyArray<{ page: number }>, page: number): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((match) => match.page >= page);
  return index === -1 ? 0 : index;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

export const THUMB_WIDTH = 112;
/** Space under each thumbnail for its page number. */
export const THUMB_LABEL = 22;

/** Fixed-width thumbnail column; each slot is the thumbnail plus its label. */
export function thumbLayout(sizes: Size[], rotation: number, width = THUMB_WIDTH): Layout {
  let top = PAGE_GUTTER;
  const pages = sizes.map((size) => {
    const r = rotatedSize(size, rotation);
    const height = r.width > 0 ? Math.round((width * r.height) / r.width) : width;
    const box = { top, width, height: height + THUMB_LABEL };
    top += box.height + PAGE_GAP;
    return box;
  });
  return { pages, height: top - PAGE_GAP + PAGE_GUTTER, width: width + PAGE_GUTTER * 2 };
}

/** Visible range ± `buffer`, as a 1-based inclusive [from, to]; [0, -1] when empty. */
export function windowRange(visible: Visibility, total: number, buffer: number): [number, number] {
  if (visible.first === 0 || total === 0) return [0, -1];
  return [Math.max(1, visible.first - buffer), Math.min(total, visible.last + buffer)];
}
