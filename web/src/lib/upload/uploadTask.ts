/**
 * One file's upload (contract §6): a single `POST /files` for small files, a chunked
 * session (`POST /uploads` → chunks → `complete` → poll) above CHUNKED_THRESHOLD.
 * Chunked uploads pause, resume, and survive a reload through resumeStore.
 */

import { api as defaultApi, ApiError, type UploadedFile, type UploadParams, type UploadSession, type UploadStatus } from '../api';
import { ChunkScheduler, chunkLength, PausedError } from './chunkScheduler';
import { findResumable, fileKey, forgetUpload, rememberUpload } from './resumeStore';
import { sendXhr } from './xhr';

/** Files above this go through a chunked session (the contract's 10 MiB chunk size). */
export const CHUNKED_THRESHOLD = 10 * 1024 * 1024;

export type UploadPhase = 'queued' | 'verifying' | 'uploading' | 'paused' | 'processing' | 'done' | 'error' | 'cancelled';

export interface UploadSnapshot {
  phase: UploadPhase;
  loaded: number;
  total: number;
  chunked: boolean;
  /** Set while resuming an earlier session. */
  resumed: boolean;
  result?: UploadedFile;
  error?: unknown;
}

type UploadApi = Pick<typeof defaultApi, 'createUpload' | 'uploadStatus' | 'completeUpload' | 'abortUpload'>;

export interface UploadDeps {
  /** Anonymous uploads: a fresh Turnstile token (action `upload`) per request. */
  getTurnstileToken?: (() => Promise<string>) | undefined;
  api?: UploadApi;
  send?: typeof sendXhr;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  parallel?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function formFields(params: UploadParams): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false) continue;
    out.push([key, String(value)]);
  }
  return out;
}

export class UploadTask {
  readonly file: File;
  readonly params: UploadParams;
  readonly chunked: boolean;
  private readonly deps: Required<Omit<UploadDeps, 'getTurnstileToken'>> & Pick<UploadDeps, 'getTurnstileToken'>;
  private readonly listener: (snapshot: UploadSnapshot) => void;
  private snapshot: UploadSnapshot;
  private controller: AbortController | null = null;
  private scheduler: ChunkScheduler | null = null;
  private session: UploadSession | null = null;

  constructor(file: File, params: UploadParams, deps: UploadDeps, listener: (snapshot: UploadSnapshot) => void) {
    this.file = file;
    this.params = params;
    this.chunked = file.size > CHUNKED_THRESHOLD;
    this.deps = {
      api: defaultApi,
      send: sendXhr,
      pollIntervalMs: 1000,
      sleep: wait,
      parallel: 3,
      ...deps,
    };
    this.listener = listener;
    this.snapshot = { phase: 'queued', loaded: 0, total: file.size, chunked: this.chunked, resumed: false };
  }

  get state(): UploadSnapshot {
    return this.snapshot;
  }

  private set(patch: Partial<UploadSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listener(this.snapshot);
  }

  /** Starts (or, after an error, restarts) the upload. */
  start(): Promise<void> {
    if (this.snapshot.phase === 'uploading' || this.snapshot.phase === 'verifying' || this.snapshot.phase === 'processing') {
      return Promise.resolve();
    }
    this.controller = new AbortController();
    this.set({ phase: 'verifying', error: undefined });
    const run = this.chunked ? this.runChunked() : this.runSingle();
    return run.catch((error: unknown) => {
      if (this.snapshot.phase === 'cancelled') {
        // Cancelled on purpose.
      } else if (error instanceof PausedError) {
        this.set({ phase: 'paused' });
      } else {
        this.set({ phase: 'error', error });
      }
    });
  }

  /** Chunked only: aborts in-flight chunks; `resume()` continues from what the server has. */
  pause(): void {
    if (!this.chunked || this.snapshot.phase !== 'uploading') return;
    this.scheduler?.pause();
  }

  resume(): Promise<void> {
    if (this.snapshot.phase !== 'paused' && this.snapshot.phase !== 'error') return Promise.resolve();
    return this.start();
  }

  /** Stops the upload and, for chunked ones, deletes the session to free the reserved quota. */
  cancel(): void {
    const phase = this.snapshot.phase;
    if (phase === 'done' || phase === 'cancelled') return;
    this.set({ phase: 'cancelled' });
    this.controller?.abort();
    this.scheduler?.pause();
    if (this.session) {
      void this.deps.api.abortUpload(this.session.upload_id).catch(() => undefined);
      forgetUpload(fileKey(this.file));
    }
  }

