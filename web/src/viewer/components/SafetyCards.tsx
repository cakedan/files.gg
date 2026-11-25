import { Ban, Hourglass, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, LinkButton } from '../../components/Button';
import { mainUrl } from '../host/context';
import type { RemovedReason, StateTarget } from '../types';
import { nextStep, readProgress, withProgress } from './pendingReload';
import { StateCard } from './StateCards';
import { removedMessage, TERMS_URL } from './stateCopy';

/*
 * Milestone 4 shell states (milestone-4 §2.4, §11.1). A chunk of their own: almost
 * every page view is a plain file, which never needs them.
 */

const reloadPage = () => window.location.reload();

interface PendingCardProps {
  target: StateTarget;
  /**
   * How to load the page again; `location.reload()` by default. Protected pages pass
   * an in-page reload instead: a full one would lose their `#t=` / `#pw=` secrets
   * (stripped on load, never stored). The card is re-mounted after each one, so the
   * schedule continues from `history.state` either way.
   */
  reload?: (() => void) | undefined;
  /** Test hook. */
  now?: () => number;
}

/**
 * `pending` (milestone-4 §2.4, §11.1): the file isn't checked yet. Reloads itself on
 * the schedule in pendingReload.ts, then offers Retry.
 */
export function PendingCard({ target, reload = reloadPage, now = Date.now }: PendingCardProps) {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const path = window.location.pathname + window.location.search;
    const started = now();
    const progress = readProgress(window.history.state, path, started);
    const step = nextStep(progress, started);
    const timer = window.setTimeout(() => {
      if (step.action === 'stall') {
        setStalled(true);
        return;
      }
      const at = now();
      window.history.replaceState(withProgress(window.history.state, { ...progress, reloads: progress.reloads + 1, at }), '');
      reload();
    }, step.delay);
    return () => window.clearTimeout(timer);
  }, [reload, now]);

  const retry = () => {
    window.history.replaceState(withProgress(window.history.state, null), '');
    reload();
  };

  return (
    <StateCard>
      {stalled ? (
        <Hourglass aria-hidden className="size-10 text-warn" />
      ) : (
        <Loader2 aria-hidden className="size-10 animate-spin text-gg motion-reduce:animate-none" />
      )}
      <h1 className="text-lg font-semibold">Checking this {target.kind}…</h1>
      <p className="text-sm text-muted" role="status">
        {stalled ? 'Still checking. Large videos can take a minute or two.' : 'This usually takes a few seconds.'}
      </p>
      {stalled && (
        <Button variant="primary" onClick={retry}>
          <RefreshCw aria-hidden className="size-4" />
          Retry
        </Button>
      )}
    </StateCard>
  );
}

/** `removed` (HTTP 410): hidden, held or removed by moderation (milestone-4 §2.4). */
export function RemovedCard({ target, reason }: { target: StateTarget; reason: RemovedReason }) {
  return (
    <StateCard>
      <Ban aria-hidden className="size-10 text-muted" />
      <h1 className="text-lg font-semibold">{removedMessage(target.kind, reason)}</h1>
      <p className="text-sm text-muted">
        Read the{' '}
        <a href={mainUrl(TERMS_URL)} className="text-gg underline-offset-2 hover:underline">
          Terms
        </a>{' '}
        to see what isn't allowed on files.gg.
      </p>
      <LinkButton href={mainUrl('/')}>Go to files.gg</LinkButton>
    </StateCard>
  );
}
