import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { ReportableTarget } from '../components/reportPath';
import { ReportForm } from './ReportForm';

/**
 * The report dialog (milestone-4 §11.1), opened by Report in the file footer and the
 * album header. A lazy chunk. It never closes on a backdrop click, so a half-written
 * report isn't lost by accident.
 */
export default function ReportDialog({ target, onClose }: { target: ReportableTarget; onClose: () => void }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('input, textarea, button:not([data-close])')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    // Touches stay in the dialog: React events cross portals, and the album lightbox swipes.
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/70 px-3 py-6"
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative mx-auto w-full max-w-lg rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"
      >
        <button
          type="button"
          data-close=""
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 rounded p-1 text-muted hover:text-text"
        >
          <X aria-hidden className="size-5" />
        </button>
        <ReportForm target={target} onClose={onClose} titleId={titleId} />
      </div>
    </div>,
    document.body,
  );
}
