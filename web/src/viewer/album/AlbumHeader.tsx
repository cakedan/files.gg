import { Download, Flag, Loader2 } from 'lucide-react';
import { useState, type MouseEvent } from 'react';

import { LinkButton } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { formatBytes } from '../../lib/format';
import { epochMsOrNull, formatExpiry, formatFullDate, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import type { AlbumData } from '../types';
import { downloadUrl } from '../urls';
import { browser, checkZip } from './downloadAll';
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

/** Shown instead of a JSON error file when the ZIP would be over the 2 GiB cap. */
function TooLargePanel({ album }: { album: AlbumData }) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 p-3 text-sm">
      <p className="font-medium text-text">This album is too large to download as one file</p>
      <p className="text-muted">Download the files one at a time instead.</p>
      <ul className="flex flex-col divide-y divide-line" aria-label="Files to download">
        {album.items.map((item, index) => (
          <li key={`${item.vanity ?? item.filename}-${index}`} className="flex items-center gap-3 py-1.5">
            <span className="min-w-0 flex-1 truncate" title={item.filename}>
              {item.filename}
            </span>
            <span className="shrink-0 text-xs text-muted">{formatBytes(item.size)}</span>
            <a
              href={downloadUrl(item.cdn_url)}
              download={item.filename}
              className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-gg hover:bg-surface-2"
              aria-label={`Download ${item.filename}`}
            >
              <Download aria-hidden className="size-4" />
              <span className="max-sm:sr-only">Download</span>
            </a>
          </li>
        ))}
      </ul>
      {album.next_cursor && (
        <p className="text-xs text-muted">
          Showing the first {album.items.length} of {album.count} files.
        </p>
      )}
    </div>
  );
}

export function AlbumHeader({ album, shareUrl, title }: { album: AlbumData; shareUrl: string; title: string }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  const zipUrl = album.download_url;
  const [zip, setZip] = useState<'idle' | 'checking' | 'too-large'>('idle');
  const onDownloadAll = (event: MouseEvent<HTMLAnchorElement>) => {
    // Modified clicks (new tab, save link as) keep their normal behaviour.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (zip === 'checking' || !zipUrl) return;
    setZip('checking');
    void checkZip(zipUrl, album.total_size).then((result) => {
      setZip(result === 'too-large' ? 'too-large' : 'idle');
      if (result === 'ok') browser.download(zipUrl);
    });
  };
  const expiresAt = epochMsOrNull(album.expires_at);
  const expiry = formatExpiry(expiresAt, now);
  const count = album.count;
  return (
    <header className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold break-words sm:text-2xl">{title}</h1>
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted">
          <span>
            {count} {count === 1 ? 'file' : 'files'} · {formatBytes(album.total_size)}
          </span>
          {expiry && expiresAt !== null && (
            <time
              dateTime={new Date(expiresAt).toISOString()}
              title={formatFullDate(expiresAt)}
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
        {zipUrl && (
          <LinkButton href={zipUrl} download onClick={onDownloadAll} aria-busy={zip === 'checking'}>
            {zip === 'checking' ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Download aria-hidden className="size-4" />}
            Download all
          </LinkButton>
        )}
        <LinkButton href={`/report?url=${encodeURIComponent(shareUrl)}`} variant="ghost">
          <Flag aria-hidden className="size-4" />
          Report
        </LinkButton>
      </div>
      {zip === 'too-large' && <TooLargePanel album={album} />}
    </header>
  );
}
