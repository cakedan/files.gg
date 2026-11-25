import { useEffect, useState } from 'react';

import { api, ApiError, type OwnerFile, type SafetyState, type UploadedFile } from '../../lib/api';

/**
 * §11.2: quickly for the first 30 s (1 s, then 2 s, then every 4 s), then every 5 s,
 * up to 10 minutes; each wait has up to ±10% jitter, so a batch of uploads doesn't
 * poll in lockstep. Nothing is asked while the tab is hidden: the next poll waits
 * until it's visible again.
 */
export const SCAN_POLL_FAST_MS = 1_000;
export const SCAN_POLL_FAST_MAX_MS = 4_000;
export const SCAN_POLL_FAST_FOR_MS = 30_000;
export const SCAN_POLL_SLOW_MS = 5_000;
export const SCAN_POLL_MAX_MS = 10 * 60_000;
export const SCAN_POLL_JITTER = 0.1;

/** The wait before poll number `attempt` (0 = the first), `elapsed` ms after the upload finished. */
export function scanPollDelay(attempt: number, elapsed: number, random: () => number = Math.random): number {
  const base = elapsed < SCAN_POLL_FAST_FOR_MS ? Math.min(SCAN_POLL_FAST_MS * 2 ** attempt, SCAN_POLL_FAST_MAX_MS) : SCAN_POLL_SLOW_MS;
  return Math.round(base * (1 + SCAN_POLL_JITTER * (2 * random() - 1)));
}

export type ScanStatus =
  /** Not uploaded yet, or nothing to wait for. */
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** `ok` or `flagged`: the link works. */
  | { phase: 'ready' }
  /** `hidden` (held for review), `removed` or `blocked` (signed in; anonymous ones are rejected). */
  | { phase: 'moderated'; state: SafetyState; noticeId: string | null }
  /** `410 UPLOAD_REJECTED { reason }` (§2.5). */
  | { phase: 'rejected'; reason: string }
  | { phase: 'gone' }
  /** Still pending after 10 minutes. */
  | { phase: 'timeout' };

function statusOf(file: Pick<OwnerFile, 'safety'>): ScanStatus {
  const state = file.safety?.state ?? 'ok';
  if (state === 'pending') return { phase: 'checking' };
  if (state === 'ok' || state === 'flagged') return { phase: 'ready' };
  return { phase: 'moderated', state, noticeId: file.safety?.notice_id ?? null };
}

/**
 * After a file finishes uploading, waits for its scan (milestone-4 §11.2) by polling
 * `GET /users/@me/files/<id>` until `safety.state` leaves `pending`. A payload without
 * `safety` (an older API) counts as ready.
 */
export function useScanStatus(result: UploadedFile | undefined): ScanStatus {
  const initial: ScanStatus = result ? statusOf(result) : { phase: 'idle' };
  const [polled, setPolled] = useState<{ id: string; status: ScanStatus } | null>(null);
  const id = result?.id;
  const waiting = initial.phase === 'checking';

  useEffect(() => {
    if (!id || !waiting) return;
    const started = Date.now();
    let timer: number | undefined;
    let stopped = false;
    let attempt = 0;
    // A poll came due while the tab was hidden: it runs when the tab is visible again.
    let due = false;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'hidden') due = true;
        else void poll();
      }, scanPollDelay(attempt++, Date.now() - started));
    };
    const onVisibility = () => {
      if (!due || stopped || document.visibilityState === 'hidden') return;
      due = false;
      void poll();
    };
    const poll = async () => {
      let next: ScanStatus = { phase: 'checking' };
      try {
        next = statusOf(await api.myFile(id));
      } catch (error) {
        if (error instanceof ApiError && error.code === 'UPLOAD_REJECTED') {
          next = { phase: 'rejected', reason: String((error.body as { reason?: unknown } | undefined)?.reason ?? '') };
        } else if (error instanceof ApiError && error.status === 404) {
          next = { phase: 'gone' };
        }
        // Anything else (offline, 5xx): keep polling.
      }
      if (stopped) return;
      if (next.phase === 'checking' && Date.now() - started >= SCAN_POLL_MAX_MS) next = { phase: 'timeout' };
      if (next.phase !== 'checking') {
        setPolled({ id, status: next });
        return;
      }
      schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [id, waiting]);

  if (polled && polled.id === id) return polled.status;
  return initial;
}
