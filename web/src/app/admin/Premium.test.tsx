import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { StaffInfo } from '../../lib/api';
import { calls, jsonResponse, ME, NO_BADGES, renderDashboard, signIn, stubApi, type StubHandler } from '../../test/apiStub';
import type { AdminDomainDetail, AdminUserDetail, CaseDetail, Entitlement } from './adminApi';
import { domainActions } from './permissions';

const now = Math.floor(Date.now() / 1000);
const MODERATOR: StaffInfo = { role: 'moderator', child_safety: false };
const ADMIN: StaffInfo = { role: 'admin', child_safety: true };

const entitlement = (extra: Partial<Entitlement> = {}): Entitlement => ({
  id: 'e1',
  kind: 'premium',
  active: true,
  granted_at: now - 86400,
  granted_by: { id: '42', username: 'mockuser' },
  expires_at: null,
  revoked_at: null,
  revoked_by: null,
  note: 'Early supporter',
  ...extra,
});

function userDetail(extra: Partial<AdminUserDetail> = {}): AdminUserDetail {
  return {
    user: { id: '48', username: 'priya', email: 'premium@example.com', created_at: now - 60 * 86400, email_verified: true },
    staff: null,
    restrictions: [],
    warnings: { count: 0 },
    counts: { files: 3, albums: 1, reports_made: 0, reports_against: 0 },
    files: [],
    premium: false,
    entitlements: [],
    identities: [{ provider: 'discord', provider_user_id: '80351110224678912', username: 'priya', created_at: now - 86400 }],
    sessions: { active: 2 },
    upload_keys: [{ id: 'k1', name: 'Laptop', prefix: 'fgg_01234567', scopes: ['files:upload'], domain: null, created_at: now, expires_at: null, last_used_at: null, revoked_at: null, state: 'active' }],
    domains: [],
    deletion: null,
    ...extra,
  };
}

const domainDetail = (extra: Partial<AdminDomainDetail> = {}): AdminDomainDetail => ({
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
  verified_at: now - 86000,
  last_checked_at: now,
  pending_until: null,
  failing_since: null,
  disabled_reason: null,
  owner: { id: '48', username: 'priya' },
  cf_hostname_id: 'cf-1',
  cases: [],
  actions: [],
  ...extra,
});

function stub(staff: StaffInfo, routes: Record<string, StubHandler>) {
  signIn({ ...ME, staff });
  return stubApi({
    'GET /users/@me/badges': () => ({ ...NO_BADGES, staff: { open: 1, p0: 0, mine: 0 } }),
    'GET /admin/summary': () => ({ open: { p0: 0, p1: 0, p2: 1, p3: 0 }, unassigned: 0, mine: 0, past_goal: { p0: 0, other: 0 }, appeals: 0, bugs: 0, scans_stalled: 0, cybertip_unrecorded: 0, newest_p0_at: null }),
    'POST /admin/actions': ({ body }) => ({ action: { id: 'a1', actor: { id: '42', username: 'mockuser', kind: 'staff' }, action: body.action, rule: body.rule ?? null, target: body.target, note: null, details: null, reverses_action_id: null, created_at: now }, notice_ids: [] }),
    ...routes,
  });
}

afterEach(() => localStorage.clear());

