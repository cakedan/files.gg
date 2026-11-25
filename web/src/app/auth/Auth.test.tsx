import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browser, OAUTH_KEY, pkceChallenge } from '../../lib/discord';
import { calls, jsonResponse, ME, NO_BADGES, renderDashboard, signIn, stubApi } from '../../test/apiStub';
import { installTurnstile } from '../../test/turnstile';
import { forgetFragmentTokens } from './authUtils';
import { forgetDiscordQuery } from './discordCallback';

const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const ok = (user = ME) => ({ expires_at: 1800000000, user });
const shared = {
  'GET /auth/config': () => ({ discord: true }),
  'GET /users/@me/badges': () => NO_BADGES,
  'GET /users/@me/limits': () => ({ storage: { used: 0, limit: 1e10 }, max_file_size_single: 1, max_file_size_chunked: 1, max_expiry: null, allow_no_expiry: true, anonymous: false }),
  'GET /users/@me/files': () => ({ count: 0, items: [], size: 0, total: { count: 0, size: 0 } }),
  'GET /users/@me/warnings': () => ({ count: 0, unacknowledged: 0, items: [] }),
};

/** Puts a URL in the real address bar (fragments and the Discord query are read from it). */
const visit = (url: string) => window.history.replaceState(null, '', url);

beforeEach(() => {
  installTurnstile();
});

afterEach(() => {
  delete window.turnstile;
  localStorage.clear();
  sessionStorage.clear();
  forgetFragmentTokens();
  forgetDiscordQuery();
  visit('/');
});

