import { lazy, Suspense, useEffect } from 'react';

import { FileCard } from './components/FileCard';
import { ConvertCard, HomeCard, MissingCard, UnavailableCard } from './components/StateCards';
import type { BootState } from './types';

/** The album page is its own chunk: single-file pages never download it. */
const AlbumPage = lazy(() => import('./album/AlbumPage'));

function documentTitle(state: BootState): string {
  if (state.page === 'file') return `${state.file.filename} · files.gg`;
  if (state.page === 'convert') return 'Convert · files.gg';
  return 'files.gg';
}

export function ViewerApp({ state }: { state: BootState }) {
  const title = documentTitle(state);
  useEffect(() => {
    // Albums set their own title once the lazy page knows the tag-derived name.
    if (state.page !== 'album') document.title = title;
  }, [title, state.page]);

  if (state.page === 'album') {
    return (
      <Suspense fallback={<main className="min-h-dvh" aria-busy="true" />}>
        <AlbumPage album={state.album} />
      </Suspense>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-3 py-6">
      {state.page === 'home' && <HomeCard />}
      {state.page === 'convert' && <ConvertCard />}
      {state.page === 'unavailable' && <UnavailableCard />}
      {state.page === 'missing' && <MissingCard />}
      {state.page === 'file' && <FileCard file={state.file} />}
    </main>
  );
}
