import { afterEach, describe, expect, it, vi } from 'vitest';

import { ownsKeyEvent, playerKeyAction, type KeyTarget } from './keys';
import { downsamplePeaks, fetchPeaks, parsePeaks, peaksPath } from './peaks';
import { loadVolumePrefs, MUTED_KEY, saveVolumePrefs, VOLUME_KEY } from './prefs';
import { tagLine } from './tagLine';
import { formatTime, spokenTime } from './time';

const free: KeyTarget = { onButton: false, onSlider: false, editable: false, fullscreen: true };

describe('playerKeyAction', () => {
  it('maps space/k, arrows, m and f', () => {
    expect(playerKeyAction({ key: ' ' }, free)).toBe('toggle');
    expect(playerKeyAction({ key: 'k' }, free)).toBe('toggle');
    expect(playerKeyAction({ key: 'K' }, free)).toBe('toggle');
    expect(playerKeyAction({ key: 'ArrowLeft' }, free)).toBe('back');
    expect(playerKeyAction({ key: 'ArrowRight' }, free)).toBe('forward');
    expect(playerKeyAction({ key: 'm' }, free)).toBe('mute');
    expect(playerKeyAction({ key: 'f' }, free)).toBe('fullscreen');
    expect(playerKeyAction({ key: 'x' }, free)).toBeNull();
  });

  it('ignores modified keys and text fields', () => {
    expect(playerKeyAction({ key: 'k', ctrlKey: true }, free)).toBeNull();
    expect(playerKeyAction({ key: 'ArrowLeft', metaKey: true }, free)).toBeNull();
    expect(playerKeyAction({ key: ' ', altKey: true }, free)).toBeNull();
    expect(playerKeyAction({ key: 'm' }, { ...free, editable: true })).toBeNull();
  });

  it('leaves Space to focused buttons, arrows to the volume slider, and f to players with fullscreen', () => {
    expect(playerKeyAction({ key: ' ' }, { ...free, onButton: true })).toBeNull();
    expect(playerKeyAction({ key: 'k' }, { ...free, onButton: true })).toBe('toggle');
    expect(playerKeyAction({ key: 'ArrowRight' }, { ...free, onSlider: true })).toBeNull();
    expect(playerKeyAction({ key: 'f' }, { ...free, fullscreen: false })).toBeNull();
  });
});

describe('ownsKeyEvent', () => {
  it('owns events inside the player, and idle-page events only with global keys', () => {
    const root = document.createElement('div');
    const inner = document.createElement('button');
    const outside = document.createElement('input');
    root.append(inner);
    document.body.append(root, outside);
    expect(ownsKeyEvent(root, inner, false)).toBe(true);
    expect(ownsKeyEvent(root, document.body, true)).toBe(true);
    expect(ownsKeyEvent(root, document.body, false)).toBe(false);
    expect(ownsKeyEvent(root, outside, true)).toBe(false);
    expect(ownsKeyEvent(null, inner, true)).toBe(false);
    root.remove();
    outside.remove();
  });
});

describe('volume prefs', () => {
  afterEach(() => localStorage.clear());

  it('defaults to full volume, unmuted', () => {
    expect(loadVolumePrefs()).toEqual({ volume: 1, muted: false });
  });

  it('round-trips through filesgg.volume / filesgg.muted', () => {
    saveVolumePrefs({ volume: 0.456, muted: true });
    expect(localStorage.getItem(VOLUME_KEY)).toBe('0.46');
    expect(localStorage.getItem(MUTED_KEY)).toBe('true');
    expect(loadVolumePrefs()).toEqual({ volume: 0.46, muted: true });
  });

  it('clamps and ignores junk', () => {
    localStorage.setItem(VOLUME_KEY, '7');
    expect(loadVolumePrefs().volume).toBe(1);
    localStorage.setItem(VOLUME_KEY, 'loud');
    localStorage.setItem(MUTED_KEY, 'yes');
    expect(loadVolumePrefs()).toEqual({ volume: 1, muted: false });
  });

  it('never throws when storage does', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadVolumePrefs()).toEqual({ volume: 1, muted: false });
    expect(() => saveVolumePrefs({ volume: 0.2, muted: false })).not.toThrow();
  });
});

describe('peaks', () => {
  it('accepts version 1 files and clamps values', () => {
    expect(parsePeaks({ version: 1, length: 3, peaks: [0, 0.5, 1.4] })).toEqual([0, 0.5, 1]);
    expect(parsePeaks({ version: 1, peaks: [-1] })).toEqual([0]);
  });

  it.each([
    ['null', null],
    ['wrong version', { version: 2, peaks: [0.1] }],
    ['no peaks', { version: 1, peaks: [] }],
    ['non-numbers', { version: 1, peaks: [0.1, 'x'] }],
    ['NaN', { version: 1, peaks: [Number.NaN] }],
  ])('rejects %s', (_label, value) => {
    expect(parsePeaks(value)).toBeNull();
  });

  it('downsamples by bucket maximum', () => {
    expect(downsamplePeaks([0.1, 0.9, 0.2, 0.3, 0.8, 0.1], 3)).toEqual([0.9, 0.3, 0.8]);
    expect(downsamplePeaks([0.1, 0.2], 5)).toEqual([0.1, 0.2]);
    expect(downsamplePeaks(new Array(1000).fill(0.5), 160)).toHaveLength(160);
  });

  it('draws one bar per value', () => {
    expect(peaksPath([0, 1]).match(/M/g)).toHaveLength(2);
  });

  it('fetches and validates, rejecting errors and bad files', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, length: 2, peaks: [0.2, 0.4] })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPeaks('https://cdn.files.gg/media/1/peaks.json?v=1&t=x')).resolves.toEqual([0.2, 0.4]);
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.files.gg/media/1/peaks.json?v=1&t=x', expect.anything());
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(fetchPeaks('u')).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response('{"version":1}'));
    await expect(fetchPeaks('u')).rejects.toThrow();
  });
});

describe('time and tags', () => {
  it('formats m:ss, and h:mm:ss for long media', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(65, 3600)).toBe('0:01:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(spokenTime(61)).toBe('1 minute 1 second');
  });

  it('builds "Artist: Title" only when both tags exist', () => {
    expect(tagLine({ media: { tags: { title: 'Song', artist: 'Band' } } })).toBe('Band: Song');
    expect(tagLine({ media: { tags: { title: 'Song' } } })).toBe('Song');
    expect(tagLine({ media: { tags: { artist: 'Band' } } })).toBeNull();
    expect(tagLine({})).toBeNull();
  });
});
