import { lazy, Suspense, useState } from 'react';

import { alwaysShowSensitive } from '../../lib/sensitive';
import type { FileData } from '../types';
import { FileCard } from './FileCard';
import { RendererFallback } from './RendererFallback';

/** Only sensitive files need the interstitial. */
const NsfwGate = lazy(() => import('./NsfwGate').then((m) => ({ default: m.NsfwGate })));
/** Rare (only files Web Risk flagged), so it's a chunk of its own. */
const LinkWarningsBanner = lazy(() => import('../links/LinkWarningsBanner'));
/** Scanner warnings and the download confirmation: rare too. */
const WarnedFile = lazy(() => import('./DownloadGuard').then((m) => ({ default: m.WarnedFile })));

/**
 * A single file page: the NSFW interstitial first when the file is sensitive (nothing
 * below mounts, so no media is requested, until Show), then the scanner and link
 * warnings above the card (milestone-4 §4.6, §11.1).
 */
export function FileView({ file }: { file: FileData }) {
  const [revealed, setRevealed] = useState(() => !file.nsfw || alwaysShowSensitive());
  if (!revealed) {
    return (
      <Suspense fallback={<main className="min-h-dvh" aria-busy="true" />}>
        <NsfwGate kind="file" onShow={() => setRevealed(true)} />
      </Suspense>
    );
  }

  if (!file.warnings?.length && !file.link_warnings?.length) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-3 py-6">
        <FileCard file={file} />
      </main>
    );
  }
  return (
    <main className="flex min-h-dvh items-center justify-center px-3 py-6">
      <div className="viewer-stack">
        {file.link_warnings && file.link_warnings.length > 0 && (
          <Suspense fallback={null}>
            <LinkWarningsBanner urls={file.link_warnings} />
          </Suspense>
        )}
        {file.warnings?.length ? (
          <Suspense fallback={<RendererFallback file={file} />}>
            <WarnedFile file={file} />
          </Suspense>
        ) : (
          <FileCard file={file} />
        )}
      </div>
    </main>
  );
}
