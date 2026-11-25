import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlbumData, AlbumItem } from '../types';
import AlbumPage from './AlbumPage';
import { AlbumTile } from './AlbumTile';
import { browser, checkZip, ZIP_LIMIT_BYTES } from './downloadAll';

const ZIP = 'https://cdn.files.gg/albums/download/v1.zip';

const item = (n: number, extra: Partial<AlbumItem> = {}): AlbumItem => ({
  kind: 'image',
  filename: `photo-${n}.png`,
  mimetype: 'image/png',
  extension: 'png',
  size: 1000,
  width: 800,
  height: 600,
  cdn_url: `https://cdn.files.gg/files/p${n}.png`,
  uploaded_at: 0,
  expires_at: null,
  position: n - 1,
  caption: '',
  ...extra,
});

const album = (extra: Partial<AlbumData> = {}): AlbumData => ({
  id: '77',
  vanity: 'v1',
  url: 'https://files.gg/a/v1',
  title: 'Trip',
  description: '',
  layout: 'grid',
  nsfw: false,
  expires_at: null,
  count: 2,
  total_size: 2000,
  next_cursor: null,
  download_url: ZIP,
  items: [item(1), item(2)],
  ...extra,
});

beforeEach(() => {
  window.history.replaceState(null, '', '/a/v1');
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
});

afterEach(() => window.history.replaceState(null, '', '/'));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Download all', () => {
  it('links to download_url as it is, and has no button without one', () => {
    const { unmount } = render(<AlbumPage album={album()} />);
    expect(screen.getByRole('link', { name: /download all/i })).toHaveAttribute('href', ZIP);
    unmount();
    render(<AlbumPage album={album({ download_url: undefined })} />);
    expect(screen.queryByRole('link', { name: /download all/i })).toBeNull();
  });

  it('uses a protected album\'s signed ZIP URL untouched', () => {
    const signed = `${ZIP}?expires=1796204800&sig=wGA5TVhWGADqYzNbG7Og11zjDW3n4A9cw5dKtfI4FFA`;
    render(<AlbumPage album={album({ visibility: 'password', download_url: signed })} />);
    expect(screen.getByRole('link', { name: /download all/i })).toHaveAttribute('href', signed);
  });

  it('checks with HEAD first, then downloads normally', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const download = vi.spyOn(browser, 'download').mockImplementation(() => undefined);
    render(<AlbumPage album={album()} />);
    fireEvent.click(screen.getByRole('link', { name: /download all/i }));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(ZIP, expect.objectContaining({ method: 'HEAD' }));
    expect(download).toHaveBeenCalledWith(ZIP);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('on 413 shows "too large" with per-item downloads instead of saving the JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 413 })));
    const download = vi.spyOn(browser, 'download').mockImplementation(() => undefined);
    render(<AlbumPage album={album()} />);
    fireEvent.click(screen.getByRole('link', { name: /download all/i }));
    const panel = await screen.findByRole('status');
    expect(within(panel).getByText('This album is too large to download as one file')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Download photo-2.png' })).toHaveAttribute(
      'href',
      'https://cdn.files.gg/files/p2.png?download=true',
    );
    expect(download).not.toHaveBeenCalled();
  });

  it('skips the request when the album is known to be over 2 GiB', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<AlbumPage album={album({ total_size: ZIP_LIMIT_BYTES + 1 })} />);
    fireEvent.click(screen.getByRole('link', { name: /download all/i }));
    expect(await screen.findByText('This album is too large to download as one file')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets the download go ahead when the check itself fails', async () => {
    await expect(checkZip(ZIP, 10, vi.fn().mockRejectedValue(new TypeError('CORS')))).resolves.toBe('ok');
    await expect(checkZip(ZIP, 10, vi.fn().mockResolvedValue(new Response(null, { status: 405 })))).resolves.toBe('ok');
  });

  it('leaves modified clicks (new tab) to the browser', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<AlbumPage album={album()} />);
    fireEvent.click(screen.getByRole('link', { name: /download all/i }), { metaKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AlbumTile assets', () => {
  it('uses thumb and thumb-2x in srcset', () => {
    const tile = item(1, {
      assets: {
        thumb: { url: 'https://cdn/t.webp', width: 320, height: 240 },
        'thumb-2x': { url: 'https://cdn/t2.webp', width: 640, height: 480 },
      },
    });
    const { container } = render(<AlbumTile item={tile} index={0} count={1} width={300} height={225} onOpen={() => undefined} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://cdn/t.webp');
    expect(img).toHaveAttribute('srcset', 'https://cdn/t.webp 320w, https://cdn/t2.webp 640w');
    expect(img).toHaveAttribute('sizes', '300px');
  });

  it('shows the type icon while an item is still processing', () => {
    const processing = item(1, { kind: 'video', filename: 'new.mp4', mimetype: 'video/mp4', processing: true });
    const { container } = render(<AlbumTile item={processing} index={0} count={1} width={200} height={150} onOpen={() => undefined} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('new.mp4')).toBeInTheDocument();
  });
});

describe('warned items put album downloads behind the confirmation (security review W2)', () => {
  const warned = () => album({ items: [item(1), item(2, { warnings: ['unwanted_software'] })] });

  it('asks before Download all, and only checks and downloads after confirming', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const download = vi.spyOn(browser, 'download').mockImplementation(() => undefined);
    render(<AlbumPage album={warned()} />);
    fireEvent.click(screen.getByRole('link', { name: /download all/i }));
    const dialog = screen.getByRole('alertdialog', { name: 'Download this file?' });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /download anyway/i }));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(ZIP, expect.objectContaining({ method: 'HEAD' }));
    expect(download).toHaveBeenCalledWith(ZIP);
  });

  it('asks on a middle click and a modified click too', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<AlbumPage album={warned()} />);
    const link = screen.getByRole('link', { name: /download all/i });
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(screen.getByRole('alertdialog', { name: 'Download this file?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(link, { ctrlKey: true });
    expect(screen.getByRole('alertdialog', { name: 'Download this file?' })).toBeInTheDocument();
  });

  it('an album with no warned items downloads without asking', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const download = vi.spyOn(browser, 'download').mockImplementation(() => undefined);
    render(<AlbumPage album={album()} />);
    fireEvent.click(screen.getByRole('link', { name: /download all/i }));
    await flush();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(download).toHaveBeenCalledWith(ZIP);
  });

  it('in the "too large" panel, only the warned item asks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 413 })));
    render(<AlbumPage album={{ ...warned(), total_size: 10 }} />);
    // the album-level confirmation comes first, then the 413 panel
    fireEvent.click(screen.getByRole('link', { name: /download all/i }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /download anyway/i }));
    const panel = await screen.findByRole('status');
    const plain = within(panel).getByRole('link', { name: 'Download photo-1.png' });
    const plainClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    plain.dispatchEvent(plainClick);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('link', { name: 'Download photo-2.png' }));
    expect(screen.getByRole('alertdialog', { name: 'Download this file?' })).toBeInTheDocument();
  });
});
