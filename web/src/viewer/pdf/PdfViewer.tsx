import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  ExternalLink,
  Maximize,
  Minimize,
  PanelLeft,
  RotateCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ExternalLinkDialog } from '../../components/ExternalLinkDialog';
import { FlaggedLinkDialog } from '../links/FlaggedLinkDialog';
import { isFlaggedLink, WEB_RISK_WARNING } from '../links/webRisk';
import type { FileData } from '../types';
import { downloadUrl } from '../urls';
import { PdfPage, type PdfServices } from './PdfPage';
import { PdfSidebar, type OutlineNode } from './PdfSidebar';
import type { PDFDocumentProxy, TextContent, TextItem } from './pdfjs';
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
  parsePageInput,
  parsePdfHash,
  pdfKeyAction,
  pinchZoom,
  pageLeft,
  resolveScale,
  rotate,
  sameSet,
  scrollTopForPage,
  stepMatch,
  visiblePages,
  wheelZoom,
  zoomIn,
  zoomLabel,
  zoomOut,
  ZOOM_STEPS,
  type Layout,
  type PageMatch,
  type SearchMatch,
  type Size,
  type ZoomMode,
} from './pdfState';

export interface PdfViewerProps {
  file: FileData;
  doc: PDFDocumentProxy;
  firstPageSize: Size;
  /** Handle the viewer's keys when nothing else has focus (true on a single-file page). */
  globalKeys: boolean;
  /** Keep `#page=N` in the address bar (single-file page only). */
  syncHash: boolean;
}

const NO_MATCHES: readonly PageMatch[] = [];
const NO_SEARCH_MATCHES: SearchMatch[] = [];

