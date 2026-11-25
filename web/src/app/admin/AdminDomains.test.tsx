import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { StaffInfo } from '../../lib/api';
import { calls, ME, NO_BADGES, renderDashboard, signIn, signOut, stubApi, type StubHandler } from '../../test/apiStub';
import type { AdminDomainSummary } from './adminApi';

/** `/app/admin/domains` (milestone-6 §10.12, §13): the list, filtered by status and hostname. */

const now = Math.floor(Date.now() / 1000);
const MODERATOR: StaffInfo = { role: 'moderator', child_safety: false };

const domain = (extra: Partial<AdminDomainSummary> = {}): AdminDomainSummary => ({
  id: 'd1',
  hostname: 'i.priya.example',
  status: 'active',
  status_reason: null,
  serving: true,
  is_default: true,
  scope: 'any',
  records: [],
  cloudflare: null,
  created_at: now - 86400,
  verified_at: now - 86400,
  last_checked_at: null,
  pending_until: null,
  failing_since: null,
  disabled_reason: null,
  owner: { id: '48', username: 'priya' },
  cf_hostname_id: 'cf-1',
  ...extra,
});

function stub(routes: Record<string, StubHandler>) {
  signIn({ ...ME, staff: MODERATOR });
  return stubApi({
    'GET /users/@me/badges': () => ({ ...NO_BADGES, staff: { open: 0, p0: 0, mine: 0 } }),
    'GET /admin/summary': () => ({ open: { p0: 0, p1: 0, p2: 0, p3: 0 }, unassigned: 0, mine: 0, past_goal: { p0: 0, other: 0 }, appeals: 0, bugs: 0, scans_stalled: 0, cybertip_unrecorded: 0, newest_p0_at: null }),
    ...routes,
  });
}

afterEach(() => {
  localStorage.clear();
  signOut();
});

describe('admin domains list', () => {
  it('lists every domain with its status, owner and links, from the Domains tab', async () => {
    const fetchMock = stub({
      'GET /admin/domains': () => ({
        items: [domain(), domain({ id: 'd2', hostname: 'files.bad.example', status: 'disabled', serving: false, is_default: false, scope: 'own', owner: { id: '77', username: 'u77' } })],
        next_cursor: null,
      }),
    });
    renderDashboard('/admin');
    fireEvent.click(await screen.findByRole('link', { name: 'Domains' }));
    const list = await screen.findByRole('list', { name: 'Domains' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'i.priya.example' })).toHaveAttribute('href', '/admin/domains/d1');
    expect(within(rows[0]!).getByText('Active')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: '@priya' })).toHaveAttribute('href', '/admin/users/48');
    expect(within(rows[1]!).getByText('Disabled by files.gg')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Only the owner’s files')).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.path === '/admin/domains')).toBeTruthy();
  });

  it('filters by status and hostname through the URL and the API', async () => {
    const fetchMock = stub({
      'GET /admin/domains': ({ url }) => ({
        items: url.searchParams.get('status') === 'failed' ? [] : [domain()],
        next_cursor: null,
      }),
    });
    const router = renderDashboard('/admin/domains');
    expect(await screen.findByRole('link', { name: 'i.priya.example' })).toBeInTheDocument();
    const status = screen.getByLabelText('Status');
    expect([...(status as HTMLSelectElement).options].map((option) => option.textContent)).toEqual([
      'Any',
      'Waiting for DNS',
      'Issuing certificate',
      'Active',
      'Failing',
      'Failed',
      'Paused',
      'Disabled by files.gg',
    ]);
    fireEvent.change(status, { target: { value: 'failed' } });
    expect(await screen.findByText('No domains match these filters.')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?status=failed');

    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'priya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls(fetchMock).some((call) => call.path === '/admin/domains' && call.search.get('q') === 'priya' && call.search.get('status') === 'failed')).toBe(true));
  });

  it('pages with Load more', async () => {
    const fetchMock = stub({
      'GET /admin/domains': ({ url }) =>
        url.searchParams.get('cursor') ? { items: [domain({ id: 'd3', hostname: 'old.example.org' })], next_cursor: null } : { items: [domain()], next_cursor: 'c2' },
    });
    renderDashboard('/admin/domains');
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'old.example.org' })).toBeInTheDocument();
    expect(calls(fetchMock).filter((call) => call.path === '/admin/domains').map((call) => call.search.get('cursor'))).toEqual([null, 'c2']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows an empty state', async () => {
    stub({ 'GET /admin/domains': () => ({ items: [], next_cursor: null }) });
    renderDashboard('/admin/domains');
    expect(await screen.findByText('No custom domains yet.')).toBeInTheDocument();
  });
});
