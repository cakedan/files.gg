import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerFile, User } from '../../lib/api';
import { createQueryClient } from '../../lib/queryClient';
import { apiUrl } from '../../test/apiStub';
import { filesResponse, json, ownerFile } from '../../test/ownerFiles';
import { ME, signedInQueryClient, signOut } from '../../test/session';
import { hiddenNote, VIEW_LIMITED_NOTE } from '../albums/hiddenNote';
import { Toaster } from '../components/Toaster';
import FilesPage from '../pages/FilesPage';
import { privateActionFired, viewsUsedLabel } from './viewLimit';

/** Milestone 6 §19.7 (dashboard) and §13.4 (Copy direct link, Open on <domain>). */

let library: OwnerFile[];
let patch: (id: string, body: Record<string, unknown>) => Response;
const writeText = vi.fn(async () => undefined);

function setup({ client = signedInQueryClient() } = {}) {
  const router = createMemoryRouter(
    [
      {
        path: '/files',
        element: (
          <Toaster>
            <FilesPage />
          </Toaster>
        ),
      },
    ],
    { initialEntries: ['/files'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const premium: User = { ...ME, premium: { active: true, expires_at: null } };
const domain = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  hostname: 'i.example.com',
  status: 'active',
  status_reason: null,
  serving: true,
  is_default: true,
  scope: 'any',
  records: [],
  cloudflare: null,
  created_at: 1_790_000_000,
  verified_at: 1_790_000_000,
  last_checked_at: null,
  pending_until: null,
  failing_since: null,
  disabled_reason: null,
  ...overrides,
});
let domains: unknown[];

const requests = () =>
  vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    path: apiUrl(input as string).pathname,
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    body: typeof (init as RequestInit | undefined)?.body === 'string' ? JSON.parse(String((init as RequestInit).body)) : undefined,
  }));

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockClear();
  domains = [];
  library = [
    ownerFile({ id: '1', name: 'limited', view_limit: 3, view_limit_action: 'expire', views_used: 1, direct_url: 'https://i.example.com/files/v1.png' }),
    ownerFile({ id: '2', name: 'burned', visibility: 'private', view_limit: 2, view_limit_action: 'private', views_used: 2 }),
    ownerFile({ id: '3', name: 'plain', view_limit: null, views_used: 0 }),
  ];
  patch = (id, body) => {
    const file = library.find((each) => each.id === id)!;
    Object.assign(file, { view_limit: body.view_limit, ...(body.view_limit_action ? { view_limit_action: body.view_limit_action } : {}), ...(body.visibility ? { visibility: body.visibility } : {}) });
    return json(file);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = apiUrl(input);
      const method = init?.method ?? 'GET';
      if (url.pathname === '/users/@me/files' && method === 'GET') return json(filesResponse(library));
      const match = /^\/users\/@me\/files\/(\d+)$/.exec(url.pathname);
      if (match && method === 'PATCH') return patch(match[1]!, JSON.parse(String(init?.body)));
      if (/^\/users\/@me\/files\/\d+\/pass$/.test(url.pathname)) return json({ token: 't', expires_at: 1_900_000_000, url: 'https://i.example.com/v1#t=t' });
      if (url.pathname === '/auth/session') return json({ user: null });
      if (url.pathname === '/users/@me/domains') return json({ items: domains, limit: 5, domain_only: { enabled: false, effective: false, paused: false } });
      if (url.pathname === '/users/@me/limits') return json({ storage: { used: 0, limit: 1e10 }, max_file_size_single: 1, max_file_size_chunked: 1, max_expiry: null, allow_no_expiry: true, anonymous: false });
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  signOut();
});

const openDrawer = async (name: string) => {
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog', { name });
};

