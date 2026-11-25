import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import { saveAccess } from '../../lib/access';
import { installTurnstile } from '../../test/turnstile';
import LockedPage from './LockedPage';
import { classifyUnlockError } from './unlockErrors';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const future = () => Math.floor(Date.now() / 1000) + 3600;
const pending = () => json({ code: 'FILE_PENDING', message: 'x', status: 409, retry_after: 5 }, 409);
const image = {
  kind: 'image',
  filename: 'holiday.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 9000,
  width: 800,
  height: 500,
  cdn_url: 'https://cdn.files.gg/files/abc.png?expires=1&sig=x',
  uploaded_at: 0,
  expires_at: null,
};
type Call = [string, RequestInit];

beforeEach(() => installTurnstile());
afterEach(() => {
  localStorage.clear();
  delete window.turnstile;
});

describe('protected files that are pending or removed (milestone-4 §12)', () => {
  it('classifies FILE_PENDING, FILE_REMOVED and ALBUM_REMOVED', () => {
    expect(classifyUnlockError(new ApiError(409, 'FILE_PENDING', 'x', { retry_after: 5 }))).toEqual({ kind: 'pending' });
    expect(classifyUnlockError(new ApiError(410, 'FILE_REMOVED', 'x', { reason: 'copyright' }))).toEqual({ kind: 'removed', reason: 'copyright' });
    expect(classifyUnlockError(new ApiError(410, 'ALBUM_REMOVED', 'x', { reason: 'nonsense' }))).toEqual({ kind: 'removed', reason: 'terms' });
  });

  it('a stored token whose /view answers FILE_REMOVED shows the removed card and keeps the token', async () => {
    saveAccess('file', 'abc', { token: 'stored', expires_at: future() });
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'FILE_REMOVED', message: 'x', status: 410, reason: 'review' }, 410)));
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    expect(await screen.findByRole('heading', { name: "This file is unavailable while it's reviewed." })).toBeInTheDocument();
    expect(localStorage.getItem('filesgg.access.file.abc')).not.toBeNull();
  });

  it('an unlock answered with FILE_PENDING shows the checking card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'FILE_PENDING', message: 'x', status: 409, retry_after: 5 }, 409)));
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    fireEvent.change(await screen.findByLabelText('Password', { selector: 'input' }), { target: { value: 'files.gg' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    });
    expect(await screen.findByRole('heading', { name: 'Checking this file…' })).toBeInTheDocument();
  });

  it('an unlocked NSFW file still shows the interstitial first', async () => {
    saveAccess('file', 'abc', { token: 'stored', expires_at: future() });
    const file = {
      kind: 'image',
      filename: 'a.png',
      mimetype: 'image/png',
      extension: 'png',
      size: 1,
      cdn_url: 'https://cdn.files.gg/files/abc.png?expires=1&sig=x',
      uploaded_at: 0,
      expires_at: null,
      nsfw: true,
    };
    vi.stubGlobal('fetch', vi.fn(async () => json({ file, token: 'stored', expires_at: future() })));
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    expect(await screen.findByRole('heading', { name: 'This file may contain sensitive content' })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('the pending page reloads in the page, keeping #t= / #pw= secrets (milestone-4 §11.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, '', '/abc');
  });
  afterEach(() => vi.useRealTimers());

  it('asks /view again with the in-memory owner pass, and shows the file once it is checked', async () => {
    let views = 0;
    const fetch = vi.fn(async (url: string) => (String(url).endsWith('/view') && ++views > 1 ? json({ file: image, token: 'pass1', expires_at: future() }) : pending()));
    vi.stubGlobal('fetch', fetch);
    render(<LockedPage kind="file" vanity="abc" protection="private" ownerPass="pass1" />);
    expect(await screen.findByRole('heading', { name: 'Checking this file…' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toBeInTheDocument();
    const calls = fetch.mock.calls as unknown as Call[];
    expect(calls).toHaveLength(2);
    for (const [url, init] of calls) {
      expect(url).toMatch(/\/files\/abc\/view$/);
      expect((init.headers as Record<string, string>)['X-Filesgg-Access']).toBe('pass1');
    }
    // The schedule is still kept in history.state, as for a full reload.
    expect(window.history.state.filesggPending).toMatchObject({ reloads: 1, path: '/abc' });
  });

  it('keeps reloading in the page on the same schedule while it stays pending', async () => {
    const fetch = vi.fn(async () => pending());
    vi.stubGlobal('fetch', fetch);
    render(<LockedPage kind="file" vanity="abc" protection="private" ownerPass="pass1" />);
    expect(await screen.findByRole('heading', { name: 'Checking this file…' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { name: 'Checking this file…' })).toBeInTheDocument();
    expect(window.history.state.filesggPending).toMatchObject({ reloads: 2 });
  });

  it('unlocks again with the same password after a pending unlock', async () => {
    let unlocks = 0;
    const fetch = vi.fn(async (url: string) =>
      String(url).endsWith('/unlock') && ++unlocks > 1 ? json({ token: 'fresh', expires_at: future(), file: image }) : pending(),
    );
    vi.stubGlobal('fetch', fetch);
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    fireEvent.change(await screen.findByLabelText('Password', { selector: 'input' }), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    });
    expect(await screen.findByRole('heading', { name: 'Checking this file…' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toBeInTheDocument();
    const bodies = (fetch.mock.calls as unknown as Call[]).filter(([url]) => url.endsWith('/unlock')).map(([, init]) => JSON.parse(String(init.body)).password);
    expect(bodies).toEqual(['hunter2', 'hunter2']);
  });
});

describe('a stored unlock token survives transient errors', () => {
  it.each([
    ['a 503', () => json({ code: 'INTERNAL', message: 'x', status: 503 }, 503)],
    ['a 429', () => json({ code: 'TOO_MANY_REQUESTS', message: 'x', status: 429, retry_after: 5 }, 429)],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s shows the unavailable card and keeps the token', async (_name, respond) => {
    saveAccess('file', 'abc', { token: 'stored', expires_at: future() });
    vi.stubGlobal('fetch', vi.fn(async () => respond()));
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    expect(await screen.findByRole('heading', { name: 'files.gg is having trouble right now.' })).toBeInTheDocument();
    expect(localStorage.getItem('filesgg.access.file.abc')).not.toBeNull();
  });

  it('a 404 (gone, or its owner\'s account pending deletion) drops it and shows missing, not the lock screen', async () => {
    saveAccess('file', 'abc', { token: 'stored', expires_at: future() });
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'UNKNOWN_FILE', message: 'x', status: 404 }, 404)));
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    // milestone-6 §8.8: content of an account pending deletion is missing, never "removed".
    expect(await screen.findByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'This file is password protected' })).not.toBeInTheDocument();
    expect(localStorage.getItem('filesgg.access.file.abc')).toBeNull();
  });

  it('an album answering 404 UNKNOWN_ALBUM is missing too', async () => {
    saveAccess('album', 'Ab3', { token: 'stored', expires_at: future() });
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'UNKNOWN_ALBUM', message: 'x', status: 404 }, 404)));
    render(<LockedPage kind="album" vanity="Ab3" protection="password" />);
    expect(await screen.findByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
    expect(localStorage.getItem('filesgg.access.album.Ab3')).toBeNull();
  });

  it('Retry on the unavailable card asks again in the page, with the owner pass', async () => {
    let views = 0;
    const fetch = vi.fn(async () => (++views > 1 ? json({ file: image, token: 'pass1', expires_at: future() }) : json({ code: 'INTERNAL', message: 'x', status: 502 }, 502)));
    vi.stubGlobal('fetch', fetch);
    render(<LockedPage kind="file" vanity="abc" protection="private" ownerPass="pass1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
