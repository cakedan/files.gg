import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAlbum } from '../../lib/api';
import { createQueryClient } from '../../lib/queryClient';
import { json, ownerAlbum, ownerFile } from '../../test/ownerFiles';
import { Toaster } from '../components/Toaster';
import AlbumEditorPage from '../pages/AlbumEditorPage';
import { ORDER_SAVE_DELAY_MS } from './useAlbumOrder';

let album: OwnerAlbum;
let putResponse: (ids: string[]) => Response;

function setup() {
  const router = createMemoryRouter(
    [
      {
        path: '/albums/:id',
        element: (
          <Toaster>
            <AlbumEditorPage />
          </Toaster>
        ),
      },
      { path: '/albums', element: <p>Albums list</p> },
    ],
    { initialEntries: ['/albums/900'] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const order = () => screen.getAllByRole('article').map((article) => article.getAttribute('aria-label'));
const puts = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init!.body)).file_ids as string[]);

/** jsdom has no layout: lay the grid out as one row of 200 px tiles so dnd-kit's keyboard coordinates work. */
function mockLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const item = this.closest<HTMLElement>('[data-testid="album-item"]');
    const index = item ? [...item.parentElement!.children].indexOf(item) : 0;
    const left = index * 200;
    return { x: left, y: 0, left, top: 0, right: left + 180, bottom: 180, width: 180, height: 180, toJSON: () => ({}) } as DOMRect;
  });
}

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function keyboardMove(name: string, key: 'ArrowRight' | 'ArrowLeft') {
  const handle = screen.getByRole('button', { name: `Move ${name}` });
  handle.focus();
  fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
  await tick();
  fireEvent.keyDown(document, { code: key, key });
  await tick();
  fireEvent.keyDown(document, { code: 'Space', key: ' ' });
  await tick();
}

beforeEach(() => {
  localStorage.setItem('filesgg.token', 'tok');
  mockLayout();
  const files = ['a', 'b', 'c'].map((name, i) => ownerFile({ id: String(i + 1), name }));
  album = ownerAlbum([...files, ownerFile({ id: '4', name: 'secret', visibility: 'password' })]);
  putResponse = (ids) => json({ ...album, items: ids.map((id, position) => ({ ...album.items.find((item) => item.id === id)!, position })) });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/users/@me/albums/900' && (init?.method ?? 'GET') === 'GET') return json(album);
      if (url.pathname === '/users/@me/albums/900/files' && init?.method === 'PUT') return putResponse(JSON.parse(String(init.body)).file_ids);
      if (url.pathname === '/users/@me/albums/900/files/2' && init?.method === 'PATCH') {
        const caption = JSON.parse(String(init.body)).caption as string;
        return json({ ...album, items: album.items.map((item) => (item.id === '2' ? { ...item, caption } : item)) });
      }
      if (url.pathname === '/users/@me/albums/900' && init?.method === 'DELETE') return json(null, 204);
      return json({}, 404);
    }),
  );
});

afterEach(() => localStorage.clear());

describe('AlbumEditorPage', () => {
  it('shows the items in order, with a note on items the album page hides', async () => {
    setup();
    expect(await screen.findByRole('textbox', { name: 'Album title' })).toHaveValue('Trip');
    expect(order()).toEqual(['1. a.png', '2. b.png', '3. c.png', '4. secret.png']);
    const secret = screen.getByRole('article', { name: '4. secret.png' });
    expect(within(secret).getByText(/Hidden here: this file is password protected/)).toBeInTheDocument();
    expect(screen.getByText('1 file hidden on the album page')).toBeInTheDocument();
  });

  it('reorders with the keyboard and saves the whole order once, after the debounce', async () => {
    setup();
    await screen.findByRole('article', { name: '1. a.png' });
    await keyboardMove('a.png', 'ArrowRight');
    expect(order()).toEqual(['1. b.png', '2. a.png', '3. c.png', '4. secret.png']);
    expect(screen.getByText('Unsaved order…')).toBeInTheDocument();
    // A second move inside the debounce window is batched into the same save.
    await keyboardMove('c.png', 'ArrowLeft');
    expect(order()).toEqual(['1. b.png', '2. c.png', '3. a.png', '4. secret.png']);
    expect(puts()).toEqual([]);
    await waitFor(() => expect(puts()).toEqual([['2', '3', '1', '4']]), { timeout: ORDER_SAVE_DELAY_MS + 1000 });
    expect(await screen.findByText('Order saved')).toBeInTheDocument();
  });

  it('rolls the order back when saving fails', async () => {
    putResponse = () => json({ code: 'INVALID_ALBUM_FILES', message: 'x', file_ids: ['1'] }, 400);
    setup();
    await screen.findByRole('article', { name: '1. a.png' });
    await keyboardMove('a.png', 'ArrowRight');
    expect(order()[0]).toBe('1. b.png');
    await waitFor(() => expect(order()[0]).toBe('1. a.png'), { timeout: ORDER_SAVE_DELAY_MS + 1000 });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save the order: 1 file can't go in an album.");
  });

  it('saves a caption on blur', async () => {
    setup();
    const caption = await screen.findByLabelText('Caption for b.png');
    fireEvent.change(caption, { target: { value: 'The view' } });
    fireEvent.blur(caption);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith('/files/2') && init?.method === 'PATCH')).toBe(true));
    expect(await screen.findByText('Caption saved.')).toBeInTheDocument();
  });

  it('deletes the album, optionally with its files', async () => {
    const router = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete album' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Trip?' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Also delete the files/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete album and files' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/albums'));
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith('/users/@me/albums/900?delete_files=true') && init?.method === 'DELETE')).toBe(true);
  });
});
