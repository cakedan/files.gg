import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StaffInfo } from '../../lib/api';
import { calls, jsonResponse, ME, NO_BADGES, renderDashboard, stubApi, signIn } from '../../test/apiStub';
import { ownerFile } from '../../test/ownerFiles';
import type { AdminFileDetail, CaseDetail, CaseSummary } from './adminApi';
import { fileActions, userActions } from './permissions';
import { NOTIFY_KEY, P0_NOTIFICATION_TEXT, useP0Notifications } from './useP0Notifications';

const now = Math.floor(Date.now() / 1000);
const MODERATOR: StaffInfo = { role: 'moderator', child_safety: false };
const ADMIN: StaffInfo = { role: 'admin', child_safety: true };

const summary = (p0 = 0) => ({
  open: { p0, p1: 1, p2: 0, p3: 1 },
  unassigned: 1,
  mine: 0,
  past_goal: { p0: 0, other: 0 },
  appeals: 0,
  bugs: 0,
  scans_stalled: 0,
  cybertip_unrecorded: 0,
  newest_p0_at: p0 ? now - 60 : null,
});

function caseSummary(overrides: Partial<CaseSummary> = {}): CaseSummary {
  return {
    id: 'c1',
    kind: 'file',
    priority: 1,
    status: 'open',
    target: { type: 'file', id: 'f1', vanity: 'abc123', name: 'free-robux.zip', state: 'flagged' },
    reasons: { malware: 2 },
    report_count: 2,
    distinct_reporters: 2,
    flags: ['unwanted_software'],
    assignee: null,
    needs_second_review: false,
    child_safety: false,
    created_at: now - 7200,
    age_seconds: 7200,
    ...overrides,
  };
}

function fileDetail(overrides: Partial<AdminFileDetail> = {}): AdminFileDetail {
  return {
    file: ownerFile({ id: 'f1', name: 'free-robux', extension: 'png', safety: { state: 'flagged', reason: 'unwanted_software', notice_id: null, nsfw_source: null, nsfw_locked: false, nsfw_review: 'none' } }),
    owner: { user_id: '77', username: 'tracker99', fingerprint: null, account_created_at: now - 86400, anonymous: false },
    moderation_state: 'visible',
    moderation_rule: null,
    scan_state: 'flagged',
    scan: { findings: [{ check: 'clamav', code: 'unwanted_software', detail: 'PUA.Win.Packer.Upx-1' }] },
    nsfw_score: 0.02,
    same_hash: { count: 1 },
    albums: [],
    reports: [],
    cases: [],
    actions: [],
    staff_urls: { content: 'https://cdn.files.gg/files/abc123.png?staff=42&expires=1&sig=x', previews: { thumb: 'https://cdn.files.gg/previews/thumb/abc123.webp?staff=42&expires=1&sig=y' } },
    ...overrides,
  };
}

function caseDetail(overrides: Partial<CaseDetail> = {}): CaseDetail {
  const { flags: _flags, ...base } = caseSummary();
  return {
    ...base,
    reports: [
      {
        id: 'r1',
        reason: 'malware',
        status: 'open',
        details: 'It asks for my password.',
        album_part: null,
        dmca: null,
        created_at: now - 7000,
        reporter: { user_id: '42', signed_in: true, account_age_days: 400 },
        messages: [],
      },
    ],
    flags: [{ id: 'fl1', source: 'scan', reason: 'unwanted_software', details: null, created_at: now - 7100, resolved_at: null }],
    actions: [],
    target_detail: fileDetail(),
    ...overrides,
  };
}

let cases: CaseSummary[];
let detail: CaseDetail;

