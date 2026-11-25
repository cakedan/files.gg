import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accessStorageKey, saveAccess } from '../../lib/access';
import { installTurnstile } from '../../test/turnstile';
import LockedPage from './LockedPage';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const payload = {
  kind: 'image',
  filename: 'holiday.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 9000,
  width: 800,
  height: 500,
  cdn_url: 'https://cdn.files.gg/files/abc.png',
  url: 'https://files.gg/abc.png',
  uploaded_at: 0,
  expires_at: null,
  visibility: 'password',
};

const future = () => Math.floor(Date.now() / 1000) + 3600;

/** As the API signs it (milestone-3 §3); the page must use it exactly as it is. */
const SIGNED = 'https://cdn.files.gg/files/abc.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8';
const signedPayload = { ...payload, cdn_url: SIGNED };

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => installTurnstile());
afterEach(() => {
  localStorage.clear();
  delete window.turnstile;
});

describe('LockedPage', () => {
  it('shows the lock screen when there is no token', async () => {
    mockFetch(() => json({}, 500));
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    expect(await screen.findByRole('heading', { name: 'This file is password protected' })).toBeInTheDocument();
  });

  it('uses a stored unlock token with GET …/view (X-Filesgg-Access), and the payload\'s signed URLs as they are', async () => {
    saveAccess('file', 'abc', { token: 'stored', expires_at: future() });
    const fetch = mockFetch(() => json({ file: signedPayload, token: 'stored', expires_at: future() }));
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    const img = await screen.findByRole('img', { name: 'holiday.png' });
    expect(img).toHaveAttribute('src', SIGNED);
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `${SIGNED}&download=true`);
    expect(screen.getByRole('link', { name: 'Raw' })).toHaveAttribute('href', SIGNED);
    expect(document.body.innerHTML).not.toContain('t=stored');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/files\/abc\/view$/);
    expect((init.headers as Record<string, string>)['X-Filesgg-Access']).toBe('stored');
  });

  it('UNLOCK_EXPIRED drops the stored token and shows the lock screen', async () => {
    saveAccess('file', 'abc', { token: 'stale', expires_at: future() });
    mockFetch(() => json({ code: 'UNLOCK_EXPIRED', message: 'x', status: 401 }, 401));
    render(<LockedPage kind="file" vanity="abc" protection="password" />);
    expect(await screen.findByRole('heading', { name: 'This file is password protected' })).toBeInTheDocument();
    expect(localStorage.getItem(accessStorageKey('file', 'abc'))).toBeNull();
  });

  it('a #t= owner pass opens a private file without unlocking, and is not stored', async () => {
    const fetch = mockFetch((url) =>
      url.endsWith('/view') ? json({ file: { ...signedPayload, visibility: 'private' }, token: 'owner-token', expires_at: future() }) : json({}, 500),
    );
    render(<LockedPage kind="file" vanity="abc" protection="private" ownerPass="owner-token" />);
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toHaveAttribute('src', SIGNED);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/unlock'))).toBe(false);
    expect(localStorage.getItem(accessStorageKey('file', 'abc'))).toBeNull();
  });

  it('a bad owner pass on a private file shows "doesn\'t exist"', async () => {
    mockFetch(() => json({ code: 'UNKNOWN_FILE', message: 'x', status: 404 }, 404));
    render(<LockedPage kind="file" vanity="abc" protection="private" ownerPass="bad" />);
    expect(await screen.findByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
  });

  it('an unlock answering 404 (the owner\'s account is pending deletion) shows missing', async () => {
    mockFetch(() => json({ code: 'UNKNOWN_FILE', message: 'x', status: 404 }, 404));
    render(<LockedPage kind="file" vanity="abc" protection="password" password="files.gg" />);
    expect(await screen.findByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
    expect(localStorage.getItem(accessStorageKey('file', 'abc'))).toBeNull();
  });

  it('the password-expired shell shows the expired card', async () => {
    mockFetch(() => json({}, 500));
    render(<LockedPage kind="file" vanity="abc" protection="password" passwordExpired />);
    expect(await screen.findByRole('heading', { name: "This link's password has expired" })).toBeInTheDocument();
  });

  it('unlocking stores the token and renders the viewer; plain URLs stay plain', async () => {
    mockFetch((url) =>
      url.endsWith('/unlock') ? json({ token: 'fresh', expires_at: future(), file: { ...payload, visibility: 'link' } }) : json({}, 500),
    );
    render(<LockedPage kind="file" vanity="abc" protection="password" password="files.gg" />);
    const img = await screen.findByRole('img', { name: 'holiday.png' });
    expect(img).toHaveAttribute('src', 'https://cdn.files.gg/files/abc.png');
    await waitFor(() => expect(JSON.parse(localStorage.getItem(accessStorageKey('file', 'abc'))!).token).toBe('fresh'));
  });

  it('unlocks albums and uses their signed item and ZIP URLs as they are', async () => {
    const sig = 'expires=1796204800&sig=wGA5TVhWGADqYzNbG7Og11zjDW3n4A9cw5dKtfI4FFA';
    const zip = `https://cdn.files.gg/albums/download/alb.zip?${sig}`;
    const item = `https://cdn.files.gg/files/abc.png?album=alb&${sig}`;
    const album = { vanity: 'alb', title: 'Trip', layout: 'list', download_url: zip, items: [{ ...payload, cdn_url: item, position: 0, caption: '' }] };
    mockFetch((url) => (url.endsWith('/albums/alb/unlock') ? json({ token: 'tok', expires_at: future(), album }) : json({}, 500)));
    render(<LockedPage kind="album" vanity="alb" protection="password" password="files.gg" />);
    expect(await screen.findByRole('heading', { name: 'Trip' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download all/i })).toHaveAttribute('href', zip);
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toHaveAttribute('src', item);
  });

  it('when an owner pass expires: private shows missing, password shows the lock screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const soon = Math.floor(Date.now() / 1000) + 2;
      for (const [protection, heading] of [
        ['private', "This file doesn't exist or has expired."],
        ['password', 'This file is password protected'],
      ] as const) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string) =>
            String(url).endsWith('/view')
              ? json({ file: payload, token: 'owner', expires_at: soon })
              : json({ code: 'UNLOCK_EXPIRED', message: 'x', status: 401 }, 401),
          ),
        );
        const { unmount } = render(<LockedPage kind="file" vanity="abc" protection={protection} ownerPass="owner" />);
        await screen.findByRole('img', { name: 'holiday.png' });
        await vi.advanceTimersByTimeAsync(3000);
        expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
        unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
