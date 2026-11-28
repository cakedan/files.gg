import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PendingCard } from './components/SafetyCards';
import type { FileData } from './types';
import { ViewerApp } from './ViewerApp';

const image: FileData = {
  kind: 'image',
  filename: 'cat.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 2048,
  width: 800,
  height: 600,
  cdn_url: 'https://cdn.files.gg/files/abc.png',
  url: 'https://files.gg/abc.png',
  vanity: 'abc',
  uploaded_at: 1_700_000_000,
  expires_at: null,
};

const zip: FileData = {
  ...image,
  kind: 'file',
  filename: 'tools.zip',
  mimetype: 'application/zip',
  extension: 'zip',
  cdn_url: 'https://cdn.files.gg/files/zip1.zip',
  width: undefined,
  height: undefined,
};

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('pending (milestone-4 §11.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/pend1');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the checking card and reloads itself after 2 s, remembering the attempt', () => {
    const reload = vi.fn();
    render(<PendingCard target={{ kind: 'file', vanity: 'pend1' }} reload={reload} />);
    expect(screen.getByRole('heading', { name: 'Checking this file…' })).toBeInTheDocument();
    expect(screen.getByText('This usually takes a few seconds.')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1999));
    expect(reload).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.history.state.filesggPending).toMatchObject({ reloads: 1, path: '/pend1' });
  });

  it('after 2 minutes of reloads, stops and offers Retry, which starts over', () => {
    const start = Date.now();
    // As if the page had already reloaded 10 times over 106 s.
    window.history.replaceState({ filesggPending: { start: start - 106_000, reloads: 10, at: start, path: '/pend1' } }, '');
    const reload = vi.fn();
    render(<PendingCard target={{ kind: 'file', vanity: 'pend1' }} reload={reload} />);
    act(() => vi.advanceTimersByTime(14_000));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('Still checking. Large videos can take a minute or two.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.history.state.filesggPending).toBeUndefined();
  });

  it('says album for albums, and sets the title without a name', async () => {
    vi.useRealTimers();
    render(<ViewerApp state={{ page: 'pending', target: { kind: 'album', vanity: 'Ab3' } }} />);
    expect(await screen.findByRole('heading', { name: 'Checking this album…' })).toBeInTheDocument();
    expect(document.title).toBe('Checking this album · files.gg');
  });
});

describe('removed (milestone-4 §11.1)', () => {
  const cases = [
    ['review', "This file is unavailable while it's reviewed."],
    ['terms', 'This file was removed for violating the Terms.'],
    ['copyright', 'This file was removed after a copyright notice.'],
    ['malware', 'This file was removed because it could harm your device.'],
  ] as const;

  it.each(cases)('shows the %s copy with a link to the Terms', async (reason, text) => {
    render(<ViewerApp state={{ page: 'removed', target: { kind: 'file', vanity: 'abc' }, reason }} />);
    expect(await screen.findByRole('heading', { name: text })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms');
  });

  it('says album for albums', async () => {
    render(<ViewerApp state={{ page: 'removed', target: { kind: 'album', vanity: 'Ab3' }, reason: 'review' }} />);
    expect(await screen.findByRole('heading', { name: "This album is unavailable while it's reviewed." })).toBeInTheDocument();
    expect(document.title).toBe('This album is unavailable · files.gg');
  });
});

describe('region (milestone-7 §11.4)', () => {
  it.each(['file', 'album'] as const)('a %s says it isn\'t available, links the Terms and shows nothing of it', async (kind) => {
    const { container } = render(<ViewerApp state={{ page: 'region', kind }} />);
    expect(await screen.findByRole('heading', { name: "This isn't available in your region." })).toBeInTheDocument();
    expect(screen.getByText(/Adult content can't be viewed where you are\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms#adult-content');
    expect(container.querySelectorAll('img, video, audio, iframe')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /download|show|report/i })).not.toBeInTheDocument();
    expect(document.title).toBe('files.gg');
  });
});

