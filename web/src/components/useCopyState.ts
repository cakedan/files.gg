import { useCallback, useEffect, useRef, useState } from 'react';

import { copyText } from '../lib/clipboard';

export type CopyState = 'idle' | 'copied' | 'failed';

/** How long "Copied!" / "Copy failed" stays visible before resetting. */
export const COPY_FEEDBACK_MS = 1500;

/**
 * Copy-to-clipboard with transient feedback: `copied` or `failed` for
 * COPY_FEEDBACK_MS, then back to `idle`. Repeated clicks restart the timer.
 */
export function useCopyState(copy: (text: string) => Promise<boolean> = copyText) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const trigger = useCallback(
    async (text: string) => {
      let ok: boolean;
      try {
        ok = await copy(text);
      } catch {
        ok = false;
      }
      window.clearTimeout(timer.current);
      setState(ok ? 'copied' : 'failed');
      timer.current = window.setTimeout(() => setState('idle'), COPY_FEEDBACK_MS);
      return ok;
    },
    [copy],
  );

  return { state, copy: trigger } as const;
}
