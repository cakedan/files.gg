import { X } from 'lucide-react';
import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { useModal } from './useModal';

interface DialogProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Buttons row at the bottom. */
  footer?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  size?: 'sm' | 'md' | 'lg';
  /** role="alertdialog" for confirmations. */
  alert?: boolean;
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

/** A centred modal dialog (a bottom sheet on phones). */
export function Dialog({ title, description, onClose, children, footer, initialFocus, size = 'md', alert = false }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useModal(panel, onClose, initialFocus);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        ref={panel}
        data-modal=""
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className={`flex max-h-[92dvh] w-full ${SIZES[size]} flex-col rounded-t-xl border border-line bg-surface shadow-card outline-none sm:rounded-xl`}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            {description && (
              <div id={descriptionId} className="text-sm text-muted">
                {description}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text">
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