function stub(staff: StaffInfo, extra: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    'GET /users/@me': () => ({ ...ME, staff }),
    'GET /users/@me/badges': () => ({ ...NO_BADGES, staff: { open: 2, p0: 0, mine: 0 } }),
    'GET /admin/summary': () => summary(),
    'GET /admin/cases': () => ({ items: cases, next_cursor: null }),
    'GET /admin/cases/:id': () => detail,
    'POST /admin/cases/:id/claim': ({ url, body }) => {
      const id = url.pathname.split('/')[3];
      const item = cases.find((each) => each.id === id)!;
      if (item.assignee && item.assignee.id !== '42' && !body.force) return jsonResponse({ code: 'CASE_CLAIMED', message: 'Claimed.', status: 409, assignee_id: item.assignee.id }, 409);
      cases = cases.map((each) => (each.id === id ? { ...each, assignee: { id: '42', username: 'mockuser' } } : each));
      detail = { ...detail, assignee: { id: '42', username: 'mockuser' } };
      return detail;
    },
    'POST /admin/cases/:id/release': () => {
      detail = { ...detail, assignee: null };
      return detail;
    },
    'POST /admin/actions': ({ body }) => ({
      action: { id: 'a1', actor: { id: '42', username: 'mockuser', kind: 'staff' }, action: body.action, rule: body.rule, target: body.target, note: null, details: null, reverses_action_id: null, created_at: now },
      notice_ids: ['n1'],
    }),
    ...extra,
  });
}

beforeEach(() => {
  signIn();
  cases = [caseSummary(), caseSummary({ id: 'c2', priority: 3, reasons: { spam: 1 }, flags: [], assignee: { id: '43', username: 'modmary' }, target: { type: 'album', id: 'al1', name: 'FREE GIFT CARDS', state: 'ok' } })];
  detail = caseDetail();
});
afterEach(() => localStorage.clear());

describe('admin queue (milestone-4 §9.2, §11.3)', () => {
  it('lists cases by priority with their columns, and claims one', async () => {
    const fetchMock = stub(MODERATOR);
    renderDashboard('/admin/queue');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('P1')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: /Malware or phishing ×2, Unwanted software/ })).toHaveAttribute('href', '/admin/cases/c1');
    expect(within(rows[0]!).getByRole('link', { name: 'free-robux.zip' })).toHaveAttribute('href', '/admin/files/f1');
    expect(within(rows[0]!).getByText('2 h')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('modmary')).toBeInTheDocument();
    // Moderators can't take over someone else's case (§9.2: admins only).
    expect(within(rows[1]!).queryByRole('button', { name: /Take over/ })).not.toBeInTheDocument();

    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Claim case c1' }));
    expect(await screen.findByText('Claimed.')).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.method === 'POST' && call.path === '/admin/cases/c1/claim')).toBe(true);
    expect(await within(table).findByRole('button', { name: 'Release case c1' })).toBeInTheDocument();
  });

  it('lets admins take over a claimed case', async () => {
    const fetchMock = stub(ADMIN);
    renderDashboard('/admin/queue');
    fireEvent.click(await screen.findByRole('button', { name: 'Take over case c2' }));
    await waitFor(() => expect(calls(fetchMock).find((call) => call.path === '/admin/cases/c2/claim')?.body).toEqual({ force: true }));
  });

  it('sends the filters to the API and announces the count', async () => {
    const fetchMock = stub(MODERATOR);
    renderDashboard('/admin/queue?priority=0&assignee=none&second=1');
    await screen.findByRole('table');
    const query = calls(fetchMock).find((call) => call.path === '/admin/cases')!.search;
    expect(Object.fromEntries(query)).toMatchObject({ status: 'open', priority: '0', assignee: 'none', needs_second_review: 'true' });
    expect(screen.getByText('2 cases')).toHaveAttribute('aria-live', 'polite');
  });
});

