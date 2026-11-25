import { useCallback, useEffect, useRef, useState } from 'react';

import { TURNSTILE_SITE_KEY } from '../lib/config';
import { loadTurnstile, type TurnstileAction, type TurnstileApi } from '../lib/turnstile';

export type TurnstileStatus = 'loading' | 'ready' | 'error';

/**
 * A managed-mode Turnstile widget ("interaction-only": invisible unless Cloudflare
 * needs the visitor to click). Tokens are single-use, so `take()` hands out the
 * current token and resets the widget for the next attempt.
 */
export function useTurnstile(action: TurnstileAction, enabled = true) {
  // A callback ref (element in state), so the widget renders once the element exists.
  const [container, mount] = useState<HTMLDivElement | null>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const widgetRef = useRef<string | undefined>(undefined);
  const tokenRef = useRef<string | null>(null);
  const waiters = useRef<Array<{ resolve: (token: string) => void; reject: (error: Error) => void }>>([]);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<TurnstileStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !container) return;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        apiRef.current = api;
        widgetRef.current = api.render(container, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          appearance: 'interaction-only',
          theme: 'dark',
          callback: (value) => {
            tokenRef.current = value;
            setToken(value);
            setStatus('ready');
            const pending = waiters.current.splice(0);
            if (pending.length > 0) {
              // The first waiter consumes this token; the rest wait for the next one.
              const [first, ...rest] = pending;
              waiters.current.push(...rest);
              tokenRef.current = null;
              setToken(null);
              first!.resolve(value);
              api.reset(widgetRef.current);
            }
          },
          'error-callback': () => {
            setStatus('error');
            waiters.current.splice(0).forEach((w) => w.reject(new Error('turnstile-error')));
          },
          'expired-callback': () => {
            tokenRef.current = null;
            setToken(null);
            api.reset(widgetRef.current);
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
        waiters.current.splice(0).forEach((w) => w.reject(new Error('turnstile-load-failed')));
      });
    return () => {
      cancelled = true;
      if (widgetRef.current !== undefined) apiRef.current?.remove(widgetRef.current);
      widgetRef.current = undefined;
    };
  }, [action, enabled, attempt, container]);

  /** Resolves with a fresh, unused token (waiting for the widget if needed). */
  const take = useCallback((): Promise<string> => {
    const current = tokenRef.current;
    if (current) {
      tokenRef.current = null;
      setToken(null);
      apiRef.current?.reset(widgetRef.current);
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => waiters.current.push({ resolve, reject }));
  }, []);

  /** After an error: render a fresh widget (reloading the script if it failed). */
  const retry = useCallback(() => {
    setStatus('loading');
    tokenRef.current = null;
    setToken(null);
    setAttempt((n) => n + 1);
  }, []);

  return { mount, token, status, take, retry };
}