describe('view limits in the dashboard', () => {
  it('labels: "N of M views used", and when the private action fired', () => {
    expect(viewsUsedLabel(library[0]!)).toBe('1 of 3 views used');
    expect(viewsUsedLabel({ view_limit: 1, views_used: 0, visibility: 'link' })).toBe('0 of 1 view used');
    expect(viewsUsedLabel(library[2]!)).toBeNull();
    expect(privateActionFired(library[1]!)).toBe(true);
    expect(privateActionFired(library[0]!)).toBe(false);
    expect(privateActionFired({ ...library[1]!, visibility: 'link' })).toBe(false);
  });

  it('rows show the views used', async () => {
    setup();
    const row = (await screen.findByRole('button', { name: 'limited.png' })).closest('tr')!;
    expect(within(row).getByText('1 of 3 views used')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'plain.png' }).closest('tr')!).queryByText(/views? used/)).toBeNull();
  });

  it('the drawer shows the limit, its action, and Edit or Remove', async () => {
    setup();
    const drawer = await openDrawer('limited.png');
    const section = within(drawer).getByRole('region', { name: 'View limit' });
    expect(section).toHaveTextContent('1 of 3 views used');
    expect(section).toHaveTextContent('It expires at the limit.');
    expect(within(section).getByRole('button', { name: 'Edit view limit…' })).toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: 'Remove limit' }));
    expect(await screen.findByText('View limit removed.')).toBeInTheDocument();
    expect(requests().find((call) => call.method === 'PATCH')).toEqual({ path: '/users/@me/files/1', method: 'PATCH', body: { view_limit: null } });
  });

  it('editing shows the VIEW_LIMIT_TOO_LOW message with views_used, and keeps the dialog open', async () => {
    patch = () => json({ code: 'VIEW_LIMIT_TOO_LOW', message: 'x', status: 400, views_used: 4 }, 400);
    setup();
    const drawer = await openDrawer('limited.png');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit view limit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'View limit' });
    expect(within(dialog).getByText(/1 of 3 views used\. Changing the limit doesn’t reset this\./)).toBeInTheDocument();
    const input = within(dialog).getByLabelText('View limit');
    expect(input).toHaveValue(3);

    // Checked here first: not above the views already used.
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Set a limit above 1, the views already used, or remove it.');
    expect(requests().some((call) => call.method === 'PATCH')).toBe(false);

    // The server knows more views than this page did.
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('4 people have already viewed this file. Set a limit of at least 5, or remove it.')).toBeInTheDocument();
    expect(requests().find((call) => call.method === 'PATCH')?.body).toEqual({ view_limit: 4, view_limit_action: 'expire' });
  });

  it('sets a limit on a file without one', async () => {
    setup();
    const drawer = await openDrawer('plain.png');
    expect(within(drawer).getByText('No view limit. Anyone with the link can open it any number of times.')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set view limit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'View limit' });
    fireEvent.change(within(dialog).getByLabelText('View limit'), { target: { value: '10' } });
    fireEvent.change(within(dialog).getByLabelText('When the limit is reached'), { target: { value: 'private' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('View limit set.')).toBeInTheDocument();
    expect(requests().find((call) => call.method === 'PATCH')?.body).toEqual({ view_limit: 10, view_limit_action: 'private' });
  });

  it('a file whose private action fired shows as private, with the hint; raising the limit can share it again', async () => {
    setup();
    const row = (await screen.findByRole('button', { name: 'burned.png' })).closest('tr')!;
    expect(within(row).getByText('Only me')).toBeInTheDocument();
    const drawer = await openDrawer('burned.png');
    expect(within(drawer).getByText('It reached its view limit and is private now. Raise the limit to share it again.')).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit view limit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'View limit' });
    expect(within(dialog).getByRole('checkbox', { name: 'Let anyone with the link open it again' })).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('View limit'), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('View limit updated.')).toBeInTheDocument();
    expect(requests().find((call) => call.method === 'PATCH')?.body).toEqual({ view_limit: 5, view_limit_action: 'private', visibility: 'link' });
  });

  it('anonymous: the limit shows, but it can only be set at upload', async () => {
    localStorage.setItem('filesgg.guest', 'fp1');
    setup({ client: createQueryClient() });
    const drawer = await openDrawer('limited.png');
    expect(within(drawer).getByRole('region', { name: 'View limit' })).toHaveTextContent('1 of 3 views used');
    expect(within(drawer).queryByRole('button', { name: /view limit…/ })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Remove limit' })).toBeNull();
  });

  it('the drawer says when the expire action fired (the file lasts the hour for the last viewer)', async () => {
    library[2] = ownerFile({ id: '3', name: 'plain', view_limit: 2, view_limit_action: 'expire', views_used: 2, expires_at: Math.floor(Date.now() / 1000) + 3000 });
    setup();
    const drawer = await openDrawer('plain.png');
    expect(within(drawer).getByText('It reached its view limit and expires within the hour. Nobody else can open it.')).toBeInTheDocument();
  });

  it('the album editor explains hidden view-limited files', () => {
    expect(hiddenNote({ shown: false, visibility: 'link', hidden_reason: 'view_limit' }, { visibility: 'link' })).toBe(VIEW_LIMITED_NOTE);
    expect(hiddenNote({ shown: false, visibility: 'link', view_limit: 3 }, { visibility: 'link' })).toBe(VIEW_LIMITED_NOTE);
    expect(VIEW_LIMITED_NOTE).toBe("View-limited files aren't shown in albums.");
    expect(hiddenNote({ shown: false, visibility: 'link', view_limit: null }, { visibility: 'link' })).not.toBe(VIEW_LIMITED_NOTE);
  });
});

describe('drawer links (milestone-6 §13.4)', () => {
  it('Copy direct link copies direct_url', async () => {
    setup();
    const drawer = await openDrawer('limited.png');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Copy direct link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://i.example.com/files/v1.png'));
    expect(await screen.findByText('Direct link copied.')).toBeInTheDocument();
  });

  it('no Copy direct link without direct_url, and no "Open on" without premium', async () => {
    setup();
    const drawer = await openDrawer('plain.png');
    expect(within(drawer).queryByRole('button', { name: 'Copy direct link' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /^Open on / })).toBeNull();
    expect(requests().some((call) => call.path === '/users/@me/domains')).toBe(false);
  });

  it('"Open on <domain>" mints an owner pass with the default serving domain', async () => {
    domains = [domain({ id: 'd0', hostname: 'old.example.com', is_default: false }), domain()];
    const tab = { location: { href: '' }, opener: {}, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    setup({ client: signedInQueryClient(premium) });
    const drawer = await openDrawer('limited.png');
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Open on i.example.com' }));
    await waitFor(() => expect(tab.location.href).toBe('https://i.example.com/v1#t=t'));
    expect(requests().find((call) => call.path === '/users/@me/files/1/pass')).toMatchObject({ method: 'POST', body: { domain_id: 'd1' } });
  });

  it('no "Open on" while the default domain isn\'t serving', async () => {
    domains = [domain({ serving: false, status: 'failing' })];
    setup({ client: signedInQueryClient(premium) });
    const drawer = await openDrawer('limited.png');
    await waitFor(() => expect(requests().some((call) => call.path === '/users/@me/domains')).toBe(true));
    expect(within(drawer).queryByRole('button', { name: /^Open on / })).toBeNull();
  });
});
