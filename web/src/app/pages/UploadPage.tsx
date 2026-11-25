import { useQuery } from '@tanstack/react-query';
import { Ban, FileUp, ShieldCheck, Upload } from 'lucide-react';
import { Link } from 'react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { useTurnstile } from '../../components/useTurnstile';
import { api, ensureFingerprint } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { queryKeys, useBadges, useMe } from '../../lib/queries';
import { epochMs } from '../../lib/time';
import { checkLimits } from '../../lib/upload/limits';
import { defaultPickerState, resolvePickers, type PickerContext, type PickerState } from '../../lib/upload/options';
import { fileKey, forgetUpload, listResumable, type ResumableUpload } from '../../lib/upload/resumeStore';
import { UploadAlbumResult, UploadAlbumToggle } from '../upload/UploadAlbumPanel';
import { UploadOptions } from '../upload/UploadOptions';
import { UploadRow } from '../upload/UploadRow';
import { useUploadAlbum } from '../upload/useUploadAlbum';
import { useUploadQueue } from '../upload/useUploadQueue';

/** PLAN.md Phase 3 "Upload": drop anywhere, paste or pick; chunked and resumable above 10 MiB. */
export default function UploadPage() {
  useEffect(() => {
    document.title = 'Upload · files.gg';
  }, []);

  // The dashboard layout waits for the session, so this is already known.
  const me = useMe();
  const anonymous = !me.data;
  const limits = useQuery({
    queryKey: [...queryKeys.myLimits, anonymous ? 'anonymous' : 'user'],
    queryFn: async ({ signal }) => {
      await ensureFingerprint();
      return api.myLimits(signal);
    },
  });

  // Milestone 4 §8.4, §11.2: a restricted account can't upload at all.
  const badges = useBadges(!anonymous);
  const restriction = useMemo(
    () => (badges.data?.restrictions ?? me.data?.restrictions ?? []).find((each) => each.kind === 'uploads' || each.kind === 'suspended') ?? null,
    [badges.data, me.data],
  );
  const restricted = restriction !== null;

  const context: PickerContext = useMemo(() => ({ anonymous, limits: limits.data ?? null }), [anonymous, limits.data]);
  const [pickers, setPickers] = useState<PickerState>(() => defaultPickerState({ anonymous: true }));
  const [touched, setTouched] = useState(false);
  // Defaults follow sign-in state and limits until the user changes something.
  const [defaultsFor, setDefaultsFor] = useState<PickerContext | null>(null);
  if (!touched && defaultsFor !== context) {
    setDefaultsFor(context);
    setPickers(defaultPickerState(context));
  }
  const { params, errors } = resolvePickers(pickers, context);
  const invalid = Object.keys(errors).length > 0;

  const { mount: turnstileMount, status: turnstileStatus, take: takeTurnstile, retry: retryTurnstile } = useTurnstile('upload', anonymous);
  const { items, add, remove, clearFinished } = useUploadQueue({
    getTurnstileToken: anonymous ? takeTurnstile : undefined,
  });
  const albums = useUploadAlbum(items, anonymous);
  const { track } = albums;

  const [resumable, setResumable] = useState<ResumableUpload[]>(() => listResumable());
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (restricted) {
        setNotice('Uploads are restricted on your account.');
        return;
      }
      if (invalid) {
        setNotice('Fix the upload options first.');
        return;
      }
      setNotice(null);
      const queued = items
        .filter((item) => !item.rejected && !['done', 'error', 'cancelled'].includes(item.snapshot.phase))
        .reduce((sum, item) => sum + item.file.size, 0);
      let pending = queued;
      const ids = add(files, params, (file) => {
        const problem = checkLimits(file.size, limits.data, pending);
        if (!problem) pending += file.size;
        return problem;
      });
      track(ids);
      const keys = new Set(files.map(fileKey));
      setResumable((list) => list.filter((entry) => !keys.has(entry.key)));
    },
    [add, invalid, items, limits.data, params, restricted, track],
  );

  // Drop anywhere on the page, and paste.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles(Array.from(event.dataTransfer?.files ?? []));
    };
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
    };
  }, [addFiles]);

  const done = items.filter((item) => item.snapshot.phase === 'done').length;
  const limitsLine = limits.data
    ? `Up to ${formatBytes(limits.data.max_file_size_chunked)} per file${
        limits.data.storage.limit !== null ? ` · ${formatBytes(limits.data.storage.used)} of ${formatBytes(limits.data.storage.limit)} used` : ''
      }`
    : null;

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Upload</h1>
        <p className="text-sm text-muted">
          {anonymous ? 'Uploading without an account.' : `Uploading as ${me.data?.display_name || me.data?.username || 'you'}.`}
          {limitsLine && ` ${limitsLine}.`}
          {limits.data?.premium && ' Premium limits.'}
        </p>
        {!anonymous && limits.data && (
          <p className="text-xs text-muted">
            ShareX and curl send each file in one request, up to {formatBytes(limits.data.max_file_size_single)}.{' '}
            <Link to="/integrations" className="text-gg hover:underline">
              Set up an upload key
            </Link>
          </p>
        )}
      </header>

      {restriction && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/50 bg-danger/10 px-4 py-3 text-sm">
          <Ban aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
          <div className="flex flex-col gap-1">
            <p className="font-semibold">
              {restriction.until !== null ? `Uploads are restricted until ${new Date(epochMs(restriction.until)).toLocaleDateString('en', { dateStyle: 'long' })}` : 'Uploads are restricted on your account'}
            </p>
            <p className="text-muted">
              Your files, albums and links still work.{' '}
              {restriction.notice_id && (
                <Link to={`/notices/${restriction.notice_id}`} className="font-medium text-gg hover:underline">
                  See why
                </Link>
              )}
            </p>
          </div>
        </div>
      )}

      <UploadOptions
        state={pickers}
        onChange={(patch) => {
          setTouched(true);
          setPickers((state) => ({ ...state, ...patch }));
        }}
        context={context}
        errors={errors}
      />

      <div
        aria-disabled={restricted || undefined}
        className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors ${
          dragging && !restricted ? 'border-gg bg-gg/5' : 'border-line'
        } ${restricted ? 'opacity-50' : ''}`}
      >
        <FileUp aria-hidden className="size-10 text-gg" strokeWidth={1.5} />
        <p className="text-sm">
          Drop files anywhere on this page, paste them, or{' '}
          <button type="button" className="font-medium text-gg hover:underline disabled:pointer-events-none" disabled={restricted} onClick={() => inputRef.current?.click()}>
            choose files
          </button>
          .
        </p>
        <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={invalid || restricted}>
          <Upload aria-hidden className="size-4" />
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={restricted}
          className="sr-only"
          aria-label="Choose files to upload"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        {anonymous && (
          <div className="flex flex-col items-center gap-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck aria-hidden className="size-3.5" /> Anonymous uploads are checked by Cloudflare Turnstile.
            </span>
            <div ref={turnstileMount} data-testid="turnstile" />
            {turnstileStatus === 'error' && (
              <button type="button" className="text-gg hover:underline" onClick={retryTurnstile}>
                The check couldn't load. Retry
              </button>
            )}
          </div>
        )}
        {notice && (
          <p className="text-sm text-danger" role="alert">
            {notice}
          </p>
        )}
      </div>

      {resumable.length > 0 && (
        <section aria-label="Interrupted uploads" className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn/5 p-3">
          <h2 className="text-sm font-semibold">Interrupted uploads</h2>
          <ul className="flex flex-col gap-2">
            {resumable.map((entry) => (
              <li key={entry.key} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  Re-select <strong>{entry.name}</strong> ({formatBytes(entry.size)}) to resume
                </span>
                <label className="inline-flex h-8 cursor-pointer items-center rounded-md bg-surface-2 px-3 text-sm font-medium hover:bg-line">
                  Re-select
                  <input
                    type="file"
                    className="sr-only"
                    aria-label={`Re-select ${entry.name}`}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      if (fileKey(file) !== entry.key) {
                        setNotice(`That's not ${entry.name}. Pick the same file to resume it.`);
                        return;
                      }
                      addFiles([file]);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="text-xs text-muted hover:text-text"
                  onClick={() => {
                    void api.abortUpload(entry.session.upload_id).catch(() => undefined);
                    forgetUpload(entry.key);
                    setResumable((list) => list.filter((other) => other.key !== entry.key));
                  }}
                >
                  Discard
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {albums.showToggle && (
        <UploadAlbumToggle
          enabled={albums.enabled}
          onEnabled={albums.setEnabled}
          title={albums.title}
          onTitle={albums.setTitle}
          blocked={albums.blocked}
          tooMany={albums.tooMany}
        />
      )}

      {albums.batches
        .filter((batch) => batch.step.status !== 'idle')
        .reverse()
        .map((batch) => (
          <UploadAlbumResult key={batch.key} batch={batch} anonymous={anonymous} onRetry={() => albums.retry(batch)} />
        ))}

      {items.length > 0 && (
        <section aria-label="Uploads" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold" aria-live="polite">
              {done > 0 ? `Uploaded ${done} ${done === 1 ? 'file' : 'files'}` : 'Uploads'}
            </h2>
            <button type="button" className="text-xs text-muted hover:text-text" onClick={clearFinished}>
              Clear finished
            </button>
          </div>
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <UploadRow key={item.id} item={item} onRemove={() => remove(item.id)} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
