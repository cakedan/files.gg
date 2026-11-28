import { Download, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../../components/Button';
import type { FileData } from '../types';
import { FileCard } from './FileCard';
import { confirmDownloadWarning, warningLines } from './stateCopy';

const withoutQuery = (url: string) => url.split(/[?#]/, 1)[0] ?? url;

function absolute(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

/** Banner above the card for the file's `warnings` (milestone-4 §11.1). */
export function FileWarnings({ file }: { file: Pick<FileData, 'warnings'> }) {
  const lines = warningLines(file.warnings);
  if (lines.length === 0) return null;
  return (
    <div role="note" className="viewer-banner flex items-start gap-2 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="flex flex-col gap-1">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  );
}

export function ConfirmDownload({
  message,
  onConfirm,
  onCancel,
  byPointer = false,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Opened by a mouse or touch click: hand focus back without a keyboard focus ring. */
  byPointer?: boolean;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // `focusVisible` (FocusOptions) is ignored where unsupported, which only brings the ring back.
      previous?.focus?.({ focusVisible: !byPointer } as FocusOptions);
    };
  }, [onCancel, byPointer]);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-3" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-message`}
        className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold">
          <ShieldAlert aria-hidden className="size-5 text-warn" />
          Download this file?
        </h2>
        <p id={`${titleId}-message`} className="text-sm text-muted">
          {message}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>
            <Download aria-hidden className="size-4" />
            Download anyway
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Any link to a warned file (`unwanted_software`, `encrypted_archive`, `encrypted_pdf`) asks for
 * confirmation first (milestone-4 §11.1): Download, Raw, a renderer's own Download, per-item
 * links in an album, and middle-clicks (security review W2). Files without such a warning, and
 * links to anything else, behave normally. "Open in new tab" from the context menu can't be
 * intercepted by a page; the CDN still serves warned files as downloads only.
 */
export function DownloadLinksGuard({ files, children }: { files: readonly Pick<FileData, 'warnings' | 'cdn_url'>[]; children: ReactNode }) {
  const [pending, setPending] = useState<{ link: HTMLAnchorElement; message: string; byPointer: boolean } | null>(null);
  const allowNext = useRef(false);

  const guarded = new Map<string, string>();
  for (const file of files) {
    const message = confirmDownloadWarning(file.warnings);
    if (message) guarded.set(withoutQuery(absolute(file.cdn_url)), message);
  }
  if (guarded.size === 0) return children;

  const intercept = (event: MouseEvent<HTMLDivElement>) => {
    if (allowNext.current) {
      allowNext.current = false;
      return;
    }
    const link = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
    const message = link ? guarded.get(withoutQuery(link.href)) : undefined;
    if (!link || !message) return;
    event.preventDefault();
    event.stopPropagation();
    // A keyboard activation (Enter on the link) is a click with `detail` 0.
    setPending({ link, message, byPointer: event.detail > 0 || event.button === 1 });
  };
  const onAuxClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) intercept(event);
  };

  return (
    <div className="contents" onClickCapture={intercept} onAuxClickCapture={onAuxClickCapture}>
      {children}
      {pending && (
        <ConfirmDownload
          message={pending.message}
          byPointer={pending.byPointer}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { link } = pending;
            setPending(null);
            allowNext.current = true;
            link.click();
          }}
        />
      )}
    </div>
  );
}

/** One file's links behind the download confirmation (see `DownloadLinksGuard`). */
export function DownloadGuard({ file, children }: { file: Pick<FileData, 'warnings' | 'cdn_url'>; children: ReactNode }) {
  return <DownloadLinksGuard files={[file]}>{children}</DownloadLinksGuard>;
}

/** A file with `warnings`: the banner, then the card behind the download confirmation. */
export function WarnedFile({ file }: { file: FileData }) {
  return (
    <>
      <FileWarnings file={file} />
      <DownloadGuard file={file}>
        <FileCard file={file} />
      </DownloadGuard>
    </>
  );
}
