import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Loader2, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

import { Button } from '../../components/Button';
import { UploadAgreement } from '../../components/TermsAgreement';
import { useTurnstile } from '../../components/useTurnstile';
import { loadAccess } from '../../lib/access';
import { api, ApiError, ensureGuest, type FilePayload, type OwnerAlbum, type OwnerFile } from '../../lib/api';
import { sourceKindOf, type SourceKind } from '../../lib/convertKinds';
import { conversionApi, isActive, type BatchSkipped, type Conversion, type CreateConversionBody } from '../../lib/conversions';
import { errorMessage, uploadRejectedMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { queryKeys, useMe, useMyLimits } from '../../lib/queries';
import type { PickerContext } from '../../lib/upload/options';
import { pluralize } from '../files/fileLabels';
import { ConvertSignIn } from './ConvertSignIn';
import { BatchForm, type BatchChoice } from './BatchForm';
import { BatchList } from './BatchList';
import { ConversionProgress } from './ConversionProgress';
import { History } from './History';
import { pickFromLink } from './options';
import type { SourceFacts } from './OptionsForm';
import { conversionKeys, useConversion, useFormats, useRefreshHistory } from './queries';
import { ResultCard } from './ResultCard';
import { rerunSource } from './conversionText';
import { SingleForm, type ConvertChoice } from './SingleForm';
import { SourceStep } from './SourceStep';
import { useDroppedSource, type DroppedSource } from './useDroppedSource';

const KIND_NAMES: Record<SourceKind, string> = {
  image: 'Image',
  animated: 'Animation',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  pdf: 'PDF',
};

/** A file the page converts: the public or owner payload (milestone-3 §4). */
type SourceFile = Pick<FilePayload, 'vanity' | 'filename' | 'extension' | 'mimetype' | 'kind' | 'size' | 'duration' | 'framecount' | 'media' | 'visibility'>;

interface StartRequest {
  body: CreateConversionBody;
  /** A protected source's unlock token (`X-Filesgg-Access`, §5.1). */
  token: string | null;
}

const factsOf = (file: SourceFile): SourceFacts => ({
  size: file.size,
  duration: file.duration ?? file.media?.duration ?? null,
  hasAudio: file.media?.has_audio ?? true,
  pages: file.media?.pages ?? null,
});

function SourceCard({ title, detail, onChange }: { title: string; detail: string; onChange: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={title}>
          {title}
        </p>
        <p className="text-xs text-muted">{detail}</p>
      </div>
      <Button variant="ghost" onClick={onChange}>
        Change
      </Button>
    </div>
  );
}

function Notice({ children, onChange }: { children: ReactNode; onChange?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <span className="min-w-0 flex-1">{children}</span>
      {onChange && (
        <Button variant="ghost" onClick={onChange}>
          Pick another file
        </Button>
      )}
    </div>
  );
}

const DROP_PHASES: Record<string, string> = {
  queued: 'Waiting…',
  verifying: 'Starting…',
  uploading: 'Uploading',
  paused: 'Paused',
  processing: 'Processing…',
  done: 'Uploaded',
  error: 'Upload failed',
  cancelled: 'Cancelled',
};

/** §13.1 step 1: a dropped file's upload, then its scan (a source must be scanned, §5.1). */
function DroppedCard({ dropped, onCancel }: { dropped: DroppedSource; onCancel: () => void }) {
  const { snapshot, scan, file } = dropped;
  const percent = snapshot.total ? Math.round((snapshot.loaded / snapshot.total) * 100) : 0;
  let line: ReactNode = `${DROP_PHASES[snapshot.phase]}${snapshot.phase === 'uploading' ? ` · ${percent}%` : ''}`;
  let failed = snapshot.phase === 'error';
  if (snapshot.phase === 'error') line = errorMessage(snapshot.error);
  else if (snapshot.phase === 'done') {
    if (scan.phase === 'checking') line = 'Checking the file…';
    else if (scan.phase === 'rejected') [line, failed] = [uploadRejectedMessage(scan.reason), true];
    else if (scan.phase === 'moderated' || scan.phase === 'gone') [line, failed] = ['This file can’t be converted.', true];
    else if (scan.phase === 'timeout') [line, failed] = ['Still checking the file. Try again in a minute.', true];
    else if (dropped.settling) line = 'Reading the file…';
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3" aria-live="polite">
      <div className="flex items-center gap-3">
        {!failed && <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-gg" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className={`text-xs ${failed ? 'text-danger' : 'text-muted'}`} role={failed ? 'alert' : undefined}>
            {line}
          </p>
        </div>
        {failed && snapshot.phase === 'error' && <Button onClick={dropped.retry}>Retry</Button>}
        <Button variant="ghost" onClick={onCancel} aria-label="Cancel">
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      {snapshot.phase === 'uploading' && (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full bg-gg" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

/** `?source=<vanity>` (§13.2): the file's public payload, with its unlock token when this browser has one. */
function useLinkedSource(vanity: string | null) {
  return useQuery({
    queryKey: ['conversions', 'source', vanity ?? ''],
    queryFn: ({ signal }) => conversionApi.sourceFile(vanity!, loadAccess('file', vanity!)?.token, signal),
    enabled: Boolean(vanity),
    staleTime: 60_000,
  });
}

/**
 * The Convert page (milestone-5 §13.1): `/app/convert` in the dashboard, and the public
 * `files.gg/convert` (`publicPage`: no history). Source, target, options, convert, result.
 */
export function ConvertView({ publicPage = false }: { publicPage?: boolean }) {
  useEffect(() => {
    document.title = 'Convert · files.gg';
  }, []);

  const me = useMe();
  const anonymous = !me.data;
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const formats = useFormats();
  const limits = useMyLimits();
  const refreshHistory = useRefreshHistory();
  // The new file's pickers start where the API would (milestone-5 §21): the account's upload defaults, signed in.
  const defaults = me.data?.settings.upload_defaults ?? null;
  const outputContext: PickerContext = useMemo(() => ({ anonymous, limits: limits.data ?? null, defaults }), [anonymous, limits.data, defaults]);

  const { mount: uploadMount, status: uploadStatus, take: takeUpload, retry: retryUpload } = useTurnstile('upload', anonymous);
  const { mount: convertMount, status: convertStatus, take: takeConvert, retry: retryConvert } = useTurnstile('convert', anonymous);
  const { dropped, start: dropFile, clear: clearDrop } = useDroppedSource(anonymous ? takeUpload : undefined, limits.data);
  const [libraryFile, setLibraryFile] = useState<OwnerFile | null>(null);

  const sourceVanity = params.get('source');
  const albumId = params.get('album');
  const batchId = params.get('batch');
  const routedFiles = (location.state as { files?: OwnerFile[] } | null)?.files ?? null;
  const single: OwnerFile | null = libraryFile ?? (routedFiles?.length === 1 ? routedFiles[0]! : null);
  const linked = useLinkedSource(!dropped && !single && !albumId && !batchId ? sourceVanity : null);
  const album = useQuery({
    queryKey: queryKeys.album(albumId ?? ''),
    queryFn: ({ signal }) => api.album(albumId!, signal),
    enabled: Boolean(albumId) && !anonymous && !batchId,
  });

  const [current, setCurrent] = useState<Conversion | null>(null);
  const live = useConversion(current);
  // A generated password is only on the `POST` answer (§10.2): the polled copies keep it for the result card.
  const password = current?.output.password;
  const polled = current ? (live.data ?? current) : null;
  const conversion = polled && password && !polled.output.password ? { ...polled, output: { ...polled.output, password } } : polled;
  const lastRequest = useRef<StartRequest | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const [skipped, setSkipped] = useState<BatchSkipped[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);

  // The history row of a conversion that just finished catches up.
  const finished = conversion && !isActive(conversion) ? conversion.status : null;
  useEffect(() => {
    if (finished && !anonymous) refreshHistory();
  }, [finished, anonymous, refreshHistory]);

  const resetSource = useCallback(() => {
    clearDrop();
    setLibraryFile(null);
    setCurrent(null);
    setStartError(null);
    setSkipped([]);
    navigate(location.pathname, { replace: true, state: null });
  }, [clearDrop, location.pathname, navigate]);

  const run = useCallback(
    async (request: StartRequest) => {
      setStartError(null);
      setStarting(true);
      try {
        let body = request.body;
        if (anonymous) {
          await ensureGuest();
          body = { ...body, turnstile_token: await takeConvert() };
        }
        const created = await conversionApi.create(body, request.token);
        lastRequest.current = request;
        client.setQueryData(conversionKeys.one(created.id), created);
        setCurrent(created);
        if (!anonymous) refreshHistory();
      } catch (error) {
        setStartError(error instanceof Error && error.message.startsWith('turnstile') ? new ApiError(403, 'CAPTCHA_INVALID', 'Turnstile failed') : error);
      } finally {
        setStarting(false);
      }
    },
    [anonymous, client, takeConvert, refreshHistory],
  );

  const cancel = useCallback(
    async (id: string) => {
      try {
        const cancelled = await conversionApi.remove(id);
        if (cancelled) client.setQueryData(conversionKeys.one(id), cancelled);
        if (batchId) void client.invalidateQueries({ queryKey: conversionKeys.batch(batchId) });
        if (!anonymous) refreshHistory();
      } catch (error) {
        setStartError(error);
      }
    },
    [anonymous, batchId, client, refreshHistory],
  );

  const startSingle = (file: SourceFile, token: string | null) => (choice: ConvertChoice) => {
    if (!file.vanity) return;
    void run({ body: { source: file.vanity, target: choice.target, ...(Object.keys(choice.options).length ? { options: choice.options } : {}), ...choice.output }, token });
  };

  const startBatch = (files: OwnerFile[], source: OwnerAlbum | null) => async (choice: BatchChoice) => {
    const options = Object.keys(choice.options).length ? { options: choice.options } : {};
    if (choice.combine) {
      // §1.2: several images (or an album, in its order) → one PDF.
      const images = files.filter((file) => sourceKindOf(file) === 'image').map((file) => file.vanity);
      void run({ body: { ...(source ? { album: source.vanity } : { sources: images }), target: 'pdf', ...options, ...choice.output }, token: null });
      return;
    }
    setStartError(null);
    setStarting(true);
    try {
      const batch = await conversionApi.createBatch({
        ...(source ? { album: source.vanity } : { files: files.map((file) => file.vanity) }),
        target: choice.target,
        ...options,
        ...choice.output,
      });
      client.setQueryData(conversionKeys.batch(batch.batch_id), { items: batch.items, next: null });
      setSkipped(batch.skipped);
      setParams({ batch: batch.batch_id });
      refreshHistory();
    } catch (error) {
      setStartError(error);
    } finally {
      setStarting(false);
    }
  };

  const signInHint = anonymous && startError instanceof ApiError && (startError.body as { sign_in?: unknown } | undefined)?.sign_in === true;
  const errorNode = startError ? (
    <p role="alert" className="text-sm text-danger">
      {errorMessage(startError)} {signInHint && startError instanceof ApiError && startError.code !== 'CONVERSION_REQUIRES_ACCOUNT' && <ConvertSignIn>Sign in for bigger conversions</ConvertSignIn>}
      {startError instanceof ApiError && startError.code === 'CONVERSION_REQUIRES_ACCOUNT' && <ConvertSignIn>Sign in</ConvertSignIn>}
    </p>
  ) : null;

  const singleForm = (file: SourceFile, token: string | null, onChange: () => void) => {
    const kind = sourceKindOf(file);
    return (
      <>
        <SourceCard title={file.filename} detail={`${kind ? KIND_NAMES[kind] : 'File'} · ${formatBytes(file.size)}`} onChange={onChange} />
        {!kind ? (
          <Notice onChange={onChange}>This file can’t be converted.</Notice>
        ) : !formats.data ? (
          formats.isError ? (
            <Notice>
              {errorMessage(formats.error)}{' '}
              <button type="button" className="font-medium text-gg hover:underline" onClick={() => void formats.refetch()}>
                Try again
              </button>
            </Notice>
          ) : (
            <p className="text-sm text-muted" role="status">
              Loading formats…
            </p>
          )
        ) : (
          <SingleForm
            key={file.vanity}
            formats={formats.data}
            kind={kind}
            extension={file.extension}
            facts={factsOf(file)}
            anonymous={anonymous}
            outputContext={outputContext}
            protectedSource={file.visibility !== 'link'}
            initialPick={pickFromLink(formats.data, kind, file.extension, params.get('preset'), params.get('target'))}
            starting={starting}
            onConvert={startSingle(file, token)}
            error={errorNode}
          />
        )}
      </>
    );
  };

  const batchForm = (files: OwnerFile[], source: OwnerAlbum | null) => (
    <>
      <SourceCard title={source ? source.title || 'Untitled album' : `${pluralize(files.length, 'file')} selected`} detail={formatBytes(files.reduce((sum, file) => sum + file.size, 0))} onChange={resetSource} />
      {formats.data ? (
        <BatchForm
          formats={formats.data}
          files={files}
          anonymous={anonymous}
          outputContext={outputContext}
          starting={starting}
          onStart={(choice) => void startBatch(files, source)(choice)}
          error={errorNode}
        />
      ) : (
        <p className="text-sm text-muted" role="status">
          Loading formats…
        </p>
      )}
    </>
  );

  let active: ReactNode = null;
  if (conversion) {
    active =
      conversion.status === 'succeeded' ? (
        <ResultCard conversion={conversion} anonymous={anonymous} onConvertAgain={() => setCurrent(null)} />
      ) : (
        <div className="flex flex-col gap-2">
          <ConversionProgress
            conversion={conversion}
            anonymous={anonymous}
            cancelling={cancelling}
            onCancel={() => {
              setCancelling(true);
              void cancel(conversion.id).finally(() => setCancelling(false));
            }}
            onRetry={() => lastRequest.current && void run(lastRequest.current)}
            signIn={(label) => <ConvertSignIn>{label}</ConvertSignIn>}
          />
          {!isActive(conversion) && (
            <div>
              <Button variant="ghost" onClick={() => setCurrent(null)}>
                Change options
              </Button>
            </div>
          )}
          {errorNode}
        </div>
      );
  }

  // The form stays mounted (hidden) under a running conversion, so Convert again keeps the picks.
  let body: ReactNode;
  if (batchId) {
    body = <BatchList batchId={batchId} skipped={skipped} onCancel={(id) => void cancel(id)} onDone={resetSource} />;
  } else if (routedFiles && routedFiles.length > 1) {
    body = batchForm(routedFiles, null);
  } else if (albumId) {
    body = album.data ? (
      batchForm(album.data.items, album.data)
    ) : album.isError || anonymous ? (
      <Notice onChange={resetSource}>{anonymous ? 'Sign in to convert an album.' : errorMessage(album.error)}</Notice>
    ) : (
      <p className="text-sm text-muted" role="status">
        Loading the album…
      </p>
    );
  } else if (dropped) {
    body = dropped.ready ? singleForm(dropped.ready, null, resetSource) : <DroppedCard dropped={dropped} onCancel={resetSource} />;
  } else if (single) {
    body = singleForm(single, null, resetSource);
  } else if (sourceVanity) {
    const data = linked.data;
    const token = loadAccess('file', sourceVanity)?.token ?? null;
    if (linked.isPending) {
      body = (
        <p className="text-sm text-muted" role="status">
          Loading the file…
        </p>
      );
    } else if (linked.isError || !data) {
      body = <Notice onChange={resetSource}>{linked.error instanceof ApiError && linked.error.status === 404 ? 'That file isn’t available.' : errorMessage(linked.error)}</Notice>;
    } else if (data.view_limited) {
      body = <Notice onChange={resetSource}>Files with a view limit can only be converted by their owner.</Notice>;
    } else if (data.protected === 'password' && !data.cdn_url) {
      body = (
        <Notice onChange={resetSource}>
          This file is password-protected.{' '}
          <a href={`/${sourceVanity}`} className="font-medium text-gg hover:underline">
            Open it and enter the password
          </a>
          , then convert it from there.
        </Notice>
      );
    } else {
      body = singleForm(data, token, resetSource);
    }
  } else {
    body = (
      <SourceStep
        signedIn={!anonymous}
        onFile={(file) => {
          setStartError(null);
          dropFile(file);
        }}
        onLibraryFile={setLibraryFile}
        onAlbum={(picked) => setParams({ album: picked.id })}
      />
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Convert</h1>
        <p className="text-sm text-muted">
          Turn a file into another format. The result is a new file with its own link.
          {anonymous && ' Without an account, files up to 50 MB.'}
        </p>
      </header>

      {active}
      <div hidden={Boolean(active)} className="flex flex-col gap-5">
        {body}
      </div>

      {anonymous && (
        <div className="flex flex-col gap-1 text-xs text-muted">
          <UploadAgreement />
          <span className="inline-flex items-center gap-1">
            <ShieldCheck aria-hidden className="size-3.5" /> Checked by Cloudflare Turnstile.
          </span>
          <div ref={uploadMount} data-testid="turnstile-upload" />
          <div ref={convertMount} data-testid="turnstile" />
          {(uploadStatus === 'error' || convertStatus === 'error') && (
            <button
              type="button"
              className="self-start text-gg hover:underline"
              onClick={() => {
                if (uploadStatus === 'error') retryUpload();
                if (convertStatus === 'error') retryConvert();
              }}
            >
              The check couldn’t load. Retry
            </button>
          )}
        </div>
      )}

      {!publicPage && !anonymous && (
        <History
          busy={busyRow}
          onRerun={(item) => {
            const source = rerunSource(item);
            if (!source) return;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            void run({ body: { ...source, target: item.target, ...(Object.keys(item.options).length ? { options: item.options } : {}) }, token: null });
          }}
          onRemove={(item) => {
            setBusyRow(item.id);
            const done = () => setBusyRow(null);
            if (isActive(item)) {
              void cancel(item.id).finally(done);
              return;
            }
            void conversionApi
              .remove(item.id)
              .then(() => {
                if (current?.id === item.id) setCurrent(null);
                refreshHistory();
              })
              .catch((error: unknown) => setStartError(error))
              .finally(done);
          }}
        />
      )}
    </section>
  );
}
