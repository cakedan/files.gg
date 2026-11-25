import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerFile } from '../../lib/api';
import { createQueryClient } from '../../lib/queryClient';
import { filesResponse, json, ownerFile } from '../../test/ownerFiles';
import { Toaster } from '../components/Toaster';
import FilesPage from '../pages/FilesPage';

let library: OwnerFile[];
let deleteResponse: () => Promise<Response>;

function setup(path = '/files') {
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
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const listCalls = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url)))
    .filter((url) => url.pathname === '/users/@me/files');

beforeEach(() => {
  localStorage.setItem('filesgg.token', 'tok');
  library = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((name, i) => ownerFile({ id: String(i + 1), name, size: 1024 * (i + 1) }));
  deleteResponse = async () => json({ deleted: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/users/@me/files' && (init?.method ?? 'GET') === 'GET') {
        const query = url.searchParams.get('query') ?? '';
        return json(filesResponse(library.filter((file) => file.filename.includes(query)), library.length));
      }
      if (url.pathname === '/users/@me/files/delete') {
        const response = await deleteResponse();
        if (response.ok) {
          const ids = JSON.parse(String(init?.body)).file_ids as string[];
          library = library.filter((file) => !ids.includes(file.id));
          return json({ deleted: ids });
        }
        return response;
      }
      if (url.pathname === '/users/@me/limits') return json({ storage: { used: 0, limit: 1e10 }, max_file_size_single: 1, max_file_size_chunked: 1, max_expiry: null, allow_no_expiry: true, anonymous: false });
      return json({}, 404);
    }),
  );
});

afterEach(() => localStorage.clear());

describe('FilesPage URL state', () => {
  it('reads page, sort and filters from the URL and sends them to the API', async () => {
    setup('/files?sort=-size&type=image&access=password&temporary=1&page=2');
    await screen.findByRole('heading', { name: 'Files' });
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    const params = Object.fromEntries(listCalls().at(-1)!.searchParams);
    expect(params).toEqual({ limit: '25', sort_by: '-size', type: 'image', visibility: 'password', temporary: 'true', offset: '25' });
    expect(screen.getByRole('button', { name: 'Images', pressed: true })).toBeInTheDocument();
  });

  it('debounces search into ?q=, and puts filters and the view in the URL', async () => {
    const router = setup('/files?sort=name');
    await screen.findByText('alpha.png');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'br' } });
    expect(router.state.location.search).toBe('?sort=name');
    await waitFor(() => expect(router.state.location.search).toBe('?q=br&sort=name'));
    await waitFor(() => expect(listCalls().at(-1)!.searchParams.get('query')).toBe('br'));
    expect(await screen.findByText('bravo.png')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Videos' }));
    expect(router.state.location.search).toBe('?q=br&sort=name&type=video');
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(router.state.location.search).toBe('?q=br&sort=name&type=video&view=grid');
  });
});

describe('FilesPage selection and bulk delete', () => {
  async function selectRange() {
    await screen.findByText('alpha.png');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select bravo.png' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select delta.png' }), { shiftKey: true });
  }

  it('shift-click selects a range and shows the count and size', async () => {
    setup();
    await selectRange();
    const bar = screen.getByRole('region', { name: 'Selected files' });
    expect(within(bar).getByText('3 files selected · 9 KB')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select charlie.png' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select echo.png' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    expect(within(bar).getByText('5 files selected · 15 KB')).toBeInTheDocument();
  });

  it('deletes optimistically after confirming, and announces the result', async () => {
    setup();
    await selectRange();
    fireEvent.click(within(screen.getByRole('region', { name: 'Selected files' })).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete 3 files?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    let release!: () => void;
    deleteResponse = () => new Promise((resolve) => (release = () => resolve(json({}))));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('bravo.png')).not.toBeInTheDocument());
    expect(screen.queryByText('delta.png')).not.toBeInTheDocument();
    expect(screen.getByText('alpha.png')).toBeInTheDocument();
    expect(screen.getByText('2 files · 6 KB used')).toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByText('Deleted 3 files.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Deleted 3 files.');
  });

  it('rolls back when the delete fails, with an error message', async () => {
    setup();
    await selectRange();
    fireEvent.click(within(screen.getByRole('region', { name: 'Selected files' })).getByRole('button', { name: 'Delete' }));
    let fail!: () => void;
    deleteResponse = () => new Promise((resolve) => (fail = () => resolve(json({ code: 'UNKNOWN_FILE', message: 'x' }, 404))));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('charlie.png')).not.toBeInTheDocument());
    await act(async () => fail());
    expect(await screen.findByText('charlie.png')).toBeInTheDocument();
    expect(screen.getByText('bravo.png')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't delete: This file doesn't exist or has expired.");
  });
});
