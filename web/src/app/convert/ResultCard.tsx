import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, Images, KeyRound, Loader2, RotateCcw } from 'lucide-react';
import { createElement, Suspense, useMemo, useState } from 'react';

import { Button, LinkButton } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { api } from '../../lib/api';
import type { Conversion } from '../../lib/conversions';
import { queryKeys } from '../../lib/queries';
import { parseFileData } from '../../viewer/boot';
import { RendererFallback } from '../../viewer/components/RendererFallback';
import { rendererFor } from '../../viewer/renderers';
import { downloadUrl } from '../../viewer/urls';
import { AddToAlbumDialog } from '../files/AddToAlbumDialog';
import { pluralize } from '../files/fileLabels';
import { useScanStatus } from '../upload/useScanStatus';
import { AppLink } from '../components/AppLink';
import { sizeChange } from './conversionText';

const SCAN_TEXT: Record<string, string> = {
  checking: 'Scanning…',
  moderated: 'This file can’t be shared.',
  rejected: 'This file was rejected.',
  gone: 'This file is no longer available.',
  timeout: 'Still checking. It appears in Files with its link once the check finishes.',
};

/**
 * §13.1 step 5: the result with the viewer's renderers (or the album link for PDF
 * pages), size before and after, Copy link, Download, Convert again and Add to album
 * (signed in). A generated password is shown once. A new output is scanned like an
 * upload, so it says "Scanning…" until it can be shared (§0).
 */
export function ResultCard({ conversion, anonymous, onConvertAgain }: { conversion: Conversion; anonymous: boolean; onConvertAgain: () => void }) {
  const output = conversion.output.file;
  const album = conversion.output.album;
  const password = conversion.output.password;
  const scan = useScanStatus(output ?? undefined);
  const ready = Boolean(output) && scan.phase !== 'checking' && (scan.phase === 'ready' || scan.phase === 'idle');
  // After the scan, the owner payload has its previews.
  const fresh = useQuery({
    queryKey: queryKeys.myFile(output?.id ?? ''),
    queryFn: ({ signal }) => api.myFile(output!.id, signal),
    enabled: Boolean(output) && ready && output?.safety?.state === 'pending',
  });
  const file = fresh.data ?? output;
  const data = useMemo(() => (file && ready ? parseFileData(file) : null), [file, ready]);
  const [adding, setAdding] = useState(false);
  const change = sizeChange(conversion.input_size, conversion.output_size ?? output?.size ?? null);

  return (
    <section aria-label="Result" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
      <header className="flex flex-wrap items-center gap-2">
        <CheckCircle2 aria-hidden className="size-5 text-gg" />
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{file?.filename ?? album?.title ?? 'Converted'}</h2>
        {conversion.cached && <span className="text-xs text-muted">Converted before, so it was instant</span>}
      </header>

      {album ? (
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-well p-4 text-sm">
          <p className="inline-flex items-center gap-2 font-medium">
            <Images aria-hidden className="size-4 text-gg" />
            {pluralize(album.count, 'page')} in a new album
          </p>
          <p className="text-muted">Each page is its own file, in order.</p>
        </div>
      ) : (
        <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-lg border border-line bg-well">
          {!ready ? (
            <p className="flex items-center gap-2 p-6 text-sm text-muted" role="status">
              {scan.phase === 'checking' && <Loader2 aria-hidden className="size-4 animate-spin" />}
              {SCAN_TEXT[scan.phase] ?? 'Scanning…'}
            </p>
          ) : data ? (
            <Suspense fallback={<RendererFallback file={data} />}>{createElement(rendererFor(data), { file: data, context: 'list' })}</Suspense>
          ) : (
            <p className="p-6 text-sm text-muted">No preview.</p>
          )}
        </div>
      )}

      {change && <p className="text-sm text-muted">{change}</p>}

      {password && (
        <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
          <p className="inline-flex items-center gap-1.5 font-medium">
            <KeyRound aria-hidden className="size-4 text-warn" />
            Password: <code className="rounded bg-bg px-1.5 py-0.5 font-mono">{password}</code>
          </p>
          <p className="text-xs text-muted">It’s shown once, so copy it now. Anyone with the link needs it to open the file.</p>
          <CopyButton text={password} label="Copy password" variant="secondary" />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {album ? (
          <>
            <CopyButton text={album.url} />
            <AppLink to={`/albums/${album.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-surface-2 px-3 text-sm font-medium hover:bg-line">
              <Images aria-hidden className="size-4" />
              Open album
            </AppLink>
          </>
        ) : (
          file &&
          ready && (
            <>
              <CopyButton text={file.url} />
              <LinkButton href={downloadUrl(file.cdn_url)} download={file.filename}>
                <Download aria-hidden className="size-4" />
                Download
              </LinkButton>
            </>
          )
        )}
        <Button onClick={onConvertAgain}>
          <RotateCcw aria-hidden className="size-4" />
          Convert again
        </Button>
        {!anonymous && file && ready && (
          <Button onClick={() => setAdding(true)}>
            <Images aria-hidden className="size-4" />
            Add to album…
          </Button>
        )}
      </div>
      {adding && file && <AddToAlbumDialog files={[file]} onClose={() => setAdding(false)} />}
    </section>
  );
}
