import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { User } from '../../lib/api';
import { calls, jsonResponse, ME, NO_BADGES, renderDashboard, signIn, stubApi, type StubHandler } from '../../test/apiStub';

const NOW = Math.floor(Date.now() / 1000);
const EMPTY_FILES = { count: 0, items: [], size: 0, total: { count: 0, size: 0 } };

function setup(user: User | null, routes: Record<string, StubHandler> = {}) {
  let current = user;
  if (user) signIn(user);
  const fetchMock = stubApi({
    'GET /auth/session': () => ({ user: current }),
    'GET /users/@me/badges': () => NO_BADGES,
    'GET /users/@me/files': () => EMPTY_FILES,
    'GET /users/@me/limits': () => ({ storage: { used: 0, limit: 1e10 }, max_file_size_single: 1, max_file_size_chunked: 1, max_expiry: null, allow_no_expiry: true, anonymous: false }),
    'GET /users/@me/exports': () => ({ items: [] }),
    'POST /auth/logout': () => jsonResponse(null, 204),
    ...routes,
  });
  return { fetchMock, setUser: (next: User | null) => (current = next) };
}

afterEach(() => localStorage.clear());

describe('session in the dashboard (milestone-6 §13.1, §13.3)', () => {
  it('a 401 on a signed-in call signs the tab out, with "You were signed out." and Sign in', async () => {
    const { setUser } = setup(ME, { 'GET /users/@me/files': () => jsonResponse({ code: 'UNAUTHORIZED', message: 'x', status: 401 }, 401) });
    setUser(ME);
    renderDashboard('/files');
    // The session query is reset; the next answer says nobody is signed in.
    setUser(null);
    expect(await screen.findByText('You were signed out.')).toBeInTheDocument();
    const toast = screen.getByText('You were signed out.').closest('div')!;
    expect(within(toast).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Fapp%2Ffiles');
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Create account' }).length).toBeGreaterThan(0));
  });

  it('shows the account in the sidebar footer, and Sign out posts logout and goes to the dashboard signed out', async () => {
    const { fetchMock, setUser } = setup(ME);
    const router = renderDashboard('/files');
    const nav = await screen.findAllByRole('link', { name: /Mock User\s*@mockuser/ });
    expect(nav[0]).toHaveAttribute('href', '/settings');
    fireEvent.click(screen.getAllByRole('button', { name: 'Account menu' })[0]!);
    setUser(null);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls(fetchMock).find((call) => call.path === '/auth/logout')!.headers.get('X-Filesgg-Csrf')).toBe('1');
    expect(await screen.findByText('You’re signed out.')).toBeInTheDocument();
  });

  it('ACCOUNT_PENDING_DELETION from any call refetches the session and shows Keep my account', async () => {
    const pending = { ...ME, deletion: { requested_at: NOW, scheduled_for: NOW + 14 * 86400 } };
    const { setUser } = setup(ME, { 'GET /users/@me/files': () => jsonResponse({ code: 'ACCOUNT_PENDING_DELETION', message: 'x', status: 403, scheduled_for: NOW + 14 * 86400 }, 403) });
    renderDashboard('/files');
    setUser(pending);
    expect(await screen.findByRole('button', { name: 'Keep my account' })).toBeInTheDocument();
  });
});

describe('Keep my account (§8.8, §13.3)', () => {
  it('a pending-deletion account sees only the card on every route, with Download my data and Sign out', async () => {
    const pending = { ...ME, deletion: { requested_at: NOW - 5 * 86400, scheduled_for: NOW + 9 * 86400 } };
    const { fetchMock } = setup(pending);
    renderDashboard('/integrations');
    expect(await screen.findByRole('heading', { level: 1, name: /Your account will be deleted on/ })).toBeInTheDocument();
    expect(screen.getByText(/your upload keys and custom domains don’t work/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Integrations' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
    expect(await screen.findByRole('button', { name: 'Request export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path === '/users/@me/upload-keys')).toBe(false);
  });
});

describe('account prompts (§13.3)', () => {
  it('asks for a new username after a staff reset, and can’t be dismissed', async () => {
    const { fetchMock, setUser } = setup({ ...ME, username: 'u42', needs_username: true }, {
      'GET /users/@me/username/check': () => ({ username: 'fresh', available: true }),
      'PUT /users/@me/username': ({ body }) => {
        const next = { ...ME, username: body.username, needs_username: false };
        setUser(next);
        return next;
      },
    });
    renderDashboard('/files');
    const dialog = await screen.findByRole('dialog', { name: 'Choose a new username' });
    expect(dialog).toHaveTextContent('Your username was reset by files.gg staff. Choose a new one.');
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Choose a new username' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'Fresh' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save username' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose a new username' })).not.toBeInTheDocument());
    expect(calls(fetchMock).find((call) => call.method === 'PUT')!.body).toEqual({ username: 'fresh' });
  });

  it('asks to verify an unverified email, with Resend, and to add one when there is none', async () => {
    const { fetchMock } = setup({ ...ME, email_verified: false }, { 'POST /auth/verify/resend': () => jsonResponse(null, 204) });
    renderDashboard('/files');
    expect(await screen.findByText('Verify your email to recover your account and add domains.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resend' }));
    expect(await screen.findByText('Sent. Check your inbox.')).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path === '/auth/verify/resend')).toBe(true);
  });

  it('offers to add an email to a Discord-only account', async () => {
    setup({ ...ME, email: null, email_verified: false, has_password: false });
    renderDashboard('/files');
    expect(await screen.findByText('Add an email so you can recover your account.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add an email' })).toHaveAttribute('href', '/settings/security');
  });

  it('Overview shows Premium with its expiry and the premium limits', async () => {
    const expires = NOW + 30 * 86400;
    setup({ ...ME, premium: { active: true, expires_at: expires } }, {
      'GET /users/@me/limits': () => ({ storage: { used: 0, limit: 100_000_000_000 }, max_file_size_single: 99_000_000, max_file_size_chunked: 5_000_000_000, max_expiry: null, allow_no_expiry: true, anonymous: false, premium: true }),
    });
    renderDashboard('/');
    expect(await screen.findByText(/^Premium until /)).toBeInTheDocument();
    expect(await screen.findByText(/of 100 GB used/)).toBeInTheDocument();
    expect(screen.getByText(/Files up to 5 GB on the website, 99 MB from ShareX or curl\./)).toBeInTheDocument();
  });
});
