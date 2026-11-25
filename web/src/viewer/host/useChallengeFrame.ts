import { useCallback, useEffect, useRef, useState } from 'react';

import {
  challengeUrl,
  MSG_EXPIRED,
  MSG_TOKEN,
  parseChallengeMessage,
  type ChallengeAction,
  type ChallengeMessage,
} from '../../challenge/protocol';
import { hostContext } from './context';

/**
 * How long the frame gets to produce a token before the page offers "Open on files.gg
 * to continue". Turnstile inside a cross-origin frame is unverified (milestone-6 §18),
 * and a frame that never loads (blocked, offline) sends nothing at all.
 */
export const CHALLENGE_TIMEOUT_MS = 15_000;

export type ChallengeStatus = 'loading' | 'ready' | 'error';

/**
 * The only messages the viewer accepts: from the main origin (`https://files.gg`), from
 * this page's own challenge frame, and shaped like the protocol. Anything else is null.
 */
export function acceptChallengeMessage(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  mainOrigin: string,
  frame: MessageEventSource | null,
): ChallengeMessage | null {
  if (event.origin !== mainOrigin) return null;
  if (frame === null || event.source !== frame) return null;
  return parseChallengeMessage(event.data);
}

/** Dev fixtures: `?challenge=error` or `?challenge=silent` on the page reaches the frame. */
function devSimulation(): Record<string, string> | undefined {
  if (!import.meta.env.DEV) return undefined;
  const simulate = new URLSearchParams(window.location.search).get('challenge');
  return simulate === 'error' || simulate === 'silent' ? { simulate } : undefined;
}

/**
 * Turnstile through the `files.gg/challenge` frame (milestone-6 §10.10), for a custom
 * domain. The same shape as `useTurnstile`: `mount` is a callback ref for the frame's
 * container, `take()` resolves with an unused token, `retry()` starts over. A token is
 * single use, so each one taken loads a fresh frame for the next attempt.
 *
 * `status` is `error` when the frame reports a failure or stays silent for
 * `CHALLENGE_TIMEOUT_MS`; waiting `take()` calls are rejected then, so nothing hangs. A
 * token that arrives late still counts.
 */
export function useChallengeFrame(action: ChallengeAction, enabled = true) {
  const [container, mount] = useState<HTMLDivElement | null>(null);
  const tokenRef = useRef<string | null>(null);
  const waiters = useRef<Array<{ resolve: (token: string) => void; reject: (error: Error) => void }>>([]);
  const [status, setStatus] = useState<ChallengeStatus>('loading');
  const statusRef = useRef<ChallengeStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  const update = useCallback((next: ChallengeStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    if (!enabled || !container) return;
    const { mainOrigin, host } = hostContext();
    const frame = document.createElement('iframe');
    frame.src = challengeUrl(mainOrigin, host, action, devSimulation());
    frame.title = 'Human check';
    frame.className = 'challenge-frame';
    // The origin is enough for files.gg's logs; the page path (the vanity) isn't sent.
    frame.referrerPolicy = 'origin';
    container.replaceChildren(frame);
    tokenRef.current = null;

    const fail = (code: string) => {
      tokenRef.current = null;
      update('error');
      waiters.current.splice(0).forEach((waiter) => waiter.reject(new Error(`turnstile-frame-${code}`)));
    };
    let answered = false;
    const timer = window.setTimeout(() => {
      if (!answered) fail('timeout');
    }, CHALLENGE_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      const message = acceptChallengeMessage(event, mainOrigin, frame.contentWindow);
      if (!message) return;
      if (message.type === MSG_EXPIRED) {
        tokenRef.current = null;
        return;
      }
      answered = true;
      window.clearTimeout(timer);
      if (message.type !== MSG_TOKEN) {
        fail(message.code);
        return;
      }
      update('ready');
      const waiter = waiters.current.shift();
      if (waiter) {
        waiter.resolve(message.token);
        // Spent: a fresh frame for the next attempt.
        setAttempt((n) => n + 1);
      } else {
        tokenRef.current = message.token;
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
    };
  }, [action, enabled, container, attempt, update]);

  /** Resolves with a fresh, unused token; rejects at once while the frame has failed. */
  const take = useCallback((): Promise<string> => {
    const current = tokenRef.current;
    if (current) {
      tokenRef.current = null;
      setAttempt((n) => n + 1);
      return Promise.resolve(current);
    }
    if (statusRef.current === 'error') return Promise.reject(new Error('turnstile-frame-failed'));
    return new Promise((resolve, reject) => waiters.current.push({ resolve, reject }));
  }, []);

  /** After an error: load the frame again. */
  const retry = useCallback(() => {
    update('loading');
    setAttempt((n) => n + 1);
  }, [update]);

  return { mount, status, take, retry };
}
