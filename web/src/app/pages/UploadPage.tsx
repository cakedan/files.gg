import { useQuery } from '@tanstack/react-query';
import { FileUp, ShieldCheck, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { useTurnstile } from '../../components/useTurnstile';
import { api, ensureFingerprint, hasToken } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { queryKeys, useMe } from '../../lib/queries';
import { checkLimits } from '../../lib/upload/limits';
import { defaultPickerState, resolvePickers, type PickerContext, type PickerState } from '../../lib/upload/options';
import { fileKey, forgetUpload, listResumable, type ResumableUpload } from '../../lib/upload/resumeStore';
import { UploadOptions } from '../upload/UploadOptions';
import { UploadRow } from '../upload/UploadRow';
import { useUploadQueue } from '../upload/useUploadQueue';

/** PLAN.md Phase 3 "Upload": drop anywhere, paste or pick; chunked and resumable above 10 MiB. */
export default function UploadPage() {
  useEffect(() => {
    document.title = 'Upload · files.gg';
  }, []);

  const signedInToken = hasToken();
  const me = useMe(signedInToken);
  const anonymous = !signedInToken || me.isError;
  const limits = useQuery({
    queryKey: [...queryKeys.myLimits, anonymous ? 'anonymous' : 'user'],
    queryFn: async ({ signal }) => {
      await ensureFingerprint();
      return api.myLimits(signal);
    },
    enabled: !signedInToken || me.isFetched,
  });

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

  const [resumable, setResumable] = useState<ResumableUpload[]>(() => listResumable());
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (invalid) {
        setNotice('Fix the upload options first.');
        return;
      }
      setNotice(null);
      const queued = items
        .filter((item) => !item.rejected && !['done', 'error', 'cancelled'].includes(item.snapshot.phase))
        .reduce((sum, item) => sum + item.file.size, 0);
      let pending = queued;
      add(files, params, (file) => {
        const problem = checkLimits(file.size, limits.data, pending);
        if (!problem) pending += file.size;
        return problem;
      });
      const keys = new Set(files.map(fileKey));
      setResumable((list) => list.filter((entry) => !keys.has(entry.key)));
    },
    [add, invalid, items, limits.data, params],
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
        </p>
      </header>

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
        className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors ${
          dragging ? 'border-gg bg-gg/5' : 'border-line'
        }`}
      >
        <FileUp aria-hidden className="size-10 text-gg" strokeWidth={1.5} />
        <p className="text-sm">
          Drop files anywhere on this page, paste them, or{' '}
          <button type="button" className="font-medium text-gg hover:underline" onClick={() => inputRef.current?.click()}>
            choose files
          </button>
          .
        </p>
        <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={invalid}>
          <Upload aria-hidden className="size-4" />
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
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
