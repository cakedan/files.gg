import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../lib/queryClient';
import { json, ownerAlbum, ownerFile } from '../../test/ownerFiles';
import { installTurnstile } from '../../test/turnstile';
import UploadPage from '../pages/UploadPage';
import { albumAccessFor } from './useUploadAlbum';

// Single-request uploads go through XHR; answer them like `POST /files` would.
let uploaded = 0;
vi.mock('../../lib/upload/xhr', () => ({
  sendXhr: vi.fn(async () => {
    uploaded++;
    return { ...ownerFile({ id: String(100 + uploaded), name: `up${uploaded}` }), expires_at: null, visibility: 'link' };
  }),
}));

const anonymousLimits = {
  storage: { used: 0, limit: null },
  max_file_size_single: 25 * 1024 * 1024,
  max_file_size_chunked: 25 * 1024 * 1024,
  max_expiry: 21 * 86400,
  allow_no_expiry: false,
  anonymous: true,
};

const albumPosts = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => String(url).endsWith('/users/@me/albums') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)));

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <UploadPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pick = (...names: string[]) =>
  fireEvent.change(screen.getByLabelText('Choose files to upload'), { target: { files: names.map((name) => new File(['x'], name)) } });

beforeEach(() => {
  uploaded = 0;
  installTurnstile();
  localStorage.setItem('filesgg.fingerprint', 'fp1');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/users/@me/limits')) return json(anonymousLimits);
      if (String(url).endsWith('/users/@me/albums') && init?.method === 'POST') {
        const ids = JSON.parse(String(init.body)).file_ids as string[];
        return json(ownerAlbum(ids.map((id) => ownerFile({ id })), { id: '77', vanity: 'albumvan', url: 'https://files.gg/a/albumvan', title: '' }), 201);
      }
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  localStorage.clear();
  delete window.turnstile;
});

describe('UploadPage: "Put these in an album"', () => {
  it('is on for a multi-file batch, then makes the album and shows its link above the file links', async () => {
    renderPage();
    await screen.findByText(/Up to 25 MB per file/);
    pick('one.png', 'two.png');
    const toggle = await screen.findByRole('switch', { name: /Put these in an album/ });
    expect(toggle).toBeChecked();
    fireEvent.change(screen.getByRole('textbox', { name: 'Album title' }), { target: { value: 'Holiday' } });

    const album = await screen.findByRole('region', { name: 'Album' });
    expect(within(album).getByRole('link', { name: 'files.gg/a/albumvan' })).toHaveAttribute('href', 'https://files.gg/a/albumvan');
    expect(within(album).getByRole('button', { name: 'Copy album link' })).toBeInTheDocument();
    // Anonymous albums can't be edited, so no Edit link.
    expect(within(album).queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(albumPosts()).toEqual([{ title: 'Holiday', file_ids: ['101', '102'] }]);
    // The album comes before the per-file results.
    const uploads = screen.getByRole('region', { name: 'Uploads' });
    expect(album.compareDocumentPosition(uploads) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('makes no album when switched off', async () => {
    renderPage();
    await screen.findByText(/Up to 25 MB per file/);
    pick('one.png', 'two.png');
    fireEvent.click(await screen.findByRole('switch', { name: /Put these in an album/ }));
    await waitFor(() => expect(screen.getAllByText(/· Uploaded$/)).toHaveLength(2));
    expect(albumPosts()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Album' })).not.toBeInTheDocument();
  });

  it('is not offered for a single file', async () => {
    renderPage();
    await screen.findByText(/Up to 25 MB per file/);
    pick('one.png');
    await waitFor(() => expect(screen.getAllByText(/· Uploaded$/)).toHaveLength(1));
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(albumPosts()).toEqual([]);
  });
});

describe('albumAccessFor', () => {
  it('gives a protected batch’s album the same access', () => {
    expect(albumAccessFor({})).toBeNull();
    expect(albumAccessFor({ visibility: 'link' })).toBeNull();
    expect(albumAccessFor({ visibility: 'private' })).toEqual({ visibility: 'private' });
    expect(albumAccessFor({ visibility: 'password', password: 'secret1', unlock_ttl: 600 })).toEqual({ visibility: 'password', password: 'secret1', unlock_ttl: 600 });
    expect(albumAccessFor({ visibility: 'password', generate_password: true })).toEqual({ visibility: 'password', generate_password: true });
  });
});
