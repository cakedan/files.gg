import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { conversionApi, isActive, type Conversion, type ConversionPage } from '../../lib/conversions';

/**
 * §8: a queued or running conversion is polled every second, and every 5 s while the
 * tab is hidden. TanStack keeps polling in the background (`refetchIntervalInBackground`)
 * and refetches at once when the tab comes back (it listens to `visibilitychange`).
 */
export const POLL_MS = 1_000;
export const POLL_HIDDEN_MS = 5_000;

export const pollInterval = (active: boolean, hidden: boolean = document.visibilityState === 'hidden'): number | false =>
  active ? (hidden ? POLL_HIDDEN_MS : POLL_MS) : false;

export const conversionKeys = {
  formats: ['conversions', 'formats'] as const,
  one: (id: string) => ['conversions', 'detail', id] as const,
  history: ['users', '@me', 'conversions'] as const,
  batch: (id: string) => ['conversions', 'batch', id] as const,
};

/** §10.1: public and cacheable for 5 minutes. */
export function useFormats() {
  return useQuery({
    queryKey: conversionKeys.formats,
    queryFn: ({ signal }) => conversionApi.formats(signal),
    staleTime: 5 * 60_000,
  });
}

/** One conversion, from the `POST` answer, polled until it finishes. */
export function useConversion(initial: Conversion | null) {
  const id = initial?.id ?? '';
  return useQuery({
    queryKey: conversionKeys.one(id),
    queryFn: ({ signal }) => conversionApi.get(id, signal),
    enabled: Boolean(initial),
    // The `POST` answer is fresh; the poll takes over from it.
    initialData: initial ?? undefined,
    initialDataUpdatedAt: () => Date.now(),
    staleTime: 0,
    refetchInterval: (query) => pollInterval(Boolean(query.state.data && isActive(query.state.data))),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
}

/** §10.5: newest first, paged by `before`. Rows still running are polled (§13.1 "live-updating"). */
export function useHistory(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: conversionKeys.history,
    queryFn: ({ pageParam, signal }) => conversionApi.history({ before: pageParam ?? undefined, limit: 20 }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page: ConversionPage) => page.next,
    enabled,
    refetchInterval: (query) => pollInterval(Boolean(query.state.data?.pages.some((page) => page.items.some(isActive)))),
    refetchIntervalInBackground: true,
  });
}

/** §10.6: a batch's combined list, polled while any item is still going. */
export function useBatch(batchId: string | null) {
  return useQuery({
    queryKey: conversionKeys.batch(batchId ?? ''),
    queryFn: ({ signal }) => conversionApi.batch(batchId!, signal),
    enabled: Boolean(batchId),
    refetchInterval: (query) => pollInterval(Boolean(query.state.data?.items.some(isActive))),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
}

/** After a conversion starts, finishes or is removed: the history list catches up. */
export function useRefreshHistory() {
  const client = useQueryClient();
  return useCallback(() => void client.invalidateQueries({ queryKey: conversionKeys.history }), [client]);
}
