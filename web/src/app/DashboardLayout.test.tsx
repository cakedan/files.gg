import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Badges } from '../lib/api';
import { calls, ME, NO_BADGES, renderDashboard, signIn, signOut, stubApi } from '../test/apiStub';

const SUMMARY = {
  open: { p0: 1, p1: 2, p2: 0, p3: 1 },
  unassigned: 3,
  mine: 1,
  past_goal: { p0: 0, other: 0 },
  appeals: 0,
  bugs: 1,
  scans_stalled: 0,
  cybertip_unrecorded: 0,
  newest_p0_at: 1795600000,
};

function stub(me: object, badges: Partial<Badges> = {}) {
  return stubApi({
    'GET /users/@me': () => me,
    'GET /users/@me/badges': () => ({ ...NO_BADGES, ...badges }),
    'GET /users/@me/warnings': () => ({ count: 0, unacknowledged: 0, items: [] }),
    'GET /users/@me/limits': () => ({ storage: { used: 0, limit: 1e10 }, max_file_size_single: 1, max_file_size_chunked: 1, max_expiry: null, allow_no_expiry: true, anonymous: false }),
    'GET /admin/summary': () => SUMMARY,
    'GET /admin/cases': () => ({ items: [], next_cursor: null }),
  });
}

const nav = () => screen.getByRole('navigation', { name: 'Dashboard' });

beforeEach(() => signIn());
afterEach(() => localStorage.clear());

describe('dashboard layout (milestone-4 §11.2)', () => {
  it('shows the notices banner on every page, and the badge counts in the sidebar', async () => {
    stub(ME, { notices_unacknowledged: 2, reports_unread: 1 });
    renderDashboard('/settings');
    const banner = await screen.findByText('You have 2 notices about your files or account.');
    expect(within(banner.closest('div')!).getByRole('link', { name: 'View notices' })).toHaveAttribute('href', '/notices');
    expect(within(nav()).getByRole('link', { name: 'Notices, 2 new' })).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'My reports, 1 unread' })).toBeInTheDocument();
  });

  it('shows no banner with nothing to acknowledge', async () => {
    stub(ME);
    renderDashboard('/settings');
    await screen.findByRole('heading', { name: 'Settings' });
    await waitFor(() => expect(within(nav()).getByRole('link', { name: 'Notices' })).toBeInTheDocument());
    expect(screen.queryByText(/You have \d+ notices?/)).not.toBeInTheDocument();
  });

  it('never shows Admin to non-staff, and /admin is a not-found page that calls no admin API', async () => {
    const fetchMock = stub(ME);
    renderDashboard('/admin/queue');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(within(nav()).queryByRole('link', { name: /Admin/ })).not.toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path.startsWith('/admin'))).toBe(false);
  });

  it('signed out, /admin is not found and nothing asks who you are', async () => {
    signOut();
    const fetchMock = stub(ME);
    renderDashboard('/admin');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path.startsWith('/admin') || call.path === '/users/@me/badges')).toBe(false);
  });

  it('shows Admin to staff, red while P0 cases are open, and loads the admin pages', async () => {
    stub({ ...ME, staff: { role: 'moderator', child_safety: false } }, { staff: { open: 4, p0: 1, mine: 1 } });
    renderDashboard('/admin');
    const link = await within(nav()).findByRole('link', { name: 'Admin, 4 open, with P0 cases' });
    expect(link.querySelector('.bg-danger-fill')).not.toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '1 child-safety or P0 case is open' })).toHaveAttribute('href', '/admin/queue?priority=0');
  });

  it('a suspended account sees only Notices and its Security settings, with the explanation (milestone-6 §11.1)', async () => {
    stub(ME, { notices_unacknowledged: 1, restrictions: [{ kind: 'suspended', until: null, notice_id: 'n1' }] });
    const router = renderDashboard('/files');
    expect(await screen.findByText('Your account has been suspended')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe('/notices'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Notices' })).toBeInTheDocument();
    expect(within(nav()).getAllByRole('link').map((each) => each.textContent)).toEqual(['Settings', 'Notices1, 1 new']);
    expect(within(nav()).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/security');
    expect(screen.queryByText(/You have \d+ notices?/)).not.toBeInTheDocument();
  });
});
