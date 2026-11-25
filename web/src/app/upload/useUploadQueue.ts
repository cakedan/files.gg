import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiError, UploadParams } from '../../lib/api';
import { UploadTask, type UploadDeps, type UploadSnapshot } from '../../lib/upload/uploadTask';

export interface QueueItem {
  id: number;
  file: File;
  task: UploadTask | null;
  snapshot: UploadSnapshot;
  /** Failed the local limits check; never started. */
  rejected?: ApiError;
}

/** Files upload two at a time; chunked ones already send 3 chunks in parallel each. */
const CONCURRENCY = 2;

let nextId = 1;

export function useUploadQueue(deps: UploadDeps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  const update = useCallback((id: number, snapshot: UploadSnapshot) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, snapshot } : item)));
  }, []);

  /** Starts queued tasks while fewer than CONCURRENCY are active. */
  useEffect(() => {
    const active = items.filter((item) => ['verifying', 'uploading', 'processing'].includes(item.snapshot.phase)).length;
    const queued = items.filter((item) => item.task && item.snapshot.phase === 'queued');
    for (const item of queued.slice(0, Math.max(0, CONCURRENCY - active))) void item.task!.start();
  }, [items]);

  const add = useCallback(
    (files: File[], params: UploadParams, reject: (file: File, index: number) => ApiError | null): number[] => {
      const added: QueueItem[] = files.map((file, index) => {
        const id = nextId++;
        const rejected = reject(file, index);
        if (rejected) {
          return {
            id,
            file,
            task: null,
            rejected,
            snapshot: { phase: 'error', loaded: 0, total: file.size, chunked: false, resumed: false, error: rejected },
          };
        }
        const task = new UploadTask(
          file,
          params,
          {
            ...depsRef.current,
            // Read the latest Turnstile callback at upload time, not at queue time.
            getTurnstileToken: depsRef.current.getTurnstileToken ? () => depsRef.current.getTurnstileToken!() : undefined,
          },
          (snapshot) => update(id, snapshot),
        );
        return { id, file, task, snapshot: task.state };
      });
      setItems((list) => [...added, ...list]);
      return added.map((item) => item.id);
    },
    [update],
  );

  const remove = useCallback((id: number) => {
    setItems((list) => {
      list.find((item) => item.id === id)?.task?.cancel();
      return list.filter((item) => item.id !== id);
    });
  }, []);

  const clearFinished = useCallback(() => {
    setItems((list) => list.filter((item) => !['done', 'cancelled'].includes(item.snapshot.phase) && !item.rejected));
  }, []);

  return { items, add, remove, clearFinished };
}
