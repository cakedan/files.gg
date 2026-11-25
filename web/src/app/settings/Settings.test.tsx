import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { User } from '../../lib/api';
import { calls, jsonResponse, ME, NO_BADGES, renderDashboard, signIn, stubApi, type StubHandler } from '../../test/apiStub';

const NOW = Math.floor(Date.now() / 1000);
const DISCORD = { provider: 'discord' as const, username: 'danw', display_name: 'Dan W', avatar_url: 'https://cdn.discordapp.com/avatars/1/a.webp?size=64', created_at: NOW - 86400, last_used_at: null };
const SESSIONS = [
  { id: 's1', current: true, method: 'password', created_at: NOW - 3600, last_used_at: NOW - 60, expires_at: NOW + 86400, device: 'Firefox on macOS', country: 'GB' },
  { id: 's2', current: false, method: 'discord', created_at: NOW - 86400, last_used_at: NOW - 7200, expires_at: NOW + 86400, device: 'Chrome on Android', country: 'US' },
];
const reauthRequired = (methods = ['password']) => jsonResponse({ code: 'REAUTH_REQUIRED', message: 'x', status: 403, methods }, 403);

function setup(user: User, routes: Record<string, StubHandler> = {}) {
  let current = user;
  signIn(user);
  const fetchMock = stubApi({
    'GET /auth/session': () => ({ user: current }),
    'GET /auth/config': () => ({ discord: true }),
    'GET /users/@me/badges': () => ({ ...NO_BADGES, restrictions: current.restrictions }),
    'GET /users/@me/sessions': () => ({ items: SESSIONS }),
    'GET /users/@me/exports': () => ({ items: [] }),
    ...routes,
  });
  return { fetchMock, setUser: (next: User) => (current = next) };
}

afterEach(() => localStorage.clear());

describe('Settings → Profile (milestone-6 §2.2, §8.1)', () => {
  it('shows the 30-day rename hold, and saves a display name with the initials preview', async () => {
    const at = NOW + 20 * 86400;
    const { fetchMock } = setup({ ...ME, username_changed_at: NOW - 10 * 86400, username_change_available_at: at }, {
      'PATCH /users/@me': ({ body }) => ({ ...ME, display_name: body.display_name }),
    });
    renderDashboard('/settings');
    expect(await screen.findByLabelText('Username')).toBeDisabled();
    const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(new Date(at * 1000).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }).format(new Date(at * 1000));
    expect(screen.getByText(`You can change it again on ${day}.`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: '  Zed  ' } });
    expect(within(screen.getByRole('region', { name: 'Profile' })).getByTestId('avatar')).toHaveTextContent('Z');
    fireEvent.click(screen.getByRole('button', { name: 'Save display name' }));
    expect(await screen.findByText('Display name saved.')).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.method === 'PATCH')!.body).toEqual({ display_name: 'Zed' });
  });
});

describe('Settings → Uploads (milestone-5 §21)', () => {
  const USER_LIMITS = { storage: { used: 0, limit: 1e10 }, max_file_size_single: 1e8, max_file_size_chunked: 1e9, max_expiry: null, allow_no_expiry: true, anonymous: false, nsfw_allowed: true };

  it('shows the saved defaults, and saves the changed ones', async () => {
    const saved = { expires_in: 7 * 86400, visibility: 'link' as const, nsfw: false };
    const { fetchMock } = setup(
      { ...ME, settings: { ...ME.settings, upload_defaults: saved } },
      {
        'GET /users/@me/limits': () => USER_LIMITS,
        'PATCH /users/@me': ({ body }) => ({ ...ME, settings: { ...ME.settings, upload_defaults: { ...saved, ...body.settings.upload_defaults } } }),
      },
    );
    renderDashboard('/settings/uploads');
    const panel = await screen.findByRole('region', { name: 'Upload defaults' });
    const expiry = within(panel).getByLabelText('Expires');
    expect(expiry).toHaveValue(String(7 * 86400));
    expect(within(expiry).getAllByRole('option').map((option) => option.textContent)).toEqual(['Never', '1 hour', '1 day', '7 days', '21 days']);
    expect(within(panel).getByRole('radio', { name: /Anyone with the link/ })).toBeChecked();
    const save = within(panel).getByRole('button', { name: 'Save defaults' });
    expect(save).toBeDisabled();

    fireEvent.change(expiry, { target: { value: 'null' } });
    fireEvent.click(within(panel).getByRole('radio', { name: /Password: a new one generated for each file/ }));
    await waitFor(() => expect(within(panel).getByLabelText('Mark uploads as adult content', { exact: false })).toBeEnabled());
    fireEvent.click(within(panel).getByLabelText('Mark uploads as adult content', { exact: false }));
    fireEvent.click(save);
    expect(await screen.findByText('Upload defaults saved.')).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.method === 'PATCH')!.body).toEqual({ settings: { upload_defaults: { expires_in: null, visibility: 'password', nsfw: true } } });
    expect(within(panel).getByRole('button', { name: 'Save defaults' })).toBeDisabled();
  });

  it('lists a saved expiry that isn’t a preset, and shows the API’s field error', async () => {
    setup(
      { ...ME, settings: { ...ME.settings, upload_defaults: { expires_in: 3 * 86400, visibility: 'private', nsfw: false } } },
      {
        'GET /users/@me/limits': () => USER_LIMITS,
        'PATCH /users/@me': () =>
          jsonResponse({ code: 'INVALID_PARAMETERS', message: 'Some fields are invalid', status: 400, errors: { 'settings.upload_defaults.expires_in': 'Must be at most 21 days' } }, 400),
      },
    );
    renderDashboard('/settings/uploads');
    const panel = await screen.findByRole('region', { name: 'Upload defaults' });
    expect(within(panel).getByLabelText('Expires')).toHaveValue(String(3 * 86400));
    expect(within(panel).getByRole('option', { name: '3 days' })).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: /Only me/ })).toBeChecked();
    fireEvent.change(within(panel).getByLabelText('Expires'), { target: { value: String(86400) } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save defaults' }));
    expect(await within(panel).findByText('Must be at most 21 days')).toBeInTheDocument();
    expect(screen.queryByText('Upload defaults saved.')).not.toBeInTheDocument();
  });
});

