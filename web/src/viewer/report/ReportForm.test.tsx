import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTurnstile } from '../../test/turnstile';
import ReportDialog from './ReportDialog';
import { ReportForm } from './ReportForm';
import ReportPage from './ReportPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** What `GET /auth/session` answers (milestone-6 §3.4): signed out unless a test says otherwise. */
let session: unknown = { user: null };
const SIGNED_IN = { user: { id: '1', username: 'dan.w', display_name: null } };
const isSession = (url: unknown) => String(url).endsWith('/auth/session');

function mockFetch(...responses: Response[]) {
  const fn = vi.fn(async (url: string) => (isSession(url) ? json(session) : (responses.shift() ?? json({}, 500))));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The calls other than the session check. */
const calls = (fetch: ReturnType<typeof mockFetch>) => fetch.mock.calls.filter(([url]) => !isSession(url));

const sent = (fetch: ReturnType<typeof mockFetch>, n = 0) => {
  const [url, init] = calls(fetch)[n] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
};

/** Lets the session call answer. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const choose = (label: string) => fireEvent.click(screen.getByRole('radio', { name: label }));
const send = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
  });
};

beforeEach(() => {
  installTurnstile();
});

afterEach(() => {
  delete window.turnstile;
  session = { user: null };
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('ReportForm: signed out', () => {
  it('lists the file reasons, runs Turnstile (action report) and needs a reason', async () => {
    const fetch = mockFetch();
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    expect(screen.getByRole('heading', { name: 'Report this file' })).toBeInTheDocument();
    expect(screen.getByText('We review every report. Child-safety reports are prioritised.')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(9);
    expect(screen.queryByRole('radio', { name: 'A problem with files.gg' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.turnstile?.render).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ action: 'report', appearance: 'interaction-only' }),
      ),
    );
    await send();
    expect(screen.getByText('Choose a reason.')).toBeInTheDocument();
    // Only the session check (milestone-6 §13.1), asked when the form opened.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toMatch(/\/auth\/session$/);
    expect(calls(fetch)).toHaveLength(0);
  });

  it('sends POST /reports/anonymous with the Turnstile token, the fingerprint and the contact email', async () => {
    localStorage.setItem('filesgg.fingerprint', '42');
    const fetch = mockFetch(json({ id: '9', status: 'open' }, 201));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    choose('Spam');
    fireEvent.change(screen.getByLabelText(/your email/i), { target: { value: 'me@example.com' } });
    await send();
    expect(await screen.findByRole('heading', { name: 'Report sent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to hear back' })).toHaveAttribute('href', '/app');
    const request = sent(fetch);
    expect(request.url).toMatch(/\/reports\/anonymous$/);
    expect(request.headers['X-Fingerprint']).toBe('42');
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body).toEqual({
      target: { type: 'file', vanity: 'abc' },
      reason: 'spam',
      contact_email: 'me@example.com',
      turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX',
    });
  });

  it('requires details for "Something else" and shows the field error', async () => {
    mockFetch();
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    choose('Something else');
    expect(screen.getByLabelText('Details')).toHaveAttribute('aria-required', 'true');
    await send();
    expect(screen.getByText('Add some details.')).toBeInTheDocument();
    expect(screen.getByLabelText('Details')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Details')).toHaveFocus();
  });

  it('rejects a malformed contact email', async () => {
    mockFetch();
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    choose('Spam');
    fireEvent.change(screen.getByLabelText(/your email/i), { target: { value: 'not-an-email' } });
    await send();
    expect(screen.getByText("That email address doesn't look right.")).toBeInTheDocument();
  });

  it('shows only "Thank you. This has been escalated." for escalated reports', async () => {
    mockFetch(json({ id: '9', status: 'open', escalated: true }, 201));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    choose('Child sexual abuse material');
    expect(screen.getByText('If a child is in immediate danger, contact your local emergency services.')).toBeInTheDocument();
    await send();
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/^Thank you\. This has been escalated\.$/);
    expect(screen.queryByText('Report sent')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('offers to retry the check after CAPTCHA_INVALID', async () => {
    mockFetch(json({ code: 'CAPTCHA_INVALID', message: 'x', status: 400 }, 400));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    choose('Spam');
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't confirm you're a person. Try again.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry the check' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a session call that fails counts as signed out (anonymous, with Turnstile)', async () => {
    const fetch = vi.fn(async (url: string) =>
      isSession(url) ? json({ code: 'INTERNAL', message: 'x', status: 502 }, 502) : json({ id: '9', status: 'open' }, 201),
    );
    vi.stubGlobal('fetch', fetch);
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    choose('Spam');
    await send();
    expect(await screen.findByRole('heading', { name: 'Report sent' })).toBeInTheDocument();
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/reports\/anonymous$/);
    expect(JSON.parse(String(init.body)).turnstile_token).toBe('XXXX.DUMMY.TOKEN.XXXX');
  });

  it('says when Turnstile fails to load', async () => {
    delete window.turnstile;
    installTurnstile({ fail: true });
    mockFetch();
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    expect(await screen.findByText("The check didn't load. Retry it to send the report.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry the check' })).toBeInTheDocument();
  });
});

describe('ReportForm: signed in (the session call says so)', () => {
  beforeEach(() => {
    session = SIGNED_IN;
  });

  it('asks GET /auth/session when it opens, then sends POST /reports with no Turnstile and no email field', async () => {
    const fetch = mockFetch(json({ report: { id: '7', status: 'open', escalated: false } }, 201));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    await settle();
    expect(String(fetch.mock.calls[0]![0])).toMatch(/\/auth\/session$/);
    expect(screen.queryByLabelText(/your email/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('turnstile')).not.toBeInTheDocument();
    choose('Malware or phishing');
    await send();
    expect(await screen.findByRole('link', { name: 'See it in My reports' })).toHaveAttribute('href', '/app/reports');
    const request = sent(fetch);
    expect(request.url).toMatch(/\/reports$/);
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body).toEqual({ target: { type: 'file', vanity: 'abc' }, reason: 'malware' });
    expect(window.turnstile?.render).not.toHaveBeenCalled();
  });

  it('a send before the session call answers waits for it', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetch = vi.fn((url: string) =>
      isSession(url) ? new Promise<Response>((resolve) => (answer = resolve)) : Promise.resolve(json({ report: { id: '7', status: 'open' } }, 201)),
    );
    vi.stubGlobal('fetch', fetch);
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    choose('Spam');
    await send();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => answer(json(SIGNED_IN)));
    expect(await screen.findByRole('link', { name: 'See it in My reports' })).toBeInTheDocument();
    expect(String(fetch.mock.calls[1]![0])).toMatch(/\/reports$/);
    expect(window.turnstile?.render).not.toHaveBeenCalled();
  });

  it('notes a duplicate', async () => {
    mockFetch(json({ report: { id: '7', status: 'open' }, duplicate: true }));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    await settle();
    choose('Spam');
    await send();
    expect(await screen.findByText("You'd already reported this, so your details were added to that report.")).toBeInTheDocument();
  });

  it.each([
    [{ code: 'CANNOT_REPORT_YOURSELF', status: 400 }, "You can't report your own file or album."],
    [{ code: 'INVALID_REPORT_TARGET', status: 400 }, "That can't be reported. Check that the link is to a file or album on files.gg."],
    [{ code: 'MAX_REPORTS', status: 429, retry_after: 1800 }, "You've sent a lot of reports. Try again in 30 minutes."],
    [{ code: 'UNKNOWN_FILE', status: 404 }, "This file doesn't exist or has expired."],
  ])('shows the message for %o', async (body, message) => {
    mockFetch(json({ message: 'server text', ...body }, body.status));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    await settle();
    choose('Spam');
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    // The form stays, so the report can be fixed or sent again.
    expect(screen.getByRole('button', { name: 'Send report' })).toBeEnabled();
  });

  it('shows a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    choose('Spam');
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach files.gg. Check your connection and try again.");
  });

  it('maps DETAILS_REQUIRED onto the details field', async () => {
    mockFetch(json({ code: 'DETAILS_REQUIRED', message: 'x', status: 400, errors: { details: 'Say what happened.' } }, 400));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    await settle();
    choose('Spam');
    await send();
    expect(await screen.findByText('Say what happened.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Details/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('collects the DMCA notice for copyright and maps DMCA_FIELDS_REQUIRED per field', async () => {
    const fetch = mockFetch(json({ code: 'DMCA_FIELDS_REQUIRED', message: 'x', status: 400, errors: { phone: 'Enter a phone number we can call.' } }, 400));
    render(<ReportForm target={{ type: 'file', vanity: 'abc' }} />);
    await settle();
    choose('Copyright (DMCA)');
    const notice = screen.getByRole('group', { name: 'Copyright notice' });
    expect(within(notice).getByLabelText('Links on files.gg')).toHaveValue('https://files.gg/abc');
    await send();
    expect(screen.getByText('Enter your full name.')).toBeInTheDocument();
    expect(calls(fetch)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/^Details/), { target: { value: 'My photo' } });
    fireEvent.change(within(notice).getByLabelText('Your full name'), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(within(notice).getByLabelText('Your address'), { target: { value: '1 Road' } });
    fireEvent.change(within(notice).getByLabelText('Phone'), { target: { value: '555' } });
    fireEvent.change(within(notice).getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(within(notice).getByLabelText('The copyrighted work'), { target: { value: 'Photo of a cat' } });
    fireEvent.click(within(notice).getByRole('checkbox', { name: /good faith/ }));
    fireEvent.click(within(notice).getByRole('checkbox', { name: /penalty of perjury/ }));
    fireEvent.change(within(notice).getByLabelText('Signature'), { target: { value: 'Ada Lovelace' } });
    await send();
    expect(await screen.findByText('Enter a phone number we can call.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Fill in every part of the copyright notice.');
    expect(sent(fetch).body.dmca).toEqual({
      name: 'Ada Lovelace',
      address: '1 Road',
      phone: '555',
      email: 'ada@example.com',
      work: 'Photo of a cat',
      urls: ['https://files.gg/abc'],
      good_faith: true,
      accurate_and_authorised: true,
      signature: 'Ada Lovelace',
    });
  });

  it('asks which part of an album, and sends it', async () => {
    const fetch = mockFetch(json({ report: { id: '7', status: 'open' } }, 201));
    render(<ReportForm target={{ type: 'album', vanity: 'Ab3' }} />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Report this album' })).toBeInTheDocument();
    choose('Its captions');
    choose('Harassment or private information');
    await send();
    await screen.findByText('Report sent');
    expect(sent(fetch).body.target).toEqual({ type: 'album', vanity: 'Ab3', part: 'captions' });
  });
});

describe('ReportForm: the any page', () => {
  beforeEach(() => {
    session = SIGNED_IN;
  });

  it('asks for the link first, validates it, and offers bug reports without one', async () => {
    const fetch = mockFetch(json({ report: { id: '1', status: 'open' } }, 201), json({ report: { id: '2', status: 'open' } }, 201));
    render(<ReportForm target={{ type: 'any' }} />);
    await settle();
    const link = screen.getByLabelText('Link');
    expect(screen.getAllByRole('textbox')[0]).toBe(link);
    choose('Spam');
    await send();
    expect(screen.getByText('Enter the link to the file or album.')).toBeInTheDocument();
    fireEvent.change(link, { target: { value: 'https://example.com/x' } });
    await send();
    expect(screen.getByText('Enter a files.gg or cdn.files.gg link.')).toBeInTheDocument();
    fireEvent.change(link, { target: { value: 'https://cdn.files.gg/files/abc.png' } });
    await send();
    await screen.findByText('Report sent');
    expect(sent(fetch).body.target).toEqual({ type: 'url', url: 'https://cdn.files.gg/files/abc.png' });
  });

  it('shows the part picker for album links', () => {
    mockFetch();
    render(<ReportForm target={{ type: 'any' }} initialUrl="https://files.gg/a/Ab3" />);
    expect(screen.getByRole('group', { name: 'What should we look at?' })).toBeInTheDocument();
  });

  it('sends a bug report with no target', async () => {
    const fetch = mockFetch(json({ report: { id: '3', status: 'open' } }, 201));
    render(<ReportForm target={{ type: 'any' }} />);
    await settle();
    choose('A problem with files.gg');
    fireEvent.change(screen.getByLabelText(/^Details/), { target: { value: 'The upload button is stuck.' } });
    await send();
    await screen.findByText('Report sent');
    expect(sent(fetch).body).toEqual({ target: { type: 'bug' }, reason: 'bug', details: 'The upload button is stuck.' });
  });

  it('the full page prefills the link from ?url=', () => {
    window.history.replaceState(null, '', '/report?url=https%3A%2F%2Ffiles.gg%2Fabc');
    render(<ReportPage target={{ type: 'any' }} />);
    expect(screen.getByLabelText('Link')).toHaveValue('https://files.gg/abc');
  });
});

describe('ReportDialog', () => {
  it('is a modal dialog that closes with Escape, Cancel and the close button', () => {
    mockFetch();
    const onClose = vi.fn();
    render(<ReportDialog target={{ type: 'file', vanity: 'abc' }} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Report this file' })).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
