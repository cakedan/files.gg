import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { headings } from '../../content/help/link-warnings.md?meta';
import { resetHostContext } from '../host/context';
import { FlaggedLinkDialog } from './FlaggedLinkDialog';
import { isFlaggedLink, LINK_WARNINGS_PATH, normalizeLink, serverForm, WEB_RISK_LEARN_MORE, WEB_RISK_WARNING } from './webRisk';
import { WebRiskNotice } from './WebRiskNotice';

afterEach(() => resetHostContext());

describe('isFlaggedLink', () => {
  it('matches regardless of host case, fragment and a trailing slash', () => {
    expect(normalizeLink('HTTPS://Bad.Example/path/#frag')).toBe('https://bad.example/path');
    expect(isFlaggedLink('https://BAD.example/path#x', ['https://bad.example/path/'])).toBe(true);
    // fail closed (security review W1): the same flagged path with a query is still flagged
    expect(isFlaggedLink('https://bad.example/path?q=1', ['https://bad.example/path'])).toBe(true);
    expect(isFlaggedLink('https://good.example/', ['https://bad.example/'])).toBe(false);
    expect(isFlaggedLink('https://bad.example/', undefined)).toBe(false);
  });
});

describe('isFlaggedLink matches what the server flagged (security review W1)', () => {
  // the server's extraction (api/safety/webrisk.py) cuts at \\ ^ ` { | } and strips trailing .,;:!?)]}'"
  it.each([
    ['a link keeping a balanced ")" the server stripped', 'https://evil.example/a_(b)', 'https://evil.example/a_(b'],
    ['a link continuing past a "|" the server cut at', 'https://evil.example/x%7Cy', 'https://evil.example/x'],
    ['a link continuing past a "{" the server cut at', 'https://evil.example/p%7B1%7D', 'https://evil.example/p'],
    ['a pdf.js link with a trailing "."', 'https://evil.example/login.', 'https://evil.example/login'],
    ['a deeper path under a flagged path', 'https://evil.example/login/step2', 'https://evil.example/login'],
    ['anything on a flagged bare host', 'https://evil.example/anything', 'https://evil.example'],
  ])('flags %s', (_name, href, flagged) => {
    expect(isFlaggedLink(href, [flagged])).toBe(true);
  });

  it.each([
    ['another host that starts with the flagged host', 'https://evil.example.org/x', 'https://evil.example'],
    ['the same path on another host', 'https://good.example/a_(b)', 'https://evil.example/a_(b'],
    ['no flagged links at all', 'https://evil.example/a', undefined],
  ])('does not flag %s', (_name, href, flagged) => {
    expect(isFlaggedLink(href, flagged === undefined ? undefined : [flagged])).toBe(false);
  });

  it('reduces a link the way the server does', () => {
    expect(serverForm('https://evil.example/a_(b)')).toBe('https://evil.example/a_(b');
    expect(serverForm('https://evil.example/x|y')).toBe('https://evil.example/x');
    expect(serverForm('https://evil.example/login.')).toBe('https://evil.example/login');
  });
});

describe('FlaggedLinkDialog (milestone-4 §11.1)', () => {
  it("shows Google's required wording and attribution, and offers Copy link only", () => {
    const onClose = vi.fn();
    render(<FlaggedLinkDialog url="https://bad.example/x" onClose={onClose} />);
    const dialog = screen.getByRole('alertdialog', { name: "You're leaving files.gg" });
    expect(dialog).toHaveTextContent(WEB_RISK_WARNING);
    expect(WEB_RISK_WARNING).toBe("This link may be dangerous: it's suspected of hosting malware, phishing or unwanted software.");
    expect(screen.getByTestId('flagged-url')).toHaveTextContent('https://bad.example/x');
    expect(screen.getByRole('link', { name: 'Advisory provided by Google' })).toHaveAttribute('href', 'https://docs.cloud.google.com/web-risk/docs/advisory');
    expect(screen.getByRole('link', { name: 'Phishing' })).toHaveAttribute('href', '/help/link-warnings#social-engineering');
    expect(screen.getByRole('link', { name: 'Unwanted software' })).toHaveAttribute('href', '/help/link-warnings#unwanted-software');
    // The flagged URL itself is never a link, and there's no Continue.
    expect(screen.queryByRole('link', { name: /bad\.example/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('learn more: the link warnings page on files.gg (milestone-7 §7)', () => {
  it('links each threat type files.gg checks to its section of /help/link-warnings', () => {
    render(<WebRiskNotice />);
    expect(screen.getByRole('link', { name: 'Malware' })).toHaveAttribute('href', '/help/link-warnings#malware');
    expect(screen.getByRole('link', { name: 'Phishing' })).toHaveAttribute('href', '/help/link-warnings#social-engineering');
    expect(screen.getByRole('link', { name: 'Unwanted software' })).toHaveAttribute('href', '/help/link-warnings#unwanted-software');
    expect(screen.getByRole('link', { name: 'Advisory provided by Google' })).toHaveAttribute('href', 'https://docs.cloud.google.com/web-risk/docs/advisory');
  });

  it('every anchor is a section of the page, which also covers potentially harmful apps', () => {
    const sections = headings.filter((heading) => heading.depth === 2).map((heading) => heading.id);
    for (const item of WEB_RISK_LEARN_MORE) expect(sections).toContain(item.anchor);
    expect(sections).toContain('potentially-harmful-applications');
  });

  it('goes to files.gg from a custom domain, which has no help page', () => {
    resetHostContext({
      custom: true,
      host: 'i.example.com',
      origin: 'https://i.example.com',
      mainOrigin: 'https://files.gg',
      apiOrigin: 'https://api.files.gg',
      cdnOrigin: 'https://cdn.files.gg',
    });
    render(<WebRiskNotice />);
    expect(screen.getByRole('link', { name: 'Malware' })).toHaveAttribute('href', `https://files.gg${LINK_WARNINGS_PATH}#malware`);
  });
});
