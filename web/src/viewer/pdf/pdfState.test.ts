import { describe, expect, it } from 'vitest';

import {
  anchorScroll,
  clampPage,
  computeLayout,
  FIT_PAGE,
  FIT_WIDTH,
  findInPage,
  firstMatchFrom,
  formatPdfHash,
  isEditableTarget,
  nextRenderSet,
  PAGE_GAP,
  PAGE_GUTTER,
  pageLeft,
  parsePageInput,
  parsePdfHash,
  pdfKeyAction,
  pinchZoom,
  resolveScale,
  rotate,
  rotatedSize,
  scrollTopForPage,
  stepMatch,
  thumbLayout,
  visiblePages,
  wheelZoom,
  windowRange,
  zoomIn,
  zoomLabel,
  zoomOut,
  ZOOM_MAX,
  ZOOM_MIN,
} from './pdfState';

const LETTER = { width: 612, height: 792 };
const LANDSCAPE = { width: 792, height: 612 };

describe('zoom', () => {
  it('steps through presets and stops at 50% and 400%', () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomIn(1.05)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  });

  it('never zooms out upward from a fit scale below 50%', () => {
    expect(zoomOut(0.38)).toBe(0.38);
    expect(zoomIn(0.38)).toBe(0.5);
    expect(wheelZoom(0.38, 100)).toBe(0.38);
  });

  it('wheel: negative deltaY zooms in, clamped, line and page modes scaled', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelZoom(1, 100)).toBeLessThan(1);
    expect(wheelZoom(4, -1000)).toBe(ZOOM_MAX);
    expect(wheelZoom(0.5, 1000)).toBe(ZOOM_MIN);
    expect(wheelZoom(1, -3, 1)).toBe(wheelZoom(1, -48, 0));
  });

  it('pinch scales by the finger-distance ratio, clamped', () => {
    expect(pinchZoom(1, 100, 150)).toBe(1.5);
    expect(pinchZoom(2, 100, 1000)).toBe(ZOOM_MAX);
    expect(pinchZoom(1, 0, 50)).toBe(1);
  });

  it('labels as a percentage', () => {
    expect(zoomLabel(1.25)).toBe('125%');
  });
});

describe('resolveScale', () => {
  const viewport = { width: 840, height: 600 };

  it('fit width fills the viewport minus the gutters', () => {
    const scale = resolveScale(FIT_WIDTH, LETTER, 0, viewport);
    expect(scale * 612 * (96 / 72)).toBeCloseTo(840 - PAGE_GUTTER * 2, -1);
  });

  it('fit page also fits the height', () => {
    const scale = resolveScale(FIT_PAGE, LETTER, 0, viewport);
    expect(scale * 792 * (96 / 72)).toBeLessThanOrEqual(600 - PAGE_GUTTER * 2);
  });

  it('fit width goes below 50% on narrow screens', () => {
    expect(resolveScale(FIT_WIDTH, LETTER, 0, { width: 338, height: 400 })).toBeLessThan(ZOOM_MIN);
  });

  it('uses the rotated page size', () => {
    expect(resolveScale(FIT_WIDTH, LETTER, 90, viewport)).toBe(resolveScale(FIT_WIDTH, LANDSCAPE, 0, viewport));
  });

  it('returns explicit scales clamped to 50–400%', () => {
    expect(resolveScale({ kind: 'scale', value: 1.5 }, LETTER, 0, viewport)).toBe(1.5);
    expect(resolveScale({ kind: 'scale', value: 9 }, LETTER, 0, viewport)).toBe(ZOOM_MAX);
    expect(resolveScale(FIT_WIDTH, LETTER, 0, { width: 0, height: 0 })).toBe(1);
  });
});

describe('pages and rotation', () => {
  it('clamps pages', () => {
    expect(clampPage(0, 8)).toBe(1);
    expect(clampPage(9, 8)).toBe(8);
    expect(clampPage(Number.NaN, 8)).toBe(1);
  });

  it('parses the jump box', () => {
    expect(parsePageInput('7', 12)).toBe(7);
    expect(parsePageInput(' 7 / 12', 12)).toBe(7);
    expect(parsePageInput('99', 12)).toBe(12);
    expect(parsePageInput('seven', 12)).toBeNull();
    expect(parsePageInput('', 12)).toBeNull();
  });

  it('rotates in quarter turns both ways', () => {
    expect(rotate(0)).toBe(90);
    expect(rotate(270)).toBe(0);
    expect(rotate(0, -1)).toBe(270);
    expect(rotatedSize(LETTER, 90)).toEqual(LANDSCAPE);
    expect(rotatedSize(LETTER, 180)).toEqual(LETTER);
  });
});