  private async turnstile(): Promise<string | undefined> {
    return this.deps.getTurnstileToken ? this.deps.getTurnstileToken() : undefined;
  }

  // ---- Single request -------------------------------------------------------

  private async runSingle(): Promise<void> {
    const token = await this.turnstile();
    const body = new FormData();
    for (const [key, value] of formFields({ ...this.params, turnstile_token: token })) body.append(key, value);
    body.append('file', this.file, this.file.name);
    this.set({ phase: 'uploading', loaded: 0 });
    const result = await this.deps.send<UploadedFile>({
      method: 'POST',
      path: '/files',
      body,
      signal: this.controller?.signal,
      onUploadProgress: (sent, total) => this.set({ loaded: Math.min(this.file.size, total ? (sent / total) * this.file.size : sent) }),
    });
    this.set({ phase: 'done', loaded: this.file.size, result });
  }

  // ---- Chunked ----------------------------------------------------------------

  /** Reuses a remembered session when the server still has it. */
  private async resumeSession(): Promise<{ session: UploadSession; status: UploadStatus } | null> {
    const remembered = findResumable(this.file);
    if (!remembered) return null;
    try {
      const status = await this.deps.api.uploadStatus(remembered.session.upload_id);
      if (status.status === 'failed') {
        forgetUpload(remembered.key);
        return null;
      }
      return { session: remembered.session, status };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        forgetUpload(remembered.key);
        return null;
      }
      throw error;
    }
  }

  private async runChunked(): Promise<void> {
    let received: number[] = [];
    if (!this.session) {
      const resumed = await this.resumeSession();
      if (resumed) {
        this.session = resumed.session;
        this.set({ resumed: true });
        if (resumed.status.status === 'complete' && resumed.status.file) return this.finish(resumed.status.file);
        if (resumed.status.status === 'processing') return this.poll();
        received = resumed.status.received;
      } else {
        const token = await this.turnstile();
        this.session = await this.deps.api.createUpload({
          ...this.params,
          filename: this.file.name,
          size: this.file.size,
          ...(token ? { turnstile_token: token } : {}),
        });
        rememberUpload(this.file, this.session);
      }
    } else {
      // Resume after pause/error: ask the server what it has.
      try {
        const status = await this.deps.api.uploadStatus(this.session.upload_id);
        if (status.status === 'complete' && status.file) return this.finish(status.file);
        if (status.status === 'processing') return this.poll();
        received = status.received;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          forgetUpload(fileKey(this.file));
          this.session = null;
        }
        throw error;
      }
    }

    const session = this.session;
    const known = this.scheduler ? [...this.scheduler.received, ...received] : received;
    this.scheduler = new ChunkScheduler({
      fileSize: this.file.size,
      chunkSize: session.chunk_size,
      chunkCount: session.chunk_count,
      received: known,
      parallel: this.deps.parallel,
      transport: {
        put: (index, signal, onProgress) => {
          const start = index * session.chunk_size;
          const blob = this.file.slice(start, start + chunkLength(index, session.chunk_size, this.file.size));
          return this.deps.send<void>({
            method: 'PUT',
            path: `/uploads/${encodeURIComponent(session.upload_id)}/chunks/${index}`,
            body: blob,
            headers: { 'Content-Type': 'application/octet-stream' },
            signal,
            onUploadProgress: (sent) => onProgress(sent),
          });
        },
      },
      onProgress: (loaded) => this.set({ loaded }),
    });
    this.set({ phase: 'uploading', loaded: this.scheduler.loaded() });
    await this.scheduler.start();
    if (this.snapshot.phase === 'cancelled') return;
    await this.deps.api.completeUpload(session.upload_id);
    await this.poll();
  }

  private async poll(): Promise<void> {
    const session = this.session!;
    this.set({ phase: 'processing', loaded: this.file.size });
    for (let attempt = 0; ; attempt++) {
      if (this.snapshot.phase === 'cancelled') return;
      const status = await this.deps.api.uploadStatus(session.upload_id);
      if (status.status === 'complete' && status.file) return this.finish(status.file);
      if (status.status === 'failed') {
        forgetUpload(fileKey(this.file));
        const code = status.error ?? 'UPLOAD_FAILED';
        throw new ApiError(500, code, code, { code });
      }
      await this.deps.sleep(Math.min(this.deps.pollIntervalMs * 1.5 ** Math.min(attempt, 4), 5000));
    }
  }

  private finish(file: UploadedFile): void {
    forgetUpload(fileKey(this.file));
    this.set({ phase: 'done', loaded: this.file.size, result: file });
  }
}
