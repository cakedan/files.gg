import { Clock, Download, ExternalLink, KeyRound, Link2, Lock, Trash2 } from 'lucide-react';
import { createElement, Suspense, useMemo } from 'react';
import { Link } from 'react-router';

import { Button, LinkButton } from '../../components/Button';
import type { OwnerFile } from '../../lib/api';
import { formatBytes, formatDimensions } from '../../lib/format';
import { useSignedValue } from '../../lib/signedUrls';
import { epochMs, formatFullDate, formatRelative, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { parseFileData } from '../../viewer/boot';
import { RendererFallback } from '../../viewer/components/RendererFallback';
import { getRenderer } from '../../viewer/renderers';
import { downloadUrl } from '../../viewer/urls';
import { Drawer } from '../components/Drawer';
import { AccessBadge } from './AccessBadge';
import type { FileHandlers } from './fileMenu';
import { formatDuration, pluralize, typeLabel } from './fileLabels';

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

  return (
    <Drawer title={file.filename} onClose={onClose}>
      <div className="flex flex-col gap-5 p-4">
        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-lg border border-line bg-well">
          {data ? (
            <Suspense fallback={<RendererFallback file={data} />}>{createElement(getRenderer(data.kind), { file: data, context: 'list' })}</Suspense>
          ) : (
            <p className="p-6 text-center text-sm text-muted">This file can't be previewed.</p>
          )}
        </div>
        {file.processing && <p className="text-xs text-muted">Previews are still being made for this file.</p>}

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => handlers.copyLink(file)}>
            <Link2 aria-hidden className="size-4" />
            Copy link
          </Button>
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
          {data && (
            <LinkButton href={downloadUrl(data.cdn_url)} download={file.filename}>
              <Download aria-hidden className="size-4" />
              Download
            </LinkButton>
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
        </dl>

        {file.albums.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs text-muted">In {pluralize(file.albums.length, 'album')}</h3>
            <ul className="flex flex-wrap gap-2">
              {file.albums.map((album) => (
                <li key={album.id}>
                  <Link to={`/albums/${album.id}`} onClick={onClose} className="rounded-md bg-surface-2 px-2 py-1 text-sm hover:text-gg">
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
