import { CheckCircle2, CircleAlert, ExternalLink, Loader2, X } from 'lucide-react';

import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { errorMessage } from '../../lib/errors';
import { isActive, type BatchSkipped, type Conversion } from '../../lib/conversions';
import { pluralize } from '../files/fileLabels';
import { outcomeMessage, queueLine, sizeChange, sourceName, STAGE_LABELS } from './conversionText';
import { useBatch } from './queries';

/** One line of a running or finished conversion: queued, the stage and progress, or its result. */
export function ConversionLine({ conversion }: { conversion: Conversion }) {
  if (conversion.status === 'queued') return <span className="text-muted">{queueLine(conversion.position)}</span>;
  if (conversion.status === 'running') {
    const percent = Math.round((conversion.progress || 0) * 100);
    return (
      <span className="flex min-w-0 items-center gap-2 text-muted">
        <span className="shrink-0">
          {STAGE_LABELS[conversion.stage ?? 'converting']} · {percent}%
        </span>
        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <span className="block h-full bg-gg" style={{ width: `${Math.max(percent, 2)}%` }} />
        </span>
      </span>
    );
  }
  if (conversion.status === 'succeeded') return <span className="text-muted">{sizeChange(conversion.input_size, conversion.output_size) ?? 'Done'}</span>;
  return <span className="text-danger">{outcomeMessage(conversion, false)}</span>;
}

export function StatusIcon({ conversion }: { conversion: Conversion }) {
  if (isActive(conversion)) return <Loader2 aria-label="In progress" className="size-4 shrink-0 animate-spin text-gg" />;
  if (conversion.status === 'succeeded') return <CheckCircle2 aria-label="Done" className="size-4 shrink-0 text-gg" />;
  return <CircleAlert aria-label={conversion.status === 'cancelled' ? 'Cancelled' : 'Failed'} className="size-4 shrink-0 text-danger" />;
}

/** §13.1 "Batch": one combined progress list (`GET /conversions?batch=`), with per-item results. */
export function BatchList({ batchId, skipped, onCancel, onDone }: { batchId: string; skipped: BatchSkipped[]; onCancel: (id: string) => void; onDone: () => void }) {
  const batch = useBatch(batchId);
  const items = batch.data?.items ?? [];
  const finished = items.filter((item) => !isActive(item)).length;
  const succeeded = items.filter((item) => item.status === 'succeeded').length;

  return (
    <section aria-label="Batch" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold" aria-live="polite">
          {batch.isPending ? 'Starting…' : finished === items.length ? `Done: ${succeeded} of ${pluralize(items.length, 'file')} converted` : `Converting ${finished} of ${pluralize(items.length, 'file')}`}
        </h2>
        <Button variant="ghost" onClick={onDone}>
          New conversion
        </Button>
      </header>
      {batch.isError && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(batch.error)}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-line">
        {items.map((item) => {
          const output = item.output.file;
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <StatusIcon conversion={item} />
              <span className="min-w-0 flex-1 truncate font-medium">{sourceName(item)}</span>
              <span className="w-full min-w-0 text-xs sm:w-auto sm:text-sm">
                <ConversionLine conversion={item} />
              </span>
              {isActive(item) && (
                <Button variant="ghost" onClick={() => onCancel(item.id)} aria-label={`Cancel ${sourceName(item)}`}>
                  <X aria-hidden className="size-4" />
                </Button>
              )}
              {output && item.status === 'succeeded' && (
                <span className="flex gap-1">
                  <CopyButton text={output.url} variant="ghost" />
                  <a href={output.url} target="_blank" rel="noopener" className="inline-flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-text" aria-label={`Open ${output.filename}`}>
                    <ExternalLink aria-hidden className="size-4" />
                  </a>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {skipped.length > 0 && (
        <details className="text-sm text-muted">
          <summary className="cursor-pointer">{pluralize(skipped.length, 'file')} skipped</summary>
          <ul className="mt-1 list-disc pl-5">
            {skipped.map((each) => (
              <li key={each.source}>
                {each.source}: {each.code === 'UNSUPPORTED_CONVERSION' ? 'can’t be converted to that format' : 'not available'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
