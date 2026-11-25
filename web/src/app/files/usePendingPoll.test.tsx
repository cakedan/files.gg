import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerFile, OwnerSafety } from '../../lib/api';
import { jsonResponse } from '../../test/apiStub';
import { ownerFile } from '../../test/ownerFiles';
import { PENDING_POLL_CONCURRENCY, usePendingPoll } from './usePendingPoll';
import { signedInQueryClient } from '../../test/session';

const safety = (state: OwnerSafety['state']): OwnerSafety => ({ state, reason: null, notice_id: null, nsfw_source: null, nsfw_locked: false, nsfw_review: 'none' });
const pendingFile = (id: string): OwnerFile => ownerFile({ id, safety: safety('pending') });

/** A fetch whose responses are released by hand, counting requests in flight. */
function slowFetch() {
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = vi.fn((input: string | URL) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const id = String(input).split('/').pop()!;
    return new Promise<Response>((resolve) => {
      waiting.push(() => {
        inFlight--;
        resolve(jsonResponse(pendingFile(id)));
      });
    });
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    maxInFlight: () => maxInFlight,
    releaseAll: async () => {
      while (waiting.length) {
        await act(async () => {
          waiting.splice(0).forEach((release) => release());
          await vi.advanceTimersByTimeAsync(0);
        });
      }
    },
  };
}

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={signedInQueryClient()}>{children}</QueryClientProvider>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('usePendingPoll (milestone-4 §11.2)', () => {
  it('never starts a round while the last one is still running, and asks for at most four files at once', async () => {
    const stub = slowFetch();
    const files = Array.from({ length: 10 }, (_, index) => pendingFile(`p${index}`));
    renderHook(() => usePendingPoll(files, 1000), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(stub.fetch).toHaveBeenCalledTimes(PENDING_POLL_CONCURRENCY);
    // A slow server: several intervals pass, but no new round piles up.
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(stub.fetch).toHaveBeenCalledTimes(PENDING_POLL_CONCURRENCY);

    await stub.releaseAll();
    expect(stub.fetch).toHaveBeenCalledTimes(10);
    expect(stub.maxInFlight()).toBe(PENDING_POLL_CONCURRENCY);

    // The next round only after the interval, counted from the end of this one.
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(stub.fetch).toHaveBeenCalledTimes(10);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(stub.fetch).toHaveBeenCalledTimes(14);
  });

  it('stops polling files that left pending', async () => {
    const stub = slowFetch();
    const { rerender } = renderHook(({ files }) => usePendingPoll(files, 1000), { wrapper, initialProps: { files: [pendingFile('a'), pendingFile('b')] } });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await stub.releaseAll();
    rerender({ files: [pendingFile('a'), ownerFile({ id: 'b', safety: safety('ok') })] });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await stub.releaseAll();
    const asked = stub.fetch.mock.calls.map(([input]) => String(input).split('/').pop());
    expect(asked).toEqual(['a', 'b', 'a']);
  });
});
