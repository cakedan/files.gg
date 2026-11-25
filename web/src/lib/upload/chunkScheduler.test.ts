import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api';
import { backoffDelay, ChunkScheduler, chunkLength, isRetryable, PausedError, type ChunkTransport } from './chunkScheduler';

const MB = 1024 * 1024;

/** A transport whose calls resolve or reject only when the test says so. */
function controllableTransport() {
  const calls: Array<{ index: number; signal: AbortSignal; resolve: () => void; reject: (e: unknown) => void; progress: (n: number) => void }> = [];
  const transport: ChunkTransport = {
    put: (index, signal, progress) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ index, signal, resolve, reject, progress });
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  };
  return { transport, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const noSleep = () => Promise.resolve();

describe('ChunkScheduler', () => {
  it('sends missing chunks in ascending order, 3 at a time', async () => {
    const { transport, calls } = controllableTransport();
    const scheduler = new ChunkScheduler({ fileSize: 55 * MB, chunkSize: 10 * MB, chunkCount: 6, transport, sleep: noSleep });
    const done = scheduler.start();
    await flush();
    expect(calls.map((c) => c.index)).toEqual([0, 1, 2]);
    calls[1]!.resolve();
    await flush();
    expect(calls.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    for (const call of [...calls]) call.resolve();
    await flush();
    calls.slice(4).forEach((c) => c.resolve());
    await done;
    expect(scheduler.done).toBe(true);
    expect(new Set(calls.map((c) => c.index))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it('never has more than `parallel` chunks in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const transport: ChunkTransport = {
      put: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    };
    await new ChunkScheduler({ fileSize: 100, chunkSize: 10, chunkCount: 10, transport, parallel: 3 }).start();
    expect(peak).toBe(3);
  });

  it('skips chunks the server already has (resume)', async () => {
    const sent: number[] = [];
    const transport: ChunkTransport = { put: async (index) => void sent.push(index) };
    const scheduler = new ChunkScheduler({ fileSize: 50, chunkSize: 10, chunkCount: 5, received: [0, 2, 9], transport });
    expect(scheduler.pending()).toEqual([1, 3, 4]);
    expect(scheduler.loaded()).toBe(20);
    await scheduler.start();
    expect(sent.sort()).toEqual([1, 3, 4]);
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    let failures = 2;
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const transport: ChunkTransport = {
      put: async () => {
        if (failures-- > 0) throw new ApiError(503, null, 'busy');
      },
    };
    const scheduler = new ChunkScheduler({ fileSize: 10, chunkSize: 10, chunkCount: 1, transport, sleep, random: () => 0.5 });
    await scheduler.start();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
    expect(scheduler.done).toBe(true);
  });

  it('gives up after maxAttempts', async () => {
    const transport: ChunkTransport = { put: async () => Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'offline')) };
    const scheduler = new ChunkScheduler({ fileSize: 10, chunkSize: 10, chunkCount: 1, transport, sleep: noSleep, maxAttempts: 3 });
    await expect(scheduler.start()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('fails at once on permanent errors (wrong chunk size)', async () => {
    const put = vi.fn(async () => Promise.reject(new ApiError(400, 'CHUNK_SIZE_MISMATCH', 'nope')));
    const scheduler = new ChunkScheduler({ fileSize: 10, chunkSize: 10, chunkCount: 1, transport: { put }, sleep: noSleep });
    await expect(scheduler.start()).rejects.toMatchObject({ code: 'CHUNK_SIZE_MISMATCH' });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('pause aborts in-flight chunks; resume re-sends only those still missing', async () => {
    const { transport, calls } = controllableTransport();
    const scheduler = new ChunkScheduler({ fileSize: 50, chunkSize: 10, chunkCount: 5, transport, sleep: noSleep });
    const first = scheduler.start();
    await flush();
    calls[0]!.resolve();
    await flush();
    scheduler.pause();
    await expect(first).rejects.toBeInstanceOf(PausedError);
    expect([...scheduler.received]).toEqual([0]);
    expect(calls.slice(1).every((c) => c.signal.aborted)).toBe(true);

    calls.length = 0;
    const second = scheduler.start();
    await flush();
    expect(calls.map((c) => c.index)).toEqual([1, 2, 3]);
    calls.forEach((c) => c.resolve());
    await flush();
    calls.slice(3).forEach((c) => c.resolve());
    await second;
    expect(scheduler.done).toBe(true);
  });

  it('reports progress from received bytes plus in-flight bytes', async () => {
    const { transport, calls } = controllableTransport();
    const onProgress = vi.fn();
    const scheduler = new ChunkScheduler({ fileSize: 25, chunkSize: 10, chunkCount: 3, transport, onProgress, sleep: noSleep });
    const done = scheduler.start();
    await flush();
    calls[0]!.progress(4);
    expect(onProgress).toHaveBeenLastCalledWith(4, 25);
    calls[0]!.resolve();
    await flush();
    expect(scheduler.loaded()).toBe(10);
    calls.slice(1).forEach((c) => c.resolve());
    await done;
    expect(onProgress).toHaveBeenLastCalledWith(25, 25);
  });
});

describe('helpers', () => {
  it('computes chunk lengths, including the short last chunk', () => {
    expect(chunkLength(0, 10, 25)).toBe(10);
    expect(chunkLength(2, 10, 25)).toBe(5);
    expect(chunkLength(3, 10, 25)).toBe(0);
  });

  it('backs off exponentially with jitter, capped', () => {
    expect(backoffDelay(0, 500, 15_000, () => 0.5)).toBe(500);
    expect(backoffDelay(3, 500, 15_000, () => 0.5)).toBe(4000);
    expect(backoffDelay(10, 500, 15_000, () => 0.5)).toBe(15_000);
    expect(backoffDelay(0, 500, 15_000, () => 0)).toBe(250);
  });

  it('retries network, 408, 429 and 5xx, never other 4xx', () => {
    expect(isRetryable(new ApiError(0, 'NETWORK_ERROR', ''))).toBe(true);
    expect(isRetryable(new ApiError(429, null, ''))).toBe(true);
    expect(isRetryable(new ApiError(502, null, ''))).toBe(true);
    expect(isRetryable(new ApiError(404, 'UNKNOWN_UPLOAD', ''))).toBe(false);
    expect(isRetryable(new TypeError('x'))).toBe(true);
  });
});
