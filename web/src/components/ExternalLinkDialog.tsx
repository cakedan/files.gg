import { ExternalLink, ShieldAlert, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { describeExternalLink, openExternal } from '../lib/externalLink';
import { Button } from './Button';

interface ExternalLinkDialogProps {
  url: string;
  onClose: () => void;
  /** Set when the link was flagged by the Web Risk check at scan time. */
  flagged?: boolean;
}

/**
 * "You're leaving files.gg": shown before opening any link that came from user
 * content, with the full URL so a misleading link text can't hide where it goes.
 */
export function ExternalLinkDialog({ url, onClose, flagged = false }: ExternalLinkDialogProps) {
  const info = describeExternalLink(url);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-3" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">
            You're leaving files.gg
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded p-1 text-muted hover:text-text">
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <p className="text-sm text-muted">
          This link was in the file, not added by files.gg. Check the address before you continue.
        </p>
        {flagged && (
          <p className="flex items-center gap-2 rounded-md bg-danger/15 px-3 py-2 text-sm text-danger">
            <ShieldAlert aria-hidden className="size-4 shrink-0" />
            This link was flagged as possibly unsafe.
          </p>
        )}
        <div className="rounded-md border border-line bg-bg px-3 py-2">
          <div className="text-sm font-semibold break-all">{info.host}</div>
          <code className="mt-1 block font-mono text-xs break-all text-muted" data-testid="external-url">
            {info.href}
          </code>
        </div>
        {!info.allowed && <p className="text-sm text-warn">files.gg can't open this kind of link.</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} onClick={onClose}>
            Cancel
          </Button>
          {info.allowed && (
            <Button
              variant="primary"
              onClick={() => {
                openExternal(info);
                onClose();
              }}
            >
              <ExternalLink aria-hidden className="size-4" />
              Continue
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
