import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UploadKey } from '../../lib/accountApi';
import { calls, jsonResponse, ME, NO_BADGES, renderDashboard, signIn, stubApi, type StubHandler } from '../../test/apiStub';

const SECRET = 'fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V';
const key = (n: number, extra: Partial<UploadKey> = {}): UploadKey => ({
  id: `k${n}`,
  name: `Key ${n}`,
  prefix: `fgg_0000000${n % 10}`,
  scopes: ['files:upload'],
  domain: null,
  created_at: 1795603600,
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  state: 'active',
  ...extra,
});
const LIMITS = { storage: { used: 0, limit: 1e10 }, max_file_size_single: 99_000_000, max_file_size_chunked: 1_000_000_000, max_expiry: null, allow_no_expiry: true, anonymous: false, upload_keys: { used: 1, limit: 20 } };

function setup(routes: Record<string, StubHandler>, user = ME) {
  signIn(user);
  return stubApi({
    'GET /users/@me/badges': () => NO_BADGES,
    'GET /users/@me/limits': () => LIMITS,
    'GET /users/@me/albums': () => ({ count: 1, items: [{ id: 'a1', vanity: 'Ab3dE6gH', title: 'Trip' }] }),
    'GET /users/@me/files': () => ({ count: 0, items: [], size: 0, total: { count: 0, size: 0 } }),
    ...routes,
  });
}

afterEach(() => localStorage.clear());

