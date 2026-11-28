import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MSG_TOKEN } from '../../challenge/protocol';
import { installTurnstile } from '../../test/turnstile';
import { resetHostContext } from '../host/context';
import { enterCustomHost } from '../host/testing';
import { ViewerApp } from '../ViewerApp';
import LimitedPage from './LimitedPage';

/** Milestone 6 §19.4–§19.7: the `limited` state, Open file, `/open`, password files with a limit. */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const error = (code: string, status: number, extra: Record<string, unknown> = {}) => json({ code, message: code, status, ...extra }, status);
const inSeconds = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

const SIGNED = 'https://cdn.files.gg/files/abc.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8';
const payload = (remaining = 2, cdn = SIGNED) => ({
  kind: 'image',
  filename: 'holiday.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 9000,
  width: 800,
  height: 500,
  vanity: 'abc',
  cdn_url: cdn,
  url: 'https://files.gg/abc',
  uploaded_at: 0,
  expires_at: null,
  visibility: 'link',
  view_limit: { remaining },
});

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

let turnstile: ReturnType<typeof installTurnstile>;
beforeEach(() => {
  turnstile = installTurnstile();
});
afterEach(() => {
  delete window.turnstile;
  localStorage.clear();
  resetHostContext();
  document.title = '';
});

describe('the limited card', () => {
  it('says how many views are left, lazily from ViewerApp, with a generic title', async () => {
    mockFetch(() => json({}, 500));
    render(<ViewerApp state={{ page: 'limited', target: { vanity: 'abc', remaining: 3 } }} />);
    expect(await screen.findByRole('heading', { name: 'This file has a view limit.' })).toBeInTheDocument();
    expect(screen.getByText('Opening it uses one of its 3 remaining views.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open file' })).toBeEnabled();
    expect(document.title).toBe('View-limited file · files.gg');
    // Nothing is opened (or counted) before the click.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('words the last view and an unknown count', async () => {
    mockFetch(() => json({}, 500));
    const { unmount } = render(<LimitedPage vanity="abc" remaining={1} />);
    expect(screen.getByText('Opening it uses its last remaining view.')).toBeInTheDocument();
    unmount();
    render(<LimitedPage vanity="abc" remaining={null} />);
    expect(screen.getByText('Opening it uses one of its remaining views.')).toBeInTheDocument();
  });

  it('Open file runs Turnstile (action view), POSTs /access/open/files/<vanity>, then shows the file with its signed URLs and "N views left"', async () => {
    const fetch = mockFetch(() => json({ file: payload(2), expires_at: inSeconds(3600) }));
    render(<LimitedPage vanity="abc" remaining={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));

    const img = await screen.findByRole('img', { name: 'holiday.png' });
    expect(img).toHaveAttribute('src', SIGNED);
    expect(screen.getByText('2 views left')).toBeInTheDocument();
    expect(document.title).toBe('holiday.png · files.gg');

    expect(turnstile.api.render).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ action: 'view' }));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/access/open/files/abc');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(bodyOf(init)).toEqual({ turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
  });

  it('"No views left" when this viewer was the last one', async () => {
    mockFetch(() => json({ file: payload(0), expires_at: inSeconds(3600) }));
    render(<LimitedPage vanity="abc" remaining={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(await screen.findByText('No views left')).toBeInTheDocument();
  });

  it('CAPTCHA_INVALID keeps the card, with the message and Retry the check', async () => {
    const fetch = mockFetch(() => error('CAPTCHA_INVALID', 403));
    render(<LimitedPage vanity="abc" remaining={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't confirm you're a person. Try again.");
    expect(screen.getByRole('button', { name: 'Retry the check' })).toBeInTheDocument();

    fetch.mockImplementation(async () => json({ file: payload(2), expires_at: inSeconds(3600) }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry the check' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toBeInTheDocument();
  });

  it('a rate limit counts down and disables Open file', async () => {
    mockFetch(() => error('TOO_MANY_ATTEMPTS', 429, { retry_after: 42 }));
    render(<LimitedPage vanity="abc" remaining={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts\. Try again in 0:4\d\./);
    expect(screen.getByRole('button', { name: 'Open file' })).toBeDisabled();
  });

  it('a 404 is the normal missing state, never "view limit reached"', async () => {
    mockFetch(() => error('UNKNOWN_FILE', 404));
    render(<LimitedPage vanity="abc" remaining={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(await screen.findByRole('heading', { name: "This link isn't available." })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/limit/i);
  });

  it('UNLOCK_REQUIRED switches to the lock screen, which says unlocking uses a view; unlock then shows the file', async () => {
    const fetch = mockFetch((url) =>
      url.includes('/access/unlock/')
        ? json({ token: 'tok', expires_at: inSeconds(3600), file: { ...payload(1), visibility: 'password' } })
        : error('UNLOCK_REQUIRED', 401),
    );
    render(<LimitedPage vanity="abc" remaining={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(await screen.findByRole('heading', { name: 'This file is password protected' })).toBeInTheDocument();
    expect(screen.getByText('This file has a view limit. Unlocking it uses one of its 2 remaining views.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'files.gg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toBeInTheDocument();
    expect(screen.getByText('1 view left')).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/access/open/files/abc', '/api/access/unlock/files/abc']);
  });

  it('a #t= owner pass opens it with …/view, without the card or /open', async () => {
    const fetch = mockFetch((url) => (url.includes('/access/view/') ? json({ token: 'owner', expires_at: inSeconds(3600), file: payload(3) }) : json({}, 500)));
    render(<LimitedPage vanity="abc" remaining={3} ownerPass="owner" />);
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('/open'))).toBe(true);
  });

  it('refreshes through /open (a new Turnstile token) before the URLs expire, without counting again', async () => {
    const NEXT = 'https://cdn.files.gg/files/abc.png?expires=1895603600&sig=next';
    let opens = 0;
    const fetch = mockFetch(() => {
      opens++;
      // The first URLs last 2 s, so the refresh runs after about 1 s.
      return opens === 1 ? json({ file: payload(2), expires_at: inSeconds(2) }) : json({ file: payload(2, NEXT), expires_at: inSeconds(3600) });
    });
    render(<LimitedPage vanity="abc" remaining={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toHaveAttribute('src', SIGNED);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/access/open/files/abc');
    expect(bodyOf(init)).toEqual({ turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
    // The old URLs were about to expire, so the page moves to the new ones; no card in between.
    await waitFor(() => expect(screen.getByRole('img', { name: 'holiday.png' })).toHaveAttribute('src', NEXT));
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
  });
});

describe('a password file with a view limit', () => {
  it('shows the lock screen with a line saying unlocking uses a view, and the views left after', async () => {
    mockFetch((url) => (url.includes('/access/unlock/') ? json({ token: 'tok', expires_at: inSeconds(3600), file: { ...payload(3), visibility: 'password' } }) : json({}, 500)));
    render(
      <ViewerApp state={{ page: 'locked', target: { kind: 'file', vanity: 'abc', name: 'holiday.png', passwordExpired: false, viewLimit: { remaining: 4 } } }} />,
    );
    expect(await screen.findByText('This file has a view limit. Unlocking it uses one of its 4 remaining views.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'files.gg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('3 views left')).toBeInTheDocument();
  });

  it('a plain lock screen says nothing about views', async () => {
    mockFetch(() => json({}, 500));
    render(<ViewerApp state={{ page: 'locked', target: { kind: 'file', vanity: 'abc', passwordExpired: false } }} />);
    expect(await screen.findByRole('heading', { name: 'This file is password protected' })).toBeInTheDocument();
    expect(screen.queryByText(/view limit/)).toBeNull();
  });
});

describe('the limited card on a custom domain', () => {
  const frame = () => document.querySelector<HTMLIFrameElement>('iframe.challenge-frame');

  it('uses the files.gg challenge frame (action view) and api.files.gg without credentials, and rehosts the URLs', async () => {
    enterCustomHost();
    const fetch = mockFetch(() => json({ file: payload(4), expires_at: inSeconds(3600) }));
    render(<LimitedPage vanity="abc" remaining={5} />);
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(frame()).toHaveAttribute('src', 'https://files.gg/challenge?host=i.example.com&action=view');
    expect(window.turnstile?.render).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: MSG_TOKEN, token: 'frame-token' }, origin: 'https://files.gg', source: frame()!.contentWindow }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));

    const img = await screen.findByRole('img', { name: 'holiday.png' });
    expect(img).toHaveAttribute('src', SIGNED.replace('https://cdn.files.gg', 'https://i.example.com'));
    expect(screen.getByText('4 views left')).toBeInTheDocument();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.files.gg/access/open/files/abc');
    expect(init.credentials).toBe('omit');
    expect(bodyOf(init)).toEqual({ turnstile_token: 'frame-token' });
    expect(new Headers(init.headers).has('X-Filesgg-Csrf')).toBe(false);
  });
});
