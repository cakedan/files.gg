import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createQueryClient } from '../../lib/queryClient';
import { NO_BADGES, signIn, signOut, stubApi } from '../../test/apiStub';
import { installTurnstile } from '../../test/turnstile';
import { publicRoutes } from '../routes';

const limits = (anonymous: boolean) => ({
  storage: { used: 0, limit: anonymous ? null : 10e9 },
  max_file_size_single: 100e6,
  max_file_size_chunked: anonymous ? 25e6 : 1e9,
  max_expiry: anonymous ? 21 * 86400 : null,
  allow_no_expiry: !anonymous,
  anonymous,
});

function renderHome() {
  const router = createMemoryRouter(publicRoutes, { initialEntries: ['/'] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installTurnstile();
  localStorage.setItem('filesgg.guest', 'fp1');
});

afterEach(() => {
  signOut();
  localStorage.clear();
  delete window.turnstile;
});

describe('the home page', () => {
  it('says what files.gg is, holds the real upload box, and lists what else it does', async () => {
    stubApi({ 'GET /users/@me/limits': () => limits(true) });
    renderHome();
    expect(await screen.findByRole('heading', { level: 1, name: 'Share any file with a link.' })).toBeInTheDocument();
    // the dashboard's Upload page, embedded: its options and drop zone, without its own "Upload" heading
    const upload = screen.getByRole('region', { name: 'Upload' });
    expect(await within(upload).findByText(/Uploading without an account\./)).toBeInTheDocument();
    expect(within(upload).queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(within(upload).getByText(/Drop files anywhere on this page/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'More than a link' })).toBeInTheDocument();
    for (const title of ['Private or password protected', 'Expiry and view limits', 'Albums', 'Convert', 'ShareX and curl', 'Your own domain']) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Convert a file' })).toHaveAttribute('href', '/convert');
    // dashboard links are plain /app links outside the dashboard
    expect(screen.getByRole('link', { name: 'Upload keys' })).toHaveAttribute('href', '/app/integrations');
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('offers Sign in and Create account signed out, and Dashboard signed in', async () => {
    stubApi({ 'GET /users/@me/limits': () => limits(true) });
    renderHome();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/app/login');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/app/register');
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('signed in, links the dashboard and uploads to the account', async () => {
    signIn();
    stubApi({ 'GET /users/@me/limits': () => limits(false), 'GET /users/@me/badges': () => NO_BADGES });
    renderHome();
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/app');
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    const upload = screen.getByRole('region', { name: 'Upload' });
    expect(await within(upload).findByRole('link', { name: 'Set up an upload key' })).toHaveAttribute('href', '/app/integrations');
    expect(within(upload).queryByText(/Uploading without an account/)).not.toBeInTheDocument();
  });
});