describe('Integrations (milestone-6 §7, §13.3)', () => {
  it('creates a key, shows it once with the .sxcu and curl, and downloads the .sxcu built in the browser', async () => {
    let items = [key(1, { last_used_at: 1795600000, domain: { id: 'd1', hostname: 'i.example.com' } })];
    const created = key(2, { name: 'Laptop ShareX', scopes: ['files:upload', 'albums:append'] });
    const fetchMock = setup({
      'GET /users/@me/upload-keys': () => ({ items, limit: 20 }),
      'POST /users/@me/upload-keys': () => {
        items = [...items, created];
        return jsonResponse({ key: created, secret: SECRET, sharex: { RequestURL: 'https://api.files.gg/files' }, curl: 'x' }, 201);
      },
    });
    let saved: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      saved = blob as Blob;
      return 'blob:sxcu';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderDashboard('/integrations');
    const list = await screen.findByRole('list', { name: 'Upload keys' });
    expect(within(list).getByText(/links on i\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/Tools send each file in one request, up to 99 MB/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    const dialog = screen.getByRole('dialog', { name: 'Create an upload key' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Laptop ShareX' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Also allow adding to albums/ }));
    fireEvent.change(within(dialog).getByLabelText('Key expires'), { target: { value: String(90 * 86400) } });
    fireEvent.change(within(dialog).getByLabelText('Files expire after'), { target: { value: String(7 * 86400) } });
    fireEvent.change(within(dialog).getByLabelText('Who can open them'), { target: { value: 'password' } });
    await within(dialog).findByRole('option', { name: 'Trip' });
    fireEvent.change(within(dialog).getByLabelText('Add to album'), { target: { value: 'Ab3dE6gH' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));

    expect(await screen.findByText('This is the only time the key is shown. Keep it secret: anyone with it can upload as you.')).toBeInTheDocument();
    // The ShareX defaults go along (optional, for the API's own sharex and curl); the .sxcu is still built here.
    expect(calls(fetchMock).find((call) => call.method === 'POST')!.body).toEqual({
      name: 'Laptop ShareX',
      scopes: ['files:upload', 'albums:append'],
      domain_id: null,
      expires_in: 90 * 86400,
      sharex: { expires_in: 604800, visibility: 'password', generate_password: true, album: 'Ab3dE6gH' },
    });
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(screen.getByText(/-F "expires_in=604800" -F "visibility=password" -F "generate_password=true" -F "album=Ab3dE6gH"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Download ShareX config' }));
    expect(click).toHaveBeenCalled();
    const config = JSON.parse(await saved!.text());
    expect(saved!.type).toBe('application/json');
    expect(config).toMatchObject({
      Version: '17.0.0',
      Name: 'files.gg (Laptop ShareX)',
      RequestURL: 'https://api.files.gg/files',
      Headers: { Authorization: `Key ${SECRET}` },
      Arguments: { expires_in: '604800', visibility: 'password', generate_password: 'true', album: 'Ab3dE6gH' },
      URL: '{json:url_with_password}',
    });
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('files.gg - Laptop ShareX.sxcu');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it('sends the view-limit defaults (milestone-6 §19.3) and puts them in the .sxcu and curl', async () => {
    const created = key(2, { name: 'Burner' });
    const fetchMock = setup({
      'GET /users/@me/upload-keys': () => ({ items: [], limit: 20 }),
      'POST /users/@me/upload-keys': () => jsonResponse({ key: created, secret: SECRET, curl: 'x' }, 201),
    });
    renderDashboard('/integrations');
    fireEvent.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = screen.getByRole('dialog', { name: 'Create an upload key' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Burner' } });
    // the action only shows once there's a limit
    expect(within(dialog).queryByLabelText('When the limit is reached')).toBeNull();
    expect(within(dialog).getByText('Off. Enter a number to stop each link after that many viewers.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('View limit'), { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Use a whole number from 1 to 1,000.');
    expect(calls(fetchMock).some((call) => call.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('View limit'), { target: { value: '5' } });
    expect(within(dialog).getByLabelText('When the limit is reached')).toHaveValue('expire');
    fireEvent.change(within(dialog).getByLabelText('When the limit is reached'), { target: { value: 'private' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.method === 'POST')!.body).toMatchObject({
      name: 'Burner',
      sharex: { view_limit: 5, view_limit_action: 'private' },
    });
    expect(screen.getByText(/-F "view_limit=5" -F "view_limit_action=private"/)).toBeInTheDocument();
  });

  it('from a blocked region (milestone-7 §11.4), one line instead of the sensitive checkbox', async () => {
    setup({
      'GET /users/@me/upload-keys': () => ({ items: [], limit: 20 }),
      'GET /users/@me/limits': () => ({ ...LIMITS, nsfw_allowed: false, adult_region_blocked: true }),
    });
    renderDashboard('/integrations');
    fireEvent.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = screen.getByRole('dialog', { name: 'Create an upload key' });
    expect(await within(dialog).findByText("Adult content isn't available in your region.")).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: /Mark uploads as sensitive/ })).toBeNull();
  });

  it('elsewhere, the sensitive checkbox and no region line', async () => {
    setup({
      'GET /users/@me/upload-keys': () => ({ items: [], limit: 20 }),
      'GET /users/@me/limits': () => ({ ...LIMITS, nsfw_allowed: true, adult_region_blocked: false }),
    });
    renderDashboard('/integrations');
    fireEvent.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = screen.getByRole('dialog', { name: 'Create an upload key' });
    expect(await within(dialog).findByRole('checkbox', { name: /Mark uploads as sensitive/ })).toBeInTheDocument();
    expect(within(dialog).queryByText("Adult content isn't available in your region.")).toBeNull();
  });

  it('disables Create key at 20 active keys, and revokes after confirming', async () => {
    const items = Array.from({ length: 20 }, (_, i) => key(i + 1));
    const fetchMock = setup({ 'GET /users/@me/upload-keys': () => ({ items, limit: 20 }), 'DELETE /users/@me/upload-keys/:id': () => jsonResponse(null, 204) });
    renderDashboard('/integrations');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled());
    expect(screen.getByText('You have 20 active keys, the most allowed. Revoke one to make another.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Key 3' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls(fetchMock).some((call) => call.method === 'DELETE' && call.path === '/users/@me/upload-keys/k3')).toBe(true));
  });

  it('lists revoked and expired keys without actions, and says when uploads are restricted', async () => {
    setup(
      { 'GET /users/@me/upload-keys': () => ({ items: [key(1, { state: 'revoked', revoked_at: 1795603600 }), key(2, { state: 'expired', expires_at: 1795603600 })], limit: 20 }) },
      { ...ME, restrictions: [{ kind: 'uploads', until: null }] },
    );
    renderDashboard('/integrations');
    const list = await screen.findByRole('list', { name: 'Upload keys' });
    expect(within(list).getByText('Revoked')).toBeInTheDocument();
    expect(within(list).getByText('Expired')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
    expect(screen.getByText('Uploads are restricted on your account, so keys can’t upload until the restriction ends.')).toBeInTheDocument();
  });
});
