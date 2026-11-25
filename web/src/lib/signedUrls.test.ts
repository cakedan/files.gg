import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { earliestUrlExpiry, signedUrlExpiry, unsignedKey, unsignedUrl, URL_SWAP_LEAD_MS, urlSwapDelay, useSignedValue } from './signedUrls';

const NOW = Date.UTC(2026, 10, 25, 12);
const s = (ms: number) => Math.floor(ms / 1000);
const signed = (path: string, expires: number, sig = `sig${expires}`) => `https://cdn.files.gg${path}?v=5&expires=${expires}&sig=${sig}`;

describe('reading signed URLs', () => {
  it('reads expires from a signed URL, null for plain ones', () => {
    expect(signedUrlExpiry('https://cdn.files.gg/files/abc.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8')).toBe(1795603600);
    expect(signedUrlExpiry('https://cdn.files.gg/files/abc.png?album=Ab3dE6gH&expires=1795603600&sig=x')).toBe(1795603600);
    expect(signedUrlExpiry('https://cdn.files.gg/previews/thumb/abc.webp?v=5')).toBeNull();
    expect(signedUrlExpiry('https://cdn.files.gg/files/abc.png?expires=1795603600')).toBeNull();
    expect(signedUrlExpiry('data:image/svg+xml,<svg/>')).toBeNull();
  });

  it('finds the earliest expiry anywhere in a payload', () => {
    const album = {
      download_url: signed('/albums/download/a.zip', 2000),
      items: [{ cdn_url: signed('/files/x.png', 3000), assets: { thumb: { url: signed('/previews/thumb/x.webp', 1500) } } }],
      url: 'https://files.gg/a/a',
    };
    expect(earliestUrlExpiry(album)).toBe(1500);
    expect(earliestUrlExpiry({ cdn_url: 'https://cdn.files.gg/files/x.png' })).toBeNull();
  });

  it('swaps 2 minutes before expiry', () => {
    expect(urlSwapDelay(s(NOW) + 600, NOW)).toBe(600_000 - URL_SWAP_LEAD_MS);
    expect(urlSwapDelay(s(NOW) + 60, NOW)).toBe(0);
    expect(urlSwapDelay(null, NOW)).toBe(0);
  });

  it('compares payloads without their signatures, never changing the URLs themselves', () => {
    const a = signed('/files/x.png', 1000, 'aaa');
    expect(unsignedUrl(a)).toBe('https://cdn.files.gg/files/x.png?v=5');
    expect(unsignedKey({ cdn_url: a })).toBe(unsignedKey({ cdn_url: signed('/files/x.png', 2000, 'bbb') }));
    expect(unsignedKey({ cdn_url: a })).not.toBe(unsignedKey({ cdn_url: signed('/files/y.png', 1000, 'aaa') }));
    expect(unsignedUrl('https://cdn.files.gg/files/x.png?download=true')).toBe('https://cdn.files.gg/files/x.png?download=true');
  });
});

describe('useSignedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const file = (expires: number, filename = 'x.png') => ({ filename, cdn_url: signed('/files/x.png', expires) });

  it('keeps the shown URLs until 2 minutes before they expire, then shows the newest', async () => {
    const first = file(s(NOW) + 3600);
    const { result, rerender } = renderHook(({ value }) => useSignedValue(value), { initialProps: { value: first } });
    const second = file(s(NOW) + 7200);
    rerender({ value: second });
    expect(result.current).toBe(first);
    const third = file(s(NOW) + 9000);
    rerender({ value: third });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(58 * 60_000 - 1);
    });
    expect(result.current).toBe(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toBe(third);
  });

  it('holds every change in the viewer mode, but shows real changes at once with showChangesAtOnce', async () => {
    const first = file(s(NOW) + 3600);
    const renamed = file(s(NOW) + 7200, 'y.png');
    const held = renderHook(({ value }) => useSignedValue(value), { initialProps: { value: first } });
    held.rerender({ value: renamed });
    expect(held.result.current).toBe(first);

    const eager = renderHook(({ value }) => useSignedValue(value, { showChangesAtOnce: true }), { initialProps: { value: first } });
    eager.rerender({ value: file(s(NOW) + 7200) });
    expect(eager.result.current).toBe(first);
    eager.rerender({ value: renamed });
    expect(eager.result.current).toBe(renamed);
  });

  it('never holds unsigned values or URLs that have already expired', async () => {
    const plain = { cdn_url: 'https://cdn.files.gg/files/x.png' };
    const { result, rerender } = renderHook(({ value }) => useSignedValue<object>(value), { initialProps: { value: plain as object } });
    const next = { cdn_url: 'https://cdn.files.gg/files/x.png', filename: 'x.png' };
    rerender({ value: next });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(next);

    const stale = file(s(NOW) - 10);
    const fresh = file(s(NOW) + 3600);
    const late = renderHook(({ value }) => useSignedValue(value), { initialProps: { value: stale } });
    late.rerender({ value: fresh });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(late.result.current).toBe(fresh);
  });
});
