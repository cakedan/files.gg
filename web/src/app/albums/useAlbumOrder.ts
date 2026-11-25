import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type OwnerAlbum } from '../../lib/api';
import { queryKeys, reorderAlbum } from '../../lib/queries';

/** Reorders are batched: the order is saved this long after the last move. */
export const ORDER_SAVE_DELAY_MS = 600;

export type OrderStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/**
 * Drag-to-reorder saving (contract §6 `PUT …/files`): the grid updates at once
 * (optimistic), the whole order is sent once moves stop, a failed save rolls back
 * to the last order the server confirmed, and a pending save is flushed on unmount.
 */
export function useAlbumOrder(albumId: string, onError: (error: unknown) => void, delayMs = ORDER_SAVE_DELAY_MS) {
  const client = useQueryClient();
  const key = queryKeys.album(albumId);
  const [status, setStatus] = useState<OrderStatus>('idle');
  const confirmed = useRef<string[] | null>(null);
  const pending = useRef<string[] | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);
  const errorRef = useRef(onError);
  useEffect(() => {
    errorRef.current = onError;
  });

  const save = useCallback(
    async (order: string[]) => {
      const mine = ++seq.current;
      pending.current = null;
      setStatus('saving');
      try {
        const album = await api.setAlbumFiles(albumId, order);
        if (mine !== seq.current) return;
        confirmed.current = null;
        client.setQueryData(key, album);
        setStatus('saved');
      } catch (error) {
        if (mine !== seq.current) return;
        const current = client.getQueryData<OwnerAlbum>(key);
        if (current && confirmed.current) client.setQueryData(key, reorderAlbum(current, confirmed.current));
        confirmed.current = null;
        setStatus('error');
        void client.invalidateQueries({ queryKey: key });
        errorRef.current(error);
      }
    },
    // key is derived from albumId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [albumId, client],
  );

  const reorder = useCallback(
    (order: string[]) => {
      const current = client.getQueryData<OwnerAlbum>(key);
      if (!current) return;
      confirmed.current ??= current.items.map((item) => item.id);
      void client.cancelQueries({ queryKey: key });
      client.setQueryData(key, reorderAlbum(current, order));
      pending.current = order;
      seq.current++;
      setStatus('pending');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(order), delayMs);
    },
    // key is derived from albumId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [albumId, client, delayMs, save],
  );

  // Leaving the editor mid-debounce still saves the order.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current) void api.setAlbumFiles(albumId, pending.current).catch(() => undefined);
    },
    [albumId],
  );

  return { reorder, status };
}
