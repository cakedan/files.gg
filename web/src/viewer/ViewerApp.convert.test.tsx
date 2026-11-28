import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseFileData } from './boot';
import { resetHostContext } from './host/context';
import { enterCustomHost } from './host/testing';
import { NotPlayable } from './media/NotPlayable';
import { renderers, rendererFor } from './renderers';
import { GenericRenderer } from './renderers/GenericRenderer';
import type { FileData } from './types';
import { ViewerApp } from './ViewerApp';

/** Milestone 5 §13.2, §13.3, §19.2: the viewer's Convert entry points, the document preview and the footer links. */

const image: FileData = {
  kind: 'image',
  filename: 'cat.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 9000,
  width: 800,
  height: 500,
  vanity: 'abc',
  cdn_url: 'https://cdn.files.gg/files/abc.png',
  url: 'https://files.gg/abc.png',
  uploaded_at: 0,
  expires_at: null,
};

const docx: FileData = {
  kind: 'file',
  filename: 'report.docx',
  mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extension: 'docx',
  size: 48_210,
  vanity: 'doc1',
  cdn_url: 'https://cdn.files.gg/files/doc1.docx',
  url: 'https://files.gg/doc1.docx',
  uploaded_at: 0,
  expires_at: null,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => resetHostContext());

describe('the footer (milestone-5 §13.2, §19.2)', () => {
  it('links Convert to files.gg/convert with the source', () => {
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    const convert = screen.getByRole('link', { name: 'Convert' });
    expect(convert).toHaveAttribute('href', '/convert?source=abc');
    expect(convert).not.toHaveAttribute('target');
  });

  it('has Terms · Privacy · Report, on files.gg', () => {
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    const nav = screen.getByRole('navigation', { name: 'files.gg' });
    expect(within(nav).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms');
    expect(within(nav).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/legal/privacy');
    expect(within(nav).getByRole('link', { name: 'Report' })).toHaveAttribute('href', '/report/abc');
  });

  it('invites visitors to share their own file, with the small mark, on files.gg', () => {
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    const nav = screen.getByRole('navigation', { name: 'files.gg' });
    const invite = within(nav).getByRole('link', { name: 'Share your own file' });
    expect(invite).toHaveAttribute('href', '/');
    expect(invite.querySelector('img')).toHaveAttribute('src', '/assets/brand/filesgg-mark-small.svg');
  });

  it('on a custom domain, shows no files.gg invitation (the domain is the customer\'s branding)', () => {
    enterCustomHost();
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    expect(screen.queryByRole('link', { name: 'Share your own file' })).toBeNull();
  });

  it('on a custom domain, opens files.gg in a new tab and links the legal pages absolutely', () => {
    enterCustomHost();
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    const convert = screen.getByRole('link', { name: 'Convert' });
    expect(convert).toHaveAttribute('href', 'https://files.gg/convert?source=abc');
    expect(convert).toHaveAttribute('target', '_blank');
    const nav = screen.getByRole('navigation', { name: 'files.gg' });
    expect(within(nav).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', 'https://files.gg/legal/terms');
    expect(within(nav).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', 'https://files.gg/legal/privacy');
    expect(within(nav).getByRole('link', { name: 'Report' })).toHaveAttribute('href', 'https://files.gg/report/abc');
  });

  it('offers no Convert for a kind without targets, or a view-limited file', () => {
    const { unmount } = render(<ViewerApp state={{ page: 'file', file: { ...image, kind: 'file', mimetype: 'application/zip', filename: 'a.zip' } }} />);
    expect(screen.queryByRole('link', { name: 'Convert' })).not.toBeInTheDocument();
    unmount();
    render(<ViewerApp state={{ page: 'file', file: { ...image, view_limit: { remaining: 2 } } }} />);
    expect(screen.queryByRole('link', { name: 'Convert' })).not.toBeInTheDocument();
  });
});

describe('a video that can’t play (milestone-5 §13.2)', () => {
  const video: FileData = { ...image, kind: 'video', mimetype: 'video/quicktime', filename: 'clip.mov', extension: 'mov', media: { playable: false } };

  it('starts the play_everywhere preset', () => {
    render(<NotPlayable file={video} kind="video" />);
    expect(screen.getByRole('link', { name: 'Convert to MP4 to play in browser' })).toHaveAttribute('href', '/convert?source=abc&preset=play_everywhere');
  });

  it('opens files.gg in a new tab from a custom domain', () => {
    enterCustomHost();
    render(<NotPlayable file={video} kind="video" />);
    const link = screen.getByRole('link', { name: 'Convert to MP4 to play in browser' });
    expect(link).toHaveAttribute('href', 'https://files.gg/convert?source=abc&preset=play_everywhere');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('isn’t repeated in the footer: the card offers Convert to MP4 once', async () => {
    render(<ViewerApp state={{ page: 'file', file: video }} />);
    // The video renderer is a lazy chunk.
    expect(await screen.findByRole('link', { name: 'Convert to MP4 to play in browser' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /convert/i })).toHaveLength(1);
  });

  it('isn’t offered for audio', () => {
    render(<NotPlayable file={{ ...video, kind: 'audio', mimetype: 'audio/x-ms-wma' }} kind="audio" />);
    expect(screen.queryByRole('link', { name: /Convert/ })).not.toBeInTheDocument();
  });
});

describe('document previews (milestone-5 §9.2, §13.3)', () => {
  const preview = { ...docx, assets: { document: { url: 'https://cdn.files.gg/previews/document/doc1.pdf?v=3', size: 17_113, pages: 8 } } };

  it('parses assets.document from the boot data', () => {
    const parsed = parseFileData({ ...docx, assets: { document: { url: 'https://cdn.files.gg/previews/document/doc1.pdf?v=3', size: 17113, pages: 8 }, thumb: { url: 'x' } } });
    expect(parsed?.assets?.document).toEqual({ url: 'https://cdn.files.gg/previews/document/doc1.pdf?v=3', size: 17113, pages: 8 });
    expect(parseFileData({ ...docx, assets: { document: { size: 1 } } })?.assets).toBeUndefined();
  });

  it('uses the PDF renderer, says "Word document · preview", and Download is still the original', () => {
    expect(rendererFor(preview)).toBe(renderers.pdf);
    expect(rendererFor(docx)).toBe(GenericRenderer);
    render(<ViewerApp state={{ page: 'file', file: preview }} />);
    expect(screen.getByText(/Word document · preview/)).toHaveTextContent('Word document · preview · 48.2 KB · 8 pages');
    const downloads = screen.getAllByRole('link', { name: 'Download' });
    expect(downloads.at(-1)).toHaveAttribute('href', 'https://cdn.files.gg/files/doc1.docx?download=true');
  });

  it('without a preview: "Sign in to preview and convert" signed out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ user: null })));
    render(<GenericRenderer file={docx} />);
    expect(await screen.findByRole('link', { name: 'Sign in to preview and convert' })).toHaveAttribute(
      'href',
      `/app/login?next=${encodeURIComponent('/app/convert?source=doc1&target=pdf')}`,
    );
  });

  it('without a preview: "Convert to PDF" signed in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ user: { id: '42' } })));
    render(<GenericRenderer file={docx} />);
    expect(await screen.findByRole('link', { name: 'Convert to PDF' })).toHaveAttribute('href', '/convert?source=doc1&target=pdf');
  });
});
