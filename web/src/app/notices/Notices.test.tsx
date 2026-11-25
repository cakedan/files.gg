import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Notice } from '../../lib/api';
import { calls, jsonResponse, ME, NO_BADGES, renderDashboard, stubApi, signIn } from '../../test/apiStub';

const now = Math.floor(Date.now() / 1000);

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 'n1',
    action: 'remove',
    rule: 'copyright',
    rule_text: 'Copyright infringement',
    message: 'Removed after a copyright notice.',
    target: { kind: 'file', id: 'f1', vanity: 'abc123', name: 'episode.mp4' },
    created_at: now - 3600,
    acknowledged_at: null,
    appeal: { state: 'none', can_appeal: true, appealed_at: null, decided_at: null, message: null },
    ...overrides,
  };
}

let items: Notice[];

function stub() {
  return stubApi({
    'GET /users/@me': () => ME,
    'GET /users/@me/badges': () => ({ ...NO_BADGES, notices_unacknowledged: items.filter((each) => !each.acknowledged_at).length }),
    'GET /users/@me/warnings': ({ url }) => {
      const list = url.searchParams.get('unacknowledged') === 'true' ? items.filter((each) => !each.acknowledged_at) : items;
      return { count: list.length, unacknowledged: items.filter((each) => !each.acknowledged_at).length, items: list };
    },
    'POST /users/@me/warnings/acknowledge': ({ body }) => {
      items = items.map((each) => (body.ids.includes(each.id) ? { ...each, acknowledged_at: now } : each));
      return { acknowledged: body.ids };
    },
    'POST /users/@me/warnings/:id/appeal': ({ url, body }) => {
      const id = url.pathname.split('/')[4];
      if (body.message === 'fail') return jsonResponse({ code: 'DMCA_FIELDS_REQUIRED', message: 'raw api text', status: 400, errors: { phone: 'Not a phone number.' } }, 400);
      items = items.map((each) => (each.id === id ? { ...each, appeal: { ...each.appeal, state: 'open', can_appeal: false, appealed_at: now } } : each));
      return items.find((each) => each.id === id);
    },
  });
}

beforeEach(() => {
  signIn();
  items = [
    notice(),
    notice({ id: 'n2', action: 'hide', rule: 'harassment', rule_text: 'Harassment', message: null, target: { kind: 'file', id: 'f2', name: 'meme.png' } }),
    notice({
      id: 'n3',
      action: 'auto_hide',
      rule: 'spam',
      rule_text: 'Spam',
      message: 'Hidden while we review a report.',
      acknowledged_at: now - 10,
      appeal: { state: 'none', can_appeal: false, appealed_at: null, decided_at: null, message: null },
    }),
    notice({
      id: 'n4',
      action: 'scan_block',
      rule: 'malware',
      rule_text: 'Malware or harmful software',
      acknowledged_at: now - 10,
      appeal: { state: 'denied', can_appeal: false, appealed_at: now - 500, decided_at: now - 100, message: 'It contains a trojan.' },
    }),
  ];
});
afterEach(() => localStorage.clear());

const card = (name: string) => screen.getByRole('article', { name: new RegExp(name) });

