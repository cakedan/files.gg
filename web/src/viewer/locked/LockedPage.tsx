import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { clearAccess, loadAccess, saveAccess } from '../../lib/access';
import { ApiError, type AccessGrant, type AccessKind, type UnlockResponse } from '../../lib/api';
import { FileView } from '../components/FileView';
import { siteName } from '../host/context';
import { PendingCard, RemovedCard } from '../components/SafetyCards';
import { MissingCard, UnavailableCard } from '../components/StateCards';
import type { RemovedReason, ViewLimitInfo } from '../types';
import { contentFrom, type Content } from './content';
import { viewerApi } from './hostApi';
import { LockScreen, PasswordExpiredCard } from './LockScreen';
import { classifyUnlockError, isTransient, type UnlockError } from './unlockErrors';
import { useAccessRefresh } from './useAccessRefresh';

const AlbumPage = lazy(() => import('../album/AlbumPage'));

export interface LockedPageProps {
  kind: AccessKind;
  vanity: string;
  /** `password`: the shell was `locked`. `private`: the shell was `missing` but the URL had `#t=`. */
  protection: 'password' | 'private';
  name?: string | undefined;
  passwordExpired?: boolean | undefined;
  /** `#pw=` from the URL (already stripped). */
  password?: string | undefined;
  /** `#t=` owner pass from the URL (already stripped). */
  ownerPass?: string | undefined;
  /** Milestone 6 §19.7: a view-limited password file (the lock screen says unlocking uses a view). */
  viewLimit?: ViewLimitInfo | undefined;
}

type Phase =
  | { status: 'checking' }
  | { status: 'locked' }
  | { status: 'missing' }
  | { status: 'unavailable' }
  // Milestone 4 §12: `FILE_PENDING`, `FILE_REMOVED` or `ALBUM_REMOVED` from unlock or /view.
  // `run` re-mounts the pending card for each in-page reload, so its schedule continues.
  | { status: 'pending'; run: number }
  | { status: 'removed'; reason: RemovedReason }
  | { status: 'unlocked'; content: Content; grant: AccessGrant; scope: 'unlock' | 'owner' };

/** Unlocked content, kept alive by `useAccessRefresh`. Also the view-limit page's owner-pass view. */
export function Unlocked({
  content,
  grant,
  scope,
  kind,
  vanity,
  onExpired,
  onMissing,
}: {
  content: Content;
  grant: AccessGrant;
  scope: 'unlock' | 'owner';
  kind: AccessKind;
  vanity: string;
  onExpired: () => void;
  onMissing: () => void;
}) {
  // The payload's URLs are already signed for this visitor (and, on a custom domain,
  // rehosted with their signatures intact); they're used as they are.
  const shown = useAccessRefresh({ grant, content }, { kind, vanity, scope, onExpired, onMissing });

  const title = shown.kind === 'file' ? shown.file.filename : null;
  useEffect(() => {
    if (title) document.title = `${title} · ${siteName()}`;
  }, [title]);

  if (shown.kind === 'album') {
    return (
      <Suspense fallback={<main className="min-h-dvh" aria-busy="true" />}>
        <AlbumPage album={shown.album} />
      </Suspense>
    );
  }
  return <FileView file={shown.file} />;
}

function stateFromError(error: UnlockError, run: number): Phase | null {
  if (error.kind === 'missing') return { status: 'missing' };
  if (error.kind === 'pending') return { status: 'pending', run };
  if (error.kind === 'removed') return { status: 'removed', reason: error.reason ?? 'terms' };
  return null;
}

/**
 * Whether a failed view call means the stored unlock token is no good: `401
 * UNLOCK_EXPIRED`, or a `404` (`UNKNOWN_FILE` / `UNKNOWN_ALBUM`: it's gone). Anything
 * else (offline, 5xx, 429) is transient and keeps the token for the next try.
 */
const dropsToken = (error: unknown) =>
  error instanceof ApiError && ((error.status === 401 && error.code === 'UNLOCK_EXPIRED') || error.status === 404);

/**
 * Protected files and albums (lazy chunk). In order:
 * 1. a `#t=` owner pass: `GET /access/view/…` with it, no unlock call;
 * 2. a stored unlock token for this vanity: `GET /access/view/…`;
 * unlock and view both return the payload with signed URLs, plus `token` and `expires_at`;
 * 3. otherwise the lock screen (`password`), or "doesn't exist" (`private`).
 * `401 UNLOCK_EXPIRED` drops the stored token. `404` (from view, unlock or refresh)
 * means missing, whatever the protection: the API answers it for unknown content and
 * for an owner whose account is pending deletion (milestone-6 §8.8).
 *
 * On a custom domain the calls go to `api.files.gg` without credentials and the URLs
 * are rehosted (host/hostApi.ts); unlock tokens live in that domain's own storage.
 *
 * `#t=` / `#pw=` secrets are stripped from the URL on load and owner passes are never
 * stored, so the pending and unavailable cards' reloads happen in the page: they run
 * these steps again with the secrets still in memory, never `location.reload()`.
 */
