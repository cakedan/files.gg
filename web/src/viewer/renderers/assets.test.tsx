import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FileData } from '../types';
import { coverUrl, imageSrc, isBrowserImage, posterUrl, tileImage, waveformUrl } from './assets';
import { GenericRenderer } from './GenericRenderer';
import { ImageRenderer } from './ImageRenderer';
import { getRenderer } from './index';

const DISPLAY = 'https://cdn.files.gg/previews/display/IMG_1.webp?v=1';

const image = (extra: Partial<FileData> = {}): FileData => ({
  kind: 'image',
  filename: 'IMG_1.heic',
  mimetype: 'image/heic',
  extension: 'heic',
  size: 1,
  width: 400,
  height: 300,
  cdn_url: 'https://cdn.files.gg/files/IMG_1.heic',
  uploaded_at: 0,
  expires_at: null,
  ...extra,
});

describe('display selection', () => {
  it('shows assets.display for types browsers cannot display', () => {
    expect(isBrowserImage('image/PNG')).toBe(true);
    expect(isBrowserImage('image/heic')).toBe(false);
    expect(imageSrc(image({ assets: { display: { url: DISPLAY } } }))).toBe(DISPLAY);
    expect(imageSrc(image({ mimetype: 'image/tiff', assets: { display: { url: DISPLAY } } }))).toBe(DISPLAY);
  });

  it('keeps the original for browser types, and when there is no display preview', () => {
    expect(imageSrc(image({ mimetype: 'image/png', assets: { display: { url: DISPLAY } } }))).toBe('https://cdn.files.gg/files/IMG_1.heic');
    expect(imageSrc(image())).toBe('https://cdn.files.gg/files/IMG_1.heic');
  });

  it('renders the display preview in the image renderer and its lightbox', () => {
    render(<ImageRenderer file={image({ assets: { display: { url: DISPLAY } } })} />);
    expect(screen.getByRole('img', { name: 'IMG_1.heic' })).toHaveAttribute('src', DISPLAY);
    fireEvent.click(screen.getByRole('button', { name: /open img_1.heic full screen/i }));
    expect(screen.getAllByRole('img', { name: 'IMG_1.heic' }).map((img) => img.getAttribute('src'))).toEqual([DISPLAY, DISPLAY]);
  });
});

describe('poster, cover and waveform', () => {
  it('prefers the matching thumbnail, then the asset', () => {
    const file = { thumbnail: { url: 'https://t/poster', type: 'poster' }, assets: { poster: { url: 'https://a/poster' }, cover: { url: 'https://a/cover' } } };
    expect(posterUrl(file)).toBe('https://t/poster');
    expect(coverUrl(file)).toBe('https://a/cover');
    expect(waveformUrl(file)).toBeUndefined();
    expect(waveformUrl({ thumbnail: { url: 'https://t/wave', type: 'waveform' } })).toBe('https://t/wave');
  });
});

describe('tileImage', () => {
  const base = { kind: 'image' as const, cdn_url: 'https://cdn/orig.png', mimetype: 'image/png' };

  it('uses thumb with thumb-2x in srcset, sized to the tile', () => {
    const assets = {
      thumb: { url: 'https://cdn/thumb.webp', width: 320, height: 240 },
      'thumb-2x': { url: 'https://cdn/thumb-2x.webp', width: 640, height: 480 },
    };
    expect(tileImage({ ...base, assets }, 251.4)).toEqual({
      src: 'https://cdn/thumb.webp',
      srcSet: 'https://cdn/thumb.webp 320w, https://cdn/thumb-2x.webp 640w',
      sizes: '252px',
    });
    expect(tileImage({ ...base, assets })).toEqual({ src: 'https://cdn/thumb.webp', srcSet: 'https://cdn/thumb.webp 1x, https://cdn/thumb-2x.webp 2x' });
    expect(tileImage({ ...base, assets: { thumb: assets.thumb } }, 200)).toEqual({ src: 'https://cdn/thumb.webp' });
  });

  it('falls back to the thumbnail, then the image itself (or its display preview), then nothing', () => {
    expect(tileImage({ ...base, kind: 'video', thumbnail: { url: 'https://cdn/poster.webp', type: 'poster' } })).toEqual({ src: 'https://cdn/poster.webp' });
    expect(tileImage(base)).toEqual({ src: 'https://cdn/orig.png' });
    expect(tileImage({ ...base, mimetype: 'image/heic', assets: { display: { url: DISPLAY } } })).toEqual({ src: DISPLAY });
    expect(tileImage({ ...base, kind: 'video' })).toBeNull();
  });
});

describe('signed URLs', () => {
  it('pass through untouched', () => {
    const sig = 'expires=1795603600&sig=fMPOSZt5evpHirGRjA7CFTi-t1VKo-Sz_TRY51c0lx0';
    const thumb = { url: `https://cdn.files.gg/previews/thumb/abc.webp?v=5&${sig}`, width: 320, height: 240 };
    const display = `https://cdn.files.gg/previews/display/abc.webp?v=5&${sig}`;
    const file = image({ visibility: 'password', assets: { thumb, display: { url: display } } });
    expect(imageSrc(file)).toBe(display);
    expect(tileImage(file)).toEqual({ src: thumb.url });
  });
});

describe('renderer registry', () => {
  it('has lazy renderers for text, video and audio', () => {
    for (const kind of ['text', 'video', 'audio'] as const) expect(getRenderer(kind)).not.toBe(GenericRenderer);
    expect(getRenderer('file')).toBe(GenericRenderer);
  });
});
