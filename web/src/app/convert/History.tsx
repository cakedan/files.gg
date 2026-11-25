import { ArrowRight, ExternalLink, RotateCcw, Trash2, X } from 'lucide-react';

import { Button } from '../../components/Button';
import { isActive, type Conversion } from '../../lib/conversions';
import { errorMessage } from '../../lib/errors';
import { epochMs, formatRelative } from '../../lib/time';
import { ConversionLine, StatusIcon } from './BatchList';
import { rerunSource, sourceName } from './conversionText';
import { useHistory } from './queries';

/**
 * §13.1 "History" (signed in): source, target, status, size change and output link,
 * with re-run and delete, newest first. Rows still running update live.
 */
export function History({ onRerun, onRemove, busy }: { onRerun: (conversion: Conversion) => void; onRemove: (conversion: Conversion) => void; busy: string | null }) {
  const history = useHistory(true);
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="convert-history" className="flex flex-col gap-3">
      <h2 id="convert-history" className="text-lg font-semibold">
        History
      </h2>
      {history.isPending ? (
        <p className="text-sm text-muted" role="status">
          Loading…
        </p>
      ) : history.isError ? (
        <p className="text-sm text-danger" role="alert">
          {errorMessage(history.error)}{' '}
          <button type="button" className="font-medium text-gg hover:underline" onClick={() => void history.refetch()}>
            Try again
          </button>
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">Your conversions show here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((item) => {
            const output = item.output.file ?? item.output.album;
            const rerun = rerunSource(item);
            const active = isActive(item);
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                <StatusIcon conversion={item} />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate font-medium">{sourceName(item)}</span>
                  <ArrowRight aria-label="to" className="size-3.5 shrink-0 text-muted" />
                  <span className="shrink-0 font-medium uppercase">{item.target}</span>
                </span>
                <time className="shrink-0 text-xs text-muted" dateTime={new Date(epochMs(item.created_at)).toISOString()}>
                  {formatRelative(epochMs(item.created_at))}
                </time>
                <span className="w-full min-w-0 text-xs">
                  <ConversionLine conversion={item} />
                </span>
                <span className="flex w-full flex-wrap justify-end gap-1">
                  {output && item.status === 'succeeded' && (
                    <a href={output.url} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-muted hover:bg-surface-2 hover:text-text">
                      <ExternalLink aria-hidden className="size-4" />
                      Open
                    </a>
                  )}
                  {rerun && !active && (
                    <Button variant="ghost" className="h-8 px-2" onClick={() => onRerun(item)} disabled={busy === item.id}>
                      <RotateCcw aria-hidden className="size-4" />
                      Run again
                    </Button>
                  )}
                  <Button variant="ghost" className="h-8 px-2" onClick={() => onRemove(item)} disabled={busy === item.id} aria-label={active ? `Cancel ${sourceName(item)}` : `Delete ${sourceName(item)} from history`}>
                    {active ? <X aria-hidden className="size-4" /> : <Trash2 aria-hidden className="size-4" />}
                    {active ? 'Cancel' : 'Delete'}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {history.hasNextPage && (
        <Button className="self-center" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
          {history.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </section>
  );
}