describe('admin premium (milestone-6 §9.3, §9.4)', () => {
  it('an admin grants premium with a note and an expiry', async () => {
    let detail = userDetail();
    const fetchMock = stub(ADMIN, {
      'GET /admin/users/:id': () => detail,
      'POST /admin/users/:id/entitlements': ({ body }) => {
        detail = userDetail({ premium: true, entitlements: [entitlement({ expires_at: body.expires_at, note: body.note })] });
        return jsonResponse(detail.entitlements![0], 201);
      },
    });
    renderDashboard('/admin/users/48');
    const card = (await screen.findByRole('heading', { name: 'Premium' })).closest('section')!;
    expect(within(card).getByText('Not premium.')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Grant' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant premium' });
    expect(within(dialog).getByRole('button', { name: 'Grant premium' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('For'), { target: { value: String(30 * 86400) } });
    fireEvent.change(within(dialog).getByLabelText('Note for staff'), { target: { value: 'Beta tester' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant premium' }));
    expect(await screen.findByText('Premium granted.')).toBeInTheDocument();
    const sent = calls(fetchMock).find((call) => call.method === 'POST' && call.path === '/admin/users/48/entitlements')!;
    expect(sent.body).toMatchObject({ kind: 'premium', note: 'Beta tester' });
    expect(sent.body.expires_at).toBeGreaterThanOrEqual(now + 30 * 86400 - 5);
    expect(sent.headers.get('X-Filesgg-Csrf')).toBe('1');
    expect(await within(card).findByText(/^Premium until/)).toBeInTheDocument();
  });

  it('an admin revokes with a note; the history and account facts show', async () => {
    const fetchMock = stub(ADMIN, {
      'GET /admin/users/:id': () => userDetail({ premium: true, entitlements: [entitlement(), entitlement({ id: 'e0', active: false, revoked_at: now - 9 * 86400, revoked_by: { id: '42', username: 'mockuser' }, note: null })] }),
      'DELETE /admin/users/:id/entitlements/:eid': () => entitlement({ active: false, revoked_at: now }),
    });
    renderDashboard('/admin/users/48');
    const card = (await screen.findByRole('heading', { name: 'Premium' })).closest('section')!;
    expect(within(card).getByText(/Premium, until revoked/)).toBeInTheDocument();
    expect(within(card).getByText('“Early supporter”')).toBeInTheDocument();
    expect(screen.getByText(/2 active sessions/)).toBeInTheDocument();
    expect(screen.getByText(/80351110224678912/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke premium' });
    fireEvent.change(within(dialog).getByLabelText('Note for staff'), { target: { value: 'Ended' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke premium' }));
    await waitFor(() => expect(calls(fetchMock).find((call) => call.method === 'DELETE')!.body).toEqual({ note: 'Ended' }));
    expect(calls(fetchMock).find((call) => call.method === 'DELETE')!.path).toBe('/admin/users/48/entitlements/e1');
  });

  it('moderators see premium read-only, and can revoke one upload key', async () => {
    const fetchMock = stub(MODERATOR, { 'GET /admin/users/:id': () => userDetail() });
    renderDashboard('/admin/users/48');
    const card = (await screen.findByRole('heading', { name: 'Premium' })).closest('section')!;
    expect(within(card).queryByRole('button', { name: 'Grant' })).not.toBeInTheDocument();
    expect(within(card).getByText('Only admins can grant or revoke premium.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke this key' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke this key' }));
    await waitFor(() => expect(calls(fetchMock).find((call) => call.path === '/admin/actions')!.body).toMatchObject({ action: 'revoke_upload_keys', target: { type: 'user', id: '48' }, details: { key_id: 'k1' } }));
  });
});

describe('domain cases (§10.12)', () => {
  it('offers disable, enable and forcing “Only my files” by state', () => {
    expect(domainActions(MODERATOR, { status: 'active', scope: 'own' }).map((option) => option.action)).toEqual(['disable_domain']);
    expect(domainActions(MODERATOR, { status: 'active', scope: 'any' }).map((option) => option.action)).toEqual(['disable_domain', 'set_domain_scope']);
    expect(domainActions(MODERATOR, { status: 'disabled', scope: 'own' }).map((option) => option.action)).toEqual(['enable_domain']);
  });

  it('a domain case shows the domain and disables it with a rule', async () => {
    const detail: CaseDetail = {
      id: 'c9',
      kind: 'domain',
      priority: 1,
      status: 'open',
      target: { type: 'domain', id: 'd1', name: 'i.priya.example', state: 'active' },
      reasons: { malware: 1 },
      report_count: 1,
      distinct_reporters: 1,
      assignee: { id: '42', username: 'mockuser' },
      needs_second_review: false,
      child_safety: false,
      created_at: now - 60,
      age_seconds: 60,
      reports: [],
      flags: [],
      actions: [],
      target_detail: domainDetail(),
    };
    const fetchMock = stub(MODERATOR, { 'GET /admin/cases/:id': () => detail });
    renderDashboard('/admin/cases/c9');
    expect(await screen.findByText('Domain case')).toBeInTheDocument();
    expect(screen.getByText('i.priya.example', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'priya' })).toHaveAttribute('href', '/admin/users/48');
    const action = screen.getByLabelText('Action');
    expect([...(action as HTMLSelectElement).options].map((option) => option.value)).toEqual(['disable_domain', 'set_domain_scope']);
    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'phishing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disable the domain' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disable the domain' }));
    await waitFor(() => expect(calls(fetchMock).find((call) => call.path === '/admin/actions')!.body).toMatchObject({ action: 'disable_domain', target: { type: 'domain', id: 'd1' }, rule: 'phishing', case_id: 'c9' }));
  });

  it('/admin/domains/:id shows the domain page', async () => {
    stub(ADMIN, { 'GET /admin/domains/:id': () => domainDetail({ status: 'disabled', disabled_reason: 'phishing', scope: 'own' }) });
    renderDashboard('/admin/domains/d1');
    expect(await screen.findByText('Disabled by staff')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable the domain' })).toBeInTheDocument();
  });
});
