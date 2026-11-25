import { useCallback, useEffect, useState } from 'react';

import { albumPath, clampIndex, parseAlbumItem } from './albumUrl';

const currentItem = () => parseAlbumItem(window.location.search);

/** Marks the history entry the lightbox added on opening, so closing can go back to it. */
const LIGHTBOX_ENTRY = 'filesggLightbox';

type HistoryState = Record<string, unknown> | null;
const ownsEntry = () => Boolean((window.history.state as HistoryState)?.[LIGHTBOX_ENTRY]);

/** Writes `?item=` for `index` (or removes it) in place, keeping the rest of the query and the fragment. */
function writeItem(vanity: string, index: number | null) {
  const { search, hash } = window.location;
  window.history.replaceState(window.history.state, '', albumPath(vanity, index, search, hash));
}

/** Opening adds one history entry (marked as ours), so Back closes the lightbox. */
function pushItem(vanity: string, index: number) {
  const { search, hash } = window.location;
  const state = { ...((window.history.state as HistoryState) ?? {}), [LIGHTBOX_ENTRY]: true };
  window.history.pushState(state, '', albumPath(vanity, index, search, hash));
}

/**
 * Lightbox index synced with the URL (milestone-6 §20.2): `/a/<vanity>?item=<n>`, n 1-based.
 * Opening adds **one** history entry, so the browser's Back button closes the lightbox.
 * Moving between items replaces that entry, so history isn't flooded. Closing goes back to
 * the entry before it when the lightbox added it, so Back and the close button behave the
 * same; on a page opened directly at `?item=<n>` there's no entry of ours, so closing drops
 * `?item` in place. The rest of the query (dev `?fixture=`) and the fragment (`#pw=`, `#t=`)
 * are kept. An unusable or out-of-range `?item` on load is dropped from the URL.
 */
export function useAlbumLightbox(vanity: string, count: number) {
  const [index, setIndex] = useState<number | null>(() => clampIndex(currentItem(), count));

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('item') && clampIndex(currentItem(), count) === null) {
      writeItem(vanity, null);
    }
    // Back and Forward to another entry of this page (a fragment change, say) re-read the URL.
    const onPop = () => setIndex(clampIndex(currentItem(), count));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [vanity, count]);

  const go = useCallback(
    (next: number) => {
      const target = clampIndex(next, count);
      if (target === null) return;
      setIndex(target);
      writeItem(vanity, target);
    },
    [vanity, count],
  );

  const open = useCallback(
    (next: number) => {
      const target = clampIndex(next, count);
      if (target === null) return;
      setIndex(target);
      // Already open (or opened from the URL): move in place. Closed: add the one entry Back closes.
      if (parseAlbumItem(window.location.search) !== null) writeItem(vanity, target);
      else pushItem(vanity, target);
    },
    [vanity, count],
  );

  const close = useCallback(() => {
    if (ownsEntry()) {
      // popstate re-reads the URL (no ?item) and closes it.
      window.history.back();
      return;
    }
    setIndex(null);
    writeItem(vanity, null);
  }, [vanity]);

  return { index, open, go, close };
}
