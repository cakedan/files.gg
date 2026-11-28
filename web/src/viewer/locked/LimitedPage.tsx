import { Eye, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { REFRESH_RETRY_MS, refreshDelay } from '../../lib/access';
import type { AccessGrant } from '../../lib/api';
import { useSignedValue } from '../../lib/signedUrls';
import { useNow } from '../../lib/useNow';
import { FileView } from '../components/FileView';
import { PendingCard, RemovedCard } from '../components/SafetyCards';
import { MissingCard, UnavailableCard } from '../components/StateCards';
import { VIEW_LIMIT_INTRO, viewLimitUse } from '../components/viewLimitText';
import { ChallengeFallback } from '../host/ChallengeFallback';
import { siteName } from '../host/context';
import { useHumanCheck } from '../host/useHumanCheck';
import type { RemovedReason } from '../types';
import { contentFrom, type Content } from './content';
import { viewerApi } from './hostApi';
import LockedPage, { Unlocked } from './LockedPage';
import { openedFrom, type OpenedFile } from './opened';
import { classifyUnlockError, isTransient, unlockErrorMessage, type UnlockError } from './unlockErrors';

/** setTimeout overflows past ~24.8 days; long waits re-check once a day instead. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

function schedule(at: number, run: () => void, recheck: () => void): number {
  const delay = at - Date.now();
  if (delay > MAX_TIMER_MS) return window.setTimeout(recheck, MAX_TIMER_MS);
  return window.setTimeout(run, Math.max(0, delay));
}

/** The API says the file is pending, removed or gone: the page shows that state instead. */
const isUnavailable = (error: UnlockError) => error.kind === 'pending' || error.kind === 'removed' || error.kind === 'missing';

interface LimitedCardProps {
  vanity: string;
  remaining: number | null;
  onOpened: (opened: OpenedFile) => void;
  /** `401 UNLOCK_REQUIRED`: it's a password file after all; the lock screen takes over. */
  onPasswordRequired: () => void;
  onUnavailable: (error: UnlockError) => void;
}

/**
 * The `limited` card (milestone-6 §19.7): "This file has a view limit. Opening it uses
 * one of its N remaining views." with **Open file**, which runs Turnstile (action `view`;
 * the files.gg frame on a custom domain), then `POST /access/open/files/<vanity>`.
 */
export function LimitedCard({ vanity, remaining, onOpened, onPasswordRequired, onUnavailable }: LimitedCardProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UnlockError | null>(null);
  // When the error arrived: the countdown clock never reads earlier than this.
  const [errorAt, setErrorAt] = useState(0);
  const { mount, status, take, retry, framed } = useHumanCheck('view');
  const now = Math.max(useNow(error?.kind === 'rate-limited' ? 1000 : 60_000), errorAt);
  const waiting = error?.kind === 'rate-limited' && (error.retryAt ?? 0) > now;

  const open = async () => {
    if (busy || waiting) return;
    setBusy(true);
    setError(null);
    try {
      const token = await take();
      const opened = openedFrom(await viewerApi.open(vanity, token));
      if (!opened) {
        setError({ kind: 'other' });
        return;
      }
      onOpened(opened);
    } catch (failure) {
      const at = Date.now();
      const classified = classifyUnlockError(failure, at);
      if (classified.kind === 'unlock-required') onPasswordRequired();
      else if (isUnavailable(classified)) onUnavailable(classified);
      else {
        setError(classified);
        setErrorAt(at);
      }
    } finally {
      setBusy(false);
    }
  };

  const checkFailed = error?.kind === 'captcha' || error?.kind === 'verification' || status === 'error';
  return (
    <section className="viewer-card w-[min(26rem,100vw-1.5rem)] gap-4 px-6 py-7" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-2">
          <Eye aria-hidden className="size-6 text-gg" />
        </span>
        <h1 id={`${id}-title`} className="text-lg font-semibold">
          {VIEW_LIMIT_INTRO}
        </h1>
        <p className="text-sm text-muted">{viewLimitUse('Opening', remaining)}</p>
      </div>

      {/* Managed Turnstile: invisible unless Cloudflare needs a click. On a custom domain, the files.gg frame. */}
      <div ref={mount} className="flex justify-center empty:hidden" data-testid="turnstile" />

      {error && (
        <p role="alert" className={error.kind === 'rate-limited' ? 'text-center text-sm text-warn' : 'text-center text-sm text-danger'}>
          {unlockErrorMessage(error, now, 'open')}
        </p>
      )}
      {framed && (error?.kind === 'verification' || status === 'error') && <ChallengeFallback target={{ type: 'file', vanity }} />}
      {checkFailed && (
        <Button
          onClick={() => {
            setError(null);
            retry();
          }}
        >
          <RefreshCw aria-hidden className="size-4" />
          Retry the check
        </Button>
      )}

      <Button variant="primary" onClick={() => void open()} disabled={busy || waiting}>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Eye aria-hidden className="size-4" />}
        {busy ? 'Opening…' : 'Open file'}
      </Button>
      <p className="text-center text-xs text-muted">Protected by Cloudflare Turnstile.</p>
    </section>
  );
}

