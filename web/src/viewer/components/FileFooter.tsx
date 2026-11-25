import { Download, ExternalLink, Wand2 } from 'lucide-react';

import { CopyButton } from '../../components/CopyButton';
import { PRIVACY_PATH, TERMS_PATH } from '../../components/SiteFooter';
import { LinkButton } from '../../components/Button';
import { convertPath, documentLabel, sourceKindOf } from '../../lib/convertKinds';
import { formatBytes, formatDimensions } from '../../lib/format';
import { epochMs, epochMsOrNull, formatExpiry, formatFullDate, formatUploaded, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { hostContext, mainUrl } from '../host/context';
import type { FileData } from '../types';
import { downloadUrl, shareUrl } from '../urls';
import { ReportButton } from './ReportButton';
import { fileReportTarget } from './reportPath';
import { viewsLeftLabel } from './viewLimitText';

/**
 * "Convert" (milestone-5 §13.2): a link to files.gg/convert?source=<vanity>, for any file
 * of a kind that has targets. A view-limited file can only be converted by its owner, so
 * a visitor who opened one doesn't get it. On a custom domain it opens files.gg in a new tab.
 */
function convertHref(file: FileData, vanity: string | null): string | null {
  if (!vanity || file.view_limit || !sourceKindOf(file)) return null;
  return mainUrl(convertPath(vanity));
}

export function FileFooter({ file }: { file: FileData }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  const uploadedAt = file.uploaded_at > 0 ? epochMs(file.uploaded_at) : null;
  const expiresAt = epochMsOrNull(file.expires_at);
  const expiry = formatExpiry(expiresAt, now);
  const preview = file.assets?.document;
  const pages = preview?.pages ?? file.media?.pages;
  const reportTarget = fileReportTarget(file);
  const convert = convertHref(file, reportTarget?.type === 'file' ? reportTarget.vanity : null);
  const custom = hostContext().custom;
  const details = [
    // §9.2: a document shown as its preview PDF says so, with the original type.
    preview ? `${documentLabel(file.mimetype) ?? 'Document'} · preview` : null,
    formatBytes(file.size),
    formatDimensions(file.width, file.height),
    pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : null,
    preview ? null : file.mimetype,
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
        {/* Milestone 6 §19.7: after opening a view-limited file. */}
        {file.view_limit && <span className="text-warn">{viewsLeftLabel(file.view_limit.remaining)}</span>}
      </p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <CopyButton text={shareUrl(file.url)} />
        <LinkButton href={downloadUrl(file.cdn_url)} download={file.filename}>
          <Download aria-hidden className="size-4" />
          Download
        </LinkButton>
        {convert && (
          <LinkButton href={convert} variant="ghost" {...(custom ? { target: '_blank', rel: 'noopener' } : {})}>
            <Wand2 aria-hidden className="size-4" />
            Convert
          </LinkButton>
        )}
        <LinkButton href={file.cdn_url} target="_blank" rel="noopener noreferrer" variant="ghost">
          <ExternalLink aria-hidden className="size-4" />
          Raw
        </LinkButton>
      </div>
      {/* Milestone 5 §19.2: on files.gg and custom domains alike, these go to files.gg. */}
      <nav aria-label="files.gg" className="mt-1 flex flex-wrap justify-center gap-x-1.5 text-xs text-muted">
        <a href={mainUrl(TERMS_PATH)} className="hover:text-text hover:underline">
          Terms
        </a>
        <span aria-hidden>·</span>
        <a href={mainUrl(PRIVACY_PATH)} className="hover:text-text hover:underline">
          Privacy
        </a>
        {reportTarget && (
          <>
            <span aria-hidden>·</span>
            <ReportButton target={reportTarget} plain />
          </>
        )}
      </nav>
    </footer>
  );
}
