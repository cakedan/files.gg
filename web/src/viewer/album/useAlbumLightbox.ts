import { useCallback, useEffect, useState } from 'react';

import { albumPath, clampIndex, parseAlbumPath } from './albumUrl';

const MARKER = 'filesggAlbumItem';

const pushedByUs = (state: unknown) => typeof state === 'object' && state !== null && MARKER in state;

/**
 * Lightbox index synced with the URL (`/a/<vanity>/<n>`, n 1-based):
 * - opening pushes a history entry, so Back closes the lightbox;
 * - moving between items replaces it, so Back doesn't step through every item;
 * - closing goes back when we pushed, otherwise rewrites the URL to the album.
 * `/a/<vanity>/<n>` on load opens item n; an out-of-range n is dropped from the URL.
 */
export function useAlbumLightbox(vanity: string, count: number) {
  const [index, setIndex] = useState<number | null>(() =>
    clampIndex(parseAlbumPath(window.location.pathname)?.index ?? null, count),
  );

  useEffect(() => {
    const parsed = parseAlbumPath(window.location.pathname);
    if (parsed?.index !== null && parsed?.index !== undefined && clampIndex(parsed.index, count) === null) {
      window.history.replaceState(window.history.state, '', albumPath(vanity, null, window.location.search));
    }
    const onPop = () => setIndex(clampIndex(parseAlbumPath(window.location.pathname)?.index ?? null, count));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [vanity, count]);

  const open = useCallback(
    (next: number) => {
      const target = clampIndex(next, count);
      if (target === null) return;
      setIndex(target);
      window.history.pushState({ [MARKER]: true }, '', albumPath(vanity, target, window.location.search));
    },
    [vanity, count],
  );

  const go = useCallback(
    (next: number) => {
      const target = clampIndex(next, count);
      if (target === null) return;
      setIndex(target);
      window.history.replaceState(window.history.state, '', albumPath(vanity, target, window.location.search));
    },
    [vanity, count],
  );

  const close = useCallback(() => {
    setIndex(null);
    if (pushedByUs(window.history.state)) {
      window.history.back();
    } else {
      window.history.replaceState(null, '', albumPath(vanity, null, window.location.search));
    }
  }, [vanity]);

  return { index, open, go, close };
}