describe('layout and visibility', () => {
  const sizes = Array.from({ length: 10 }, () => LETTER);
  const layout = computeLayout(sizes, 0.5, 0);
  const pageHeight = Math.floor(792 * (96 / 72) * 0.5);

  it('stacks pages with gaps and gutters', () => {
    expect(layout.pages[0]).toEqual({ top: PAGE_GUTTER, width: Math.floor(612 * (96 / 72) * 0.5), height: pageHeight });
    expect(layout.pages[1]!.top).toBe(PAGE_GUTTER + pageHeight + PAGE_GAP);
    expect(layout.height).toBe(PAGE_GUTTER * 2 + pageHeight * 10 + PAGE_GAP * 9);
  });

  it('finds the visible range and the most-visible page', () => {
    expect(visiblePages(layout, 0, 600)).toEqual({ first: 1, last: 2, current: 1 });
    const top = layout.pages[4]!.top - 100;
    expect(visiblePages(layout, top, 600)).toMatchObject({ first: 4, last: 5, current: 5 });
    expect(visiblePages(computeLayout([], 1, 0), 0, 600)).toEqual({ first: 0, last: 0, current: 1 });
  });

  it('centres pages, and starts wide pages at the gutter', () => {
    expect(pageLeft(300, 500)).toBe(100);
    expect(pageLeft(900, 500)).toBe(PAGE_GUTTER);
  });

  it('scrolls to the top of a page', () => {
    expect(scrollTopForPage(layout, 1)).toBe(0);
    expect(scrollTopForPage(layout, 3)).toBe(layout.pages[2]!.top - PAGE_GUTTER);
  });

  it('keeps the reader on the same spot when zooming', () => {
    const bigger = computeLayout(sizes, 1, 0);
    const scrollTop = layout.pages[4]!.top + pageHeight / 2 - 300; // page 5's middle at the centre
    const next = anchorScroll(layout, bigger, scrollTop, 600);
    const centre = next + 300;
    const page5 = bigger.pages[4]!;
    expect((centre - page5.top) / page5.height).toBeCloseTo(0.5, 1);
  });
});

describe('render window', () => {
  it('renders the visible pages plus 2 on each side', () => {
    const next = nextRenderSet(new Set(), { first: 10, last: 11, current: 10 }, 500);
    expect([...next].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12, 13]);
  });

  it('keeps nearby rendered pages and releases far-off ones', () => {
    const previous = new Set([1, 2, 3, 4, 5]);
    const next = nextRenderSet(previous, { first: 9, last: 9, current: 9 }, 500);
    expect(next.has(3)).toBe(true); // within 6 of the visible range
    expect(next.has(2)).toBe(false);
    expect(next.has(1)).toBe(false);
    const far = nextRenderSet(next, { first: 300, last: 301, current: 300 }, 500);
    expect([...far].sort((a, b) => a - b)).toEqual([298, 299, 300, 301, 302, 303]);
  });

  it('clips at the document edges', () => {
    expect([...nextRenderSet(new Set(), { first: 1, last: 1, current: 1 }, 2)]).toEqual([1, 2]);
    expect(nextRenderSet(new Set([1]), { first: 0, last: 0, current: 1 }, 0).size).toBe(0);
    expect(windowRange({ first: 2, last: 3, current: 2 }, 4, 3)).toEqual([1, 4]);
  });

  it('virtualises thumbnails with variable heights', () => {
    const thumbs = thumbLayout([LETTER, LANDSCAPE], 0, 100);
    expect(thumbs.pages[0]!.height).toBeGreaterThan(thumbs.pages[1]!.height);
  });
});

