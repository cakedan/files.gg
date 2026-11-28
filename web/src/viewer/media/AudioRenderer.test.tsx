import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileData } from '../types';
import AudioRenderer from './AudioRenderer';
import { fakeMedia } from './fakeMedia';
import { VOLUME_KEY } from './prefs';

const PEAKS = 'https://cdn.files.gg/media/1/peaks.json?v=1';

const audio = (extra: Partial<FileData> = {}): FileData => ({
  kind: 'audio',
  filename: 'song.mp3',
  mimetype: 'audio/mpeg',
  extension: 'mp3',
  size: 1000,
  duration: 200_000,
  cdn_url: 'https://cdn.files.gg/files/song.mp3',
  media: { playable: true, tags: { title: 'Song', artist: 'Band' } },
  uploaded_at: 0,
  expires_at: null,
  ...extra,
});

afterEach(() => localStorage.clear());

describe('AudioRenderer', () => {
  it('shows the cover large, the "Artist: Title" line and controls without fullscreen', () => {
    render(<AudioRenderer file={audio({ thumbnail: { url: 'https://cdn/cover.webp', type: 'cover' } })} />);
    expect(screen.getByTestId('audio-cover')).toHaveAttribute('src', 'https://cdn/cover.webp');
    expect(screen.getByText('Band: Song')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByLabelText('Volume')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Full screen' })).not.toBeInTheDocument();
    expect(document.querySelector('audio')).not.toHaveAttribute('controls');
  });

  it('shows the waveform strip when there is no cover', () => {
    render(<AudioRenderer file={audio({ assets: { waveform: { url: 'https://cdn/waveform.webp' } } })} />);
    expect(screen.getByTestId('audio-waveform')).toHaveAttribute('src', 'https://cdn/waveform.webp');
    expect(screen.queryByTestId('audio-cover')).not.toBeInTheDocument();
  });

  it('draws the peaks seek bar once peaks.json loads, with a plain bar until then', async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal('fetch', fetchMock);
    render(<AudioRenderer file={audio({ assets: { peaks: { url: PEAKS } } })} />);
    expect(fetchMock).toHaveBeenCalledWith(PEAKS, expect.anything());
    expect(screen.getByTestId('seek-bar')).toBeInTheDocument();
    resolve(new Response(JSON.stringify({ version: 1, length: 4, peaks: [0.1, 0.5, 1, 0.2] })));
    expect(await screen.findByTestId('peaks-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('seek-bar')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Seek')).toBeInTheDocument();
  });

  it('keeps the plain bar if peaks.json fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AudioRenderer file={audio({ assets: { peaks: { url: PEAKS } } })} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('seek-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('peaks-bar')).not.toBeInTheDocument();
  });

  it('seeks from the peaks bar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 1, peaks: [0.5, 0.5] }))));
    const { container } = render(<AudioRenderer file={audio({ assets: { peaks: { url: PEAKS } } })} />);
    const values = fakeMedia(container.querySelector('audio')!, { duration: 200 });
    await screen.findByTestId('peaks-bar');
    fireEvent.change(screen.getByLabelText('Seek'), { target: { value: '100' } });
    expect(values.currentTime).toBe(100);
    expect(container.querySelector('clipPath rect')).toHaveAttribute('width', '1');
  });

  it('shares the keyboard shortcuts and saved volume, minus fullscreen', () => {
    const { container } = render(<AudioRenderer file={audio()} />);
    const values = fakeMedia(container.querySelector('audio')!);
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(values.paused).toBe(false);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(values.currentTime).toBe(5);
    fireEvent.keyDown(document.body, { key: 'f' }); // nothing to do, no error
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0.25' } });
    expect(localStorage.getItem(VOLUME_KEY)).toBe('0.25');
  });

  it('shows the not-playable message, not a player or a second Download, when not playable', () => {
    render(<AudioRenderer file={audio({ media: { playable: false, tags: { title: 'Song', artist: 'Band' } } })} />);
    expect(screen.getByText("This audio can't play in the browser")).toBeInTheDocument();
    // Download is the footer's (one per card).
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
    expect(screen.getByText('Band: Song')).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('shows the music icon and a plain bar while processing', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<AudioRenderer file={audio({ processing: true, media: undefined })} />);
    expect(document.querySelector('svg.lucide-music')).not.toBeNull();
    expect(screen.getByTestId('seek-bar')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
