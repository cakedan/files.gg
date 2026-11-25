import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { api, ApiError, type OwnerFile } from '../../lib/api';
import { queryKeys, replaceCachedFiles } from '../../lib/queries';

export const PENDING_POLL_MS = 5_000;
export const PENDING_POLL_MAX_MS = 10 * 60_000;
/** At most this many `GET /users/@me/files/<id>` at once. */
export const PENDING_POLL_CONCURRENCY = 4;

/** Runs `run` over `items`, at most `limit` at a time. `run` must not throw. */
async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>, stopped: () => boolean) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Milestone-4 §11.2: "Checking…" files on the page are polled with
 * `GET /users/@me/files/<id>` every 5 s, for up to 10 minutes each, while the tab is
 * visible. A file that leaves `pending` replaces its cached copies; one that was
 * rejected or is gone refetches the lists.
 *
 * The next round is scheduled only once the previous one has finished (never two at
 * once on a slow connection), and a round asks for at most four files at a time.
 */
export function usePendingPoll(files: OwnerFile[], intervalMs = PENDING_POLL_MS) {
  const client = useQueryClient();
  const firstSeen = useRef(new Map<string, number>());
  const pending = files
    .filter((file) => file.safety?.state === 'pending')
    .map((file) => file.id)
    .join(',');

  useEffect(() => {
    const ids = pending ? pending.split(',') : [];
    // Forget files that left `pending` (or the page); the map only ever holds this page's.
    const current = new Set(ids);
    for (const id of firstSeen.current.keys()) if (!current.has(id)) firstSeen.current.delete(id);
    if (ids.length === 0) return;
    for (const id of ids) if (!firstSeen.current.has(id)) firstSeen.current.set(id, Date.now());

    let stopped = false;
    let timer: number | undefined;
    const check = async (id: string) => {
      try {
        const file = await api.myFile(id);
        if (stopped) return;
        if (file.safety?.state !== 'pending') {
          replaceCachedFiles(client, [file]);
          void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll, refetchType: 'none' });
        }
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
          void client.invalidateQueries({ queryKey: queryKeys.myFilesAll });
        }
      }
    };
    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        const live = ids.filter((id) => Date.now() - (firstSeen.current.get(id) ?? 0) < PENDING_POLL_MAX_MS);
        // Every file has had its 10 minutes: stop until the pending set changes.
        if (live.length === 0) return;
        await eachLimited(live, PENDING_POLL_CONCURRENCY, check, () => stopped);
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), intervalMs);
    };
    timer = window.setTimeout(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [pending, client, intervalMs]);
}
