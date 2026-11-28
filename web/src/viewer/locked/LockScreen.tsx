import { Eye, EyeOff, Loader2, Lock, RefreshCw, TimerOff } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { Button, LinkButton } from '../../components/Button';
import type { AccessKind, UnlockResponse } from '../../lib/api';
import { useNow } from '../../lib/useNow';
import { ChallengeFallback } from '../host/ChallengeFallback';
import { mainUrl } from '../host/context';
import { useHumanCheck } from '../host/useHumanCheck';
import { viewLimitLine } from '../components/viewLimitText';
import type { ViewLimitInfo } from '../types';
import { viewerApi } from './hostApi';
import { classifyUnlockError, unlockErrorMessage, type UnlockError } from './unlockErrors';

interface LockScreenProps {
  kind: AccessKind;
  vanity: string;
  /** Only when the owner chose "show name when locked". */
  name?: string | undefined;
  /** From a `#pw=` link: unlock automatically once Turnstile passes. */
  initialPassword?: string | undefined;
  onUnlocked: (response: UnlockResponse) => void;
  /**
   * Milestone 4: the API says it's pending or removed; milestone 6 §8.8: or missing
   * (`404`, for example the owner's account is pending deletion). The page shows that
   * state instead. `password` is the one tried, so a pending unlock can be tried again.
   */
  onUnavailable?: ((error: UnlockError, password: string) => void) | undefined;
  /** Milestone 6 §19.7: a view-limited password file; a successful unlock uses a view. */
  viewLimit?: ViewLimitInfo | undefined;
}

export function PasswordExpiredCard({ kind }: { kind: AccessKind }) {
  return (
    <section className="viewer-card w-[min(28rem,100vw-1.5rem)] items-center gap-4 px-6 py-8 text-center">
      <TimerOff aria-hidden className="size-10 text-warn" />
      <h1 className="text-lg font-semibold">This link's password has expired</h1>
      <p className="text-sm text-muted">
        The password for this {kind} no longer works. Ask whoever shared it for a new link.
      </p>
      <LinkButton href={mainUrl('/')}>Go to files.gg</LinkButton>
    </section>
  );
}

/**
 * Contract §4/§5 lock screen: password (with a show toggle), managed Turnstile
 * (action `unlock`, required on every attempt) and Unlock.
 */
export function LockScreen({ kind, vanity, name, initialPassword, onUnlocked, onUnavailable, viewLimit }: LockScreenProps) {
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UnlockError | null>(null);
  // When the error arrived: the countdown clock never reads earlier than this.
  const [errorAt, setErrorAt] = useState(0);
  const [expired, setExpired] = useState(false);
  const autoTried = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const {
    mount: turnstileMount,
    status: turnstileStatus,
    take: takeTurnstile,
    retry: retryTurnstile,
    framed,
  } = useHumanCheck('unlock');
  const now = Math.max(useNow(error?.kind === 'rate-limited' ? 1000 : 60_000), errorAt);
  const waiting = error?.kind === 'rate-limited' && (error.retryAt ?? 0) > now;

  const attempt = async (value: string, fromLink: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const token = await takeTurnstile();
      const response = await viewerApi.unlock(kind, vanity, value, token);
      onUnlocked(response);
    } catch (failure) {
      const at = Date.now();
      const classified = classifyUnlockError(failure, at);
      if (classified.kind === 'expired') {
        setExpired(true);
      } else if ((classified.kind === 'pending' || classified.kind === 'removed' || classified.kind === 'missing') && onUnavailable) {
        onUnavailable(classified, value);
      } else {
        setError({ ...classified, fromLink });
        setErrorAt(at);
        if (classified.kind === 'wrong') {
          // Keep what they typed, selected: retyping replaces it, and Show reveals a typo.
          requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
          });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  // `#pw=` links: wait for the invisible check, then unlock once.
  useEffect(() => {
    if (!initialPassword || autoTried.current) return;
    autoTried.current = true;
    void attempt(initialPassword, true);
    // attempt is stable enough for a one-shot auto-unlock.
  }, [initialPassword]); // eslint-disable-line react-hooks/exhaustive-deps

  if (expired) return <PasswordExpiredCard kind={kind} />;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy || waiting) return;
    void attempt(password, false);
  };

  const what = kind === 'album' ? 'album' : 'file';
  return (
    <section className="viewer-card w-[min(26rem,100vw-1.5rem)] gap-4 px-6 py-7" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-2">
          <Lock aria-hidden className="size-6 text-gg" />
        </span>
        <h1 id={`${id}-title`} className="text-lg font-semibold">
          This {what} is password protected
        </h1>
        {name && (
          <p className="max-w-full truncate text-sm text-muted" title={name}>
            {name}
          </p>
        )}
        {viewLimit && kind === 'file' && <p className="text-sm text-muted">{viewLimitLine('Unlocking', viewLimit.remaining)}</p>}
      </div>

      <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
        <label htmlFor={`${id}-pw`} className="text-sm font-medium">
          Password
        </label>
        <div className="flex items-stretch gap-1">
          <input
            ref={inputRef}
            id={`${id}-pw`}
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            autoFocus={!initialPassword}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error?.kind === 'wrong'}
            aria-describedby={error ? `${id}-error` : undefined}
            className="h-10.5 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 text-[15px] text-text aria-invalid:border-danger"
          />
          <button
            type="button"
            onClick={() => setReveal(!reveal)}
            aria-label={reveal ? 'Hide password' : 'Show password'}
            aria-pressed={reveal}
            className="flex w-10.5 items-center justify-center rounded-xl border border-line text-muted hover:text-text"
          >
            {reveal ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          </button>
        </div>

        {/* Managed Turnstile: invisible unless Cloudflare needs a click. On a custom domain, the files.gg frame. */}
        <div ref={turnstileMount} className="flex justify-center empty:hidden" data-testid="turnstile" />

        {error && (
          <p id={`${id}-error`} role="alert" className={error.kind === 'rate-limited' ? 'text-sm text-warn' : 'text-sm text-danger'}>
            {unlockErrorMessage(error, now)}
          </p>
        )}
        {framed && (error?.kind === 'verification' || turnstileStatus === 'error') && (
          <ChallengeFallback target={{ type: kind, vanity }} />
        )}
        {(error?.kind === 'captcha' || error?.kind === 'verification' || turnstileStatus === 'error') && (
          <Button
            onClick={() => {
              setError(null);
              retryTurnstile();
            }}
          >
            <RefreshCw aria-hidden className="size-4" />
            Retry the check
          </Button>
        )}

        <Button type="submit" variant="primary" disabled={!password || busy || waiting}>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Lock aria-hidden className="size-4" />}
          {busy ? (initialPassword && !error ? 'Unlocking…' : 'Checking…') : 'Unlock'}
        </Button>
      </form>
      <p className="text-center text-xs text-muted">Protected by Cloudflare Turnstile.</p>
    </section>
  );
}