describe('admin case (milestone-4 §9.3, §11.3)', () => {
  it('blurs the target until Reveal, and runs an action with a rule', async () => {
    const fetchMock = stub(MODERATOR);
    renderDashboard('/admin/cases/c1');
    await screen.findByRole('button', { name: 'Reveal free-robux.png' });
    const media = document.querySelector('img[data-safe="blurred"]') as HTMLImageElement;
    expect(media).toHaveStyle({ filter: 'blur(24px) grayscale(1)' });
    expect(media.src).toContain('staff=42');
    fireEvent.click(screen.getByRole('button', { name: 'Reveal free-robux.png' }));
    expect(document.querySelector('img[data-safe="blurred"]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the file' })).toBeInTheDocument();

    // Moderators get no CSAM confirmation (child safety only).
    const panel = within(screen.getByRole('region', { name: 'Actions' }));
    const action = panel.getByLabelText('Action');
    expect(within(action).queryByRole('option', { name: 'Confirm CSAM' })).not.toBeInTheDocument();
    fireEvent.change(action, { target: { value: 'remove' } });
    fireEvent.click(panel.getByRole('button', { name: 'Remove' }));
    expect(await panel.findByText('Pick the rule this breaks.')).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path === '/admin/actions')).toBe(false);

    fireEvent.change(panel.getByLabelText('Rule'), { target: { value: 'malware' } });
    fireEvent.change(panel.getByLabelText('Message in the notice (optional)'), { target: { value: 'Contains a password stealer.' } });
    fireEvent.click(panel.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Done. Sent 1 notice.')).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.path === '/admin/actions')!.body).toEqual({
      action: 'remove',
      target: { type: 'file', id: 'f1' },
      rule: 'malware',
      notify: true,
      message: 'Contains a password stealer.',
      case_id: 'c1',
    });
  });

  it('shows CASE_CLAIMED when someone else holds the case', async () => {
    detail = caseDetail({ id: 'c2', assignee: { id: '43', username: 'modmary' } });
    stub(ADMIN, { 'POST /admin/cases/:id/claim': () => jsonResponse({ code: 'CASE_CLAIMED', message: 'Claimed.', status: 409, assignee_id: '44' }, 409) });
    renderDashboard('/admin/cases/c2');
    expect(await screen.findByText('Claimed by modmary.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(await screen.findByText(/Someone else has claimed this case\./)).toBeInTheDocument();
  });

  it('never requests media for hash-matched content', async () => {
    detail = caseDetail({
      kind: 'hash',
      priority: 0,
      child_safety: true,
      hash_matched: true,
      target_detail: fileDetail({ hash_matched: true, staff_urls: undefined, scan_state: 'blocked', scan: { findings: [] } }),
    });
    stub(ADMIN);
    renderDashboard('/admin/cases/c1');
    expect(await screen.findByTestId('not-displayable')).toHaveTextContent('Not displayable');
    expect(screen.getByRole('main').querySelector('img, video')).toBeNull();
    expect(screen.getByRole('heading', { name: 'CyberTipline report' })).toBeInTheDocument();
    expect(screen.getByText(/can’t be unblocked or shown/)).toBeInTheDocument();
  });

  it('decides an appeal, and explains SAME_MODERATOR', async () => {
    detail = caseDetail({
      kind: 'appeal',
      priority: 2,
      needs_second_review: true,
      reports: [],
      flags: [],
      appeal: {
        notice: {
          id: 'n1',
          action: 'remove',
          rule: 'spam',
          rule_text: 'Spam',
          message: null,
          target: { kind: 'file', id: 'f1', name: 'notes.pdf' },
          created_at: now - 86400,
          acknowledged_at: now,
          appeal: { state: 'open', can_appeal: false, appealed_at: now - 3600, decided_at: null, message: null },
        },
        message: 'These are lecture notes.',
        original_action: { id: 'a0', actor: { id: '42', username: 'mockuser', kind: 'staff' }, action: 'remove', rule: 'spam', target: null, note: null, details: null, reverses_action_id: null, created_at: now - 86400 },
      },
    });
    const fetchMock = stub(MODERATOR, { 'POST /admin/cases/:id/appeal': () => jsonResponse({ code: 'SAME_MODERATOR', message: 'No.', status: 409 }, 409) });
    renderDashboard('/admin/cases/c1');
    expect(await screen.findByText('These are lecture notes.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Grant/));
    fireEvent.change(screen.getByLabelText('Reply to the owner'), { target: { value: 'Fair enough.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decide' }));
    expect(await screen.findByText(/another staff member has to decide this appeal/)).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.path === '/admin/cases/c1/appeal')!.body).toEqual({ decision: 'grant', message: 'Fair enough.' });
    expect(screen.queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
  });

  it('a moderator gets no admin-only pages or actions', async () => {
    stub(MODERATOR);
    renderDashboard('/admin/audit');
    expect(await screen.findByText(/Only admins can see the whole audit log/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument();
  });
});

describe('admin permissions (milestone-4 §9.1)', () => {
  const file = { moderationState: 'visible' as const, scanState: 'flagged' as const, nsfw: false, hashMatched: false, csamRelated: false };

  it('offers CSAM confirmation to child-safety staff only, and nothing for hash-matched content', () => {
    expect(fileActions(MODERATOR, file).map((option) => option.action)).not.toContain('confirm_csam');
    expect(fileActions(ADMIN, file).map((option) => option.action)).toContain('confirm_csam');
    expect(fileActions(ADMIN, { ...file, hashMatched: true })).toEqual([]);
    expect(fileActions(ADMIN, { ...file, scanState: 'blocked', csamRelated: true }).map((option) => option.action)).not.toContain('unblock_hash');
  });

  it('offers a scan retry only for a pending file held because its scan kept failing', () => {
    const actions = (extra: Partial<Parameters<typeof fileActions>[1]>) =>
      fileActions(MODERATOR, { ...file, ...extra }).map((option) => option.action);
    expect(actions({ scanState: 'pending', scanStuck: true })).toContain('retry_scan');
    expect(actions({ scanState: 'pending', scanStuck: false })).not.toContain('retry_scan');
    expect(actions({ scanState: 'pending' })).not.toContain('retry_scan');
    expect(actions({ scanState: 'flagged', scanStuck: true })).not.toContain('retry_scan');
  });

  it('keeps suspensions for admins, and never lifts a CSAM suspension', () => {
    // Milestone 6 §11.4 adds Sign out everywhere and the username reset for both roles.
    expect(userActions(MODERATOR, { restricted: false, suspended: false, csamSuspension: false }).map((option) => option.action)).toEqual(['restrict_uploads', 'revoke_sessions', 'reset_username']);
    expect(userActions(ADMIN, { restricted: true, suspended: false, csamSuspension: false }).map((option) => option.action)).toEqual(['unrestrict_uploads', 'revoke_sessions', 'reset_username', 'suspend_user']);
    expect(userActions(ADMIN, { restricted: false, suspended: true, csamSuspension: true }).map((option) => option.action)).toEqual(['restrict_uploads', 'revoke_sessions', 'reset_username']);
  });
});

describe('P0 browser notifications (milestone-4 §11.3)', () => {
  it('asks permission on opt-in, then notifies when newest_p0_at increases', async () => {
    const created: string[] = [];
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static requestPermission = vi.fn(async () => {
        FakeNotification.permission = 'granted';
        return 'granted' as NotificationPermission;
      });
      constructor(title: string) {
        created.push(title);
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    const { result, rerender } = renderHook(({ newest }) => useP0Notifications(newest), { initialProps: { newest: 100 as number | null } });
    expect(result.current.enabled).toBe(false);
    await act(() => result.current.toggle());
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('1');
    expect(result.current.enabled).toBe(true);
    rerender({ newest: 100 });
    expect(created).toEqual([]);
    rerender({ newest: 200 });
    expect(created).toEqual([P0_NOTIFICATION_TEXT]);
    rerender({ newest: 150 });
    expect(created).toHaveLength(1);
  });
});
