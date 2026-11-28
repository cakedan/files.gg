import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MSG_ERROR, MSG_TOKEN } from '../challenge/protocol';
import { accessStorageKey } from '../lib/access';
import { installTurnstile } from '../test/turnstile';
import { resetHostContext } from './host/context';
import { enterCustomHost } from './host/testing';
import { ViewerApp } from './ViewerApp';

/**
 * The custom-domain viewer end to end (milestone-6 §10.9–§10.11, §13.4): the shell says
 * `data-host="custom"`, API calls go to api.files.gg without credentials, Turnstile
 * comes from the files.gg/challenge frame, URLs are rehosted.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const future = () => Math.floor(Date.now() / 1000) + 3600;

const SIGNED_PATH = '/files/abc.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8';
const payload = {
  kind: 'image',
  filename: 'holiday.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 9000,
  width: 800,
  height: 500,
  vanity: 'abc',
  cdn_url: `https://cdn.files.gg${SIGNED_PATH}`,
  url: 'https://files.gg/abc',
  uploaded_at: 0,
  expires_at: null,
  visibility: 'password',
};

type Handler = (url: string, init: RequestInit) => Response;
function mockFetch(handler: Handler) {
  const fn = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const frame = () => document.querySelector<HTMLIFrameElement>('iframe.challenge-frame');

/** What files.gg/challenge posts once Turnstile passes (or fails) in the frame. */
async function frameSays(data: unknown) {
  await waitFor(() => expect(frame()).not.toBeNull());
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: 'https://files.gg', source: frame()!.contentWindow }));
  });
}

beforeEach(() => {
  enterCustomHost();
  // Present but never used on a custom host: its hostname isn't in the widget's list.
  installTurnstile();
});

