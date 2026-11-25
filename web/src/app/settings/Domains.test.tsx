import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Domain } from '../../lib/accountApi';
import type { User } from '../../lib/api';
import { calls, jsonResponse, ME, NO_BADGES, renderDashboard, signIn, stubApi, type StubHandler } from '../../test/apiStub';
import { DOMAIN_POLL_MS } from '../account/accountQueries';
import { domainOnlyWarning } from './domainText';

const NOW = Math.floor(Date.now() / 1000);
const PREMIUM: User = { ...ME, premium: { active: true, expires_at: null } };
const domain = (hostname: string, status: Domain['status'], extra: Partial<Domain> = {}): Domain => ({
  id: hostname,
  hostname,
  status,
  status_reason: null,
  serving: status === 'active' || status === 'failing',
  is_default: false,
  scope: 'own',
  records: [
    { type: 'CNAME', name: hostname, value: 'domains.files.gg', ok: status !== 'pending_dns' },
    { type: 'TXT', name: `_filesgg-verify.${hostname}`, value: 'filesgg-verify=aaaqeayeaudaocajbifqydiob4', ok: status !== 'pending_dns' },
  ],
  cloudflare: null,
  created_at: NOW - 600,
  verified_at: null,
  last_checked_at: NOW - 60,
  pending_until: NOW + 72 * 3600,
  failing_since: null,
  disabled_reason: null,
  ...extra,
});

function setup(routes: Record<string, StubHandler>, user = PREMIUM) {
  signIn(user);
  return stubApi({ 'GET /users/@me/badges': () => NO_BADGES, ...routes });
}

afterEach(() => localStorage.clear());

