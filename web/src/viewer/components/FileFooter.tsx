import { Download, ExternalLink } from 'lucide-react';

import { CopyButton } from '../../components/CopyButton';
import { LinkButton } from '../../components/Button';
import { formatBytes, formatDimensions } from '../../lib/format';
import { formatExpiry, formatFullDate, formatUploaded, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import type { FileData } from '../types';
import { downloadUrl, shareUrl } from '../urls';

export function FileFooter({ file }: { file: FileData }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  const expiry = formatExpiry(file.expiresAt, now);
  const pages = file.media?.pages;
  const details = [
    formatBytes(file.size),
    formatDimensions(file.width, file.height),
    pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : null,
    file.mimetype,
  ].filter(Boolean);

  return (
    <footer className="viewer-footer flex flex-col gap-2 px-4 pt-3 pb-3.5 text-center">
      <h1 className="truncate text-base font-semibold" title={file.filename}>
        {file.filename}
      </h1>
      <p className="truncate text-xs text-muted">{details.join(' · ')}</p>
      <p className="flex flex-wrap justify-center gap-x-3 gap-y-0.5 text-sm text-muted">
        {file.uploadedAt > 0 && (
          <time dateTime={new Date(file.uploadedAt).toISOString()} title={formatFullDate(file.uploadedAt)}>
            {formatUploaded(file.uploadedAt, now)}
          </time>
        )}
        {expiry && file.expiresAt !== null && (
          <time
            dateTime={new Date(file.expiresAt).toISOString()}
            title={formatFullDate(file.expiresAt)}
            className={expiry.tone === 'danger' ? 'text-danger' : 'text-warn'}
          >
            {expiry.label}
          </time>
        )}
      </p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <CopyButton text={shareUrl(file.url)} />
        <LinkButton href={downloadUrl(file.cdnUrl)} download={file.filename}>
          <Download aria-hidden className="size-4" />
          Download
        </LinkButton>
        <LinkButton href={file.cdnUrl} target="_blank" rel="noopener noreferrer" variant="ghost">
          <ExternalLink aria-hidden className="size-4" />
          Raw
        </LinkButton>
      </div>
    </footer>
  );
}