describe('CSAM-blocked looks exactly like missing (milestone-4 §2.4)', () => {
  it('renders the same markup and title as an unknown file', () => {
    const missing = render(<ViewerApp state={{ page: 'missing' }} />);
    const html = missing.container.innerHTML;
    const title = document.title;
    missing.unmount();
    // The worker serves blocked content as `missing` + `null`; nothing else reaches the client.
    const blocked = render(<ViewerApp state={{ page: 'missing' }} />);
    expect(blocked.container.innerHTML).toBe(html);
    expect(document.title).toBe(title);
    expect(screen.getByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
  });
});

describe('NSFW interstitial for files (milestone-4 §4.6)', () => {
  it('mounts nothing of the file before Show', async () => {
    render(<ViewerApp state={{ page: 'file', file: { ...image, nsfw: true } }} />);
    expect(await screen.findByRole('heading', { name: 'This file may contain sensitive content' })).toBeInTheDocument();
    // milestone-5 §19.2: the age rule for viewing adult content.
    expect(screen.getByText(/You must be 18 or older\./)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Leave' })).toHaveAttribute('href', '/');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('img', { name: 'cat.png' })).toBeInTheDocument();
    expect(localStorage.getItem('filesgg.showSensitive')).toBeNull();
  });

  it('"Always show sensitive media" is remembered and skips the gate next time', async () => {
    const first = render(<ViewerApp state={{ page: 'file', file: { ...image, nsfw: true } }} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Always show sensitive media' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(localStorage.getItem('filesgg.showSensitive')).toBe('1');
    first.unmount();
    render(<ViewerApp state={{ page: 'file', file: { ...image, nsfw: true } }} />);
    expect(screen.getByRole('img', { name: 'cat.png' })).toBeInTheDocument();
  });

  it("never gates files that aren't NSFW", () => {
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    expect(screen.getByRole('img', { name: 'cat.png' })).toBeInTheDocument();
  });
});

describe('scanner warnings (milestone-4 §11.1)', () => {
  it('shows each warning as a banner above the card', async () => {
    render(<ViewerApp state={{ page: 'file', file: { ...zip, warnings: ['unwanted_software', 'archive_partially_scanned', 'too_large_to_scan'] } }} />);
    const note = await screen.findByRole('note');
    expect(within(note).getByText("files.gg's scanner flagged this file as potentially unwanted software.")).toBeInTheDocument();
    // Two codes share one sentence: it appears once.
    expect(within(note).getAllByText('This file was too large to scan completely.')).toHaveLength(1);
  });

  it('asks before downloading an encrypted archive, and downloads on confirm', async () => {
    const clicks = vi.fn((event: Event) => event.preventDefault());
    document.addEventListener('click', clicks);
    render(<ViewerApp state={{ page: 'file', file: { ...zip, warnings: ['encrypted_archive'] } }} />);
    expect(
      await screen.findByText("This archive is encrypted and couldn't be scanned. Only download files from people you trust."),
    ).toBeInTheDocument();
    const download = screen.getAllByRole('link', { name: 'Download' })[0]!;
    fireEvent.click(download);
    const dialog = screen.getByRole('alertdialog', { name: 'Download this file?' });
    expect(clicks).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(download);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Download anyway' }));
    expect(clicks).toHaveBeenCalledTimes(1);
    expect((clicks.mock.calls[0]![0].target as HTMLAnchorElement).href).toBe(`${zip.cdn_url}?download=true`);
    document.removeEventListener('click', clicks);
  });

  it('also guards Raw', async () => {
    render(<ViewerApp state={{ page: 'file', file: { ...zip, warnings: ['unwanted_software'] } }} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Open original' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it("doesn't ask for warnings that only inform", async () => {
    render(<ViewerApp state={{ page: 'file', file: { ...zip, warnings: ['archive_partially_scanned'] } }} />);
    fireEvent.click((await screen.findAllByRole('link', { name: 'Download' }))[0]!);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('link warnings on files (milestone-4 §5.7)', () => {
  it('lists the flagged links with Copy only and Google attribution', async () => {
    const urls = ['https://bad.example/1', 'https://bad.example/2', 'https://bad.example/3', 'https://bad.example/4'];
    render(<ViewerApp state={{ page: 'file', file: { ...zip, link_warnings: urls } }} />);
    const banner = (await screen.findByRole('heading', { name: 'This file contains 4 links that may be dangerous' })).closest('section')!;
    expect(within(banner).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(within(banner).getByRole('button', { name: 'Show all 4' }));
    expect(within(banner).getAllByRole('listitem')).toHaveLength(4);
    expect(within(banner).getByRole('button', { name: 'Copy https://bad.example/1' })).toBeInTheDocument();
    expect(within(banner).queryByRole('link', { name: /bad\.example/ })).not.toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: 'Advisory provided by Google' })).toHaveAttribute(
      'href',
      'https://docs.cloud.google.com/web-risk/docs/advisory',
    );
    // milestone-7 §7: learn more is files.gg's own page, a section per threat type
    expect(within(banner).getByRole('link', { name: 'Malware' })).toHaveAttribute('href', '/help/link-warnings#malware');
    expect(within(banner).getByRole('link', { name: 'Phishing' })).toHaveAttribute('href', '/help/link-warnings#social-engineering');
  });
});

describe('download-only files (milestone-4 §2.3)', () => {
  it('a file sent as kind "file" renders the download card, not the image', () => {
    render(<ViewerApp state={{ page: 'file', file: { ...image, kind: 'file' } }} />);
    expect(screen.getByText(/no preview available/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'cat.png' })).not.toBeInTheDocument();
  });
});

describe('Report in the footer (milestone-4 §7.2)', () => {
  it('links to the report page and opens the dialog on a plain click', async () => {
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    const report = screen.getByRole('link', { name: 'Report' });
    expect(report).toHaveAttribute('href', '/report/abc');
    fireEvent.click(report);
    expect(await screen.findByRole('dialog', { name: 'Report this file' })).toBeInTheDocument();
  });

  it('keeps multi-segment vanities as path segments', () => {
    render(<ViewerApp state={{ page: 'file', file: { ...image, vanity: undefined, url: 'https://files.gg/abcd/xyz.png' } }} />);
    expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute('href', '/report/abcd/xyz');
  });
});

describe('report page (milestone-4 §10.1)', () => {
  it('renders the full-page form', async () => {
    render(<ViewerApp state={{ page: 'report', target: { type: 'any' } }} />);
    expect(await screen.findByRole('heading', { name: 'Report a file, an album or a problem' })).toBeInTheDocument();
    expect(document.title).toBe('Report · files.gg');
  });
});
