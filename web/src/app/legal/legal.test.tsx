import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SiteFooter } from '../../components/SiteFooter';
import { CHANGELOG_SEEN_KEY, changelogUnread, LATEST_CHANGELOG_ENTRY } from '../../lib/changelog';
import { createQueryClient } from '../../lib/queryClient';
import { renderDashboard, stubApi } from '../../test/apiStub';
import { publicRoutes } from '../routes';
import { DocPage } from './DocPage';

function renderPublic(path: string) {
  const router = createMemoryRouter(publicRoutes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const FOOTER = [
  ['Changelog', '/changelog'],
  ['Terms', '/legal/terms'],
  ['Privacy', '/legal/privacy'],
  ['Report abuse', '/report'],
  ['Contact', 'mailto:support@files.gg'],
] as const;

function expectFooter(footer: HTMLElement) {
  for (const [name, href] of FOOTER) {
    expect(within(footer).getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute('href', href);
  }
}

beforeEach(() => {
  stubApi({});
});

afterEach(() => {
  localStorage.clear();
  window.location.hash = '';
});

describe('the Terms and Privacy pages (milestone-5 §19.1, §19.4, §19.5)', () => {
  it('/legal/terms renders the Markdown: title, last updated, contents, headings with anchors', async () => {
    renderPublic('/legal/terms');
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of Service' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Terms of Service · files.gg'));
    const updated = screen.getByText('November 25, 2026');
    expect(updated.tagName).toBe('TIME');
    expect(updated).toHaveAttribute('datetime', '2026-11-25');
    expect(updated.parentElement).toHaveTextContent('Last updated November 25, 2026');

    // Every section of §19.4, in the contents, linked to a stable id.
    const contents = screen.getAllByRole('navigation', { name: 'Contents' })[0]!;
    const sections = within(contents).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]);
    expect(sections).toEqual([
      ['1. Who runs files.gg', '#who-runs-files-gg'],
      ['2. Who can use files.gg', '#who-can-use-files-gg'],
      ['3. Accounts, anonymous use and upload keys', '#accounts-anonymous-use-and-upload-keys'],
      ['4. Your content', '#your-content'],
      ['5. Acceptable use', '#acceptable-use'],
      ['6. Scanning', '#scanning'],
      ['7. Reports, moderation and appeals', '#reports-moderation-and-appeals'],
      ['8. Copyright', '#copyright'],
      ['9. Expiry, view limits and deletion', '#expiry-view-limits-and-deletion'],
      ['10. Premium and custom domains', '#premium-and-custom-domains'],
      ['11. No warranty, liability and indemnity', '#no-warranty-liability-and-indemnity'],
      ['12. Ending, changes, law and contact', '#ending-changes-law-and-contact'],
    ]);
    const scanning = screen.getByRole('heading', { level: 2, name: /6\. Scanning/ });
    expect(scanning).toHaveAttribute('id', 'scanning');
    expect(within(scanning).getByRole('link', { name: 'Link to this section: 6. Scanning' })).toHaveAttribute('href', '#scanning');
    // The age rule (§19.2), and links to the other pages.
    expect(screen.getByText(/13 or older/, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Privacy Policy' })[0]).toHaveAttribute('href', '/legal/privacy');
  });

  it('the regional rules (milestone-7 §11.4): the ages, and adult content in the United Kingdom', async () => {
    renderPublic('/legal/terms');
    await screen.findByRole('heading', { level: 1, name: 'Terms of Service' });
    const prose = document.querySelector('.doc-prose')!;
    expect(prose).toHaveTextContent('You must be 13 or older to use files.gg, or 16 or older in the European Union, Iceland, Liechtenstein and Norway.');
    const adult = screen.getByRole('heading', { level: 3, name: /Adult content/ });
    expect(adult).toHaveAttribute('id', 'adult-content');
    // The UK sentence is in the adult-content section, after its heading and before the next section.
    const after: string[] = [];
    for (let node = adult.nextElementSibling; node && node.tagName !== 'H2' && node.tagName !== 'H3'; node = node.nextElementSibling) after.push(node.textContent ?? '');
    expect(after).toContain("Adult content isn't available in the United Kingdom: it can't be viewed, uploaded or marked from there.");
  });

  it('the Privacy Policy explains the country and that it isn\'t stored (milestone-7 §11.4)', async () => {
    renderPublic('/legal/privacy');
    const heading = await screen.findByRole('heading', { level: 3, name: /Your country/ });
    const text = heading.nextElementSibling!.textContent;
    expect(text).toContain("which country you're connecting from, from your IP address");
    expect(text).toContain('regional rules');
    expect(text).toContain("We don't store it for this.");
    expect(document.querySelector('.doc-prose')).toHaveTextContent('or 16 or older in the European Union, Iceland, Liechtenstein and Norway');
  });

  it('shows the draft banner while placeholders remain, and marks them', async () => {
    renderPublic('/legal/terms');
    const banner = await screen.findByRole('note');
    expect(banner).toHaveTextContent('Draft: pending legal review.');
    expect(document.querySelectorAll('.doc-prose mark.doc-placeholder').length).toBeGreaterThan(0);
    // The reviewers' notes (HTML comments) never reach the page.
    expect(document.querySelector('.doc-prose')!.innerHTML).not.toContain('<!--');
  });

  it('/legal/privacy: the policy, its storage table, the settings behind its numbers left out', async () => {
    renderPublic('/legal/privacy');
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /Cookies and browser storage/ })).toHaveAttribute('id', 'cookies-and-browser-storage');
    expect(screen.getByRole('cell', { name: 'filesgg.changelog.seen' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Draft: pending legal review.');
    expect(document.querySelector('.doc-prose')!.textContent).not.toContain('ABUSE_IP_KEEP_DAYS');
  });

  it('/legal goes to /legal/terms', async () => {
    const router = renderPublic('/legal');
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of Service' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/legal/terms');
  });

  it('has the site footer', async () => {
    renderPublic('/legal/privacy');
    await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' });
    expectFooter(screen.getByRole('contentinfo'));
  });

  it('no placeholders, no banner', () => {
    render(<DocPage doc={{ html: '<h2 id="a">A</h2>', title: 'Final', updated: '2027-01-02', headings: [{ depth: 2, id: 'a', text: 'A' }], placeholders: [] }} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Final' })).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByText('January 2, 2027')).toBeInTheDocument();
  });
});

describe('the link warnings help page (milestone-7 §7)', () => {
  it('/help/link-warnings explains each threat type under a stable anchor, says Google Web Risk flags it, with no draft banner', async () => {
    renderPublic('/help/link-warnings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Link warnings' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Link warnings · files.gg'));
    for (const [name, id] of [
      ['Malware', 'malware'],
      ['Social engineering', 'social-engineering'],
      ['Unwanted software', 'unwanted-software'],
      ['Potentially harmful applications', 'potentially-harmful-applications'],
    ] as const) {
      expect(screen.getByRole('heading', { level: 2, name: new RegExp(`^${name}`) })).toHaveAttribute('id', id);
    }
    expect(screen.getAllByText('What to do.', { selector: 'strong' })).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Google Web Risk' })).toHaveAttribute('href', 'https://cloud.google.com/web-risk');
    expect(screen.getByRole('link', { name: 'report it' })).toHaveAttribute('href', '/report');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expectFooter(screen.getByRole('contentinfo'));
  });
});

describe('the changelog (milestone-5 §19.3)', () => {
  it('/changelog renders CHANGELOG.md, each entry anchored by its date, with no banner', async () => {
    renderPublic('/changelog');
    expect(await screen.findByRole('heading', { level: 1, name: 'Changelog' })).toBeInTheDocument();
    const entry = screen.getByRole('heading', { level: 2, name: /2026-11-25: The new files\.gg/ });
    expect(entry).toHaveAttribute('id', '2026-11-25');
    expect(screen.getByText(/Upload files up to 1 GB/)).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByText('November 25, 2026')).toHaveAttribute('datetime', LATEST_CHANGELOG_ENTRY);
  });

  it('opening it records the newest entry, which clears the sidebar dot', async () => {
    renderPublic('/changelog');
    await screen.findByRole('heading', { level: 1, name: 'Changelog' });
    expect(localStorage.getItem(CHANGELOG_SEEN_KEY)).toBe(LATEST_CHANGELOG_ENTRY);
  });

  it('unread while the newest entry is newer than the one seen', () => {
    expect(LATEST_CHANGELOG_ENTRY).toBe('2026-11-25');
    expect(changelogUnread(null, '2026-11-25')).toBe(true);
    expect(changelogUnread('2026-11-01', '2026-11-25')).toBe(true);
    expect(changelogUnread('2026-11-25', '2026-11-25')).toBe(false);
    expect(changelogUnread('2026-12-01', '2026-11-25')).toBe(false);
    expect(changelogUnread(null, null)).toBe(false);
  });
});

describe('links to them (milestone-5 §19.2)', () => {
  it('the site footer: Changelog · Terms · Privacy · Report abuse · Contact', () => {
    render(<SiteFooter />);
    expectFooter(screen.getByRole('contentinfo'));
    expect(screen.queryByTestId('changelog-dot')).not.toBeInTheDocument();
  });

  it('on the home page', async () => {
    stubApi({ 'GET /users/@me/limits': () => ({ storage: { used: 0, limit: null }, max_file_size_single: 100e6, max_file_size_chunked: 25e6, max_expiry: 21 * 86400, allow_no_expiry: false, anonymous: true }) });
    renderPublic('/');
    await screen.findByRole('heading', { level: 1, name: 'Share any file with a link.' });
    expectFooter(screen.getByRole('contentinfo'));
  });

  it('on the auth pages', async () => {
    renderDashboard('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    expectFooter(screen.getByRole('contentinfo'));
  });

  it('at the bottom of the dashboard sidebar, with a dot on Changelog until the newest entry is seen', async () => {
    renderDashboard('/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    const footer = screen.getByRole('contentinfo');
    expectFooter(footer);
    expect(within(footer).getByRole('link', { name: /^Changelog\s*\(new\)$/ })).toHaveAttribute('href', '/changelog');
    expect(within(footer).getByTestId('changelog-dot')).toBeInTheDocument();
  });

  it('no dot once this browser has opened the newest entry', async () => {
    localStorage.setItem(CHANGELOG_SEEN_KEY, LATEST_CHANGELOG_ENTRY!);
    renderDashboard('/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Changelog' })).toBeInTheDocument();
    expect(screen.queryByTestId('changelog-dot')).not.toBeInTheDocument();
  });
});
