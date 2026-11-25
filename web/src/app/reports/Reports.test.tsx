import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Report, ReportMessage } from '../../lib/api';
import { calls, ME, NO_BADGES, renderDashboard, stubApi, signIn } from '../../test/apiStub';

const now = Math.floor(Date.now() / 1000);

function report(overrides: Partial<Report> = {}): Report {
  return {
    id: 'r1',
    kind: 'file',
    target: { type: 'file', vanity: 'abc123', url: 'https://files.gg/abc123', part: null },
    reason: 'malware',
    status: 'open',
    closed: false,
    escalated: false,
    can_reopen: false,
    unread: 1,
    created_at: now - 7200,
    updated_at: now - 3600,
    resolved_at: null,
    last_message_at: now - 3600,
    ...overrides,
  };
}

let messages: ReportMessage[];
let current: Report;

beforeEach(() => {
  signIn();
  messages = [{ id: 'm1', author: 'staff', body: 'Thanks, we’re checking this file.', created_at: now - 3600 }];
  current = report();
});
afterEach(() => localStorage.clear());

function stub(extra: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    'GET /users/@me': () => ME,
    'GET /users/@me/badges': () => ({ ...NO_BADGES, reports_unread: 3 }),
    'GET /users/@me/reports': ({ url }) => {
      const all = [current, report({ id: 'r2', reason: 'spam', status: 'resolved', unread: 0, resolved_at: now - 100 })];
      const status = url.searchParams.get('status');
      const items = status ? all.filter((each) => each.status === status) : all;
      return { count: items.length, items };
    },
    'GET /users/@me/reports/:id': () => current,
    'GET /users/@me/reports/:id/messages': () => ({ items: messages }),
    'POST /users/@me/reports/:id/messages': ({ body }) => {
      const message: ReportMessage = { id: `m${messages.length + 1}`, author: 'you', body: body.body, created_at: now };
      messages = [...messages, message];
      return new Response(JSON.stringify(message), { status: 201 });
    },
    'PATCH /users/@me/reports/:id': () => {
      current = { ...current, status: 'open', can_reopen: false };
      return current;
    },
    ...extra,
  });
}

describe('My reports', () => {
  it('lists reports with status, unread counts and the status filter', async () => {
    const fetchMock = stub();
    renderDashboard('/reports');
    const list = await screen.findByRole('list');
    const first = (await within(list).findByText('Malware or phishing')).closest('a')!;
    expect(first).toHaveAttribute('href', '/reports/r1');
    expect(within(first).getByText('files.gg/abc123')).toBeInTheDocument();
    expect(within(first).getByText('Open')).toBeInTheDocument();
    expect(within(first).getByText(/unread update/)).toBeInTheDocument();
    // The sidebar badge comes from GET /users/@me/badges.
    expect(await within(screen.getByRole('navigation', { name: 'Dashboard' })).findByRole('link', { name: 'My reports, 3 unread' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
    await waitFor(() => expect(calls(fetchMock).some((call) => call.path === '/users/@me/reports' && call.search.get('status') === 'resolved')).toBe(true));
    expect(await screen.findByText('Spam')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Malware or phishing')).not.toBeInTheDocument());
  });

  it('shows the thread with "files.gg staff", sends a reply, and marks the report read', async () => {
    const fetchMock = stub();
    renderDashboard('/reports/r1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Malware or phishing' })).toBeInTheDocument();
    expect(await screen.findByText('files.gg staff')).toBeInTheDocument();
    expect(screen.getByText('Thanks, we’re checking this file.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /files\.gg\/abc123/ })).toHaveAttribute('href', 'https://files.gg/abc123');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Write a message first.')).toHaveAttribute('role', 'alert');

    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'It also asks for my email.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('It also asks for my email.')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.method === 'POST')!.body).toEqual({ body: 'It also asks for my email.' });
    expect(screen.getByLabelText('Reply')).toHaveValue('');
  });

  it('reopens a dismissed report once', async () => {
    current = report({ status: 'dismissed', can_reopen: true, resolved_at: now - 86400 });
    const fetchMock = stub();
    renderDashboard('/reports/r1');
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('Report reopened.')).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.method === 'PATCH')!.body).toEqual({ status: 'open' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument());
  });

  it('a closed report is read only, and an escalated one says so', async () => {
    current = report({ status: 'resolved', closed: true, escalated: true, reason: 'csam', resolved_at: now - 40 * 86400 });
    stub();
    renderDashboard('/reports/r1');
    expect(await screen.findByText('This report is closed, so you can’t reply any more.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reply')).not.toBeInTheDocument();
    expect(screen.getByText(/Thank you\. This has been escalated\./)).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });
});
