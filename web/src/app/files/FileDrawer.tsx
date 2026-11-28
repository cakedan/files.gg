import { AlertTriangle, Clock, Download, Eye, EyeOff, ExternalLink, Gauge, Globe, KeyRound, Link as LinkIcon, Link2, Lock, MessageSquareWarning, Trash2, Wand2 } from 'lucide-react';
import { createElement, Suspense, useId, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { Button, LinkButton } from '../../components/Button';
import type { OwnerFile } from '../../lib/api';
import { formatBytes, formatDimensions } from '../../lib/format';
import { ADULT_REGION_TEXT } from '../../lib/upload/options';
import { useSignedValue } from '../../lib/signedUrls';
import { epochMs, formatFullDate, formatRelative, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { parseFileData } from '../../viewer/boot';
import { RendererFallback } from '../../viewer/components/RendererFallback';
import { rendererFor } from '../../viewer/renderers';
import { downloadUrl } from '../../viewer/urls';
import { Drawer } from '../components/Drawer';
import { canShowMedia, stateExplanation, WARNING_TEXT } from '../safety/labels';
import { SafetyBadge } from '../safety/SafetyBadge';
import { useShowSensitive } from '../safety/sensitive';
import { AccessBadge } from './AccessBadge';
import { canAskReview, canConvert, NSFW_LOCKED_HINT, type FileHandlers } from './fileMenu';
import { formatDuration, pluralize, typeLabel } from './fileLabels';
import { EXPIRE_FIRED_HINT, expireActionFired, privateActionFired, PRIVATE_FIRED_HINT, viewLimitActionText, viewLimitOf, viewsUsedLabel } from './viewLimit';

interface FileDrawerProps {
  file: OwnerFile;
  handlers: FileHandlers;
  onClose: () => void;
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

const NSFW_SOURCES: Record<string, string> = {
  uploader: 'You marked this file as sensitive.',
  auto: 'files.gg’s classifier marked this file as sensitive.',
  moderator: 'A moderator marked this file as sensitive.',
  reports: 'This file was marked as sensitive after reports.',
};

/** §4.6: the drawer opens NSFW files behind an interstitial. Nothing mounts before Show. */
function SensitiveGate({ onShow }: { onShow: () => void }) {
  const id = useId();
  const [, setAlways] = useShowSensitive();
  const [always, setAlwaysChecked] = useState(false);
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <EyeOff aria-hidden className="size-8 text-warn" />
      <p className="text-sm font-medium">This file may contain sensitive content</p>
      <label htmlFor={`${id}-always`} className="flex items-center gap-2 text-xs text-muted">
        <input id={`${id}-always`} type="checkbox" checked={always} onChange={(event) => setAlwaysChecked(event.target.checked)} className="accent-gg" />
        Always show sensitive media
      </label>
      <Button
        variant="primary"
        onClick={() => {
          if (always) setAlways(true);
          onShow();
        }}
      >
        <Eye aria-hidden className="size-4" />
        Show
      </Button>
    </div>
  );
}

/**
 * The file in a side drawer, shown with the viewer's own renderers (contract §8). The
 * owner payload's URLs are used as they are (signed for 1 h for protected files). A
 * list refetch re-signs them; the renderer keeps its URLs until they near expiry, so a
 * playing video isn't restarted.
 */
export default function FileDrawer({ file, handlers, onClose }: FileDrawerProps) {
  const protectedFile = file.visibility !== 'link';
  const media = useSignedValue(file, { showChangesAtOnce: true });
  const data = useMemo(() => parseFileData(media), [media]);

  const dims = formatDimensions(file.width ?? file.media?.width, file.height ?? file.media?.height);
  const duration = file.duration ?? file.media?.duration;
  const now = useNow(RELATIVE_REFRESH_MS);
  const [showSensitive] = useShowSensitive();
  const [revealed, setRevealed] = useState(false);
  const servable = canShowMedia(file);
  const gated = Boolean(file.nsfw) && !showSensitive && !revealed;
  const explanation = stateExplanation(file);
  const warnings = [...new Set((file.warnings ?? []).map((code) => WARNING_TEXT[code]).filter(Boolean))];
  const nsfwSource = file.safety?.nsfw_source;
  const viewLimit = viewLimitOf(file);

  return (
    <Drawer title={file.filename} onClose={onClose}>
      <div className="flex flex-col gap-5 p-4">
        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-2xl border border-line bg-well">
          {!servable ? (
            <p className="p-6 text-center text-sm text-muted">{file.safety?.state === 'pending' ? 'This file can’t be viewed until the check finishes.' : 'This file can’t be viewed.'}</p>
          ) : gated ? (
            <SensitiveGate onShow={() => setRevealed(true)} />
          ) : data ? (
            <Suspense fallback={<RendererFallback file={data} />}>{createElement(rendererFor(data), { file: data, context: 'list' })}</Suspense>
          ) : (
            <p className="p-6 text-center text-sm text-muted">This file can't be previewed.</p>
          )}
        </div>
        {servable && file.processing && <p className="text-xs text-muted">Previews are still being made for this file.</p>}

        {explanation && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-bg px-3 py-2 text-sm">
            <SafetyBadge safety={file.safety} />
            <span className="min-w-0 flex-1 text-muted">{explanation}</span>
            {file.safety?.notice_id && (
              <Link to={`/notices/${file.safety.notice_id}`} onClick={onClose} className="font-medium text-gg hover:underline">
                See the notice
              </Link>
            )}
          </div>
        )}
        {warnings.map((text) => (
          <p key={text} className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
            {text} Visitors see this warning too.
          </p>
        ))}

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => handlers.copyLink(file)}>
            <Link2 aria-hidden className="size-4" />
            Copy link
          </Button>
          {handlers.copyDirectLink && file.direct_url && (
            <Button onClick={() => handlers.copyDirectLink!(file)}>
              <LinkIcon aria-hidden className="size-4" />
              Copy direct link
            </Button>
          )}
          {protectedFile ? (
            <Button onClick={() => handlers.openAsOwner(file)}>
              <KeyRound aria-hidden className="size-4" />
              Open as owner
            </Button>
          ) : (
            <Button onClick={() => handlers.open(file)}>
              <ExternalLink aria-hidden className="size-4" />
              Open
            </Button>
          )}
          {handlers.openOnDomain && (
            <Button onClick={() => handlers.openOnDomain!.open(file)}>
              <Globe aria-hidden className="size-4" />
              Open on {handlers.openOnDomain.hostname}
            </Button>
          )}
          {data && servable && (
            <LinkButton href={downloadUrl(data.cdn_url)} download={file.filename}>
              <Download aria-hidden className="size-4" />
              Download
            </LinkButton>
          )}
          {handlers.convert && canConvert(file) && (
            <Button onClick={() => handlers.convert!([file])}>
              <Wand2 aria-hidden className="size-4" />
              Convert…
            </Button>
          )}
          <Button onClick={() => handlers.changeAccess([file])}>
            <Lock aria-hidden className="size-4" />
            Change access…
          </Button>
          <Button onClick={() => handlers.setExpiry([file])}>
            <Clock aria-hidden className="size-4" />
            Set expiry…
          </Button>
          <Button variant="danger" onClick={() => handlers.remove([file])}>
            <Trash2 aria-hidden className="size-4" />
            Delete
          </Button>
        </div>

        {(viewLimit !== null || handlers.editViewLimit) && (
          <section aria-label="View limit" className="flex flex-col gap-2 rounded-xl border border-line px-3 py-3">
            {viewLimit !== null ? (
              <p className="text-sm">
                <span className="font-medium">{viewsUsedLabel(file)}</span> <span className="text-muted">{viewLimitActionText(file)}</span>
              </p>
            ) : (
              <p className="text-sm text-muted">No view limit. Anyone with the link can open it any number of times.</p>
            )}
            {privateActionFired(file) && <p className="text-sm text-warn">{PRIVATE_FIRED_HINT}</p>}
            {expireActionFired(file) && <p className="text-sm text-warn">{EXPIRE_FIRED_HINT}</p>}
            {handlers.editViewLimit && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => handlers.editViewLimit!(file)}>
                  <Gauge aria-hidden className="size-4" />
                  {viewLimit === null ? 'Set view limit…' : 'Edit view limit…'}
                </Button>
                {viewLimit !== null && handlers.removeViewLimit && (
                  <Button variant="ghost" onClick={() => handlers.removeViewLimit!(file)}>
                    Remove limit
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {handlers.setSensitive && (
          <section aria-label="Sensitive content" className="flex flex-col gap-2 rounded-xl border border-line px-3 py-3">
            <p className="text-sm text-muted">{file.nsfw ? (NSFW_SOURCES[nsfwSource ?? ''] ?? 'This file is marked as sensitive.') : 'This file isn’t marked as sensitive.'}</p>
            <div className="flex flex-wrap gap-2">
              {file.nsfw ? (
                <Button onClick={() => handlers.setSensitive!([file], false)} disabled={Boolean(file.safety?.nsfw_locked)} title={file.safety?.nsfw_locked ? NSFW_LOCKED_HINT : undefined}>
                  <Eye aria-hidden className="size-4" />
                  Unmark as sensitive
                </Button>
              ) : handlers.adultRegionBlocked ? null : (
                <Button onClick={() => handlers.setSensitive!([file], true)}>
                  <EyeOff aria-hidden className="size-4" />
                  Mark as sensitive
                </Button>
              )}
              {handlers.askReview && canAskReview(file) && (
                <Button onClick={() => handlers.askReview!(file)}>
                  <MessageSquareWarning aria-hidden className="size-4" />
                  Ask for review…
                </Button>
              )}
            </div>
            {!file.nsfw && handlers.adultRegionBlocked && <p className="text-xs text-muted">{ADULT_REGION_TEXT}</p>}
            {file.nsfw && file.safety?.nsfw_locked && <p className="text-xs text-muted">{NSFW_LOCKED_HINT}</p>}
            {file.safety?.nsfw_review === 'open' && <p className="text-xs text-muted">You asked for a review. A moderator will check it.</p>}
          </section>
        )}

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Meta label="Type">
            {typeLabel(file)} <span className="text-muted">({file.mimetype})</span>
          </Meta>
          <Meta label="Size">{formatBytes(file.size)}</Meta>
          {dims && <Meta label="Dimensions">{dims}</Meta>}
          {duration ? <Meta label="Duration">{formatDuration(duration)}</Meta> : null}
          {file.media?.pages ? <Meta label="Pages">{file.media.pages}</Meta> : null}
          {file.media?.lines ? <Meta label="Lines">{file.media.lines.toLocaleString('en')}</Meta> : null}
          <Meta label="Uploaded">
            <span title={formatFullDate(epochMs(file.uploaded_at))}>{formatRelative(epochMs(file.uploaded_at), now)}</span>
          </Meta>
          <Meta label="Expires">
            {file.expires_at === null ? (
              'Never'
            ) : (
              <span title={formatFullDate(epochMs(file.expires_at))}>{formatRelative(epochMs(file.expires_at), now)}</span>
            )}
          </Meta>
          <Meta label="Access">
            <AccessBadge visibility={file.visibility} />
          </Meta>
          {file.views !== undefined && <Meta label="Views">{file.views.toLocaleString('en')}</Meta>}
          {viewLimit !== null && <Meta label="View limit">{viewLimit.toLocaleString('en')}</Meta>}
        </dl>

        {file.albums.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs text-muted">In {pluralize(file.albums.length, 'album')}</h3>
            <ul className="flex flex-wrap gap-2">
              {file.albums.map((album) => (
                <li key={album.id}>
                  <Link to={`/albums/${album.id}`} onClick={onClose} className="rounded-xl bg-surface-2 px-2 py-1 text-sm hover:text-gg">
                    {album.title || 'Untitled album'}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}
