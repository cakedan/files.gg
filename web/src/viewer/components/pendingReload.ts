/**
 * The `pending` page's self-reload schedule (milestone-4 §11.1): reload after 2, 3,
 * 5, 8 and 13 s, then every 15 s, up to 2 minutes in total; then stop and offer
 * Retry. No API polling: each reload asks the Worker again.
 *
 * Progress survives the reloads in `history.state` (kept by the browser across
 * `location.reload()`, per tab and per history entry), so it needs no storage and a
 * fresh visit starts over. Protected pages reload in the page instead (their `#t=` /
 * `#pw=` secrets are gone from the URL): the card re-mounts and reads the same
 * `history.state`, so the schedule is the same.
 */

export const PENDING_DELAYS_MS = [2000, 3000, 5000, 8000, 13_000] as const;
export const PENDING_EVERY_MS = 15_000;
export const PENDING_TOTAL_MS = 120_000;
/** A record older than this (since its last reload) is from an earlier visit. */
export const PENDING_STALE_MS = 60_000;

const KEY = 'filesggPending';

export interface PendingProgress {
  /** When this run of reloads started (ms). */
  start: number;
  /** Reloads done so far. */
  reloads: number;
  /** When the last reload was scheduled to happen (ms). */
  at: number;
  /** Which page it's for, so another page's record is ignored. */
  path: string;
}

export type PendingStep = { action: 'reload'; delay: number } | { action: 'stall'; delay: number };

/** The progress to continue from: the one in `state` when it's this page's and fresh. */
export function readProgress(state: unknown, path: string, now: number): PendingProgress {
  const saved = (state as Record<string, unknown> | null | undefined)?.[KEY] as Partial<PendingProgress> | undefined;
  if (
    saved &&
    saved.path === path &&
    typeof saved.start === 'number' &&
    typeof saved.reloads === 'number' &&
    typeof saved.at === 'number' &&
    now - saved.at <= PENDING_STALE_MS &&
    saved.start <= now
  ) {
    return { start: saved.start, reloads: saved.reloads, at: saved.at, path };
  }
  return { start: now, reloads: 0, at: now, path };
}

/** What to do next: reload after `delay`, or (past 2 minutes) show the stalled message after `delay`. */
export function nextStep(progress: PendingProgress, now: number): PendingStep {
  const delay = PENDING_DELAYS_MS[progress.reloads] ?? PENDING_EVERY_MS;
  const elapsed = now - progress.start;
  if (elapsed + delay > PENDING_TOTAL_MS) return { action: 'stall', delay: Math.max(0, PENDING_TOTAL_MS - elapsed) };
  return { action: 'reload', delay };
}

/** `history.state` with the progress for the next load merged in (or removed with `null`). */
export function withProgress(state: unknown, progress: PendingProgress | null): Record<string, unknown> {
  const base = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  if (progress) base[KEY] = progress;
  else delete base[KEY];
  return base;
}
