import { X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useModal } from './useModal';

interface DrawerProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Extra header content, next to the close button. */
  actions?: ReactNode;
}

/** A side panel (full width on phones), modal like a dialog. */
export function Drawer({ title, onClose, children, actions }: DrawerProps) {
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useModal(panel, onClose, closeRef);

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onMouseDown={onClose}>
      <aside
        ref={panel}
        data-modal=""
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        className="file-drawer flex h-full w-full flex-col border-l border-line bg-surface shadow-card sm:w-[min(44rem,92vw)]"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold" title={title}>
            {title}
          </h2>
          {actions}
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text">
            <X aria-hidden className="size-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
