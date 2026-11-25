import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type MyLimitsResponse, type OwnerFile, type UploadedFile } from '../../lib/api';
import { checkLimits } from '../../lib/upload/limits';
import { UploadTask, type UploadSnapshot } from '../../lib/upload/uploadTask';
import { useScanStatus, type ScanStatus } from '../upload/useScanStatus';

/** While the probe hasn't run, a GIF, WebP or APNG might be one frame or many (§1.1). */
const SETTLE_POLL_MS = 1_500;
const SETTLE_MAX_MS = 60_000;

const ambiguous = (file: Pick<OwnerFile, 'mimetype' | 'processing' | 'framecount' | 'media' | 'kind'>) =>
  Boolean(file.processing) && ['image/gif', 'image/webp', 'image/apng'].includes(file.mimetype) && !(file.framecount ?? file.media?.framecount);

export interface DroppedSource {
  file: File;
  snapshot: UploadSnapshot;
  scan: ScanStatus;
  /** The uploaded file, once it's scanned and its kind is known. */
  ready: UploadedFile | OwnerFile | null;
  /** The probe is still running, so the kind isn't known yet. */
  settling: boolean;
  retry: () => void;
}

/**
 * §13.1 step 1: a dropped or pasted file goes through the normal upload (lib/upload, with
 * Turnstile action `upload` for anonymous visitors), then waits for its scan, which a
 * conversion source needs (§5.1), and for its probe when the kind depends on it.
 */
export function useDroppedSource(getTurnstileToken: (() => Promise<string>) | undefined, limits: MyLimitsResponse | undefined) {
  const [current, setCurrent] = useState<{ file: File; task: UploadTask | null } | null>(null);
  const [snapshot, setSnapshot] = useState<UploadSnapshot | null>(null);
  const task = current?.task ?? null;
  const tokenRef = useRef(getTurnstileToken);
  useEffect(() => {
    tokenRef.current = getTurnstileToken;
  });

  const start = useCallback(
    (file: File) => {
      task?.cancel();
      const rejected = checkLimits(file.size, limits);
      if (rejected) {
        setCurrent({ file, task: null });
        setSnapshot({ phase: 'error', loaded: 0, total: file.size, chunked: false, resumed: false, error: rejected });
        return file;
      }
      const next = new UploadTask(file, {}, { getTurnstileToken: tokenRef.current ? () => tokenRef.current!() : undefined }, setSnapshot);
      setCurrent({ file, task: next });
      setSnapshot(next.state);
      void next.start();
      return file;
    },
    [limits, task],
  );

  const clear = useCallback(() => {
    task?.cancel();
    setCurrent(null);
    setSnapshot(null);
  }, [task]);

  useEffect(() => () => task?.cancel(), [task]);

  const result = snapshot?.phase === 'done' ? snapshot.result : undefined;
  const scan = useScanStatus(result);
  const [settled, setSettled] = useState<{ id: string; file: OwnerFile } | null>(null);
  const needsSettle = Boolean(result) && scan.phase === 'ready' && ambiguous(result!) && settled?.id !== result?.id;

  useEffect(() => {
    if (!needsSettle || !result) return;
    const started = Date.now();
    let timer: number | undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const file = await api.myFile(result.id);
        if (stopped) return;
        if (!file.processing || Date.now() - started > SETTLE_MAX_MS) {
          setSettled({ id: result.id, file });
          return;
        }
      } catch {
        // Keep trying until the limit; the source then goes ahead with what it has.
        if (Date.now() - started > SETTLE_MAX_MS) {
          setSettled({ id: result.id, file: result as OwnerFile });
          return;
        }
      }
      timer = window.setTimeout(() => void poll(), SETTLE_POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), SETTLE_POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [needsSettle, result]);

  const ready = result && scan.phase === 'ready' ? (settled?.id === result.id ? settled.file : needsSettle ? null : result) : null;
  const dropped: DroppedSource | null =
    current && snapshot ? { file: current.file, snapshot, scan, ready, settling: needsSettle, retry: () => void task?.start() } : null;
  return { dropped, start, clear };
}