describe('sign in (milestone-6 §4.1, §13.2)', () => {
  it('signs in by email with Turnstile and the CSRF header, claims this browser’s uploads, and goes to next', async () => {
    localStorage.setItem('filesgg.fingerprint', '777');
    let signedIn = false;
    const fetchMock = stubApi({
      ...shared,
      'GET /auth/session': () => ({ user: signedIn ? ME : null }),
      'POST /auth/login': () => {
        signedIn = true;
        return ok();
      },
    });
    const router = renderDashboard('/login?next=%2Fapp%2Ffiles');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Files you uploaded from this browser will move to your account.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' dan@example.com ' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/files'));
    const login = calls(fetchMock).find((call) => call.path === '/auth/login')!;
    expect(login.body).toEqual({ email: 'dan@example.com', password: 'hunter2hunter2', turnstile_token: TOKEN });
    expect(login.headers.get('X-Filesgg-Csrf')).toBe('1');
    expect(login.headers.get('X-Fingerprint')).toBe('777');
    expect(login.credentials).toBe('same-origin');
    expect(localStorage.getItem('filesgg.fingerprint')).toBeNull();
    expect(await screen.findByText('Signed in. Files you uploaded from this browser are now in your account.')).toBeInTheDocument();
  });

  it.each([
    [{ code: 'INVALID_CREDENTIALS', message: 'x', status: 400 }, 400, 'Wrong email or password.'],
    [{ code: 'TOO_MANY_ATTEMPTS', message: 'x', status: 429, retry_after: 600 }, 429, 'Too many attempts. Try again in 10 minutes.'],
    [{ code: 'CAPTCHA_INVALID', message: 'x', status: 403 }, 403, 'Couldn’t verify you’re human. Try again.'],
  ])('shows the contract copy for %o', async (body, status, text) => {
    stubApi({ ...shared, 'POST /auth/login': () => jsonResponse(body, status) });
    renderDashboard('/login');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'dan@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope-nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    // A fresh Turnstile token for the next try.
    expect(window.turnstile!.reset).toHaveBeenCalled();
  });

  it('ignores an unsafe next and sends a signed-in visitor to the dashboard', async () => {
    signIn();
    stubApi(shared);
    const router = renderDashboard('/login?next=%2F%2Fevil.example');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});

describe('create account (§4.3, §13.2)', () => {
  it('lowercases the username, checks it after 400 ms with the reason, and maps field errors', async () => {
    const fetchMock = stubApi({
      ...shared,
      'GET /users/@me/username/check': ({ url }) => ({ username: url.searchParams.get('username'), available: false, reason: 'taken' }),
      'POST /auth/register': () => jsonResponse({ code: 'INVALID_PARAMETERS', message: 'x', status: 400, errors: { email: 'An account already uses that email.' } }, 400),
    });
    renderDashboard('/register');
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'Dan.W' } });
    expect(screen.getByLabelText('Username')).toHaveValue('dan.w');
    expect(await screen.findByText('That username is taken.', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(calls(fetchMock).filter((call) => call.path === '/users/@me/username/check')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'dan-w' } });
    expect(screen.getByText('Use only letters, numbers, underscores and dots.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'danw' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dan@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    expect(screen.getByRole('meter', { name: 'Password strength' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path === '/auth/register')).toBe(false);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('An account already uses that email.')).toBeInTheDocument();
    const sent = calls(fetchMock).find((call) => call.path === '/auth/register')!;
    expect(sent.body).toMatchObject({ email: 'dan@example.com', username: 'danw', password: 'a-long-password', turnstile_token: TOKEN });
  });
});

describe('email links (§2.5, §4.4)', () => {
  it('verify reads #token= once, removes it from the address bar, and confirms', async () => {
    visit('/app/verify#token=abc123');
    const fetchMock = stubApi({ ...shared, 'POST /auth/verify': () => jsonResponse(null, 204) });
    renderDashboard('/verify');
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(calls(fetchMock).find((call) => call.path === '/auth/verify')!.body).toEqual({ token: 'abc123' });
  });

  it('an invalid link offers a new one when signed in', async () => {
    signIn({ ...ME, email_verified: false });
    visit('/app/verify#token=used');
    const fetchMock = stubApi({ ...shared, 'POST /auth/verify': () => jsonResponse({ code: 'INVALID_TOKEN', message: 'x', status: 400 }, 400), 'POST /auth/verify/resend': () => jsonResponse(null, 204) });
    renderDashboard('/verify');
    expect(await screen.findByRole('heading', { name: 'This link is invalid or has expired' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Send a new link' }));
    expect(await screen.findByText('Sent. Check your inbox.')).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path === '/auth/verify/resend')).toBe(true);
  });

  it('forgot always says the same thing', async () => {
    const fetchMock = stubApi({ ...shared, 'POST /auth/forgot': () => jsonResponse(null, 204) });
    renderDashboard('/forgot');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
    expect(await screen.findByText('If an account uses that email, we’ve sent a link. It works for 1 hour.')).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.path === '/auth/forgot')!.body).toEqual({ email: 'nobody@example.com', turnstile_token: TOKEN });
  });

  it('reset sets the password with Turnstile and signs in', async () => {
    visit('/app/reset#token=reset-token');
    let signedIn = false;
    const fetchMock = stubApi({
      ...shared,
      'GET /auth/session': () => ({ user: signedIn ? ME : null }),
      'POST /auth/forgot/reset': () => {
        signedIn = true;
        return ok();
      },
    });
    const router = renderDashboard('/reset');
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'brand-new-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls(fetchMock).find((call) => call.path === '/auth/forgot/reset')!.body).toEqual({ token: 'reset-token', password: 'brand-new-password', turnstile_token: TOKEN });
    expect(await screen.findByText('Your password was changed, and you’re signed in.')).toBeInTheDocument();
  });
});

