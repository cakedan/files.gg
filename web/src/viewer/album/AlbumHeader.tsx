import { Download, Flag } from 'lucide-react';

import { LinkButton } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { formatBytes } from '../../lib/format';
import { formatExpiry, formatFullDate, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import type { AlbumData } from '../types';
import { linkify } from './linkify';

export function AlbumDescription({ text }: { text: string }) {
  return (
    <p className="text-sm whitespace-pre-line break-words text-muted">
      {linkify(text).map((segment, index) =>
        segment.type === 'link' ? (
          <a key={index} href={segment.href} target="_blank" rel="nofollow ugc noopener" className="text-gg underline-offset-2 hover:underline">
            {segment.text}
          </a>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

export function AlbumHeader({ album, shareUrl, title }: { album: AlbumData; shareUrl: string; title: string }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  const expiry = formatExpiry(album.expiresAt, now);
  const count = album.count;
  return (
    <header className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold break-words sm:text-2xl">{title}</h1>
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted">
          <span>
            {count} {count === 1 ? 'file' : 'files'} · {formatBytes(album.totalSize)}
          </span>
          {expiry && album.expiresAt !== null && (
            <time
              dateTime={new Date(album.expiresAt).toISOString()}
              title={formatFullDate(album.expiresAt)}
              className={expiry.tone === 'danger' ? 'text-danger' : 'text-warn'}
            >
              {expiry.label}
            </time>
          )}
        </p>
      </div>
      {album.description && <AlbumDescription text={album.description} />}
      <div className="flex flex-wrap gap-2">
        <CopyButton text={shareUrl} />
        <LinkButton href={`${shareUrl.replace(/\/+$/, '')}/download.zip`} download>
          <Download aria-hidden className="size-4" />
          Download all
        </LinkButton>
        <LinkButton href={`/report?url=${encodeURIComponent(shareUrl)}`} variant="ghost">
          <Flag aria-hidden className="size-4" />
          Report
        </LinkButton>
      </div>
    </header>
  );
}