type RefreshPhase = 'idle' | 'running' | 'failed';

interface OpenedViewProps {
  vanity: string;
  initial: OpenedFile;
  /** The URLs ran out without a refresh: back to the card (opening again doesn't count). */
  onExpired: () => void;
  onPasswordRequired: () => void;
  onUnavailable: (error: UnlockError) => void;
}

/**
 * The opened file, rendered normally. Its signed URLs last 1 h (or until the file
 * expires); shortly before that it opens again (a fresh Turnstile token each time, the
 * same viewer never counts twice) and moves to the new URLs once the old ones are about
 * to expire, so playing media isn't reloaded. If the check needs the visitor, a small
 * panel shows the widget.
 */
export function OpenedView({ vanity, initial, onExpired, onPasswordRequired, onUnavailable }: OpenedViewProps) {
  const [current, setCurrent] = useState(initial);
  const [phase, setPhase] = useState<RefreshPhase>('idle');
  const [failure, setFailure] = useState<UnlockError | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  /** Open stopped extending the URLs (the file expires first): let them run out. */
  const [capped, setCapped] = useState(false);
  const [tick, setTick] = useState(0);
  const { mount, take, retry, framed } = useHumanCheck('view', phase !== 'idle');
  const callbacks = useRef({ onExpired, onPasswordRequired, onUnavailable });
  useEffect(() => {
    callbacks.current = { onExpired, onPasswordRequired, onUnavailable };
  });

  const shown = useSignedValue(current.file);
  useEffect(() => {
    document.title = `${shown.filename} · ${siteName()}`;
  }, [shown.filename]);

  // Open again shortly before the URLs expire (or after a failed try).
  useEffect(() => {
    if (capped || phase !== 'idle') return;
    const at = retryAt ?? Date.now() + refreshDelay(current.expiresAt, Date.now());
    const id = schedule(at, () => setPhase('running'), () => setTick((n) => n + 1));
    return () => window.clearTimeout(id);
  }, [current, capped, phase, retryAt, tick]);

  useEffect(() => {
    if (phase !== 'running') return;
    let cancelled = false;
    (async () => {
      try {
        const token = await take();
        const next = openedFrom(await viewerApi.open(vanity, token));
        if (cancelled) return;
        if (!next) {
          setRetryAt(Date.now() + REFRESH_RETRY_MS);
          setPhase('idle');
          return;
        }
        if (next.expiresAt <= current.expiresAt) setCapped(true);
        setCurrent(next);
        setRetryAt(null);
        setFailure(null);
        setPhase('idle');
      } catch (error) {
        if (cancelled) return;
        const classified = classifyUnlockError(error);
        if (classified.kind === 'unlock-required') callbacks.current.onPasswordRequired();
        else if (isUnavailable(classified)) callbacks.current.onUnavailable(classified);
        else if (classified.kind === 'captcha' || classified.kind === 'verification') {
          setFailure(classified);
          setPhase('failed');
        } else {
          // Offline, a server error or a rate limit: try again soon, quietly.
          setRetryAt(Date.now() + REFRESH_RETRY_MS);
          setPhase('idle');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, take, vanity, current.expiresAt]);

  // Hard stop when the URLs expire.
  useEffect(() => {
    const id = schedule(current.expiresAt * 1000, () => callbacks.current.onExpired(), () => setTick((n) => n + 1));
    return () => window.clearTimeout(id);
  }, [current, tick]);

  return (
    <>
      <FileView file={shown} />
      {phase !== 'idle' && (
        <aside
          aria-label="Keeping this file open"
          className="fixed bottom-3 left-1/2 z-20 flex w-[min(22rem,100vw-1.5rem)] -translate-x-1/2 flex-col items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-3 text-center shadow-lg"
        >
          <p className="text-sm text-muted" role="status">
            {/* Only `captcha` or `verification` fail here, so no clock is needed. */}
            {phase === 'running' ? 'Keeping this file open…' : unlockErrorMessage(failure ?? { kind: 'captcha' }, 0, 'open')}
          </p>
          <div ref={mount} className="flex justify-center empty:hidden" />
          {phase === 'failed' && framed && <ChallengeFallback target={{ type: 'file', vanity }} />}
          {phase === 'failed' && (
            <Button
              onClick={() => {
                retry();
                setPhase('running');
              }}
            >
              <RefreshCw aria-hidden className="size-4" />
              Retry the check
            </Button>
          )}
        </aside>
      )}
    </>
  );
}

type Phase =
  | { status: 'checking' }
  | { status: 'card' }
  | { status: 'opened'; opened: OpenedFile }
  | { status: 'owner'; content: Content; grant: AccessGrant }
  | { status: 'password' }
  | { status: 'missing' }
  | { status: 'unavailable' }
  | { status: 'pending'; run: number }
  | { status: 'removed'; reason: RemovedReason };

export interface LimitedPageProps {
  vanity: string;
  /** `views_remaining` from the shell, or null. */
  remaining: number | null;
  /** `#t=` owner pass from the URL (already stripped): the owner never counts. */
  ownerPass?: string | undefined;
}

/**
 * A view-limited file (`data-state="limited"`, milestone-6 §19.4–§19.7), lazy:
 * 1. a `#t=` owner pass opens it with `/access/view/files/<vanity>` (owners never count);
 * 2. otherwise the card, then Open file (Turnstile, `/access/open/files/<vanity>`) renders it normally;
 * 3. `401 UNLOCK_REQUIRED` switches to the lock screen, where unlocking uses the view.
 * `404` is the normal missing state: the next viewer after the limit is never told why.
 */
export default function LimitedPage({ vanity, remaining, ownerPass }: LimitedPageProps) {
  const [phase, setPhase] = useState<Phase>(ownerPass ? { status: 'checking' } : { status: 'card' });
  const [attempt, setAttempt] = useState(0);
  const runs = useRef(0);
  const reload = useCallback(() => {
    setPhase(ownerPass ? { status: 'checking' } : { status: 'card' });
    setAttempt((n) => n + 1);
  }, [ownerPass]);

  const fromError = useCallback((error: UnlockError): Phase | null => {
    if (error.kind === 'missing') return { status: 'missing' };
    if (error.kind === 'pending') return { status: 'pending', run: ++runs.current };
    if (error.kind === 'removed') return { status: 'removed', reason: error.reason ?? 'terms' };
    return null;
  }, []);

  useEffect(() => {
    if (!ownerPass) return;
    let cancelled = false;
    viewerApi
      .view('file', vanity, ownerPass)
      .then((response) => {
        if (cancelled) return;
        const content = contentFrom('file', response);
        setPhase(content ? { status: 'owner', content, grant: { token: response.token, expires_at: response.expires_at } } : { status: 'card' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const state = fromError(classifyUnlockError(error));
        setPhase(state ?? (isTransient(error) ? { status: 'unavailable' } : { status: 'card' }));
      });
    return () => {
      cancelled = true;
    };
  }, [vanity, ownerPass, attempt, fromError]);

  const onOpened = useCallback((opened: OpenedFile) => setPhase({ status: 'opened', opened }), []);
  const onPasswordRequired = useCallback(() => setPhase({ status: 'password' }), []);
  const onUnavailable = useCallback((error: UnlockError) => setPhase(fromError(error) ?? { status: 'card' }), [fromError]);
  const toCard = useCallback(() => setPhase({ status: 'card' }), []);
  const toMissing = useCallback(() => setPhase({ status: 'missing' }), []);

  switch (phase.status) {
    case 'checking':
      return <main className="min-h-dvh" aria-busy="true" />;
    case 'opened':
      return (
        <OpenedView
          vanity={vanity}
          initial={phase.opened}
          onExpired={toCard}
          onPasswordRequired={onPasswordRequired}
          onUnavailable={onUnavailable}
        />
      );
    case 'owner':
      return <Unlocked content={phase.content} grant={phase.grant} scope="owner" kind="file" vanity={vanity} onExpired={toCard} onMissing={toMissing} />;
    case 'password':
      return <LockedPage kind="file" vanity={vanity} protection="password" viewLimit={{ remaining }} />;
    default:
      return (
        <main className="flex min-h-dvh items-center justify-center px-3 py-6">
          {phase.status === 'missing' && <MissingCard />}
          {phase.status === 'unavailable' && <UnavailableCard onRetry={reload} />}
          {phase.status === 'pending' && <PendingCard key={phase.run} target={{ kind: 'file', vanity }} reload={reload} />}
          {phase.status === 'removed' && <RemovedCard target={{ kind: 'file', vanity }} reason={phase.reason} />}
          {phase.status === 'card' && (
            <LimitedCard vanity={vanity} remaining={remaining} onOpened={onOpened} onPasswordRequired={onPasswordRequired} onUnavailable={onUnavailable} />
          )}
        </main>
      );
  }
}
