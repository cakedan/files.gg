import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { createQueryClient } from '../lib/queryClient';
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

describe('dashboard routes', () => {
  it.each(NAV_ITEMS.map((item) => [item.path, item.label] as const))('%s renders the %s page', async (path, label) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeInTheDocument();
    // Upload is built (Milestone 2); the rest are still placeholders.
    if (path !== '/upload') expect(screen.getByText(/coming in a later milestone/i)).toBeInTheDocument();
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
