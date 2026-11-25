import { CheckCircle2, CircleAlert, KeyRound, Loader2, Pause, Play, RotateCcw, X } from 'lucide-react';
import { Link } from 'react-router';

import { CopyButton } from '../../components/CopyButton';
import { formatBytes } from '../../lib/format';
import { errorMessage } from '../../lib/upload/errors';
import { uploadRejectedMessage } from '../safety/labels';
import { useScanStatus, type ScanStatus } from './useScanStatus';
import type { QueueItem } from './useUploadQueue';

/** The row's label once the bytes are up and the scan has an answer (milestone-4 §11.2). */
const SCAN_LABEL: Record<ScanStatus['phase'], string | null> = {
  idle: null,
  checking: 'Checking…',
  ready: null,
  moderated: 'Not shared',
  rejected: 'Rejected',
  gone: 'Not available',
  timeout: 'Still checking',
};

function ScanMessage({ scan }: { scan: ScanStatus }) {
  if (scan.phase === 'rejected') {
    return (
      <p className="text-sm text-danger" role="alert">
        {uploadRejectedMessage(scan.reason)}
      </p>
    );
  }
  if (scan.phase === 'moderated') {
    const text =
      scan.state === 'hidden'
        ? 'This file is being reviewed before it can be shared.'
        : scan.state === 'blocked'
          ? 'This file was blocked, so it can’t be shared.'
          : 'This file was removed, so it can’t be shared.';
    return (
      <p className="text-sm text-danger" role="alert">
        {text}{' '}
        {scan.noticeId && (
          <Link to={`/notices/${scan.noticeId}`} className="font-medium text-gg hover:underline">
            See the notice
          </Link>
        )}
      </p>
    );
  }
  if (scan.phase === 'gone') return <p className="text-sm text-danger" role="alert">This file is no longer available.</p>;
  if (scan.phase === 'timeout') return <p className="text-sm text-muted">Still checking. It appears in Files with its link once the check finishes.</p>;
  return null;
}

const PHASE_LABEL = {
  queued: 'Waiting…',
  verifying: 'Starting…',
  uploading: 'Uploading',
  paused: 'Paused',
  processing: 'Processing…',
  done: 'Uploaded',
  error: 'Failed',
  cancelled: 'Cancelled',
} as const;

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  );
}

export function UploadRow({ item, onRemove }: { item: QueueItem; onRemove: () => void }) {
  const { snapshot, task, file } = item;
  const { phase, loaded, total, result } = snapshot;
  const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
  const scan = useScanStatus(phase === 'done' ? result : undefined);
  const checking = scan.phase === 'checking';
  const failed = phase === 'error' || scan.phase === 'rejected' || scan.phase === 'moderated' || scan.phase === 'gone';
  const active = phase === 'uploading' || phase === 'verifying' || phase === 'processing' || checking;
  // The link only shows once the file is shared: `ok` or `flagged` (§11.2).
  const link = scan.phase === 'ready' || scan.phase === 'idle' ? result?.url : undefined;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" aria-label={file.name}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {failed ? (
            <CircleAlert aria-hidden className="size-5 text-danger" />
          ) : phase === 'done' && !checking ? (
            <CheckCircle2 aria-hidden className="size-5 text-gg" />
          ) : active ? (
            <Loader2 aria-hidden className="size-5 animate-spin text-muted" />
          ) : (
            <Pause aria-hidden className="size-5 text-muted" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </span>
          <span className="text-xs text-muted" aria-live="polite">
            {formatBytes(file.size)} · {(phase === 'done' && SCAN_LABEL[scan.phase]) || PHASE_LABEL[phase]}
            {phase === 'uploading' && ` ${percent}%`}
            {snapshot.chunked && phase !== 'done' && ' · resumable'}
            {snapshot.resumed && phase === 'uploading' && ' · resumed'}
          </span>
        </div>
        <div className="flex shrink-0 items-center">
          {task?.chunked && phase === 'uploading' && (
            <IconButton label="Pause" onClick={() => task.pause()}>
              <Pause aria-hidden className="size-4" />
            </IconButton>
          )}
          {task?.chunked && phase === 'paused' && (
            <IconButton label="Resume" onClick={() => void task.resume()}>
              <Play aria-hidden className="size-4" />
            </IconButton>
          )}
          {task && phase === 'error' && (
            <IconButton label="Retry" onClick={() => void task.start()}>
              <RotateCcw aria-hidden className="size-4" />
            </IconButton>
          )}
          <IconButton label={phase === 'done' || phase === 'error' || phase === 'cancelled' ? 'Remove' : 'Cancel'} onClick={onRemove}>
            <X aria-hidden className="size-4" />
          </IconButton>
        </div>
      </div>

      {phase !== 'done' && phase !== 'error' && phase !== 'cancelled' && (
        <div
          role="progressbar"
          aria-label={`${file.name} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        >
          <div
            className={`h-full rounded-full transition-[width] ${phase === 'paused' ? 'bg-muted' : 'bg-gg'} ${phase === 'processing' ? 'animate-pulse' : ''}`}
            style={{ width: `${phase === 'processing' ? 100 : percent}%` }}
          />
        </div>
      )}

      {phase === 'error' && (
        <p className="text-sm text-danger" role="alert">
          {errorMessage(snapshot.error)}
        </p>
      )}

      {phase === 'done' && <ScanMessage scan={scan} />}

      {phase === 'done' && (link || result?.password) && (
        <div className="flex flex-col gap-2">
          {link && (
            <div className="flex flex-wrap items-center gap-2">
              <a href={link} target="_blank" rel="noopener" className="min-w-0 truncate text-sm text-gg hover:underline">
                {link.replace(/^https?:\/\//, '')}
              </a>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={link} variant="secondary" />
                {result?.url_with_password && (
                  <CopyButton text={result.url_with_password} label="Copy link with password" variant="secondary" />
                )}
              </div>
            </div>
          )}
          {result?.password && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
              <KeyRound aria-hidden className="size-4 shrink-0 text-warn" />
              <span>
                Password: <code className="font-mono font-semibold break-all">{result.password}</code>
              </span>
              <CopyButton text={result.password} label="Copy password" variant="ghost" className="ml-auto" />
              <p className="w-full text-xs text-muted">Shown once. files.gg can't show it again, only reset it.</p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
