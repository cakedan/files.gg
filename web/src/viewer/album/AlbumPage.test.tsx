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
    expect(screen.getByText('3 files · 3 KB')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'https://example.com/notes' });
    expect(link).toHaveAttribute('rel', 'nofollow ugc noopener');
    expect(screen.getByRole('link', { name: /download all/i })).toHaveAttribute('href', 'https://cdn.files.gg/albums/download/v1.zip');
    // Milestone 4: a real link to the album's report page, which opens the dialog on click.
    expect(screen.getByRole('link', { name: /report/i })).toHaveAttribute('href', '/report/a/v1');
  });

  it('says who can open the album, and notes the password next to Copy link', () => {
    render(<AlbumPage album={album({ visibility: 'password' })} />);
    expect(screen.getByText('Password protected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toHaveAccessibleDescription('Anyone you share it with needs the password too.');
  });

  it('shows "Anyone with the link" on a link album, with no password note', () => {
    render(<AlbumPage album={album({ visibility: 'link' })} />);
    expect(screen.getByText('Anyone with the link')).toBeInTheDocument();
    expect(screen.queryByText('Anyone you share it with needs the password too.')).toBeNull();
  });

  it('ends with the mark, Terms and Privacy, like a file page', () => {
    render(<AlbumPage album={album()} />);
    const nav = screen.getByRole('navigation', { name: 'files.gg' });
    expect(within(nav).getByRole('link', { name: 'Share your own file' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms');
    expect(within(nav).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/legal/privacy');
  });

  it('opens the lightbox from a tile, syncs ?item= (milestone-6 §20.2), moves with arrows and closes with Escape', async () => {
    window.history.replaceState(null, '', '/a/v1#pw=amber-tunnel');
    const entries = window.history.length;
    render(<AlbumPage album={album()} />);
    fireEvent.click(screen.getByRole('button', { name: /open photo-2.png/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2 / 3')).toBeInTheDocument();
    expect(within(dialog).getByText('Caption 2')).toBeInTheDocument();
    const where = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
    expect(where()).toBe('/a/v1?item=2#pw=amber-tunnel');
    // opening added exactly one entry, so the browser's Back button closes it
    expect(window.history.length).toBe(entries + 1);

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(within(screen.getByRole('dialog')).getByText('3 / 3')).toBeInTheDocument();
    expect(where()).toBe('/a/v1?item=3#pw=amber-tunnel');
    fireEvent.keyDown(document, { key: 'ArrowRight' }); // stops at the end
    expect(where()).toBe('/a/v1?item=3#pw=amber-tunnel');

    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(where()).toBe('/a/v1#pw=amber-tunnel');
    // moving between items added none; closing went back to the entry before the lightbox
    expect(window.history.length).toBe(entries + 1);
  });

  it('swipes between items on touch', async () => {
    window.history.replaceState(null, '', '/a/v1?item=1');
    render(<AlbumPage album={album()} />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.touchStart(dialog, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 100, clientY: 210 }] });
    expect(within(screen.getByRole('dialog')).getByText('2 / 3')).toBeInTheDocument();
  });

  it('shows one NSFW interstitial for the whole album, and no media before Show', () => {
    render(<AlbumPage album={album({ nsfw: true })} />);
    expect(screen.getByRole('heading', { name: 'This album may contain sensitive content' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trip' })).not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'Leave' })).toHaveAttribute('href', '/');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('heading', { name: 'Trip' })).toBeInTheDocument();
    // Inside, NSFW items aren't blurred or gated again.
    expect(document.querySelector('img')).not.toBeNull();
  });

  it('gates an unmarked album that has an NSFW item (§4.4)', () => {
    render(<AlbumPage album={album({ items: [image(1), image(2, { nsfw: true }), image(3)] })} />);
    expect(screen.getByRole('heading', { name: 'This album may contain sensitive content' })).toBeInTheDocument();
  });

  it('skips the interstitial with "Always show sensitive media", and the checkbox sets it', () => {
    const first = render(<AlbumPage album={album({ nsfw: true })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Always show sensitive media' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(localStorage.getItem('filesgg.showSensitive')).toBe('1');
    first.unmount();
    render(<AlbumPage album={album({ nsfw: true })} />);
    expect(screen.getByRole('heading', { name: 'Trip' })).toBeInTheDocument();
    localStorage.removeItem('filesgg.showSensitive');
  });

  it('renders flagged links in the description and captions as text with a warning, never as links', () => {
    const flagged = 'https://bad.example/x';
    render(
      <AlbumPage
        album={album({
          description: `Safe https://example.com/notes and bad ${flagged}.`,
          link_warnings: [flagged],
          items: [image(1, { caption: `See ${flagged}` }), image(2), image(3)],
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'https://example.com/notes' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: flagged })).not.toBeInTheDocument();
    const warnings = screen.getAllByRole('button', { name: 'This link may be dangerous' });
    expect(warnings).toHaveLength(2);
    // The album-level banner, with Google's attribution (lazy).
    fireEvent.click(warnings[0]!);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/suspected of hosting malware, phishing or unwanted software/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Advisory provided by Google' })).toHaveAttribute(
      'href',
      'https://docs.cloud.google.com/web-risk/docs/advisory',
    );
    expect(within(dialog).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /continue|open/i })).not.toBeInTheDocument();
  });

  it('shows the album link-warnings banner', async () => {
    render(<AlbumPage album={album({ link_warnings: ['https://bad.example/x'] })} />);
    expect(await screen.findByRole('heading', { name: 'This album contains a link that may be dangerous' })).toBeInTheDocument();
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
