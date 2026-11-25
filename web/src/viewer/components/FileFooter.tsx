import { Download, ExternalLink } from 'lucide-react';

import { CopyButton } from '../../components/CopyButton';
import { LinkButton } from '../../components/Button';
import { formatBytes, formatDimensions } from '../../lib/format';
import { epochMs, epochMsOrNull, formatExpiry, formatFullDate, formatUploaded, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import type { FileData } from '../types';
import { downloadUrl, shareUrl } from '../urls';
import { ReportButton } from './ReportButton';
import { fileReportTarget } from './reportPath';

export function FileFooter({ file }: { file: FileData }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  const uploadedAt = file.uploaded_at > 0 ? epochMs(file.uploaded_at) : null;
  const expiresAt = epochMsOrNull(file.expires_at);
  const expiry = formatExpiry(expiresAt, now);
  const pages = file.media?.pages;
  const reportTarget = fileReportTarget(file);
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
        {uploadedAt !== null && (
          <time dateTime={new Date(uploadedAt).toISOString()} title={formatFullDate(uploadedAt)}>
            {formatUploaded(uploadedAt, now)}
          </time>
        )}
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
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <CopyButton text={shareUrl(file.url)} />
        <LinkButton href={downloadUrl(file.cdn_url)} download={file.filename}>
          <Download aria-hidden className="size-4" />
          Download
        </LinkButton>
        <LinkButton href={file.cdn_url} target="_blank" rel="noopener noreferrer" variant="ghost">
          <ExternalLink aria-hidden className="size-4" />
          Raw
        </LinkButton>
        {reportTarget && <ReportButton target={reportTarget} />}
      </div>
    </footer>
  );
}
