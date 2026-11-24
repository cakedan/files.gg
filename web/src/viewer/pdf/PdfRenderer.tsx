import './pdf.css';

import { Download, FileWarning, Loader2, Lock } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Button, LinkButton } from '../../components/Button';
import type { RendererProps } from '../renderers/types';
import { downloadUrl } from '../urls';
import { openDocument, pageSize, PasswordResponses, type PDFDocumentProxy } from './pdfjs';
import type { Size } from './pdfState';
import { PdfViewer } from './PdfViewer';

type LoadState =
  | { status: 'loading'; progress: number | null }
  | { status: 'password'; incorrect: boolean; submit: (password: string) => void; cancel: () => void }
  | { status: 'locked' }
  | { status: 'error' }
  | { status: 'ready'; doc: PDFDocumentProxy; firstPageSize: Size };

const frameStyle = {
  width: 'min(62.5rem, var(--media-max-width))',
  height: 'var(--pdf-height, var(--media-max-height))',
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="viewer-well flex min-h-[18rem] flex-col gap-3 px-6 py-8 text-center" style={frameStyle}>
      {children}
    </div>
  );
}

function PasswordPrompt({ incorrect, onSubmit, onCancel }: { incorrect: boolean; onSubmit: (password: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => inputRef.current?.focus(), [incorrect]);
  return (
    <Frame>
      <Lock aria-hidden className="size-10 text-muted" />
      <h2 className="text-base font-semibold">This PDF is password-protected</h2>
      <p className="max-w-sm text-sm text-muted">
        Enter the password to open it. It's checked in your browser and never sent to files.gg.
      </p>
      <form
        className="flex w-full max-w-xs flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (password) onSubmit(password);
        }}
      >
        <label htmlFor={id} className="sr-only">
          PDF password
        </label>
        <input
          ref={inputRef}
          id={id}
          type="password"
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={incorrect}
          aria-describedby={incorrect ? `${id}-error` : undefined}
          className="h-9 rounded-md border border-line bg-bg px-3 text-sm text-text aria-invalid:border-danger"
        />
        {incorrect && (
          <p id={`${id}-error`} className="text-sm text-danger">
            That password isn't right. Try again.
          </p>
        )}
        <div className="flex justify-center gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!password}>
            Open
          </Button>
        </div>
      </form>
    </Frame>
  );
}

/** `kind: "pdf"` renderer (lazy chunk): pdf.js, range-loaded from the CDN. */
export default function PdfRenderer({ file, context = 'card' }: RendererProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading', progress: null });

  useEffect(() => {
    let cancelled = false;
    const task = openDocument(file.cdnUrl);
    task.onPassword = (update: (password: string) => void, reason: number) => {
      if (cancelled) return;
      setState({
        status: 'password',
        incorrect: reason === PasswordResponses.INCORRECT_PASSWORD,
        submit: (password) => {
          setState({ status: 'loading', progress: null });
          update(password);
        },
        cancel: () => {
          setState({ status: 'locked' });
          void task.destroy();
        },
      });
    };
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (!cancelled && total > 0) {
        setState((previous) => (previous.status === 'loading' ? { status: 'loading', progress: Math.min(1, loaded / total) } : previous));
      }
    };
    task.promise
      .then(async (doc) => {
        const first = await doc.getPage(1);
        if (!cancelled) setState({ status: 'ready', doc, firstPageSize: pageSize(first) });
      })
      .catch((error: { name?: string }) => {
        if (cancelled) return;
        setState((previous) => (previous.status === 'locked' || error?.name === 'PasswordException' ? { status: 'locked' } : { status: 'error' }));
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [file.cdnUrl]);

  switch (state.status) {
    case 'loading':
      return (
        <Frame>
          <div className="m-auto flex flex-col items-center gap-2 text-sm text-muted" role="status">
            <Loader2 aria-hidden className="size-6 animate-spin" />
            Loading PDF{state.progress !== null ? ` · ${Math.round(state.progress * 100)}%` : '…'}
          </div>
        </Frame>
      );
    case 'password':
      return <PasswordPrompt incorrect={state.incorrect} onSubmit={state.submit} onCancel={state.cancel} />;
    case 'locked':
    case 'error':
      return (
        <Frame>
          <div className="m-auto flex flex-col items-center gap-3">
            {state.status === 'locked' ? (
              <Lock aria-hidden className="size-10 text-muted" />
            ) : (
              <FileWarning aria-hidden className="size-10 text-warn" />
            )}
            <h2 className="text-base font-semibold">
              {state.status === 'locked' ? 'This PDF is password-protected' : "Can't preview this PDF"}
            </h2>
            <p className="max-w-sm text-sm text-muted">
              {state.status === 'locked'
                ? 'Download it to open it with the password in another app.'
                : 'It may be damaged or use features the viewer doesn’t support. You can still download it.'}
            </p>
            <LinkButton href={downloadUrl(file.cdnUrl)} download={file.filename} variant="primary">
              <Download aria-hidden className="size-4" />
              Download
            </LinkButton>
          </div>
        </Frame>
      );
    case 'ready':
      return (
        <PdfViewer
          file={file}
          doc={state.doc}
          firstPageSize={state.firstPageSize}
          globalKeys={context === 'card'}
          syncHash={context === 'card'}
        />
      );
  }
}
