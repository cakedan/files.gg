import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlbumData, AlbumItem } from '../types';
import AlbumPage from './AlbumPage';
import { AlbumTile } from './AlbumTile';

const image = (n: number, extra: Partial<AlbumItem> = {}): AlbumItem => ({
  kind: 'image',
  filename: `photo-${n}.png`,
  mimetype: 'image/png',
  extension: 'png',
  size: 1000,
  width: 800,
  height: 600,
  cdn_url: `https://cdn.files.gg/files/p${n}.png`,
  url: `https://files.gg/p${n}.png`,
  uploaded_at: 0,
  expires_at: null,
  position: n - 1,
  caption: `Caption ${n}`,
  ...extra,
});

const album = (extra: Partial<AlbumData> = {}): AlbumData => ({
  vanity: 'v1',
  url: 'https://files.gg/a/v1',
  title: 'Trip',
  description: 'Notes at https://example.com/notes',
  layout: 'grid',
  nsfw: false,
  expires_at: null,
  count: 3,
  total_size: 3000,
  next_cursor: null,
  download_url: 'https://cdn.files.gg/albums/download/v1.zip',
  items: [image(1), image(2), image(3)],
  ...extra,
});

beforeEach(() => {
  window.history.replaceState(null, '', '/a/v1');
  // jsdom has no layout: give the grid a width.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('AlbumPage', () => {
  it('renders the header: title, count and size, linkified description, actions', () => {
    render(<AlbumPage album={album()} />);
    expect(screen.getByRole('heading', { name: 'Trip' })).toBeInTheDocument();
    expect(screen.getByText('3 files · 2.9 KB')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'https://example.com/notes' });
    expect(link).toHaveAttribute('rel', 'nofollow ugc noopener');
    expect(screen.getByRole('link', { name: /download all/i })).toHaveAttribute('href', 'https://cdn.files.gg/albums/download/v1.zip');
    expect(screen.getByRole('link', { name: /report/i })).toHaveAttribute(
      'href',
      `/report?url=${encodeURIComponent('https://files.gg/a/v1')}`,
    );
  });

  it('opens the lightbox from a tile, syncs the URL, moves with arrows and closes with Escape', async () => {
    render(<AlbumPage album={album()} />);
    fireEvent.click(screen.getByRole('button', { name: /open photo-2.png/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2 / 3')).toBeInTheDocument();
    expect(within(dialog).getByText('Caption 2')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/a/v1/2');

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(within(screen.getByRole('dialog')).getByText('3 / 3')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/a/v1/3');
    fireEvent.keyDown(document, { key: 'ArrowRight' }); // stops at the end
    expect(window.location.pathname).toBe('/a/v1/3');

    fireEvent.keyDown(document, { key: 'Escape' });
    // Closing goes back in history; jsdom applies it asynchronously.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('swipes between items on touch', async () => {
    window.history.replaceState(null, '', '/a/v1/1');
    render(<AlbumPage album={album()} />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.touchStart(dialog, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 100, clientY: 210 }] });
    expect(within(screen.getByRole('dialog')).getByText('2 / 3')).toBeInTheDocument();
  });

  it('shows one NSFW interstitial for the whole album', () => {
    render(<AlbumPage album={album({ nsfw: true })} />);
    expect(screen.getByRole('heading', { name: /marked nsfw/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trip' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show album' }));
    expect(screen.getByRole('heading', { name: 'Trip' })).toBeInTheDocument();
  });

  it('renders the list layout with captions', () => {
    render(<AlbumPage album={album({ layout: 'list' })} />);
    expect(screen.getAllByRole('img', { name: /photo-\d\.png/ })).toHaveLength(3);
    expect(screen.getByText('Caption 3')).toBeInTheDocument();
  });

  it('renders a tracklist for all-audio albums, with tags and durations', () => {
    const track = (n: number, title: string): AlbumItem => ({
      ...image(n),
      kind: 'audio',
      filename: `${n}.wav`,
      extension: 'wav',
      mimetype: 'audio/wav',
      width: undefined,
      height: undefined,
      caption: '',
      media: { duration: 65_000, tags: { title, artist: 'Band', album: 'Record' } },
    });
    render(<AlbumPage album={album({ title: '', layout: 'auto', items: [track(1, 'One'), track(2, 'Two')] })} />);
    expect(screen.getAllByRole('heading', { name: 'Record' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Band').length).toBeGreaterThan(0);
    const tracks = screen.getByRole('list', { name: 'Tracks' });
    expect(within(tracks).getByRole('button', { name: 'Play Two' })).toHaveTextContent('1:05');
    expect(screen.getByRole('region', { name: 'Player' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shuffle' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Repeat: off' }));
    expect(screen.getByRole('button', { name: 'Repeat: all' })).toBeInTheDocument();
  });
});

describe('AlbumTile', () => {
  it('shows a ▶ badge on video posters and plays the hover clip only on hover', () => {
    const video: AlbumItem = {
      ...image(1),
      kind: 'video',
      filename: 'clip.mp4',
      thumbnail: { url: 'https://cdn/poster.webp', type: 'poster' },
      hover_url: 'https://cdn/hover.mp4',
    };
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<AlbumTile item={video} index={0} count={1} width={200} height={120} onOpen={() => undefined} />);
    const tile = screen.getByRole('button', { name: /open clip.mp4/i });
    expect(screen.queryByTestId('hover-clip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(tile);
    expect(screen.getByTestId('hover-clip')).toHaveAttribute('src', 'https://cdn/hover.mp4');
    fireEvent.mouseLeave(tile);
    expect(screen.queryByTestId('hover-clip')).not.toBeInTheDocument();
  });

  it('shows a type tile for other files', () => {
    const zip: AlbumItem = { ...image(1), kind: 'file', filename: 'a.zip', extension: 'zip', mimetype: 'application/zip', width: undefined, height: undefined };
    render(<AlbumTile item={zip} index={0} count={1} width={120} height={120} onOpen={() => undefined} />);
    expect(screen.getByText('a.zip')).toBeInTheDocument();
    expect(screen.getByText('zip')).toBeInTheDocument();
  });
});
