import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accessStorageKey } from '../../lib/access';
import { parseFileData } from '../boot';
import type { Content } from './content';
import { useAccessRefresh } from './useAccessRefresh';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const NOW = Date.UTC(2026, 10, 24, 12);
const s = (ms: number) => Math.floor(ms / 1000);

/** A payload as unlock / `/view` / refresh return it: URLs signed until `expires`. */
const payload = (expires: number) => ({
  kind: 'image',
  filename: 'holiday.png',
  visibility: 'password',
  cdn_url: `https://cdn.files.gg/files/abc.png?expires=${expires}&sig=s${expires}`,
  assets: { thumb: { url: `https://cdn.files.gg/previews/thumb/abc.webp?v=1&expires=${expires}&sig=t${expires}` } },
  uploaded_at: s(NOW) - 60,
  expires_at: null,
});

const content = (expires: number): Content => ({ kind: 'file', file: parseFileData(payload(expires))! });
const unlocked = (token: string, expires: number) => ({ grant: { token, expires_at: expires }, content: content(expires) });
const cdnUrl = (shown: Content) => (shown.kind === 'file' ? shown.file.cdn_url : '');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('useAccessRefresh', () => {
  it('refreshes 5 minutes before expiry, stores the new token, keeps the old URLs until 2 minutes before they expire', async () => {
    const fetch = vi.fn(async () => json({ token: 'second', expires_at: s(NOW) + 2 * 3600, file: payload(s(NOW) + 2 * 3600) }));
    vi.stubGlobal('fetch', fetch);
    const onExpired = vi.fn();
    const { result } = renderHook(() =>
      useAccessRefresh(unlocked('first', s(NOW) + 3600), { kind: 'file', vanity: 'abc', scope: 'unlock', onExpired }),
    );
    const first = result.current;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55 * 60_000 - 1);
    });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/files\/abc\/unlock\/refresh$/);
    expect(JSON.parse(String(init.body))).toEqual({ token: 'first' });
    expect(JSON.parse(localStorage.getItem(accessStorageKey('file', 'abc'))!).token).toBe('second');
    // Still the old payload, same object: a refresh never reloads an image or restarts a video...
    expect(result.current).toBe(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000 - 2000);
    });
    expect(cdnUrl(result.current)).toBe(`https://cdn.files.gg/files/abc.png?expires=${s(NOW) + 3600}&sig=s${s(NOW) + 3600}`);
    // ...until 2 minutes before the old URLs' `expires`; then the new payload's URLs, as they are.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(cdnUrl(result.current)).toBe(`https://cdn.files.gg/files/abc.png?expires=${s(NOW) + 7200}&sig=s${s(NOW) + 7200}`);
    expect(result.current.kind === 'file' && result.current.file.assets?.thumb?.url).toBe(
      `https://cdn.files.gg/previews/thumb/abc.webp?v=1&expires=${s(NOW) + 7200}&sig=t${s(NOW) + 7200}`,
    );
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('UNLOCK_EXPIRED on refresh clears the token and returns to the lock screen', async () => {
    localStorage.setItem(accessStorageKey('file', 'abc'), JSON.stringify({ token: 'first', expires_at: s(NOW) + 600 }));
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'UNLOCK_EXPIRED', message: 'x', status: 401 }, 401)));
    const onExpired = vi.fn();
    renderHook(() => useAccessRefresh(unlocked('first', s(NOW) + 600), { kind: 'file', vanity: 'abc', scope: 'unlock', onExpired }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(accessStorageKey('file', 'abc'))).toBeNull();
  });

  it('stops refreshing at the server cap and expires at the end', async () => {
    const fetch = vi.fn(async () => json({ token: 'capped', expires_at: s(NOW) + 600, file: payload(s(NOW) + 600) }));
    vi.stubGlobal('fetch', fetch);
    const onExpired = vi.fn();
    renderHook(() => useAccessRefresh(unlocked('first', s(NOW) + 600), { kind: 'file', vanity: 'abc', scope: 'unlock', onExpired }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9 * 60_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onExpired).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('retries a failed (network) refresh 30 s later', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(json({ token: 'second', expires_at: s(NOW) + 7200, file: payload(s(NOW) + 7200) }));
    vi.stubGlobal('fetch', fetch);
    renderHook(() => useAccessRefresh(unlocked('first', s(NOW) + 3600), { kind: 'file', vanity: 'abc', scope: 'unlock', onExpired: () => undefined }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55 * 60_000 + 1);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('owner passes refresh with the same timing but are never stored', async () => {
    const fetch = vi.fn(async () => json({ token: 'owner-2', expires_at: s(NOW) + 7200, file: payload(s(NOW) + 7200) }));
    vi.stubGlobal('fetch', fetch);
    renderHook(() =>
      useAccessRefresh(unlocked('owner', s(NOW) + 3600), { kind: 'file', vanity: 'abc', scope: 'owner', onExpired: () => undefined }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55 * 60_000 + 1);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toMatch(/\/files\/abc\/unlock\/refresh$/);
    expect(localStorage.getItem(accessStorageKey('file', 'abc'))).toBeNull();
  });

  it('a refresh carries the payload again: unsigned (public) URLs show at once, and a refresh without a payload keeps the content', async () => {
    const plain = { ...payload(0), visibility: 'link', cdn_url: 'https://cdn.files.gg/files/abc.png', assets: {} };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'second', expires_at: s(NOW) + 7200, file: { ...plain, filename: 'renamed.png' } }))
      .mockResolvedValueOnce(json({ token: 'third', expires_at: s(NOW) + 3 * 3600 }));
    vi.stubGlobal('fetch', fetch);
    const start = { grant: { token: 'first', expires_at: s(NOW) + 3600 }, content: { kind: 'file', file: parseFileData(plain)! } as Content };
    const { result } = renderHook(() => useAccessRefresh(start, { kind: 'file', vanity: 'abc', scope: 'unlock', onExpired: () => undefined }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55 * 60_000 + 1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.kind === 'file' && result.current.file.filename).toBe('renamed.png');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.kind === 'file' && result.current.file.filename).toBe('renamed.png');
  });

  it('an owner pass hitting UNLOCK_EXPIRED expires (the page then shows missing or the lock screen)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'UNLOCK_EXPIRED', message: 'x', status: 401 }, 401)));
    const onExpired = vi.fn();
    renderHook(() => useAccessRefresh(unlocked('owner', s(NOW) + 600), { kind: 'file', vanity: 'abc', scope: 'owner', onExpired }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });
});