afterEach(() => {
  resetHostContext();
  delete window.turnstile;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('custom host: protected files', () => {
  it('unlocks through the challenge frame and api.files.gg without credentials, and shows rehosted, still-signed URLs', async () => {
    const fetch = mockFetch((url) => (url.includes('/access/unlock/') ? json({ token: 'fresh', expires_at: future(), file: payload }) : json({}, 500)));
    render(<ViewerApp state={{ page: 'locked', target: { kind: 'file', vanity: 'abc', passwordExpired: false } }} />);
    expect(await screen.findByRole('heading', { name: 'This file is password protected' })).toBeInTheDocument();
    expect(document.title).toBe('Password-protected file · i.example.com');
    expect(frame()).toHaveAttribute('src', 'https://files.gg/challenge?host=i.example.com&action=unlock');
    expect(window.turnstile?.render).not.toHaveBeenCalled();

    await frameSays({ type: MSG_TOKEN, token: 'XXXX.DUMMY.TOKEN.XXXX' });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'files.gg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    const img = await screen.findByRole('img', { name: 'holiday.png' });
    expect(img).toHaveAttribute('src', `https://i.example.com${SIGNED_PATH}`);
    expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute('href', `https://i.example.com${SIGNED_PATH}`);
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `https://i.example.com${SIGNED_PATH}&download=true`);
    expect(document.title).toBe('holiday.png · i.example.com');

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.files.gg/access/unlock/files/abc');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toEqual({ password: 'files.gg', turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
    // Kept in this domain's own storage (unlocking on files.gg doesn't unlock here, and back).
    expect(localStorage.getItem(accessStorageKey('file', 'abc'))).toContain('fresh');
  });

  it('an owner pass (#t=) on a private file is redeemed at api.files.gg …/view', async () => {
    window.history.replaceState(null, '', '/abc');
    const fetch = mockFetch(() => json({ token: 'pass', expires_at: future(), file: { ...payload, visibility: 'private' } }));
    render(<ViewerApp state={{ page: 'missing' }} secrets={{ ownerPass: 'pass', rest: '' }} />);
    expect(await screen.findByRole('img', { name: 'holiday.png' })).toHaveAttribute('src', `https://i.example.com${SIGNED_PATH}`);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.files.gg/access/view/files/abc');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ Accept: 'application/json', 'X-Filesgg-Access': 'pass' });
    // Owner passes are never stored.
    expect(localStorage.getItem(accessStorageKey('file', 'abc'))).toBeNull();
  });

  it('when the frame fails, offers "Open on files.gg to continue" instead of hanging', async () => {
    const fetch = mockFetch(() => json({}, 500));
    render(<ViewerApp state={{ page: 'locked', target: { kind: 'file', vanity: 'abc', passwordExpired: false } }} />);
    await screen.findByRole('heading', { name: 'This file is password protected' });
    await frameSays({ type: MSG_ERROR, code: '110200' });
    expect(screen.getByRole('link', { name: 'Open on files.gg to continue' })).toHaveAttribute('href', 'https://files.gg/abc');
    expect(screen.getByRole('button', { name: 'Retry the check' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'files.gg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("The human check couldn't load.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a 404 from unlock (the owner\'s account is pending deletion) shows missing, never removed', async () => {
    mockFetch(() => json({ code: 'UNKNOWN_FILE', message: 'Unknown file.', status: 404 }, 404));
    render(<ViewerApp state={{ page: 'locked', target: { kind: 'file', vanity: 'abc', passwordExpired: false } }} />);
    await screen.findByRole('heading', { name: 'This file is password protected' });
    await frameSays({ type: MSG_TOKEN, token: 'XXXX.DUMMY.TOKEN.XXXX' });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'files.gg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
    expect(screen.queryByText(/removed/i)).not.toBeInTheDocument();
    // "Go to files.gg" goes to files.gg, not to this domain's /.
    expect(screen.getByRole('link', { name: 'Go to files.gg' })).toHaveAttribute('href', 'https://files.gg/');
  });
});

describe('custom host: public files', () => {
  it('Copy link uses this domain; no sign-in or dashboard links', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <ViewerApp
        state={{
          page: 'file',
          file: { ...payload, visibility: 'link', cdn_url: 'https://i.example.com/files/abc.png', url: 'https://files.gg/abc', kind: 'image', uploaded_at: 0, expires_at: null } as never,
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://i.example.com/abc'));
    expect(document.querySelector('a[href^="/app"]')).toBeNull();
    expect(document.title).toBe('holiday.png · i.example.com');
  });
});

describe('custom host: reports', () => {
  it('the domain landing card: "Files hosted with files.gg" and Report, which reports the domain anonymously', async () => {
    const fetch = mockFetch(() => json({ id: '9', status: 'open' }, 201));
    render(<ViewerApp state={{ page: 'domain-home' }} />);
    expect(await screen.findByRole('heading', { name: 'Files hosted with files.gg' })).toBeInTheDocument();
    expect(screen.getByText('i.example.com')).toBeInTheDocument();
    expect(document.title).toBe('i.example.com');
    expect(document.querySelector('a[href^="/app"]')).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report this domain' });
    expect(within(dialog).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
      'Malware or phishing',
      'Spam',
      'Harassment or private information',
      'Something else',
    ]);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Spam' }));
    await frameSays({ type: MSG_TOKEN, token: 'XXXX.DUMMY.TOKEN.XXXX' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    });
    expect(await within(dialog).findByRole('heading', { name: 'Report sent' })).toBeInTheDocument();
    // Never signed in here: no "My reports" or "Sign in" links.
    expect(within(dialog).queryByRole('link')).toBeNull();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.files.gg/reports/anonymous');
    expect(init.credentials).toBe('omit');
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(['Accept', 'Content-Type']);
    expect(JSON.parse(String(init.body))).toEqual({
      target: { type: 'domain', hostname: 'i.example.com' },
      reason: 'spam',
      turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX',
    });
  });

  it('a file report never asks for the session, and falls back to files.gg\'s report page if the frame fails', async () => {
    localStorage.setItem('filesgg.guest', '42');
    const fetch = mockFetch(() => json({ id: '9', status: 'open' }, 201));
    render(<ViewerApp state={{ page: 'report', target: { type: 'file', vanity: 'abc' } }} />);
    expect(await screen.findByRole('heading', { name: 'Report this file' })).toBeInTheDocument();
    expect(screen.getByText(/i\.example\.com\//)).toHaveTextContent('i.example.com/abc');
    await frameSays({ type: MSG_ERROR, code: 'load-failed' });
    expect(screen.getByRole('link', { name: 'Open on files.gg to continue' })).toHaveAttribute('href', 'https://files.gg/report/abc');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the any page accepts this domain\'s links', async () => {
    const fetch = mockFetch(() => json({ id: '9', status: 'open' }, 201));
    render(<ViewerApp state={{ page: 'report', target: { type: 'any' } }} />);
    const link = await screen.findByLabelText('Link');
    expect(link).toHaveAttribute('placeholder', 'https://i.example.com/…');
    fireEvent.change(link, { target: { value: 'https://evil.example/abc' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Spam' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    });
    expect(screen.getByText('Enter a link on i.example.com, files.gg or cdn.files.gg.')).toBeInTheDocument();
    fireEvent.change(link, { target: { value: 'https://i.example.com/abc' } });
    await frameSays({ type: MSG_TOKEN, token: 'XXXX.DUMMY.TOKEN.XXXX' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    });
    await screen.findByRole('heading', { name: 'Report sent' });
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).target).toEqual({ type: 'url', url: 'https://i.example.com/abc' });
  });
});