describe('Settings → Security (§3.5, §5.6, §8.3–§8.5)', () => {
  it('asks to re-authenticate on REAUTH_REQUIRED, then retries the email change', async () => {
    let fresh = false;
    const { fetchMock } = setup(ME, {
      'POST /users/@me/email': () => (fresh ? jsonResponse({ pending_email: 'new@example.com' }, 202) : reauthRequired()),
      'POST /auth/reauth': ({ body }) => {
        if (body.password !== 'right-password') return jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'x', status: 400 }, 400);
        fresh = true;
        return jsonResponse(null, 204);
      },
    });
    renderDashboard('/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Change email' }));
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('That password isn’t right.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'right-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(calls(fetchMock).filter((call) => call.path === '/users/@me/email')).toHaveLength(2));
    expect(calls(fetchMock).find((call) => call.path === '/auth/reauth')!.headers.get('X-Filesgg-Csrf')).toBe('1');
  });

  it('offers Discord in the re-auth dialog when the account has it', async () => {
    setup({ ...ME, has_password: false, identities: [DISCORD] }, { 'POST /users/@me/email': () => reauthRequired(['discord']) });
    renderDashboard('/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Change email' }));
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'x@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    expect(within(dialog).queryByLabelText('Password')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Continue with Discord' })).toBeInTheDocument();
  });

  it('won’t unlink Discord when it’s the last way to sign in', async () => {
    setup({ ...ME, has_password: false, email_verified: false, identities: [DISCORD] });
    renderDashboard('/settings/security');
    expect(await screen.findByRole('button', { name: 'Unlink' })).toBeDisabled();
    expect(screen.getByText('Add a password and verify your email first, so you can still sign in.')).toBeInTheDocument();
    expect(screen.getByText('Verify your email first, so you can recover your account if you forget the password.')).toBeInTheDocument();
    expect(screen.getByText(/Discord → User Settings → Authorized Apps/)).toBeInTheDocument();
  });

  it('unlinks with a password and a verified email', async () => {
    const { fetchMock } = setup({ ...ME, identities: [DISCORD] }, { 'DELETE /users/@me/identities/discord': () => jsonResponse(null, 204) });
    renderDashboard('/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(calls(fetchMock).some((call) => call.method === 'DELETE' && call.path === '/users/@me/identities/discord')).toBe(true));
  });

  it('hides Discord when the server has no Discord sign-in, unless one is still linked (to unlink it)', async () => {
    setup(ME, { 'GET /auth/config': () => ({ discord: false }) });
    renderDashboard('/settings/security');
    expect(await screen.findByLabelText('Current password')).toBeInTheDocument();
    expect(screen.queryByText('Login methods')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
    cleanup();
    setup({ ...ME, identities: [DISCORD] }, { 'GET /auth/config': () => ({ discord: false }) });
    renderDashboard('/settings/security');
    expect(await screen.findByRole('button', { name: 'Unlink' })).toBeEnabled();
  });

  it('changes the password with the current one, and says what it did', async () => {
    const { fetchMock } = setup(ME, { 'PUT /users/@me/password': () => jsonResponse(null, 204) });
    renderDashboard('/settings/security');
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Other devices were signed out\. Your upload keys still work\./)).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.method === 'PUT')!.body).toEqual({ current_password: 'old-password', new_password: 'new-password-1' });
  });

  it('lists sessions, signs one out, and Sign out everywhere signs this browser out too', async () => {
    const { fetchMock, setUser } = setup(ME, {
      'DELETE /users/@me/sessions/:id': () => jsonResponse(null, 204),
      'DELETE /users/@me/sessions': () => ({ revoked: 2 }),
      'POST /auth/logout': () => jsonResponse(null, 204),
    });
    const router = renderDashboard('/settings/security');
    const list = await screen.findByRole('list', { name: 'Sessions' });
    expect(within(list).getByText('This device')).toBeInTheDocument();
    expect(within(list).getByText(/Chrome on Android/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Sign out Chrome on Android' }));
    await waitFor(() => expect(calls(fetchMock).some((call) => call.path === '/users/@me/sessions/s2')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    setUser(null as unknown as User);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('Settings → Data (§8.7, §8.8)', () => {
  it('requests an export and links the ready one', async () => {
    let items: unknown[] = [];
    const { fetchMock } = setup(ME, {
      'GET /users/@me/exports': () => ({ items }),
      'POST /users/@me/exports': () => {
        items = [{ id: 'e1', status: 'ready', created_at: NOW, ready_at: NOW, expires_at: NOW + 7 * 86400, size: 2048 }];
        return jsonResponse({ export: items[0] }, 202);
      },
    });
    renderDashboard('/settings/data');
    fireEvent.click(await screen.findByRole('button', { name: 'Request export' }));
    expect(await screen.findByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/users/@me/exports/e1/download');
    expect(calls(fetchMock).find((call) => call.method === 'POST')!.headers.get('X-Filesgg-Csrf')).toBe('1');
  });

  it('deletes: type the username, re-authenticate, confirm; then only Keep my account shows', async () => {
    let user: User = ME;
    const { fetchMock, setUser } = setup(ME, {
      'POST /auth/reauth': () => jsonResponse(null, 204),
      'POST /users/@me/delete': ({ body }) => {
        expect(body).toEqual({ confirm_username: 'mockuser' });
        user = { ...ME, deletion: { requested_at: NOW, scheduled_for: NOW + 14 * 86400 } };
        setUser(user);
        return jsonResponse({ deletion: user.deletion }, 202);
      },
      'POST /users/@me/delete/cancel': () => {
        setUser(ME);
        return ME;
      },
    });
    renderDashboard('/settings/data');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
    const first = screen.getByRole('alertdialog', { name: 'Delete your account?' });
    expect(within(first).getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(within(first).getByLabelText(/Type your username/), { target: { value: 'mockuser' } });
    fireEvent.click(within(first).getByRole('button', { name: 'Continue' }));
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    fireEvent.change(within(reauth).getByLabelText('Password'), { target: { value: 'pw-pw-pw-pw' } });
    fireEvent.click(within(reauth).getByRole('button', { name: 'Confirm' }));
    const final = (await screen.findByRole('button', { name: 'Delete my account' })).closest<HTMLElement>('[role="alertdialog"]')!;
    expect(final).toHaveTextContent('Your files and albums go offline now. Sign in within 14 days to keep your account; after that it’s deleted for good.');
    fireEvent.click(within(final).getByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByRole('heading', { name: /Your account will be deleted on/ })).toBeInTheDocument();
    expect(screen.getByText('Your files and albums are offline until then.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Settings' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my account' }));
    expect(await screen.findByText(/Your account is back/)).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path === '/users/@me/delete/cancel')).toBe(true);
  });

  it('staff and suspended accounts can’t request deletion', async () => {
    setup({ ...ME, staff: { role: 'moderator', child_safety: false } });
    renderDashboard('/settings/data');
    expect(await screen.findByText('Staff accounts can’t be deleted while they’re staff.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete account' })).not.toBeInTheDocument();
  });
});

describe('suspended accounts (§11.1)', () => {
  it('keep Security (password and sessions) and Data (exports), nothing else', async () => {
    const suspended = { ...ME, restrictions: [{ kind: 'suspended' as const, until: null }] };
    setup(suspended, { 'GET /users/@me/warnings': () => ({ count: 0, unacknowledged: 0, items: [] }) });
    const router = renderDashboard('/settings/security');
    expect(await screen.findByText('Your account is suspended. You can still change your password and sign out your sessions.')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(tabs).getAllByRole('link').map((link) => link.textContent)).toEqual(['Security', 'Data']);
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change email' })).not.toBeInTheDocument();
    router.navigate('/settings/data');
    expect(await screen.findByText('Suspended accounts can’t request deletion. Ask files.gg staff through your notices.')).toBeInTheDocument();
    router.navigate('/integrations');
    await waitFor(() => expect(router.state.location.pathname).toBe('/notices'));
  });
});
