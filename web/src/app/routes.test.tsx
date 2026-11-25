import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { createQueryClient } from '../lib/queryClient';
import { installTurnstile } from '../test/turnstile';
import { stubApi } from '../test/apiStub';
import { NAV_ITEMS } from './nav';
import { routes } from './routes';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  // Signed out: the session answers `{ user: null }`; everything else is a 404.
  stubApi({});
});

describe('dashboard routes', () => {
  it.each(NAV_ITEMS.map((item) => [item.path, item.label] as const))('%s renders the %s page', async (path, label) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeInTheDocument();
    // Only Convert is still a placeholder; Integrations and Settings ask a signed-out visitor to sign in.
    if (path === '/convert') expect(screen.getByText(/coming in a later milestone/i)).toBeInTheDocument();
    if (path === '/integrations' || path === '/settings') {
      const hrefs = screen.getAllByRole('link', { name: 'Sign in' }).map((link) => link.getAttribute('href'));
      expect(hrefs).toContain(`/login?next=${encodeURIComponent(`/app${path}`)}`);
    }
  });

  it('renders a not-found page for unknown paths', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows every section in the sidebar, with the lockup in its header', async () => {
    renderAt('/');
    await screen.findByRole('heading', { name: 'Overview' });
    const nav = screen.getByRole('navigation', { name: 'Dashboard' });
    for (const { label } of NAV_ITEMS) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getAllByAltText('files.gg').length).toBeGreaterThan(0);
  });

  it('opens the mobile drawer and closes it on navigation', async () => {
    renderAt('/');
    await screen.findByRole('heading', { name: 'Overview' });
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    fireEvent.click(within(drawer).getByRole('link', { name: 'Files' }));
    expect(await screen.findByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
  });
});

describe('auth routes (milestone-6 §6.1)', () => {
  it.each([
    ['/login', 'Sign in'],
    ['/register', 'Create an account'],
    ['/forgot', 'Reset your password'],
    ['/verify', 'This link is invalid or has expired'],
    ['/reset', 'This link is invalid or has expired'],
    ['/auth/discord', 'Discord sign-in'],
  ])('%s renders outside the dashboard layout', async (path, heading) => {
    installTurnstile();
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('the signed-out sidebar offers Sign in and Create account', async () => {
    renderAt('/files');
    await screen.findByRole('heading', { level: 1, name: 'Files' });
    const links = screen.getAllByRole('link', { name: 'Create account' });
    expect(links[0]).toHaveAttribute('href', '/register');
    expect(screen.getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute('href', '/login?next=%2Fapp%2Ffiles');
  });
});
