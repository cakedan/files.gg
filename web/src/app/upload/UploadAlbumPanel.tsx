import { ExternalLink, Images, KeyRound, Loader2, Pencil, RotateCcw } from 'lucide-react';
import { useId } from 'react';

import { Button, LinkButton } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { errorMessage } from '../../lib/errors';
import { linkWithPassword } from '../../lib/files/accessForm';
import { fieldClass } from '../access/fieldUtils';
import { pluralize } from '../files/fileLabels';
import { ANONYMOUS_ALBUM_MAX, type UploadBatch } from './useUploadAlbum';
import { AppLink } from '../components/AppLink';

interface ToggleProps {
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  title: string;
  onTitle: (title: string) => void;
  blocked: boolean;
  tooMany: boolean;
}

/** "Put these in an album", on by default, shown while a batch has more than one file. */
export function UploadAlbumToggle({ enabled, onEnabled, title, onTitle, blocked, tooMany }: ToggleProps) {
  const id = useId();
  if (blocked) {
    return <p className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">Sign in to put password-protected uploads in an album.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          aria-checked={enabled}
          onChange={(event) => onEnabled(event.target.checked)}
          className="size-4 accent-gg"
        />
        <Images aria-hidden className="size-4 text-gg" />
        Put these in an album
      </label>
      {enabled && (
        <>
          <label htmlFor={`${id}-title`} className="sr-only">
            Album title
          </label>
          <input
            id={`${id}-title`}
            value={title}
            maxLength={100}
            placeholder="Album title (optional)"
            onChange={(event) => onTitle(event.target.value)}
            className={`${fieldClass} min-w-0 flex-1 basis-48`}
          />
        </>
      )}
      {enabled && tooMany && <p className="w-full text-xs text-warn">Without an account an album holds up to {ANONYMOUS_ALBUM_MAX} files.</p>}
    </div>
  );
}

/** The album link, above the per-file links, once a batch has finished. */
export function UploadAlbumResult({ batch, anonymous, onRetry }: { batch: UploadBatch; anonymous: boolean; onRetry: () => void }) {
  const { step } = batch;
  if (step.status === 'creating') {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-line bg-surface p-3 text-sm text-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        Making the album…
      </div>
    );
  }
  if (step.status === 'skipped') {
    return step.reason ? <p className="text-sm text-muted">{step.reason}</p> : null;
  }
  if (step.status === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">
        <p role="alert" className="min-w-0 flex-1">
          Couldn't make the album. {errorMessage(step.error)}
        </p>
        <Button onClick={onRetry}>
          <RotateCcw aria-hidden className="size-4" />
          Retry
        </Button>
      </div>
    );
  }
  if (step.status !== 'done') return null;
  const { album, password } = step;
  return (
    <section aria-label="Album" className="flex flex-col gap-2 rounded-lg border border-gg/40 bg-gg/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Images aria-hidden className="size-5 shrink-0 text-gg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">
            {album.title || 'Album'} · {pluralize(album.items.length, 'file')}
          </span>
          <a href={album.url} target="_blank" rel="noopener" className="truncate text-sm text-gg hover:underline">
            {album.url.replace(/^https?:\/\//, '')}
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={album.url} label="Copy album link" />
          {password && <CopyButton text={linkWithPassword(album.url, password)} label="Copy link with password" variant="secondary" />}
          <LinkButton href={album.url} target="_blank" rel="noopener">
            <ExternalLink aria-hidden className="size-4" />
            Open
          </LinkButton>
          {!anonymous && (
            <AppLink to={`/albums/${album.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text">
              <Pencil aria-hidden className="size-4" />
              Edit
            </AppLink>
          )}
        </div>
      </div>
      {password && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <KeyRound aria-hidden className="size-4 shrink-0 text-warn" />
          <span>
            Album password: <code className="font-mono font-semibold break-all">{password}</code>
          </span>
          <CopyButton text={password} label="Copy password" variant="ghost" className="ml-auto" />
          <p className="w-full text-xs text-muted">Shown once. files.gg can't show it again, only reset it.</p>
        </div>
      )}
    </section>
  );
}
