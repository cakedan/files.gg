import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTurnstile } from '../../test/turnstile';
import { LockScreen } from './LockScreen';
import { classifyUnlockError, formatCountdown, unlockErrorMessage } from './unlockErrors';
import { ApiError } from '../../lib/api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockFetch(...responses: Response[]) {
  const fn = vi.fn(async () => responses.shift() ?? json({}, 500));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  installTurnstile();
});

afterEach(() => {
  delete window.turnstile;
});

async function submit(password: string) {
  fireEvent.change(screen.getByLabelText('Password', { selector: 'input' }), { target: { value: password } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  });
}

describe('LockScreen', () => {
  it('shows the lock card, the name only when provided, a show toggle and Turnstile', async () => {
    render(<LockScreen kind="file" vanity="abc" name="holiday.png" onUnlocked={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'This file is password protected' })).toBeInTheDocument();
    expect(screen.getByText('holiday.png')).toBeInTheDocument();
    const input = screen.getByLabelText('Password', { selector: 'input' });
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    await waitFor(() =>
      expect(window.turnstile?.render).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ action: 'unlock', appearance: 'interaction-only', sitekey: '1x00000000000000000000AA' }),
      ),
    );
  });

  it('sends the password with a Turnstile token and reports success', async () => {
    const fetch = mockFetch(json({ token: 'tok', expires_at: 2e9, file: { filename: 'a.png', cdnUrl: 'https://cdn/a.png' } }));
    const onUnlocked = vi.fn();
    render(<LockScreen kind="file" vanity="abc" onUnlocked={onUnlocked} />);
    await submit('files.gg');
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok' })));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/files\/abc\/unlock$/);
    expect(JSON.parse(String(init.body))).toEqual({ password: 'files.gg', turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
  });

  it('WRONG_PASSWORD clears the field and says so', async () => {
    mockFetch(json({ code: 'WRONG_PASSWORD', message: 'x', status: 401 }, 401));
    render(<LockScreen kind="file" vanity="abc" onUnlocked={() => undefined} />);
    await submit('nope123');
    expect(await screen.findByRole('alert')).toHaveTextContent("That password isn't right.");
    expect(screen.getByLabelText('Password', { selector: 'input' })).toHaveValue('');
  });

  it('TOO_MANY_ATTEMPTS shows a countdown and disables Unlock until it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch(json({ code: 'TOO_MANY_ATTEMPTS', message: 'x', status: 429, retry_after: 42 }, 429));
      render(<LockScreen kind="file" vanity="abc" onUnlocked={() => undefined} />);
      await submit('guess123');
      expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 0:42.');
      fireEvent.change(screen.getByLabelText('Password', { selector: 'input' }), { target: { value: 'again123' } });
      expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(43_000);
      });
      expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('PASSWORD_EXPIRED replaces the form with the expired card', async () => {
    mockFetch(json({ code: 'PASSWORD_EXPIRED', message: 'x', status: 410 }, 410));
    render(<LockScreen kind="file" vanity="abc" onUnlocked={() => undefined} />);
    await submit('files.gg');
    expect(await screen.findByRole('heading', { name: "This link's password has expired" })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password', { selector: 'input' })).not.toBeInTheDocument();
  });

  it('CAPTCHA_INVALID offers a retry of the check', async () => {
    mockFetch(json({ code: 'CAPTCHA_INVALID', message: 'x', status: 403 }, 403));
    render(<LockScreen kind="album" vanity="abc" onUnlocked={() => undefined} />);
    await submit('files.gg');
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't confirm you're a person.");
    const renders = vi.mocked(window.turnstile!.render).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /retry the check/i }));
    await waitFor(() => expect(vi.mocked(window.turnstile!.render).mock.calls.length).toBe(renders + 1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a #pw= password unlocks automatically once Turnstile passes', async () => {
    const fetch = mockFetch(json({ token: 'tok', expires_at: 2e9, file: {} }));
    const onUnlocked = vi.fn();
    render(<LockScreen kind="file" vanity="abc" initialPassword="from-link" onUnlocked={onUnlocked} />);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).password).toBe('from-link');
  });

  it('a failed #pw= password says the link password did not work', async () => {
    mockFetch(json({ code: 'WRONG_PASSWORD', message: 'x', status: 401 }, 401));
    render(<LockScreen kind="file" vanity="abc" initialPassword="stale" onUnlocked={() => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("The password in this link didn't work.");
  });
});

describe('unlock errors', () => {
  it('classifies contract §5 codes', () => {
    const now = 1000;
    expect(classifyUnlockError(new ApiError(429, 'TOO_MANY_ATTEMPTS', '', { retry_after: 30 }), now)).toEqual({ kind: 'rate-limited', retryAt: 31_000 });
    expect(classifyUnlockError(new ApiError(401, 'WRONG_PASSWORD', ''))).toEqual({ kind: 'wrong' });
    expect(classifyUnlockError(new ApiError(410, 'PASSWORD_EXPIRED', ''))).toEqual({ kind: 'expired' });
    expect(classifyUnlockError(new ApiError(403, 'CAPTCHA_INVALID', ''))).toEqual({ kind: 'captcha' });
    expect(classifyUnlockError(new ApiError(0, 'NETWORK_ERROR', ''))).toEqual({ kind: 'network' });
    expect(classifyUnlockError(new Error('turnstile-load-failed'))).toEqual({ kind: 'verification' });
  });

  it('formats the countdown and never hints at closeness', () => {
    expect(formatCountdown(42_000)).toBe('0:42');
    expect(formatCountdown(125_400)).toBe('2:06');
    expect(unlockErrorMessage({ kind: 'rate-limited', retryAt: 61_000 }, 1000)).toBe('Too many attempts. Try again in 1:00.');
    expect(unlockErrorMessage({ kind: 'rate-limited', retryAt: 0 }, 1000)).toBe('You can try again now.');
  });
});
