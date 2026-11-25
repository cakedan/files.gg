import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { albumWithAccessToken, clearAccess, loadAccess, saveAccess, withAccessToken } from '../../lib/access';
import { api, ApiError, type AccessGrant, type AccessKind, type UnlockResponse } from '../../lib/api';
import { FileCard } from '../components/FileCard';
import { MissingCard, UnavailableCard } from '../components/StateCards';
import { contentFrom, type Content } from './content';
import { LockScreen, PasswordExpiredCard } from './LockScreen';
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
}

type Phase =
  | { status: 'checking' }
  | { status: 'locked' }
  | { status: 'missing' }
  | { status: 'unavailable' }
  | { status: 'unlocked'; content: Content; grant: AccessGrant; scope: 'unlock' | 'owner' };

function Unlocked({
  content,
  grant,
  scope,
  kind,
  vanity,
  onExpired,
}: {
  content: Content;
  grant: AccessGrant;
  scope: 'unlock' | 'owner';
  kind: AccessKind;
  vanity: string;
  onExpired: () => void;
}) {
  const urlGrant = useAccessRefresh(grant, { kind, vanity, scope, onExpired });
  const signed = useMemo(
    () =>
      content.kind === 'file'
        ? ({ kind: 'file', file: withAccessToken(content.file, urlGrant.token) } as const)
        : ({ kind: 'album', album: albumWithAccessToken(content.album, urlGrant.token) } as const),
    [content, urlGrant.token],
  );

  const title = signed.kind === 'file' ? signed.file.filename : null;
  useEffect(() => {
    if (title) document.title = `${title} · files.gg`;
  }, [title]);

  if (signed.kind === 'album') {
    return (
      <Suspense fallback={<main className="min-h-dvh" aria-busy="true" />}>
        <AlbumPage album={signed.album} />
      </Suspense>
    );
  }
  return (
    <main className="flex min-h-dvh items-center justify-center px-3 py-6">
      <FileCard file={signed.file} />
    </main>
  );
}

/**
 * Protected files and albums (lazy chunk). In order:
 * 1. a `#t=` owner pass: `GET …/view` with it, no unlock call;
 * 2. a stored unlock token for this vanity: `GET …/view`;
 * 3. otherwise the lock screen (`password`), or "doesn't exist" (`private`).
 * `401 UNLOCK_EXPIRED` drops the stored token; `404` means missing.
 */
export default function LockedPage({ kind, vanity, protection, name, passwordExpired, password, ownerPass }: LockedPageProps) {
  const [phase, setPhase] = useState<Phase>({ status: 'checking' });
  // A `#pw=` password is used for one automatic unlock only, never again after expiry.
  const [linkPassword, setLinkPassword] = useState(password);
  const fallback = useCallback((): Phase => ({ status: protection === 'private' ? 'missing' : 'locked' }), [protection]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const candidates: Array<{ token: string; scope: 'unlock' | 'owner' }> = [];
      if (ownerPass) candidates.push({ token: ownerPass, scope: 'owner' });
      const stored = protection === 'password' ? loadAccess(kind, vanity) : null;
      if (stored) candidates.push({ token: stored.token, scope: 'unlock' });

      for (const candidate of candidates) {
        try {
          const response = await api.view(kind, vanity, candidate.token);
          const content = contentFrom(kind, response);
          if (cancelled) return;
          if (content) {
            setPhase({
              status: 'unlocked',
              content,
              grant: { token: candidate.token, expires_at: response.expires_at },
              scope: candidate.scope,
            });
            return;
          }
        } catch (error) {
          if (cancelled) return;
          if (candidate.scope === 'unlock') clearAccess(kind, vanity);
          if (error instanceof ApiError && error.isNetworkError) {
            setPhase({ status: 'unavailable' });
            return;
          }
          // 401 UNLOCK_EXPIRED / 404 UNKNOWN_FILE: try the next candidate, then fall back.
        }
      }
      if (!cancelled) setPhase(fallback());
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, vanity, ownerPass, protection, fallback]);

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
        />
      );
    default:
      return (
        <main className="flex min-h-dvh items-center justify-center px-3 py-6">
          {phase.status === 'missing' && <MissingCard />}
          {phase.status === 'unavailable' && <UnavailableCard />}
          {phase.status === 'locked' &&
            (passwordExpired ? (
              <PasswordExpiredCard kind={kind} />
            ) : (
              <LockScreen kind={kind} vanity={vanity} name={name} initialPassword={linkPassword} onUnlocked={onUnlocked} />
            ))}
        </main>
      );
  }
}
