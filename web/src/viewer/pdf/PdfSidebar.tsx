import { ChevronRight } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import type { PDFDocumentProxy, RenderTask } from './pdfjs';
import { PDF_TO_CSS, THUMB_LABEL, THUMB_WIDTH, thumbLayout, visiblePages, windowRange, type Size } from './pdfState';

export interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineNode[];
}

interface ThumbProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  height: number;
  rotation: number;
  current: boolean;
  onSelect: (page: number) => void;
}

/** Renders thumbnails one at a time so they never compete with the main pages. */
let thumbQueue: Promise<unknown> = Promise.resolve();

const Thumb = memo(function Thumb({ doc, pageNumber, height, rotation, current, onSelect }: ThumbProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let canvas: HTMLCanvasElement | null = null;
    thumbQueue = thumbQueue.then(async () => {
      if (cancelled) return;
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: PDF_TO_CSS, rotation: (rotation + page.rotate) % 360 });
      const viewport = page.getViewport({
        scale: (PDF_TO_CSS * THUMB_WIDTH) / base.width,
        rotation: (rotation + page.rotate) % 360,
      });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.className = 'block h-full w-full';
      task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise.catch(() => undefined);
      if (!cancelled && canvas) box.replaceChildren(canvas);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [doc, pageNumber, rotation]);

  return (
    <button
      type="button"
      onClick={() => onSelect(pageNumber)}
      aria-label={`Page ${pageNumber}`}
      aria-current={current ? 'page' : undefined}
      className="group flex w-full flex-col items-center gap-1"
    >
      <div
        ref={boxRef}
        style={{ width: THUMB_WIDTH, height: height - THUMB_LABEL }}
        className={`overflow-hidden rounded-sm bg-white outline-offset-2 ${
          current ? 'outline-2 outline-gg' : 'outline-1 outline-line group-hover:outline-muted'
        } outline`}
      />
      <span className={`text-xs ${current ? 'font-semibold text-gg' : 'text-muted'}`}>{pageNumber}</span>
    </button>
  );
});

interface ThumbnailsProps {
  doc: PDFDocumentProxy;
  sizes: Size[];
  rotation: number;
  current: number;
  onSelect: (page: number) => void;
}

/** Virtualised: only thumbnails near the visible part of the list exist. */
function Thumbnails({ doc, sizes, rotation, current, onSelect }: ThumbnailsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const layout = useMemo(() => thumbLayout(sizes, rotation), [sizes, rotation]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  // Keep the current page's thumbnail in view.
  useEffect(() => {
    const el = scrollRef.current;
    const box = layout.pages[current - 1];
    if (!el || !box) return;
    if (box.top < el.scrollTop || box.top + box.height > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: box.top - el.clientHeight / 3 });
    }
  }, [current, layout]);

  const [from, to] = windowRange(visiblePages(layout, view.top, view.height), sizes.length, 3);
  const items = [];
  for (let page = from; page <= to && page > 0; page++) {
    const box = layout.pages[page - 1]!;
    items.push(
      <div key={page} className="absolute inset-x-0" style={{ top: box.top, height: box.height }}>
        <Thumb
          doc={doc}
          pageNumber={page}
          height={box.height}
          rotation={rotation}
          current={page === current}
          onSelect={onSelect}
        />
      </div>,
    );
  }

  return (
    <div ref={scrollRef} className="relative h-full overflow-y-auto overscroll-contain">
      <div className="relative" style={{ height: layout.height }}>
        {items}
      </div>
    </div>
  );
}

function OutlineTree({ nodes, onSelect, depth = 0 }: { nodes: OutlineNode[]; onSelect: (node: OutlineNode) => void; depth?: number }) {
  return (
    <ul className={depth === 0 ? 'flex flex-col gap-0.5 p-2' : 'flex flex-col gap-0.5 pl-3'}>
      {nodes.map((node, index) => (
        <OutlineEntry key={`${depth}-${index}`} node={node} onSelect={onSelect} depth={depth} />
      ))}
    </ul>
  );
}

function OutlineEntry({ node, onSelect, depth }: { node: OutlineNode; onSelect: (node: OutlineNode) => void; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  return (
    <li>
      <div className="flex items-start gap-0.5">
        {node.items.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
            className="mt-1 rounded p-0.5 text-muted hover:text-text"
          >
            <ChevronRight aria-hidden className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="w-4.5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node)}
          className="min-w-0 flex-1 rounded px-1.5 py-1 text-left text-sm break-words text-muted hover:bg-surface-2 hover:text-text"
        >
          {node.title || 'Untitled'}
        </button>
      </div>
      {open && node.items.length > 0 && <OutlineTree nodes={node.items} onSelect={onSelect} depth={depth + 1} />}
    </li>
  );
}

interface PdfSidebarProps extends ThumbnailsProps {
  outline: OutlineNode[];
  onOutline: (node: OutlineNode) => void;
}

export function PdfSidebar({ outline, onOutline, ...thumbs }: PdfSidebarProps) {
  const [tab, setTab] = useState<'pages' | 'outline'>('pages');
  const hasOutline = outline.length > 0;
  const active = hasOutline ? tab : 'pages';
  return (
    <div className="flex h-full flex-col">
      {hasOutline && (
        <div role="tablist" aria-label="Sidebar" className="flex shrink-0 gap-1 border-b border-line p-1.5">
          {(['pages', 'outline'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={active === name}
              onClick={() => setTab(name)}
              className={`flex-1 rounded px-2 py-1 text-xs font-medium ${
                active === name ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'
              }`}
            >
              {name === 'pages' ? 'Pages' : 'Outline'}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {active === 'pages' ? (
          <Thumbnails {...thumbs} />
        ) : (
          <div className="h-full overflow-y-auto overscroll-contain">
            <OutlineTree nodes={outline} onSelect={onOutline} />
          </div>
        )}
      </div>
    </div>
  );
}
