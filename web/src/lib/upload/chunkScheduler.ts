/**
 * Chunk scheduling for resumable uploads (PLAN.md "Chunked, resumable uploads",
 * contract §6). Pure orchestration: the transport, the clock and the randomness
 * are injected, so it's fully unit-tested.
 *
 * - Chunks go in ascending index order, skipping ones the server already has.
 * - Up to `parallel` (3) are in flight at once.
 * - A failed chunk is retried with exponential backoff and jitter; errors the
 *   server marks as permanent (4xx other than 408/429) fail at once.
 * - `pause()` aborts in-flight chunks (they become pending again); `resume()` carries on.
 * - Progress is bytes the server has, plus bytes of in-flight chunks sent so far.
 */

export interface ChunkTransport {
  /** Sends chunk `index`. Calls `onProgress(sentBytes)` as it goes. Rejects on failure or abort. */
  put(index: number, signal: AbortSignal, onProgress: (sent: number) => void): Promise<void>;
}

export interface ChunkSchedulerOptions {
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  /** Indexes the server already has (resume). */
  received?: Iterable<number>;
  transport: ChunkTransport;
  parallel?: number;
  /** Attempts per chunk, including the first. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  onProgress?: (loaded: number, total: number) => void;
  /** Called after each chunk lands, with the full received set (persist it if you like). */
  onChunk?: (index: number, received: ReadonlySet<number>) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** A failure that retrying won't fix (wrong size, unknown session, forbidden…). */
export class PermanentChunkError extends Error {
  override readonly name = 'PermanentChunkError';
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Chunk upload failed permanently');
    this.cause = cause;
  }
}

export class PausedError extends Error {
  override readonly name = 'PausedError';
  constructor() {
    super('Upload paused');
  }
}

/** Retry everything except definite client errors (but do retry 408 and 429). */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PermanentChunkError) return false;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number' || status === 0) return true; // network
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/** 0-based attempt → delay: base × 2^attempt, capped, with ±50% jitter. */
export function backoffDelay(attempt: number, base = 500, max = 15_000, random: () => number = Math.random): number {
  const exponential = Math.min(max, base * 2 ** attempt);
  return Math.round(exponential * (0.5 + random()));
}

export const chunkLength = (index: number, chunkSize: number, fileSize: number): number =>
  Math.max(0, Math.min(chunkSize, fileSize - index * chunkSize));

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new PausedError());
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(new PausedError());
      },
      { once: true },
    );
  });

export class ChunkScheduler {
  private readonly options: Required<Omit<ChunkSchedulerOptions, 'received' | 'onProgress' | 'onChunk'>> &
    Pick<ChunkSchedulerOptions, 'onProgress' | 'onChunk'>;
  readonly received = new Set<number>();
  private inFlight = new Map<number, number>();
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(options: ChunkSchedulerOptions) {
    this.options = {
      parallel: 3,
      maxAttempts: 6,
      backoffBaseMs: 500,
      backoffMaxMs: 15_000,
      sleep: defaultSleep,
      random: Math.random,
      ...options,
    };
    for (const index of options.received ?? []) {
      if (index >= 0 && index < options.chunkCount) this.received.add(index);
    }
  }

  get done(): boolean {
    return this.received.size === this.options.chunkCount;
  }

  get paused(): boolean {
    return this.running === null && !this.done;
  }

  /** Indexes still to send, in order. */
  pending(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.options.chunkCount; i++) if (!this.received.has(i)) out.push(i);
    return out;
  }

  loaded(): number {
    const { chunkSize, fileSize } = this.options;
    let bytes = 0;
    for (const index of this.received) bytes += chunkLength(index, chunkSize, fileSize);
    for (const sent of this.inFlight.values()) bytes += sent;
    return Math.min(bytes, fileSize);
  }

  private report() {
    this.options.onProgress?.(this.loaded(), this.options.fileSize);
  }

  /** Uploads every missing chunk. Resolves when all are in; rejects with PausedError on pause. */
  start(): Promise<void> {
    if (this.running) return this.running;
    const controller = new AbortController();
    this.controller = controller;
    const queue = this.pending();
    const worker = async () => {
      for (;;) {
        if (controller.signal.aborted) throw new PausedError();
        const index = queue.shift();
        if (index === undefined) return;
        await this.sendWithRetry(index, controller.signal);
      }
    };
    const workers = Array.from({ length: Math.min(this.options.parallel, Math.max(1, queue.length)) }, worker);
    this.running = Promise.all(workers)
      .then(() => undefined)
      .catch((error: unknown) => {
        controller.abort();
        throw error;
      })
      .finally(() => {
        this.inFlight.clear();
        this.running = null;
        this.controller = null;
        this.report();
      });
    this.report();
    return this.running;
  }

  /** Aborts in-flight chunks; they'll be re-sent on resume. */
  pause(): void {
    this.controller?.abort();
  }

  private async sendWithRetry(index: number, signal: AbortSignal): Promise<void> {
    const { maxAttempts, transport, backoffBaseMs, backoffMaxMs, random, sleep } = this.options;
    for (let attempt = 0; ; attempt++) {
      this.inFlight.set(index, 0);
      try {
        await transport.put(index, signal, (sent) => {
          this.inFlight.set(index, sent);
          this.report();
        });
        this.inFlight.delete(index);
        this.received.add(index);
        this.options.onChunk?.(index, this.received);
        this.report();
        return;
      } catch (error) {
        this.inFlight.delete(index);
        this.report();
        if (signal.aborted) throw new PausedError();
        if (!isRetryable(error) || attempt + 1 >= maxAttempts) {
          throw error;
        }
        await sleep(backoffDelay(attempt, backoffBaseMs, backoffMaxMs, random), signal);
      }
    }
  }
}
