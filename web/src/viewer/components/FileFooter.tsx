import { Download, ExternalLink, Wand2 } from 'lucide-react';
import { useId } from 'react';

import { CopyButton } from '../../components/CopyButton';
import { LinkButton } from '../../components/Button';
import { convertPath, documentLabel, sourceKindOf } from '../../lib/convertKinds';
import { formatBytes, formatDimensions } from '../../lib/format';
import { epochMs, epochMsOrNull, formatExpiry, formatFullDate, formatUploaded, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { hostContext, mainUrl } from '../host/context';
import type { FileData } from '../types';
import { downloadUrl, shareUrl } from '../urls';
import { AccessLine } from './AccessLine';
import { PASSWORD_SHARE_NOTE } from './accessText';
import { ReportButton } from './ReportButton';
import { ViewerFooterNav } from './ViewerFooterNav';
import { fileReportTarget } from './reportPath';
import { viewsLeftLabel } from './viewLimitText';

/**
 * "Convert" (milestone-5 §13.2): a link to files.gg/convert?source=<vanity>, for any file
 * of a kind that has targets. A view-limited file can only be converted by its owner, so
 * a visitor who opened one doesn't get it. On a custom domain it opens files.gg in a new tab.
 */
function convertHref(file: FileData, vanity: string | null): string | null {
  if (!vanity || file.view_limit || !sourceKindOf(file)) return null;
  // An unplayable video already offers "Convert to MP4 to play in browser" in the card (NotPlayable).
  if (file.kind === 'video' && file.media?.playable === false) return null;
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
  const noteId = useId();
  const passwordNote = file.visibility === 'password';
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
        <AccessLine visibility={file.visibility} />
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
        {/* Derive hasn't finished: no poster, thumbnails or length yet. The file itself still opens. */}
        {file.processing && <span>Preview still processing</span>}
        {/* Milestone 6 §19.7: after opening a view-limited file. */}
        {file.view_limit && <span className="text-warn">{viewsLeftLabel(file.view_limit.remaining)}</span>}
      </p>
      {passwordNote && (
        <p id={noteId} className="mt-0.5 text-xs text-muted">
          {PASSWORD_SHARE_NOTE}
        </p>
      )}
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {/* Grey, with only its icon green: a green fill pulls the eye off the file (DESIGN.md, viewer card). */}
        <CopyButton
          text={shareUrl(file.url)}
          variant="secondary"
          iconOnly
          iconClassName="text-gg"
          aria-describedby={passwordNote ? noteId : undefined}
        />
        <LinkButton href={downloadUrl(file.cdn_url)} download={file.filename} size="icon" aria-label="Download" title="Download">
          <Download aria-hidden className="size-5" />
        </LinkButton>
        {convert && (
          <LinkButton
            href={convert}
            variant="ghost"
            size="icon"
            aria-label="Convert"
            title="Convert"
            {...(custom ? { target: '_blank', rel: 'noopener' } : {})}
          >
            <Wand2 aria-hidden className="size-5" />
          </LinkButton>
        )}
        <LinkButton href={file.cdn_url} target="_blank" rel="noopener noreferrer" variant="ghost" size="icon" aria-label="Open original" title="Open original">
          <ExternalLink aria-hidden className="size-5" />
        </LinkButton>
      </div>
      <ViewerFooterNav className="mt-1" report={reportTarget && <ReportButton target={reportTarget} plain />} />
    </footer>
  );
}