function ToolButton({
  label,
  onClick,
  children,
  pressed,
  className = '',
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40 aria-pressed:bg-surface-2 aria-pressed:text-text ${className}`}
    >
      {children}
    </button>
  );
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

const textItems = (content: TextContent) =>
  content.items.filter((item): item is TextItem => 'str' in item).map((item) => ({ str: item.str, hasEOL: item.hasEOL }));

export function PdfViewer({ file, doc, firstPageSize, globalKeys, syncHash }: PdfViewerProps) {
  const numPages = doc.numPages;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const initialHash = useMemo(() => (syncHash ? parsePdfHash(window.location.hash) : {}), [syncHash]);
  const [sizes, setSizes] = useState<Size[]>(() => Array.from({ length: numPages }, () => firstPageSize));
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState<ZoomMode>(initialHash.zoom ?? FIT_WIDTH);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [rendered, setRendered] = useState<Set<number>>(() => new Set());
  const [pageInput, setPageInput] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState<boolean | null>(null);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  // Milestone 4 §11.1: links Web Risk flagged can't be opened from here, only copied.
  const flaggedRef = useRef(file.link_warnings);
  useEffect(() => {
    flaggedRef.current = file.link_warnings;
  }, [file.link_warnings]);
  const [fullscreen, setFullscreen] = useState(false);
  const [fakeFullscreen, setFakeFullscreen] = useState(false);
  const [pinch, setPinch] = useState(1);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Results and selection are tagged with their query, so a new query never shows stale ones. */
  const [results, setResults] = useState<{ query: string; matches: SearchMatch[]; done: boolean }>({
    query: '',
    matches: [],
    done: true,
  });
  const [pick, setPick] = useState({ query: '', index: -1 });
  const pendingMatchScroll = useRef(false);

  // ---- Layout -------------------------------------------------------------
  const scale = resolveScale(zoom, sizes[0] ?? firstPageSize, rotation, viewport);
  const renderScale = useDebounced(scale, 160);
  const layout = useMemo(() => computeLayout(sizes, scale, rotation), [sizes, scale, rotation]);
  const visibility = visiblePages(layout, scrollTop, viewport.height || 1);
  const current = clampPage(visibility.current, numPages);

  const stateRef = useRef({ layout, scale, current, numPages });
  useLayoutEffect(() => {
    stateRef.current = { layout, scale, current, numPages };
  });

  const goToPage = useCallback((page: number) => {
    const el = scrollRef.current;
    const { layout: now, numPages: total } = stateRef.current;
    if (!el) return;
    el.scrollTop = scrollTopForPage(now, clampPage(page, total));
    setScrollTop(el.scrollTop);
  }, []);

  // Measure the scroll area.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Track scrolling, once per frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrollTop(el.scrollTop));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Keep the reader's place when the layout changes (zoom, rotation, page sizes).
  const previousLayout = useRef<Layout | null>(null);
  const jumpedToHash = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || viewport.width === 0) return;
    const before = previousLayout.current;
    previousLayout.current = layout;
    if (!jumpedToHash.current) {
      jumpedToHash.current = true;
      if (initialHash.page) {
        el.scrollTop = scrollTopForPage(layout, clampPage(initialHash.page, numPages));
        setScrollTop(el.scrollTop);
      }
      return;
    }
    if (before && before !== layout) {
      el.scrollTop = anchorScroll(before, layout, el.scrollTop, el.clientHeight);
      setScrollTop(el.scrollTop);
    }
  }, [layout, viewport.width, initialHash.page, numPages]);

  // Lazy rendering: visible pages ± 2, far-off canvases released. Derived state,
  // adjusted during render (it converges: the next set of the next set is itself).
  const nextRendered = nextRenderSet(rendered, visibility, numPages);
  if (!sameSet(rendered, nextRendered)) setRendered(nextRendered);

  // #page=N deep link, kept in sync without adding history entries.
  useEffect(() => {
    if (!syncHash || viewport.width === 0) return;
    const id = window.setTimeout(() => {
      const hash = formatPdfHash(current, zoom);
      if (window.location.hash !== hash) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
      }
    }, 250);
    return () => window.clearTimeout(id);
  }, [current, zoom, syncHash, viewport.width]);

  // Someone edits the hash (or follows an in-page #page=N link): follow it.
  useEffect(() => {
    if (!syncHash) return;
    const onHash = () => {
      const parsed = parsePdfHash(window.location.hash);
      if (parsed.zoom) setZoom(parsed.zoom);
      if (parsed.page) {
        const page = parsed.page;
        // After the zoom's layout lands.
        requestAnimationFrame(() => goToPage(page));
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [syncHash, goToPage]);

  // ---- Document services ---------------------------------------------------
  const textCache = useRef(new Map<number, Promise<TextContent>>());
  const goToDestination = useCallback(
    async (dest: unknown) => {
      try {
        const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
        if (!Array.isArray(explicit)) return;
        const ref = explicit[0] as unknown;
        const index =
          typeof ref === 'number' ? ref : ref && typeof ref === 'object' ? await doc.getPageIndex(ref as never) : null;
        if (index !== null) goToPage(index + 1);
      } catch {
        // A broken destination simply does nothing.
      }
    },
    [doc, goToPage],
  );

  const services = useMemo<PdfServices>(() => {
    const linkService = {
      externalLinkEnabled: true,
      eventBus: undefined,
      get pagesCount() {
        return numPages;
      },
      get page() {
        return stateRef.current.current;
      },
      rotation: 0,
      isInPresentationMode: false,
      addLinkAttributes(link: HTMLAnchorElement, url: string) {
        if (isFlaggedLink(url, flaggedRef.current)) {
          // No real href, so a middle click or "open in new tab" can't open it either.
          link.href = '#';
          link.title = `${WEB_RISK_WARNING} ${url}`;
          link.dataset.flagged = '';
        } else {
          link.href = url;
          link.title = url;
          link.rel = 'noopener noreferrer nofollow';
          link.target = '_blank';
        }
        link.addEventListener('click', (event) => {
          event.preventDefault();
          setExternalUrl(url);
        });
        // A middle click would open the link without the notice (security review W2).
        link.addEventListener('auxclick', (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          setExternalUrl(url);
        });
      },
      getDestinationHash: () => '#',
      getAnchorUrl: (anchor: string) => `#${anchor}`,
      goToDestination: (dest: unknown) => void goToDestination(dest),
      goToPage: (page: number) => goToPage(page),
      executeNamedAction(action: string) {
        const { current: page, numPages: total } = stateRef.current;
        if (action === 'NextPage') goToPage(page + 1);
        else if (action === 'PrevPage') goToPage(page - 1);
        else if (action === 'FirstPage') goToPage(1);
        else if (action === 'LastPage') goToPage(total);
      },
      executeSetOCGState: () => undefined,
      getAttachmentContent: async () => null,
      isPageVisible: () => true,
      isPageCached: () => true,
    };
    return {
      doc,
      linkService,
      textContent: (page: number) => {
        let promise = textCache.current.get(page);
        if (!promise) {
          promise = doc.getPage(page).then((p) => p.getTextContent());
          textCache.current.set(page, promise);
        }
        return promise;
      },
      onPageSize: (page: number, size: Size) =>
        setSizes((previous) => {
          const old = previous[page - 1];
          if (old && Math.abs(old.width - size.width) < 0.5 && Math.abs(old.height - size.height) < 0.5) return previous;
          const next = previous.slice();
          next[page - 1] = size;
          return next;
        }),
    };
  }, [doc, numPages, goToPage, goToDestination]);

  // Outline (bookmarks), when the PDF has one.
  useEffect(() => {
    let cancelled = false;
    doc
      .getOutline()
      .then((items) => {
        if (!cancelled && items) setOutline(items as unknown as OutlineNode[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const onOutline = useCallback(
    (node: OutlineNode) => {
      if (node.url) setExternalUrl(node.url);
      else if (node.dest) void goToDestination(node.dest);
    },
    [goToDestination],
  );

  // ---- Search ----------------------------------------------------------------
  const debouncedQuery = useDebounced(query.trim(), 250);
  useEffect(() => {
    if (!debouncedQuery) return;
    let cancelled = false;
    (async () => {
      const found: SearchMatch[] = [];
      let first = true;
      for (let page = 1; page <= numPages && !cancelled; page++) {
        try {
          const content = await services.textContent(page);
          if (cancelled) return;
          for (const match of findInPage(textItems(content), debouncedQuery)) found.push({ ...match, page });
        } catch {
          // Skip pages whose text can't be read.
        }
        if (page % 8 === 0 || page === numPages) {
          setResults({ query: debouncedQuery, matches: found.slice(), done: false });
          if (first && found.length > 0) {
            first = false;
            pendingMatchScroll.current = true;
            setPick({ query: debouncedQuery, index: firstMatchFrom(found, stateRef.current.current) });
          }
        }
      }
      if (!cancelled) setResults({ query: debouncedQuery, matches: found, done: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, numPages, services]);

  const matches = results.query === debouncedQuery && debouncedQuery ? results.matches : NO_SEARCH_MATCHES;
  const searchDone = !debouncedQuery || (results.query === debouncedQuery && results.done);
  const selected = pick.query === debouncedQuery && debouncedQuery ? pick.index : -1;

  const matchesByPage = useMemo(() => {
    const map = new Map<number, PageMatch[]>();
    for (const match of matches) {
      const list = map.get(match.page) ?? [];
      list.push(match);
      map.set(match.page, list);
    }
    return map;
  }, [matches]);

  const selectedMatch = selected >= 0 ? matches[selected] : undefined;
  const selectedLocal = selectedMatch ? (matchesByPage.get(selectedMatch.page) ?? []).indexOf(selectedMatch) : -1;

  // Bring the selected match's page into view; the page scrolls to the highlight itself.
  useEffect(() => {
    if (!selectedMatch) return;
    const { layout: now } = stateRef.current;
    const box = now.pages[selectedMatch.page - 1];
    const el = scrollRef.current;
    if (!box || !el) return;
    if (box.top + box.height < el.scrollTop || box.top > el.scrollTop + el.clientHeight) goToPage(selectedMatch.page);
  }, [selectedMatch, goToPage]);

  const onSelectedElement = useCallback((element: HTMLElement) => {
    const el = scrollRef.current;
    if (!el || !pendingMatchScroll.current) return;
    pendingMatchScroll.current = false;
    const target = element.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (target.top < box.top + 40 || target.bottom > box.bottom - 40) {
      el.scrollTop += target.top - box.top - el.clientHeight / 3;
    }
    if (target.left < box.left || target.right > box.right) {
      el.scrollLeft += target.left - box.left - el.clientWidth / 3;
    }
  }, []);

  const step = useCallback(
    (direction: 1 | -1) => {
      pendingMatchScroll.current = true;
      setPick({ query: debouncedQuery, index: stepMatch(selected, matches.length, direction) });
    },
    [matches.length, selected, debouncedQuery],
  );

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  // ---- Fullscreen --------------------------------------------------------------
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (typeof root.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
      root.requestFullscreen().catch(() => setFakeFullscreen((value) => !value));
    } else {
      // iPhone Safari has no element fullscreen: fill the viewport instead.
      setFakeFullscreen((value) => !value);
    }
  }, []);

  // ---- Zoom helpers ----------------------------------------------------------
  const setScale = useCallback((value: number) => setZoom({ kind: 'scale', value }), []);
  const doZoomIn = useCallback(() => setScale(zoomIn(stateRef.current.scale)), [setScale]);
  const doZoomOut = useCallback(() => setScale(zoomOut(stateRef.current.scale)), [setScale]);

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report the same way).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setScale(wheelZoom(stateRef.current.scale, event.deltaY, event.deltaMode));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setScale]);

  // Touch pinch: scale the pages visually while pinching, re-render on release.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let start: { distance: number; scale: number } | null = null;
    let ratio = 1;
    const distance = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    };
    const onStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        start = { distance: distance(event.touches), scale: stateRef.current.scale };
        ratio = 1;
      }
    };
    const onMove = (event: TouchEvent) => {
      if (!start || event.touches.length !== 2) return;
      event.preventDefault();
      const target = pinchZoom(start.scale, start.distance, distance(event.touches));
      ratio = target / start.scale;
      setPinch(ratio);
    };
    const onEnd = () => {
      if (!start) return;
      const committed = start.scale * ratio;
      start = null;
      setPinch(1);
      if (Math.abs(ratio - 1) > 0.01) setScale(committed);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [setScale]);

  // ---- Keyboard: scoped to the viewer --------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || externalUrl) return;
      const root = rootRef.current;
      const target = event.target as Node | null;
      const inside = Boolean(root && target && root.contains(target));
      const idle = target === document.body || target === document.documentElement;
      if (!inside && !(globalKeys && idle)) return;
      const action = pdfKeyAction(event, isEditableTarget(event.target));
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const { current: page, numPages: total } = stateRef.current;
      switch (action) {
        case 'prev':
          goToPage(page - 1);
          break;
        case 'next':
          goToPage(page + 1);
          break;
        case 'first':
          goToPage(1);
          break;
        case 'last':
          goToPage(total);
          break;
        case 'zoom-in':
          doZoomIn();
          break;
        case 'zoom-out':
          doZoomOut();
          break;
        case 'fullscreen':
          toggleFullscreen();
          break;
        case 'search':
          openSearch();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [globalKeys, externalUrl, goToPage, doZoomIn, doZoomOut, toggleFullscreen, openSearch]);

  // ---- Render --------------------------------------------------------------------
  const sidebarOpen = sidebar ?? (viewport.width >= 720 && numPages > 1);
  const overlaySidebar = viewport.width < 560;
  const zoomValue = zoom.kind === 'scale' ? String(zoom.value) : zoom.kind;
  const customZoom = zoom.kind === 'scale' && !(ZOOM_STEPS as readonly number[]).includes(zoom.value);

  const pages = [];
  for (let page = 1; page <= numPages; page++) {
    const box = layout.pages[page - 1]!;
    pages.push(
      <div
        key={page}
        className="absolute"
        style={{ top: box.top, height: box.height, left: pageLeft(box.width, viewport.width), width: box.width }}
      >
        <PdfPage
          services={services}
          pageNumber={page}
          width={box.width}
          height={box.height}
          renderScale={renderScale}
          rotation={rotation}
          active={rendered.has(page)}
          matches={matchesByPage.get(page) ?? NO_MATCHES}
          selected={selectedMatch?.page === page ? selectedLocal : -1}
          onSelectedElement={onSelectedElement}
        />
      </div>,
    );
  }

  return (
    <div
      ref={rootRef}
      data-no-swipe=""
      data-own-keys=""
      className={`pdf-root relative flex min-h-[18rem] flex-col overflow-hidden bg-well ${fakeFullscreen ? 'pdf-fake-fullscreen' : ''}`}
      style={{
        width: 'min(62.5rem, var(--media-max-width))',
        height: 'var(--pdf-height, var(--media-max-height))',
      }}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-line bg-surface px-1.5 py-1">
        <ToolButton label="Toggle sidebar" onClick={() => setSidebar(!sidebarOpen)} pressed={sidebarOpen}>
          <PanelLeft aria-hidden className="size-4" />
        </ToolButton>
        <ToolButton label="Previous page" onClick={() => goToPage(current - 1)} disabled={current <= 1} className="max-sm:hidden">
          <ChevronUp aria-hidden className="size-4" />
        </ToolButton>
        <form
          className="flex items-center gap-1 text-sm text-muted"
          onSubmit={(event) => {
            event.preventDefault();
            const page = parsePageInput(pageInput ?? '', numPages);
            if (page) goToPage(page);
            setPageInput(null);
          }}
        >
          <input
            aria-label="Page number"
            inputMode="numeric"
            value={pageInput ?? String(current)}
            onChange={(event) => setPageInput(event.target.value)}
            onFocus={(event) => {
              setPageInput(String(current));
              event.target.select();
            }}
            onBlur={() => {
              const page = parsePageInput(pageInput ?? '', numPages);
              if (page && page !== current) goToPage(page);
              setPageInput(null);
            }}
            className="h-7 w-10 rounded border border-line bg-bg px-1 text-center text-text tabular-nums"
          />
          <span className="tabular-nums whitespace-nowrap">/ {numPages}</span>
        </form>
        <ToolButton label="Next page" onClick={() => goToPage(current + 1)} disabled={current >= numPages} className="max-sm:hidden">
          <ChevronDown aria-hidden className="size-4" />
        </ToolButton>

        <div className="ml-auto flex items-center gap-0.5">
          <ToolButton label="Zoom out" onClick={doZoomOut}>
            <ZoomOut aria-hidden className="size-4" />
          </ToolButton>
          <select
            aria-label="Zoom"
            value={customZoom ? 'custom' : zoomValue}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'fit-width') setZoom(FIT_WIDTH);
              else if (value === 'fit-page') setZoom(FIT_PAGE);
              else if (value !== 'custom') setScale(Number(value));
            }}
            className="h-7 max-w-[6.5rem] rounded border border-line bg-bg px-1 text-sm text-text"
          >
            <option value="fit-width">Fit width</option>
            <option value="fit-page">Fit page</option>
            {customZoom && <option value="custom">{zoomLabel(scale)}</option>}
            {ZOOM_STEPS.map((step) => (
              <option key={step} value={String(step)}>
                {zoomLabel(step)}
              </option>
            ))}
          </select>
          <ToolButton label="Zoom in" onClick={doZoomIn}>
            <ZoomIn aria-hidden className="size-4" />
          </ToolButton>
          <ToolButton label="Rotate" onClick={() => setRotation((r) => rotate(r))}>
            <RotateCw aria-hidden className="size-4" />
          </ToolButton>
          <ToolButton label="Search" onClick={() => (searchOpen ? closeSearch() : openSearch())} pressed={searchOpen}>
            <Search aria-hidden className="size-4" />
          </ToolButton>
          <ToolButton label={fullscreen || fakeFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>
            {fullscreen || fakeFullscreen ? <Minimize aria-hidden className="size-4" /> : <Maximize aria-hidden className="size-4" />}
          </ToolButton>
          <a
            href={downloadUrl(file.cdn_url)}
            download={file.filename}
            aria-label="Download"
            title="Download"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text max-sm:hidden"
          >
            <Download aria-hidden className="size-4" />
          </a>
          <a
            href={file.cdn_url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Raw"
            title="Raw"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text max-sm:hidden"
          >
            <ExternalLink aria-hidden className="size-4" />
          </a>
        </div>
      </div>

      {searchOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-1.5 py-1">
          <input
            ref={searchInputRef}
            type="search"
            aria-label="Search in document"
            placeholder="Search…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              }
            }}
            className="h-7 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-sm text-text"
          />
          <span className="px-1 text-xs whitespace-nowrap text-muted tabular-nums" aria-live="polite">
            {!debouncedQuery
              ? ''
              : matches.length === 0
                ? searchDone
                  ? 'No matches'
                  : 'Searching…'
                : `${selected + 1} / ${matches.length}${searchDone ? '' : '+'}`}
          </span>
          <ToolButton label="Previous match" onClick={() => step(-1)} disabled={matches.length === 0}>
            <ChevronLeft aria-hidden className="size-4" />
          </ToolButton>
          <ToolButton label="Next match" onClick={() => step(1)} disabled={matches.length === 0}>
            <ChevronRight aria-hidden className="size-4" />
          </ToolButton>
          <ToolButton label="Close search" onClick={closeSearch}>
            <X aria-hidden className="size-4" />
          </ToolButton>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside
            aria-label="Pages and outline"
            className={`w-40 shrink-0 border-r border-line bg-surface ${overlaySidebar ? 'absolute inset-y-0 left-0 z-10 shadow-card' : ''}`}
          >
            <PdfSidebar
              doc={doc}
              sizes={sizes}
              rotation={rotation}
              current={current}
              onSelect={(page) => {
                goToPage(page);
                if (overlaySidebar) setSidebar(false);
              }}
              outline={outline}
              onOutline={(node) => {
                onOutline(node);
                if (overlaySidebar) setSidebar(false);
              }}
            />
          </aside>
        )}
        <div
          ref={scrollRef}
          tabIndex={0}
          aria-label={`${file.filename}, page ${current} of ${numPages}`}
          className="relative min-w-0 flex-1 overflow-auto overscroll-contain outline-none"
          style={{ touchAction: 'pan-x pan-y' }}
        >
          <div
            ref={contentRef}
            className="relative"
            style={{
              height: layout.height,
              width: Math.max(layout.width, viewport.width),
              transform: pinch !== 1 ? `scale(${pinch})` : undefined,
              transformOrigin: `50% ${scrollTop + (viewport.height || 0) / 2}px`,
            }}
          >
            {pages}
          </div>
        </div>
      </div>

      {externalUrl &&
        (isFlaggedLink(externalUrl, file.link_warnings) ? (
          <FlaggedLinkDialog url={externalUrl} onClose={() => setExternalUrl(null)} />
        ) : (
          <ExternalLinkDialog url={externalUrl} onClose={() => setExternalUrl(null)} />
        ))}
    </div>
  );
}
