import { CircleAlert, Loader2, RotateCcw, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../../components/Button';
import { spokenDuration } from '../../lib/conversionErrors';
import type { Conversion } from '../../lib/conversions';
import { outcomeMessage, queueLine, STAGE_LABELS } from './conversionText';

/**
 * §13.1 step 4: queued ("Waiting in line", and "Sign in to skip the line" for anonymous
 * visitors), then the stage and a progress bar, with Cancel throughout. A conversion
 * that failed, timed out or was cancelled shows its message and Try again.
 */
export function ConversionProgress({
  conversion,
  anonymous,
  onCancel,
  cancelling,
  onRetry,
  signIn,
}: {
  conversion: Conversion;
  anonymous: boolean;
  onCancel: () => void;
  cancelling: boolean;
  onRetry: () => void;
  /** The "Sign in" link, for anonymous visitors. */
  signIn: (label: string) => ReactNode;
}) {
  if (conversion.status === 'queued' || conversion.status === 'running') {
    const running = conversion.status === 'running';
    const percent = Math.round(Math.min(1, Math.max(0, conversion.progress || 0)) * 100);
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          <Loader2 aria-hidden className="size-4 animate-spin text-gg" />
          <p className="min-w-0 flex-1 text-sm font-medium" data-testid="conversion-status">
            {running ? `${STAGE_LABELS[conversion.stage ?? 'converting']}…` : queueLine(conversion.position)}
          </p>
          <Button variant="ghost" onClick={onCancel} disabled={cancelling}>
            <X aria-hidden className="size-4" />
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        </div>
        {running ? (
          <div className="flex flex-col gap-1">
            <div
              role="progressbar"
              aria-label="Conversion progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 overflow-hidden rounded-full bg-surface-2"
            >
              <div className="h-full rounded-full bg-gg transition-[width] duration-500" style={{ width: `${Math.max(percent, 2)}%` }} />
            </div>
            <p className="text-xs text-muted">
              {percent}%{conversion.time_limit ? ` · up to ${spokenDuration(conversion.time_limit)}` : ''}
            </p>
          </div>
        ) : (
          anonymous && <p className="text-sm text-muted">{signIn('Sign in to skip the line')}</p>
        )}
      </div>
    );
  }

  const signInHint = conversion.error?.metadata?.sign_in === true && anonymous;
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-danger/40 bg-danger/10 p-4">
      <p className="flex items-start gap-2 text-sm">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        <span>{outcomeMessage(conversion, anonymous)}</span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onRetry}>
          <RotateCcw aria-hidden className="size-4" />
          Try again
        </Button>
        {signInHint && <span className="text-sm">{signIn('Sign in for bigger conversions')}</span>}
      </div>
    </div>
  );
}