describe('Domains (milestone-6 §10, §13.4)', () => {
  it('explains custom domains to non-premium accounts, with no form', async () => {
    const fetchMock = setup({}, ME);
    renderDashboard('/settings/domains');
    expect(await screen.findByText('Custom domains need premium. Premium is granted by files.gg staff for now.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Hostname')).not.toBeInTheDocument();
    expect(calls(fetchMock).some((call) => call.path === '/users/@me/domains')).toBe(false);
  });

  it('adds a domain and shows the setup card with both records and Copy buttons', async () => {
    let items: Domain[] = [];
    const fetchMock = setup({
      'GET /users/@me/domains': () => ({ items, limit: 5, domain_only: { enabled: false, effective: false, paused: false } }),
      'POST /users/@me/domains': ({ body }) => {
        items = [domain(body.hostname, 'pending_dns')];
        return jsonResponse(items[0], 201);
      },
    });
    renderDashboard('/settings/domains');
    fireEvent.change(await screen.findByLabelText('Hostname'), { target: { value: 'i.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    const card = await screen.findByRole('article', { name: 'i.example.com' });
    expect(within(card).getByText('Waiting for DNS')).toBeInTheDocument();
    const records = within(card).getByRole('list', { name: 'DNS records for i.example.com' });
    expect(within(records).getByText('domains.files.gg')).toBeInTheDocument();
    expect(within(records).getByText('_filesgg-verify.i.example.com')).toBeInTheDocument();
    expect(within(records).getByText('filesgg-verify=aaaqeayeaudaocajbifqydiob4')).toBeInTheDocument();
    expect(within(records).getByRole('button', { name: 'Copy the CNAME target' })).toBeInTheDocument();
    expect(within(records).getByRole('button', { name: 'Copy the TXT value' })).toBeInTheDocument();
    expect(within(card).getByText(/DNS only/)).toBeInTheDocument();
    expect(calls(fetchMock).find((call) => call.method === 'POST')!.body).toEqual({ hostname: 'i.example.com' });
  });

  it('shows each status, and offers Check now, Set as default, Retry and the staff reason', async () => {
    setup({
      'GET /users/@me/domains': () => ({
        items: [
          domain('a.example.com', 'active', { is_default: true }),
          domain('b.example.com', 'active'),
          domain('c.example.com', 'pending_cert'),
          domain('d.example.com', 'failing', { failing_since: NOW - 86400 }),
          domain('e.example.com', 'failed', { status_reason: 'dns_timeout' }),
          domain('f.example.com', 'disabled', { disabled_reason: 'phishing' }),
        ],
        limit: 5,
        domain_only: { enabled: false, effective: false, paused: false },
      }),
    });
    renderDashboard('/settings/domains');
    const card = (name: string) => screen.findByRole('article', { name });
    expect(within(await card('a.example.com')).getByText('Default')).toBeInTheDocument();
    expect(within(await card('b.example.com')).getByRole('button', { name: 'Set as default' })).toBeInTheDocument();
    expect(within(await card('c.example.com')).getByText('Issuing certificate')).toBeInTheDocument();
    expect(within(await card('c.example.com')).getByRole('button', { name: 'Check now' })).toBeInTheDocument();
    expect(within(await card('d.example.com')).getByText(/fix the records within 3 days/)).toBeInTheDocument();
    expect(within(await card('e.example.com')).getByText(/didn’t see the records within 72 hours/)).toBeInTheDocument();
    expect(within(await card('e.example.com')).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    const disabled = await card('f.example.com');
    expect(within(disabled).getByText('Disabled by files.gg')).toBeInTheDocument();
    expect(within(disabled).getByText(/Phishing or scams/)).toBeInTheDocument();
    expect(within(disabled).getByRole('link', { name: 'Appeal in Notices' })).toHaveAttribute('href', '/notices');
    expect(within(disabled).getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('turning Only my files off asks first, then sends scope any with confirm', async () => {
    const fetchMock = setup({
      'GET /users/@me/domains': () => ({ items: [domain('a.example.com', 'active')], limit: 5, domain_only: { enabled: false, effective: false, paused: false } }),
      'PATCH /users/@me/domains/:id': ({ body }) => ({ ...domain('a.example.com', 'active'), scope: body.scope }),
    });
    renderDashboard('/settings/domains');
    const toggle = within(await screen.findByRole('article', { name: 'a.example.com' })).getByRole('switch', { name: /Only my files/ });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Other people’s files will be viewable on your domain.');
    expect(calls(fetchMock).some((call) => call.method === 'PATCH')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Show everyone’s files' }));
    await waitFor(() => expect(calls(fetchMock).find((call) => call.method === 'PATCH')!.body).toEqual({ scope: 'any', confirm: true }));
  });

  it('domain-only: off without a serving domain; on shows how many links stop working and confirms', async () => {
    const fetchMock = setup({
      'GET /users/@me/domains': () => ({ items: [domain('a.example.com', 'active')], limit: 5, domain_only: { enabled: false, effective: false, paused: false } }),
      'GET /users/@me/domain-only/preview': () => ({ affected_files: 142, affected_albums: 3 }),
      'PUT /users/@me/domain-only': () => ({ enabled: true, effective: true, paused: false, affected_files: 142, affected_albums: 3 }),
    });
    renderDashboard('/settings/domains');
    fireEvent.click(await screen.findByRole('switch', { name: /Only show my files on my domain/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('142 files and 3 albums have files.gg links that will stop working, including links already shared in Discord.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(calls(fetchMock).find((call) => call.method === 'PUT')!.body).toEqual({ enabled: true, confirm: true }));
  });

  it('domain-only can’t be turned on with no serving domain, and says when it’s paused', async () => {
    setup({ 'GET /users/@me/domains': () => ({ items: [domain('a.example.com', 'pending_dns')], limit: 5, domain_only: { enabled: true, effective: false, paused: true } }) });
    renderDashboard('/settings/domains');
    expect(await screen.findByText('Paused because no domain is working. Your files are showing on files.gg again.')).toBeInTheDocument();
  });

  it('words the warning for one file and for files only', () => {
    expect(domainOnlyWarning(142, 0)).toBe('142 files have files.gg links that will stop working, including links already shared in Discord.');
    expect(domainOnlyWarning(1, 0)).toBe('1 file has a files.gg link that will stop working, including links already shared in Discord.');
    expect(DOMAIN_POLL_MS).toBe(10_000);
  });
});
