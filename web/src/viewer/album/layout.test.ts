import { describe, expect, it } from 'vitest';

import type { AlbumItem } from '../types';
import { albumArtist, albumName, chooseLayout, itemAspect, justifyRows, MAX_ASPECT, targetRowHeight, trackTitle } from './layout';

const item = (kind: AlbumItem['kind'], extra: Partial<AlbumItem> = {}): AlbumItem => ({
  kind,
  filename: `x.${kind}`,
  mimetype: 'x/y',
  extension: kind,
  size: 1,
  cdnUrl: 'https://cdn/x',
  uploadedAt: 0,
  expiresAt: null,
  position: 0,
  caption: '',
  ...extra,
});

describe('chooseLayout', () => {
  it('uses a tracklist when every item is audio (auto or tracklist)', () => {
    expect(chooseLayout({ layout: 'auto', items: [item('audio'), item('audio')] })).toBe('tracklist');
    expect(chooseLayout({ layout: 'tracklist', items: [item('audio')] })).toBe('tracklist');
  });

  it('falls back to a grid when anything is not audio', () => {
    expect(chooseLayout({ layout: 'auto', items: [item('audio'), item('image')] })).toBe('grid');
    expect(chooseLayout({ layout: 'tracklist', items: [item('audio'), item('pdf')] })).toBe('grid');
    expect(chooseLayout({ layout: 'auto', items: [] })).toBe('grid');
  });

  it('respects an explicit grid or list, even for audio', () => {
    expect(chooseLayout({ layout: 'list', items: [item('audio')] })).toBe('list');
    expect(chooseLayout({ layout: 'grid', items: [item('audio')] })).toBe('grid');
  });
});

describe('itemAspect', () => {
  it('prefers the file size, then the thumbnail, then a per-kind default', () => {
    expect(itemAspect(item('image', { width: 1600, height: 900 }))).toBeCloseTo(16 / 9);
    expect(itemAspect(item('pdf', { thumbnail: { url: 'u', type: 'thumb', width: 240, height: 310 } }))).toBeCloseTo(240 / 310);
    expect(itemAspect(item('pdf'))).toBeCloseTo(0.77);
    expect(itemAspect(item('video'))).toBeCloseTo(16 / 9);
    expect(itemAspect(item('file'))).toBe(1);
  });

  it('clamps extreme panoramas', () => {
    expect(itemAspect(item('image', { width: 10000, height: 100 }))).toBe(MAX_ASPECT);
  });
});

describe('justifyRows', () => {
  const options = { containerWidth: 1000, targetHeight: 200, gap: 10 };
  const rowWidth = (row: { tiles: { width: number }[] }) =>
    row.tiles.reduce((sum, t) => sum + t.width, 0) + options.gap * (row.tiles.length - 1);

  it('fills full rows exactly to the container width', () => {
    const rows = justifyRows([1.5, 1, 1.5, 1, 2, 0.75, 1.5], options);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) expect(rowWidth(row)).toBe(1000);
  });

  it('keeps every tile in a row at the same height and the aspect ratio within a pixel', () => {
    const aspects = [1.5, 1, 1.5, 1, 2];
    const [row] = justifyRows(aspects, options);
    const height = row!.height;
    for (const tile of row!.tiles.slice(0, -1)) {
      expect(tile.height).toBe(height);
      expect(Math.abs(tile.width - aspects[tile.index]! * height)).toBeLessThanOrEqual(1);
    }
  });

  it('does not stretch the last, incomplete row', () => {
    const rows = justifyRows([1.5, 1.5, 1.5, 1.5, 1.5, 1], options);
    const last = rows.at(-1)!;
    expect(last.height).toBe(200);
    expect(rowWidth(last)).toBeLessThanOrEqual(1000);
  });

  it('caps a single very wide item at the container width', () => {
    const [row] = justifyRows([10], options);
    expect(row!.tiles[0]!.width).toBeLessThanOrEqual(1000);
    expect(row!.height).toBe(100);
  });

  it('keeps every index exactly once, in order', () => {
    const rows = justifyRows([1, 2, 0.5, 1, 1, 1, 3, 0.7], options);
    expect(rows.flatMap((r) => r.tiles.map((t) => t.index))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns nothing before the container is measured', () => {
    expect(justifyRows([1, 1], { ...options, containerWidth: 0 })).toEqual([]);
  });

  it('uses smaller rows on phones', () => {
    expect(targetRowHeight(340)).toBeLessThan(targetRowHeight(1100));
  });
});

describe('track tags', () => {
  const tagged = (artist?: string, album?: string, title?: string) =>
    item('audio', { filename: 'song.mp3', extension: 'mp3', media: { tags: { artist, album, title } } });

  it('derives artist and album names', () => {
    expect(albumArtist([tagged('A'), tagged('A')])).toBe('A');
    expect(albumArtist([tagged('A'), tagged('B')])).toBe('Various artists');
    expect(albumArtist([tagged()])).toBeNull();
    expect(albumName([tagged('A', 'X'), tagged('A', 'X')])).toBe('X');
    expect(albumName([tagged('A', 'X'), tagged('A', 'Y')])).toBeNull();
  });

  it('titles tracks from tags, else the filename without extension', () => {
    expect(trackTitle(tagged(undefined, undefined, 'Intro'))).toBe('Intro');
    expect(trackTitle(tagged())).toBe('song');
  });
});
