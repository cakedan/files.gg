import { lazy, Suspense, useEffect } from 'react';

import type { FragmentSecrets } from '../lib/access';
import { targetFromPath } from '../lib/access';
import { FileView } from './components/FileView';
import { MissingCard, UnavailableCard } from './components/StateCards';
import { siteName } from './host/context';
import type { BootState } from './types';

/** The album page is its own chunk: single-file pages never download it. */
const AlbumPage = lazy(() => import('./album/AlbumPage'));
/** Lock screen, unlock, owner passes and Turnstile: only for protected pages. */
const LockedPage = lazy(() => import('./locked/LockedPage'));
/** A view-limited file's card and Open file (milestone-6 §19.7): only limited pages load it. */
const LimitedPage = lazy(() => import('./locked/LimitedPage'));
/** `files.gg/report` and the per-file and per-album report pages (milestone-4 §10.1). */
const ReportPage = lazy(() => import('./report/ReportPage'));
/** `pending` and `removed` (milestone-4 §2.4): rare, so not in the entry bundle. */
const PendingCard = lazy(() => import('./components/SafetyCards').then((m) => ({ default: m.PendingCard })));
const RemovedCard = lazy(() => import('./components/SafetyCards').then((m) => ({ default: m.RemovedCard })));
/** `region` (milestone-7 §11.4): adult content from a blocked country. Rare too. */
const RegionCard = lazy(() => import('./components/SafetyCards').then((m) => ({ default: m.RegionCard })));
/** A custom domain's `/` (milestone-6 §10.8): only custom domains ever load it. */
const DomainHomeCard = lazy(() => import('./host/DomainHomeCard'));

/** The page title. On a custom domain the suffix is the domain, not files.gg (milestone-6 §13.4). */
function documentTitle(state: BootState, site: string = siteName()): string {
  if (state.page === 'file') return `${state.file.filename} · ${site}`;
  if (state.page === 'locked') return `Password-protected ${state.target.kind} · ${site}`;
  // Milestone 6 §19.5: the shell's og:title, never the name.
  if (state.page === 'limited') return `View-limited file · ${site}`;
  // Milestone 4 §10.1: the same titles as the shell's og:title, never the name.
  if (state.page === 'pending') return `Checking this ${state.target.kind} · ${site}`;
  if (state.page === 'removed') {
    const { kind } = state.target;
    return state.reason === 'review' ? `This ${kind} is unavailable · ${site}` : `This ${kind} was removed · ${site}`;
  }
  if (state.page === 'report') return `Report · ${site}`;
  return site;
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

  if (state.page === 'report') {
    return (
      <Suspense fallback={busy}>
        <ReportPage target={state.target} />
      </Suspense>
    );
  }

  if (state.page === 'file') return <FileView file={state.file} />;

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
          viewLimit={target.viewLimit}
        />
      </Suspense>
    );
  }

  if (state.page === 'limited') {
    return (
      <Suspense fallback={busy}>
        <LimitedPage vanity={state.target.vanity} remaining={state.target.remaining} ownerPass={secrets.ownerPass} />
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
      {state.page === 'unavailable' && <UnavailableCard />}
      {/* Missing also covers CSAM-blocked and private files: the shell can't tell them apart. */}
      {state.page === 'missing' && <MissingCard />}
      <Suspense fallback={null}>
        {state.page === 'domain-home' && <DomainHomeCard />}
        {state.page === 'pending' && <PendingCard target={state.target} />}
        {state.page === 'removed' && <RemovedCard target={state.target} reason={state.reason} />}
        {state.page === 'region' && <RegionCard />}
      </Suspense>
    </main>
  );
}
