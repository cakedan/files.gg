import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileData } from '../types';
import { fakeMedia } from './fakeMedia';
import { MUTED_KEY, VOLUME_KEY } from './prefs';
import VideoRenderer from './VideoRenderer';

const video = (extra: Partial<FileData> = {}): FileData => ({
  kind: 'video',
  filename: 'clip.mp4',
  mimetype: 'video/mp4',
  extension: 'mp4',
  size: 1000,
  width: 640,
  height: 360,
  duration: 60_000,
  cdn_url: 'https://cdn.files.gg/files/clip.mp4',
  thumbnail: { url: 'https://cdn.files.gg/media/1/poster.webp?v=1', type: 'poster' },
  media: { playable: true },
  uploaded_at: 0,
  expires_at: null,
  ...extra,
});

function setup(file = video(), context?: 'card' | 'list' | 'lightbox') {
  const view = render(<VideoRenderer file={file} context={context} />);
  const element = view.container.querySelector('video')!;
  const values = fakeMedia(element, { duration: 60 });
  return { ...view, element, values };
}

afterEach(() => {
  localStorage.clear();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('VideoRenderer', () => {
  it('uses the poster thumbnail and replaces the native controls', () => {
    const { element } = setup();
    expect(element).toHaveAttribute('poster', 'https://cdn.files.gg/media/1/poster.webp?v=1');
    expect(element).not.toHaveAttribute('controls');
    expect(screen.getByRole('region', { name: 'Video player: clip.mp4' })).toBeInTheDocument();
    for (const name of ['Play', 'Seek', 'Mute', 'Volume', 'Playback speed: 1×', 'Full screen']) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
    expect(screen.getByText('1:00', { exact: false })).toBeInTheDocument();
  });

  it('falls back to assets.poster when the thumbnail is not a poster', () => {
    const { element } = setup(
      video({ thumbnail: { url: 'https://cdn/thumb.webp', type: 'thumb' }, assets: { poster: { url: 'https://cdn/poster.webp' } } }),
    );
    expect(element).toHaveAttribute('poster', 'https://cdn/poster.webp');
  });

  it('shows "This video can\'t play in the browser", with no second Download, when not playable', () => {
    render(<VideoRenderer file={video({ media: { playable: false } })} />);
    expect(screen.getByText("This video can't play in the browser")).toBeInTheDocument();
    // Download is the footer's (one per card).
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
    expect(document.querySelector('video')).toBeNull();
  });

  it('switches to the not-playable state when the video fails to load', () => {
    const { element } = setup();
    fireEvent.error(element);
    expect(screen.getByText("This video can't play in the browser")).toBeInTheDocument();
  });

  it('plays and pauses from the button and the video itself', () => {
    const { element, values } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(values.paused).toBe(false);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    fireEvent.click(element);
    expect(values.paused).toBe(true);
  });

  it('handles space/k, ←/→, m and f when nothing else has focus (single-file page)', () => {
    const { values, container } = setup();
    const fullscreen = vi.fn().mockResolvedValue(undefined);
    (container.querySelector('[data-own-keys]') as HTMLElement).requestFullscreen = fullscreen;

    fireEvent.keyDown(document.body, { key: ' ' });
    expect(values.paused).toBe(false);
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(values.paused).toBe(true);

    values.currentTime = 20;
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(values.currentTime).toBe(25);
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(values.currentTime).toBe(15);
    values.currentTime = 2;
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(values.currentTime).toBe(0);

    fireEvent.keyDown(document.body, { key: 'm' });
    expect(values.muted).toBe(true);
    fireEvent.keyDown(document.body, { key: 'f' });
    expect(fullscreen).toHaveBeenCalledOnce();

    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(values.paused).toBe(true);
  });

  it('ignores page keys outside the player in an album, but handles them inside', () => {
    const { values } = setup(video(), 'lightbox');
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(values.paused).toBe(true);
    const seek = screen.getByLabelText('Seek');
    seek.focus();
    fireEvent.keyDown(seek, { key: 'k' });
    expect(values.paused).toBe(false);
    fireEvent.keyDown(seek, { key: 'ArrowRight' });
    expect(values.currentTime).toBe(5);
  });

  it('ignores keys typed into other fields', () => {
    const { values } = setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'k' });
    expect(values.paused).toBe(true);
    input.remove();
  });

  it('applies the saved volume and saves changes to filesgg.volume / filesgg.muted', () => {
    localStorage.setItem(VOLUME_KEY, '0.3');
    localStorage.setItem(MUTED_KEY, 'true');
    const view = render(<VideoRenderer file={video()} />);
    const element = view.container.querySelector('video')!;
    expect(element.volume).toBeCloseTo(0.3);
    expect(element.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument();

    const values = fakeMedia(element);
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0.6' } });
    expect(values.volume).toBeCloseTo(0.6);
    expect(values.muted).toBe(false);
    expect(localStorage.getItem(VOLUME_KEY)).toBe('0.6');
    expect(localStorage.getItem(MUTED_KEY)).toBe('false');
  });

  it('still plays when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { values } = setup();
    fireEvent.keyDown(document.body, { key: 'm' });
    expect(values.muted).toBe(true);
  });

  it('seeks with the slider and shows the buffered range', () => {
    const { values } = setup();
    fireEvent.change(screen.getByLabelText('Seek'), { target: { value: '30' } });
    expect(values.currentTime).toBe(30);
    expect(screen.getByLabelText('Seek')).toHaveAttribute('aria-valuetext', '30 seconds of 1 minute 0 seconds');
    expect(parseFloat(screen.getByTestId('seek-buffered').style.width)).toBeCloseTo((40 / 60) * 100, 2);
  });

  it('sets the speed (0.25× to 2×) and the keep-pitch toggle', () => {
    const { values } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Playback speed: 1×' }));
    const menu = screen.getByRole('group', { name: 'Playback speed' });
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '0.25×',
      '0.5×',
      '0.75×',
      '1×',
      '1.25×',
      '1.5×',
      '1.75×',
      '2×',
    ]);
    fireEvent.click(within(menu).getByRole('button', { name: '1.5×' }));
    expect(values.playbackRate).toBe(1.5);
    expect(screen.getByRole('button', { name: 'Playback speed: 1.5×' })).toBeInTheDocument();

    const pitch = within(menu).getByRole('checkbox', { name: 'Keep pitch' });
    expect(pitch).toBeChecked();
    fireEvent.click(pitch);
    expect(values.preservesPitch).toBe(false);
    expect(pitch).not.toBeChecked();

    fireEvent.keyDown(pitch, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Playback speed' })).not.toBeInTheDocument();
  });

  it('hides the controls after 2.5 s of no movement while playing', () => {
    vi.useFakeTimers();
    try {
      const { container } = setup();
      const root = container.querySelector('[data-own-keys]')!;
      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      fireEvent.pointerMove(root);
      act(() => vi.advanceTimersByTime(2400));
      expect(root).not.toHaveAttribute('data-idle');
      act(() => vi.advanceTimersByTime(200));
      expect(root).toHaveAttribute('data-idle');
      fireEvent.pointerMove(root);
      expect(root).not.toHaveAttribute('data-idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the type icon over the player while processing without a poster', () => {
    const { container } = setup(video({ thumbnail: undefined, processing: true }));
    expect(container.querySelector('video')).not.toHaveAttribute('poster');
    expect(container.querySelector('svg.lucide-file-video, svg[class*="lucide-file-video"]')).not.toBeNull();
    expect(container.querySelector('video')!.getAttribute('style')).toContain('--media-w: 640');
  });
});
