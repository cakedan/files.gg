import { lazy, Suspense, useEffect } from 'react';

import type { FragmentSecrets } from '../lib/access';
import { targetFromPath } from '../lib/access';
import { FileCard } from './components/FileCard';
import { ConvertCard, HomeCard, MissingCard, UnavailableCard } from './components/StateCards';
import type { BootState } from './types';

/** The album page is its own chunk: single-file pages never download it. */
const AlbumPage = lazy(() => import('./album/AlbumPage'));
/** Lock screen, unlock, owner passes and Turnstile: only for protected pages. */
const LockedPage = lazy(() => import('./locked/LockedPage'));

function documentTitle(state: BootState): string {
  if (state.page === 'file') return `${state.file.filename} · files.gg`;
  if (state.page === 'convert') return 'Convert · files.gg';
  if (state.page === 'locked') return `Password-protected ${state.target.kind} · files.gg`;
  return 'files.gg';
}

const busy = <main className="min-h-dvh" aria-busy="true" />;

export function ViewerApp({ state, secrets = { rest: '' } }: { state: BootState; secrets?: FragmentSecrets }) {
  const title = documentTitle(state);
  useEffect(() => {
    // Albums set their own title once the lazy page knows the tag-derived name.
    if (state.page !== 'album') document.title = title;
  }, [title, state.page]);

  if (state.page === 'album') {
    return (
      <Suspense fallback={busy}>
        <AlbumPage album={state.album} />
      </Suspense>
    );
  }

  if (state.page === 'locked') {
    const { target } = state;
    return (
      <Suspense fallback={busy}>
        <LockedPage
          kind={target.kind}
          vanity={target.vanity}
          protection="password"
          name={target.name}
          passwordExpired={target.passwordExpired}
          password={secrets.password}
          ownerPass={secrets.ownerPass}
        />
      </Suspense>
    );
  }

  // A private file's shell is "missing"; an owner pass (#t=) may still open it.
  const privateTarget = state.page === 'missing' && secrets.ownerPass ? targetFromPath(window.location.pathname) : null;
  if (privateTarget) {
    return (
      <Suspense fallback={busy}>
        <LockedPage kind={privateTarget.kind} vanity={privateTarget.vanity} protection="private" ownerPass={secrets.ownerPass} />
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
