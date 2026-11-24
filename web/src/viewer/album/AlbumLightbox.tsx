import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react';
import { createElement, Suspense, useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { LinkButton } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { isEditableTarget } from '../../lib/dom';
import { RendererFallback } from '../components/RendererFallback';
import { getRenderer } from '../renderers';
import type { AlbumItem } from '../types';
import { downloadUrl, shareUrl } from '../urls';
import { stepIndex } from './albumUrl';

interface AlbumLightboxProps {
  items: AlbumItem[];
  index: number;
  onGo: (index: number) => void;
  onClose: () => void;
}

const lightboxVars = {
  '--media-max-width': 'calc(100vw - 1rem)',
  '--media-max-height': 'calc(100dvh - 8.5rem)',
  '--media-min-width': '0px',
  '--pdf-height': 'calc(100dvh - 8.5rem)',
} as CSSProperties;

/** True when a swipe or arrow key started inside something that handles its own (PDF, zoomed image). */
const ownsInput = (target: EventTarget | null) =>
  target instanceof Element && target.closest('[data-no-swipe], [data-own-keys]') !== null;

/**
 * Full-screen carousel: ←/→, touch swipe, Esc. Each item renders with its own
 * viewer renderer; the URL follows `/a/<vanity>/<n>` (see useAlbumLightbox).
 */
export function AlbumLightbox({ items, index, onGo, onClose }: AlbumLightboxProps) {
  const item = items[index]!;
  const closeRef = useRef<HTMLButtonElement>(null);
  const touch = useRef<{ x: number; y: number; ignore: boolean } | null>(null);
  const count = items.length;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (isEditableTarget(event.target) || ownsInput(event.target)) return;
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        onGo(stepIndex(index, count, -1));
      } else if (event.key === 'ArrowRight' && index < count - 1) {
        event.preventDefault();
        onGo(stepIndex(index, count, 1));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, count, onGo, onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${item.filename}, ${index + 1} of ${count}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/95 text-text"
      style={lightboxVars}
      onTouchStart={(event) => {
        const t = event.touches[0];
        touch.current = t && event.touches.length === 1 ? { x: t.clientX, y: t.clientY, ignore: ownsInput(event.target) } : null;
      }}
      onTouchEnd={(event) => {
        const start = touch.current;
        const t = event.changedTouches[0];
        touch.current = null;
        if (!start || !t || start.ignore) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          onGo(stepIndex(index, count, dx < 0 ? 1 : -1));
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 px-2 py-2 sm:px-3">
        <span className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-sm tabular-nums" aria-live="polite">
          {index + 1} / {count}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted" title={item.filename}>
          {item.filename}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <CopyButton text={shareUrl(item.url)} variant="secondary" className="max-sm:px-2" />
          <LinkButton href={downloadUrl(item.cdnUrl)} download={item.filename} aria-label="Download" title="Download" className="px-2">
            <Download aria-hidden className="size-4" />
          </LinkButton>
          <LinkButton href={item.cdnUrl} target="_blank" rel="noopener noreferrer" aria-label="Raw" title="Raw" className="px-2" variant="ghost">
            <ExternalLink aria-hidden className="size-4" />
          </LinkButton>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-1 rounded-full p-2 text-muted hover:bg-white/10 hover:text-text"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        <div key={index} className="flex max-h-full max-w-full items-center justify-center">
          <Suspense fallback={<RendererFallback file={item} />}>
            {createElement(getRenderer(item.kind), { file: item, context: 'lightbox' })}
          </Suspense>
        </div>
        {index > 0 && (
          <button
            type="button"
            onClick={() => onGo(stepIndex(index, count, -1))}
            aria-label="Previous"
            className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80 max-sm:hidden"
          >
            <ChevronLeft aria-hidden className="size-6" />
          </button>
        )}
        {index < count - 1 && (
          <button
            type="button"
            onClick={() => onGo(stepIndex(index, count, 1))}
            aria-label="Next"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80 max-sm:hidden"
          >
            <ChevronRight aria-hidden className="size-6" />
          </button>
        )}
      </div>

      <div className="flex min-h-12 shrink-0 items-center justify-center gap-3 px-4 py-2 text-center text-sm">
        <button
          type="button"
          onClick={() => onGo(stepIndex(index, count, -1))}
          disabled={index === 0}
          aria-label="Previous"
          className="rounded-full p-1.5 text-muted disabled:opacity-30 sm:hidden"
        >
          <ChevronLeft aria-hidden className="size-5" />
        </button>
        <p className="line-clamp-2 min-w-0 flex-1 break-words text-muted sm:flex-none">{item.caption}</p>
        <button
          type="button"
          onClick={() => onGo(stepIndex(index, count, 1))}
          disabled={index === count - 1}
          aria-label="Next"
          className="rounded-full p-1.5 text-muted disabled:opacity-30 sm:hidden"
        >
          <ChevronRight aria-hidden className="size-5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