describe('Notices', () => {
  it('lists notices with action, rule, target, message, appeal state and staff reply', async () => {
    stub();
    renderDashboard('/notices');
    expect(await screen.findByRole('heading', { level: 2, name: /Removed/ })).toBeInTheDocument();
    const removed = card('Removed');
    expect(within(removed).getByText('Copyright infringement')).toBeInTheDocument();
    expect(within(removed).getByRole('link', { name: 'episode.mp4' })).toHaveAttribute('href', '/files?q=episode.mp4');
    expect(within(removed).getByText('Removed after a copyright notice.')).toBeInTheDocument();
    expect(within(card('Hidden while we review')).getByText(/can’t be appealed/)).toBeInTheDocument();
    const blocked = card('Blocked by our scanner');
    expect(within(blocked).getByText(/Appeal denied/)).toBeInTheDocument();
    expect(within(blocked).getByText('It contains a trojan.')).toBeInTheDocument();
    expect(within(blocked).queryByRole('button', { name: 'Appeal' })).not.toBeInTheDocument();
  });

  it('acknowledges one notice, then all of them, and the banner goes away', async () => {
    const fetchMock = stub();
    renderDashboard('/notices');
    expect(await screen.findByText('You have 2 notices about your files or account.')).toBeInTheDocument();
    fireEvent.click(within(await screen.findByRole('article', { name: /Removed/ })).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(within(card('Removed')).queryByText('New')).not.toBeInTheDocument());
    expect(calls(fetchMock).find((call) => call.path === '/users/@me/warnings/acknowledge')!.body).toEqual({ ids: ['n1'] });
    expect(await screen.findByText('You have 1 notice about your files or account.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge all' }));
    expect(await screen.findByText('Acknowledged 1 notice.')).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path === '/users/@me/warnings' && call.search.get('unacknowledged') === 'true')).toBe(true);
    await waitFor(() => expect(screen.queryByText(/You have \d+ notices?/)).not.toBeInTheDocument());
  });

  it('appeals a copyright notice with the counter-notice fields', async () => {
    const fetchMock = stub();
    renderDashboard('/notices');
    fireEvent.click(within(await screen.findByRole('article', { name: /Removed/ })).getByRole('button', { name: 'Appeal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Appeal this notice' });
    expect(within(dialog).getByLabelText('Why should we reverse this?')).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send appeal' }));
    expect(within(dialog).getByText('Explain why you think this was a mistake.')).toBeInTheDocument();
    expect(within(dialog).getByText('Type your full legal name to sign.')).toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path.endsWith('/appeal'))).toBe(false);

    const fill = (label: string | RegExp, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    fill('Why should we reverse this?', 'I own the rights to this episode.');
    fill('Full legal name', 'Mock User');
    fill('Address', '1 Example Street');
    fill('Phone number', '+1 555 0100');
    fill('Email', 'mock@example.com');
    fill('Signature', 'Mock User');
    for (const box of within(dialog).getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send appeal' }));

    expect(await screen.findByText('Appeal sent.')).toBeInTheDocument();
    const body = calls(fetchMock).find((call) => call.path === '/users/@me/warnings/n1/appeal')!.body;
    expect(body).toEqual({
      message: 'I own the rights to this episode.',
      counter_notice: {
        name: 'Mock User',
        address: '1 Example Street',
        phone: '+1 555 0100',
        email: 'mock@example.com',
        material: 'episode.mp4',
        mistake_statement: true,
        jurisdiction_consent: true,
        service_consent: true,
        signature: 'Mock User',
      },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(card('Removed')).findByText(/Appeal sent/)).toBeInTheDocument();
  });

  it('appeals other notices with a message only, and shows field errors from the API', async () => {
    const fetchMock = stub();
    renderDashboard('/notices');
    fireEvent.click(within(await screen.findByRole('article', { name: /^Hidden(?! while)/ })).getByRole('button', { name: 'Appeal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Appeal this notice' });
    expect(within(dialog).queryByText('Counter-notice')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Why should we reverse this?'), { target: { value: 'fail' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send appeal' }));
    expect(await within(dialog).findByText('Fill in every field of the notice.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Why should we reverse this?'), { target: { value: 'It’s satire about a public figure.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send appeal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls(fetchMock).filter((call) => call.path === '/users/@me/warnings/n2/appeal').at(-1)!.body).toEqual({ message: 'It’s satire about a public figure.' });
  });

  it('opens one notice by id, as the badges link to it', async () => {
    stub();
    renderDashboard('/notices/n2');
    expect(await screen.findByRole('heading', { level: 1, name: 'Notice' })).toBeInTheDocument();
    expect(await screen.findByRole('article', { name: /^Hidden(?! while)/ })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /Removed/ })).not.toBeInTheDocument();
  });
});
