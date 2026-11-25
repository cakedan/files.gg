import { useEffect, useState } from 'react';

import { fetchPeaks } from './peaks';

export type PeaksState = { status: 'none' | 'loading' | 'failed' } | { status: 'ready'; peaks: number[] };

/** Loads `assets.peaks.url` once per URL. No URL (for example while processing) is `none`. */
export function usePeaks(url: string | undefined): PeaksState {
  const [result, setResult] = useState<{ url: string; state: PeaksState } | null>(null);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetchPeaks(url, controller.signal).then(
      (peaks) => setResult({ url, state: { status: 'ready', peaks } }),
      () => {
        if (!controller.signal.aborted) setResult({ url, state: { status: 'failed' } });
      },
    );
    return () => controller.abort();
  }, [url]);

  if (!url) return { status: 'none' };
  return result?.url === url ? result.state : { status: 'loading' };
}
