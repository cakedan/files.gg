import './links.css';

import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { describeExternalLink } from '../../lib/externalLink';
import { WEB_RISK_WARNING } from './webRisk';
import { WebRiskNotice } from './WebRiskNotice';

/**
 * The "You're leaving files.gg" interstitial for a link Web Risk flagged
 * (milestone-4 §11.1): the warning, Google's attribution, and Copy link only.
 * There is deliberately no way to open the link from here.
 */
export function FlaggedLinkDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const info = describeExternalLink(url);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
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
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-warning`}
        className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card"
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
        <p id={`${titleId}-warning`} className="flex items-start gap-2 rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {WEB_RISK_WARNING}
        </p>
        <div className="rounded-xl border border-line bg-bg px-3 py-2">
          <div className="text-sm font-semibold break-all">{info.host}</div>
          <code className="mt-1 block font-mono text-xs break-all text-muted" data-testid="flagged-url">
            {info.href}
          </code>
        </div>
        <p className="text-sm text-muted">files.gg won't open this link. If you trust it anyway, copy it.</p>
        <WebRiskNotice />
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={closeRef} onClick={onClose}>
            Close
          </Button>
          <CopyButton text={info.href} variant="secondary" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