export default function LockedPage({ kind, vanity, protection, name, passwordExpired, password, ownerPass, viewLimit }: LockedPageProps) {
  const [phase, setPhase] = useState<Phase>({ status: 'checking' });
  // A `#pw=` password is used for one automatic unlock only, never again after expiry.
  // An unlock answered `FILE_PENDING` puts its password here, for the in-page reloads.
  const [linkPassword, setLinkPassword] = useState(password);
  const fallback = useCallback((): Phase => ({ status: protection === 'private' ? 'missing' : 'locked' }), [protection]);
  // Bumped by an in-page reload: runs the checks below again.
  const [attempt, setAttempt] = useState(0);
  const pendingRuns = useRef(0);
  const reload = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const candidates: Array<{ token: string; scope: 'unlock' | 'owner' }> = [];
      if (ownerPass) candidates.push({ token: ownerPass, scope: 'owner' });
      const stored = protection === 'password' ? loadAccess(kind, vanity) : null;
      if (stored) candidates.push({ token: stored.token, scope: 'unlock' });

      for (const candidate of candidates) {
        try {
          const response = await viewerApi.view(kind, vanity, candidate.token);
          const content = contentFrom(kind, response);
          if (cancelled) return;
          if (content) {
            const grant = { token: response.token, expires_at: response.expires_at };
            if (candidate.scope === 'unlock') saveAccess(kind, vanity, grant);
            setPhase({ status: 'unlocked', content, grant, scope: candidate.scope });
            return;
          }
        } catch (error) {
          if (cancelled) return;
          if (candidate.scope === 'unlock' && dropsToken(error)) clearAccess(kind, vanity);
          // Pending or removed: the grant is fine, the content just isn't viewable now.
          // Missing (404): it's gone for everyone, or offline with its owner's account.
          const state = stateFromError(classifyUnlockError(error), ++pendingRuns.current);
          if (state) {
            setPhase(state);
            return;
          }
          if (isTransient(error)) {
            setPhase({ status: 'unavailable' });
            return;
          }
          // 401 UNLOCK_EXPIRED: try the next candidate, then fall back.
        }
      }
      if (!cancelled) setPhase(fallback());
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, vanity, ownerPass, protection, fallback, attempt]);

  const onUnlocked = useCallback(
    (response: UnlockResponse) => {
      const content = contentFrom(kind, response);
      if (!content) {
        setPhase({ status: 'unavailable' });
        return;
      }
      const grant = { token: response.token, expires_at: response.expires_at };
      saveAccess(kind, vanity, grant);
      setLinkPassword(undefined);
      setPhase({ status: 'unlocked', content, grant, scope: 'unlock' });
    },
    [kind, vanity],
  );

  const onExpired = useCallback(() => setPhase(fallback()), [fallback]);
  const onMissing = useCallback(() => setPhase({ status: 'missing' }), []);
  const onUnavailable = useCallback((error: UnlockError, password: string) => {
    const state = stateFromError(error, ++pendingRuns.current);
    if (!state) return;
    // A pending unlock is tried again with the same password (the lock screen re-mounts
    // and unlocks with it); a removed one never is.
    setLinkPassword(state.status === 'pending' ? password : undefined);
    setPhase(state);
  }, []);

  switch (phase.status) {
    case 'checking':
      return <main className="min-h-dvh" aria-busy="true" />;
    case 'unlocked':
      return (
        <Unlocked
          content={phase.content}
          grant={phase.grant}
          scope={phase.scope}
          kind={kind}
          vanity={vanity}
          onExpired={onExpired}
          onMissing={onMissing}
        />
      );
    default:
      return (
        <main className="flex min-h-dvh items-center justify-center px-3 py-6">
          {phase.status === 'missing' && <MissingCard />}
          {phase.status === 'unavailable' && <UnavailableCard onRetry={reload} />}
          {phase.status === 'pending' && <PendingCard key={phase.run} target={{ kind, vanity }} reload={reload} />}
          {phase.status === 'removed' && <RemovedCard target={{ kind, vanity }} reason={phase.reason} />}
          {phase.status === 'locked' &&
            (passwordExpired ? (
              <PasswordExpiredCard kind={kind} />
            ) : (
              <LockScreen
                kind={kind}
                vanity={vanity}
                name={name}
                initialPassword={linkPassword}
                onUnlocked={onUnlocked}
                onUnavailable={onUnavailable}
                viewLimit={viewLimit}
              />
            ))}
        </main>
      );
  }
}