describe('deep-link hash', () => {
  it('parses page and zoom', () => {
    expect(parsePdfHash('#page=3')).toEqual({ page: 3 });
    expect(parsePdfHash('#page=3&zoom=150')).toEqual({ page: 3, zoom: { kind: 'scale', value: 1.5 } });
    expect(parsePdfHash('#zoom=page-fit')).toEqual({ zoom: FIT_PAGE });
    expect(parsePdfHash('#zoom=page-width')).toEqual({ zoom: FIT_WIDTH });
    expect(parsePdfHash('#page=2&zoom=125,0,792')).toEqual({ page: 2, zoom: { kind: 'scale', value: 1.25 } });
    expect(parsePdfHash('#zoom=9000')).toEqual({ zoom: { kind: 'scale', value: ZOOM_MAX } });
  });

  it('ignores junk', () => {
    expect(parsePdfHash('')).toEqual({});
    expect(parsePdfHash('#page=0&zoom=-5')).toEqual({});
    expect(parsePdfHash('#page=two')).toEqual({});
    expect(parsePdfHash('#L5-L9')).toEqual({});
  });

  it('formats, leaving out the default fit width', () => {
    expect(formatPdfHash(4, FIT_WIDTH)).toBe('#page=4');
    expect(formatPdfHash(4, FIT_PAGE)).toBe('#page=4&zoom=page-fit');
    expect(formatPdfHash(4, { kind: 'scale', value: 1.5 })).toBe('#page=4&zoom=150');
    expect(parsePdfHash(formatPdfHash(4, { kind: 'scale', value: 2 }))).toEqual({ page: 4, zoom: { kind: 'scale', value: 2 } });
  });
});

describe('keyboard', () => {
  it.each([
    [{ key: 'ArrowLeft' }, 'prev'],
    [{ key: 'PageUp' }, 'prev'],
    [{ key: 'ArrowRight' }, 'next'],
    [{ key: 'PageDown' }, 'next'],
    [{ key: 'Home' }, 'first'],
    [{ key: 'End' }, 'last'],
    [{ key: '+' }, 'zoom-in'],
    [{ key: '=' }, 'zoom-in'],
    [{ key: '-' }, 'zoom-out'],
    [{ key: 'f' }, 'fullscreen'],
    [{ key: 'f', ctrlKey: true }, 'search'],
    [{ key: 'F', metaKey: true }, 'search'],
    [{ key: 'ArrowLeft', altKey: true }, null],
    [{ key: 'ArrowLeft', ctrlKey: true }, null],
    [{ key: 'x' }, null],
  ] as const)('%o -> %s', (event, action) => {
    expect(pdfKeyAction(event, false)).toBe(action);
  });

  it('leaves editable targets alone, except Ctrl/⌘-F', () => {
    expect(pdfKeyAction({ key: 'ArrowRight' }, true)).toBeNull();
    expect(pdfKeyAction({ key: 'f' }, true)).toBeNull();
    expect(pdfKeyAction({ key: 'f', ctrlKey: true }, true)).toBe('search');
  });

  it('detects editable targets', () => {
    document.body.innerHTML = '<input id="i"><div id="d"></div><div contenteditable="true"><span id="s">x</span></div>';
    expect(isEditableTarget(document.getElementById('i'))).toBe(true);
    expect(isEditableTarget(document.getElementById('s'))).toBe(true);
    expect(isEditableTarget(document.getElementById('d'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('search', () => {
  const items = [
    { str: 'The quick brown', hasEOL: true },
    { str: 'fox jumps over the', hasEOL: false },
    { str: ' lazy dog. THE END', hasEOL: false },
  ];

  it('finds case-insensitive matches with item positions', () => {
    const matches = findInPage(items, 'the');
    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({ begin: { item: 0, offset: 0 }, end: { item: 0, offset: 3 } });
    expect(matches[1]).toEqual({ begin: { item: 1, offset: 15 }, end: { item: 1, offset: 18 } });
    expect(matches[2]!.begin).toEqual({ item: 2, offset: 11 });
  });

  it('matches across a line break and across items', () => {
    expect(findInPage(items, 'brown fox')).toEqual([{ begin: { item: 0, offset: 10 }, end: { item: 1, offset: 3 } }]);
    expect(findInPage(items, 'the lazy')).toHaveLength(1);
  });

  it('returns nothing for blank queries', () => {
    expect(findInPage(items, '   ')).toEqual([]);
    expect(findInPage([], 'x')).toEqual([]);
  });

  it('steps with wrap-around and starts at the current page', () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
    const matches = [{ page: 1 }, { page: 4 }, { page: 9 }];
    expect(firstMatchFrom(matches, 3)).toBe(1);
    expect(firstMatchFrom(matches, 10)).toBe(0);
    expect(firstMatchFrom([], 1)).toBe(-1);
  });
});
