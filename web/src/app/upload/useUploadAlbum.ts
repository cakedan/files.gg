import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ensureFingerprint, type AccessParams, type OwnerAlbum, type UploadParams, type Visibility } from '../../lib/api';
import { queryKeys } from '../../lib/queries';
import type { QueueItem } from './useUploadQueue';

/** Anonymous albums: at most 50 files from one batch (contract §6). */
export const ANONYMOUS_ALBUM_MAX = 50;

export type AlbumStep =
  | { status: 'idle' }
  | { status: 'creating'; album?: OwnerAlbum | undefined }
  | { status: 'done'; album: OwnerAlbum; password?: string | undefined }
  | { status: 'error'; error: unknown; album?: OwnerAlbum | undefined }
  | { status: 'skipped'; reason?: string | undefined };

export interface UploadBatch {
  key: number;
  /** Queue item ids. */
  ids: number[];
  title: string;
  step: AlbumStep;
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);
const isTerminal = (item: QueueItem) => Boolean(item.rejected) || TERMINAL.has(item.snapshot.phase);

let nextKey = 1;

/** The album gets the batch's access, so a password batch doesn't become an empty public album. */
export function albumAccessFor(params: UploadParams): (AccessParams & { visibility: Visibility }) | null {
  if (!params.visibility || params.visibility === 'link') return null;
  if (params.visibility === 'private') return { visibility: 'private' };
  return {
    visibility: 'password',
    ...(params.generate_password ? { generate_password: true } : { password: params.password }),
    ...(params.unlock_ttl ? { unlock_ttl: params.unlock_ttl } : {}),
    ...(params.password_expires_in ? { password_expires_in: params.password_expires_in } : {}),
  };
}

/**
 * "Put these in an album" (contract §8): files added while a batch is still going
 * join it; once every file in it has finished, the successful ones become an album
 * (`POST /users/@me/albums`). Signed in, a protected batch's album gets the same
 * access. Anonymous protected uploads can't (anonymous albums can't be edited).
 */
export function useUploadAlbum(items: QueueItem[], anonymous: boolean) {
  const client = useQueryClient();
  const [batches, setBatches] = useState<UploadBatch[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [title, setTitle] = useState('');
  const running = useRef(new Set<number>());

  const current = batches.at(-1) ?? null;
  const itemsOf = useCallback((batch: UploadBatch) => items.filter((item) => batch.ids.includes(item.id)), [items]);
  const liveOf = useCallback((batch: UploadBatch) => itemsOf(batch).filter((item) => !item.rejected), [itemsOf]);
  const paramsOf = (batch: UploadBatch): UploadParams => liveOf(batch)[0]?.task?.params ?? {};
  const blockedOf = (batch: UploadBatch) => anonymous && Boolean(albumAccessFor(paramsOf(batch)));

  const finished = (batch: UploadBatch) => {
    const list = itemsOf(batch);
    return list.length > 0 && list.every(isTerminal);
  };

  /** Call with the ids `add` returned. */
  const track = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      setBatches((list) => {
        const last = list.at(-1);
        const lastItems = last ? items.filter((item) => last.ids.includes(item.id)) : [];
        const open = last && last.step.status === 'idle' && !(lastItems.length > 0 && lastItems.every(isTerminal));
        if (open) return [...list.slice(0, -1), { ...last, ids: [...last.ids, ...ids] }];
        return [...list, { key: nextKey++, ids, title: '', step: { status: 'idle' } }];
      });
    },
    [items],
  );

  const setStep = (key: number, step: AlbumStep) => setBatches((list) => list.map((batch) => (batch.key === key ? { ...batch, step } : batch)));

  const create = useCallback(
    async (batch: UploadBatch, existing?: OwnerAlbum) => {
      if (running.current.has(batch.key)) return;
      running.current.add(batch.key);
      const fileIds = itemsOf(batch).flatMap((item) => (item.snapshot.phase === 'done' && item.snapshot.result ? [item.snapshot.result.id] : []));
      let album = existing;
      try {
        if (!album) {
          await ensureFingerprint();
          album = await api.createAlbum({ ...(batch.title ? { title: batch.title } : {}), file_ids: fileIds });
        }
        let password: string | undefined;
        const access = anonymous ? null : albumAccessFor(liveOf(batch)[0]?.task?.params ?? {});
        if (access) {
          const updated = await api.updateAlbum(album.id, access);
          password = updated.password;
          const { password: _p, url_with_password: _u, ...rest } = updated;
          album = rest;
        }
        setStep(batch.key, { status: 'done', album, password });
        void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll });
        void client.invalidateQueries({ queryKey: queryKeys.myFilesAll });
      } catch (error) {
        setStep(batch.key, { status: 'error', error, album });
      } finally {
        running.current.delete(batch.key);
      }
    },
    [anonymous, client, itemsOf, liveOf],
  );

  /** Why a finished batch gets no album, or null when it gets one. */
  const skipReason = (batch: UploadBatch): { reason?: string | undefined } | null => {
    const live = liveOf(batch);
    if (live.length < 2 || blockedOf(batch) || !enabled) return {};
    const done = live.filter((item) => item.snapshot.phase === 'done').length;
    if (done < 2) return { reason: done === 1 ? 'Only one file uploaded, so no album was made.' : undefined };
    return null;
  };

  // A finished batch is marked during render: skipped, or "creating" with the title
  // as it is now…
  const settled = batches.filter((batch) => batch.step.status === 'idle' && finished(batch));
  if (settled.length > 0) {
    setBatches((list) =>
      list.map((batch) => {
        if (!settled.some((each) => each.key === batch.key)) return batch;
        const skip = skipReason(batch);
        return skip ? { ...batch, step: { status: 'skipped', ...skip } } : { ...batch, title: title.trim(), step: { status: 'creating' } };
      }),
    );
  }

  // …and the effect makes the album for each one still to do.
  useEffect(() => {
    for (const batch of batches) {
      if (batch.step.status === 'creating' && !running.current.has(batch.key)) void create(batch, batch.step.album);
    }
  });

  const retry = (batch: UploadBatch) => {
    const album = batch.step.status === 'error' ? batch.step.album : undefined;
    setStep(batch.key, { status: 'creating', album });
  };

  const showToggle = Boolean(current && current.step.status === 'idle' && liveOf(current).length > 1);
  return {
    batches,
    track,
    retry,
    enabled,
    setEnabled,
    title,
    setTitle,
    showToggle,
    blocked: current ? blockedOf(current) : false,
    tooMany: Boolean(anonymous && current && liveOf(current).length > ANONYMOUS_ALBUM_MAX),
  };
}
