import { describe, expect, it } from 'vitest';

import { albumPath, albumShareUrl, clampIndex, parseAlbumPath, stepIndex } from './albumUrl';

describe('album URLs', () => {
  it('parses /a/<vanity> and /a/<vanity>/<n> (1-based)', () => {
    expect(parseAlbumPath('/a/Ab3dE6gH')).toEqual({ vanity: 'Ab3dE6gH', index: null });
    expect(parseAlbumPath('/a/Ab3dE6gH/')).toEqual({ vanity: 'Ab3dE6gH', index: null });
    expect(parseAlbumPath('/a/Ab3dE6gH/3')).toEqual({ vanity: 'Ab3dE6gH', index: 2 });
    expect(parseAlbumPath('/a/Ab3dE6gH/0')).toEqual({ vanity: 'Ab3dE6gH', index: null });
    expect(parseAlbumPath('/abc.png')).toBeNull();
    expect(parseAlbumPath('/a/x/y/z')).toBeNull();
  });

  it('builds paths, keeping the query string', () => {
    expect(albumPath('v', null)).toBe('/a/v');
    expect(albumPath('v', 0)).toBe('/a/v/1');
    expect(albumPath('v', 4, '?fixture=album-grid')).toBe('/a/v/5?fixture=album-grid');
  });

  it('prefers the canonical share URL', () => {
    expect(albumShareUrl('v', 'https://files.gg/a/v')).toBe('https://files.gg/a/v');
    expect(albumShareUrl('v', undefined, 'https://files.gg')).toBe('https://files.gg/a/v');
  });

  it('clamps and steps indexes', () => {
    expect(clampIndex(2, 3)).toBe(2);
    expect(clampIndex(3, 3)).toBeNull();
    expect(clampIndex(-1, 3)).toBeNull();
    expect(clampIndex(null, 3)).toBeNull();
    expect(stepIndex(0, 3, -1)).toBe(0);
    expect(stepIndex(2, 3, 1)).toBe(2);
    expect(stepIndex(1, 3, 1)).toBe(2);
  });
});