describe('Discord (§5.2–§5.5)', () => {
  const store = (value: object) => sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ verifier: 'v'.repeat(43), state: 'st', purpose: 'login', next: null, ...value }));

  it('Continue with Discord sends a PKCE challenge, keeps the verifier and state, and redirects', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    const fetchMock = stubApi({ ...shared, 'POST /auth/discord/authorize': () => ({ url: 'https://discord.com/oauth2/authorize?x=1', state: 'signed-state' }) });
    renderDashboard('/login?next=%2Fapp%2Falbums');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Discord' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://discord.com/oauth2/authorize?x=1'));
    const stored = JSON.parse(sessionStorage.getItem(OAUTH_KEY)!);
    expect(stored).toMatchObject({ state: 'signed-state', purpose: 'login', next: '/albums' });
    const sent = calls(fetchMock).find((call) => call.path === '/auth/discord/authorize')!;
    expect(sent.body).toEqual({ purpose: 'login', code_challenge: await pkceChallenge(stored.verifier) });
    expect(sent.headers.get('X-Filesgg-Csrf')).toBe('1');
  });

  it('shows "or" only with the button: neither when Discord is off, on sign in and create account', async () => {
    stubApi({ ...shared, 'GET /auth/config': () => ({ discord: false }) });
    renderDashboard('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    await waitFor(() => expect(screen.queryByText('or')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Continue with Discord' })).not.toBeInTheDocument();

    stubApi(shared);
    renderDashboard('/register');
    await screen.findByRole('button', { name: 'Continue with Discord' });
    expect(screen.getByText('or')).toBeInTheDocument();
  });

  it('a state that doesn’t match sends nothing', async () => {
    store({ state: 'mine' });
    visit('/app/auth/discord?code=c&state=theirs');
    const fetchMock = stubApi(shared);
    renderDashboard('/auth/discord');
    expect(await screen.findByText('This sign-in link expired. Try again.')).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path.startsWith('/auth/discord'))).toBe(false);
    expect(window.location.search).toBe('');
  });

  it('a cancel says so', async () => {
    store({});
    visit('/app/auth/discord?error=access_denied&state=st');
    stubApi(shared);
    renderDashboard('/auth/discord');
    expect(await screen.findByText('Discord sign-in was cancelled.')).toBeInTheDocument();
  });

  it('retries once without prompt after another error', async () => {
    store({});
    visit('/app/auth/discord?error=interaction_required&state=st');
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    stubApi({ ...shared, 'POST /auth/discord/authorize': () => ({ url: 'https://discord.com/oauth2/authorize?state=s2&prompt=none', state: 's2' }) });
    renderDashboard('/auth/discord');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://discord.com/oauth2/authorize?state=s2'));
    expect(JSON.parse(sessionStorage.getItem(OAUTH_KEY)!)).toMatchObject({ state: 's2', retried: true });
  });

  it('signs up: the callback with code, state, verifier and Turnstile, then Choose your username', async () => {
    store({});
    visit('/app/auth/discord?code=the-code&state=st');
    let signedIn = false;
    const fetchMock = stubApi({
      ...shared,
      'GET /auth/session': () => ({ user: signedIn ? ME : null }),
      'GET /users/@me/username/check': () => ({ username: 'danw', available: true }),
      'POST /auth/discord/callback': () => ({
        status: 'signup_required',
        signup_token: 'sut',
        suggested_username: 'danw',
        discord: { id: '1', username: 'danw', display_name: 'Dan W', avatar_url: null },
        email: { address: 'dan@example.com', usable: true, reason: null },
      }),
      'POST /auth/discord/signup': () => {
        signedIn = true;
        return ok();
      },
    });
    const router = renderDashboard('/auth/discord');
    expect(await screen.findByRole('heading', { name: 'Choose your username' })).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.path === '/auth/discord/callback')!.body).toEqual({ code: 'the-code', state: 'st', code_verifier: 'v'.repeat(43), turnstile_token: TOKEN });
    expect(screen.getByLabelText('Username')).toHaveValue('danw');
    expect(screen.getByLabelText(/Display name/)).toHaveValue('Dan W');
    expect(screen.getByText('We’ll use dan@example.com from Discord.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls(fetchMock).find((call) => call.path === '/auth/discord/signup')!.body).toEqual({ signup_token: 'sut', username: 'danw', display_name: 'Dan W', turnstile_token: TOKEN });
    expect(sessionStorage.getItem(OAUTH_KEY)).toBeNull();
  });

  it('refuses a sign-up whose verified email belongs to an account, with Sign in', async () => {
    store({});
    visit('/app/auth/discord?code=c&state=st');
    stubApi({
      ...shared,
      'POST /auth/discord/callback': () => ({
        status: 'signup_required',
        signup_token: 'sut',
        suggested_username: 'danw',
        discord: { id: '1', username: 'danw', display_name: null, avatar_url: null },
        email: { address: 'dan@example.com', usable: false, reason: 'in_use' },
      }),
    });
    renderDashboard('/auth/discord');
    expect(await screen.findByText('An account already uses this email. Sign in with your password, then link Discord in Settings.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('linking returns to Security settings with a toast, and needs no Turnstile', async () => {
    signIn();
    store({ purpose: 'link', next: '/settings/security' });
    visit('/app/auth/discord?code=c&state=st');
    const fetchMock = stubApi({
      ...shared,
      'POST /auth/discord/callback': () => ({ status: 'linked', identity: { provider: 'discord', username: 'danw', display_name: null, avatar_url: null, created_at: 1, last_used_at: null } }),
      'GET /users/@me/sessions': () => ({ items: [] }),
    });
    const router = renderDashboard('/auth/discord');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/security'));
    expect(await screen.findByText('Discord is linked. You can sign in with it now.')).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.path === '/auth/discord/callback')!.body).not.toHaveProperty('turnstile_token');
    await act(async () => undefined);
  });
});
