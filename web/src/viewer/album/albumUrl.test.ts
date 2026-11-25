import { describe, expect, it } from 'vitest';

import { albumPath, albumShareUrl, clampIndex, parseAlbumItem, parseAlbumPath, stepIndex } from './albumUrl';

describe('album URLs', () => {
  it('parses /a/<vanity> and ?item=<n> (1-based); nothing comes after the vanity', () => {
    expect(parseAlbumPath('/a/Ab3dE6gH')).toEqual({ vanity: 'Ab3dE6gH', index: null });
    expect(parseAlbumPath('/a/Ab3dE6gH/')).toEqual({ vanity: 'Ab3dE6gH', index: null });
    expect(parseAlbumPath('/a/Ab3dE6gH', '?item=3')).toEqual({ vanity: 'Ab3dE6gH', index: 2 });
    expect(parseAlbumPath('/a/Ab3dE6gH', '?fixture=album-grid&item=12')).toEqual({ vanity: 'Ab3dE6gH', index: 11 });
    for (const search of ['?item=0', '?item=-1', '?item=x', '?item=', '?item=1.5', '?item=1e3', '?other=3', '']) {
      expect(parseAlbumPath('/a/Ab3dE6gH', search)).toEqual({ vanity: 'Ab3dE6gH', index: null });
    }
    expect(parseAlbumPath('/a/caf%C3%A9')).toEqual({ vanity: 'café', index: null });
    expect(parseAlbumPath('/abc.png')).toBeNull();
    expect(parseAlbumPath('/a/Ab3dE6gH/3')).toBeNull();
    expect(parseAlbumPath('/a/x/y/z')).toBeNull();
    expect(parseAlbumItem('?item=7')).toBe(6);
  });

  it('builds URLs with ?item=, keeping the rest of the query and the fragment', () => {
    expect(albumPath('v', null)).toBe('/a/v');
    expect(albumPath('v', 0)).toBe('/a/v?item=1');
    expect(albumPath('v', 4, '?fixture=album-grid')).toBe('/a/v?fixture=album-grid&item=5');
    expect(albumPath('v', 4, '?item=2&fixture=album-grid', '#pw=amber-tunnel')).toBe('/a/v?item=5&fixture=album-grid#pw=amber-tunnel');
    expect(albumPath('v', null, '?item=2&fixture=album-grid', '#t=tok')).toBe('/a/v?fixture=album-grid#t=tok');
    expect(albumPath('a b', 1)).toBe('/a/a%20b?item=2');
  });

  it('round-trips every item through the URL', () => {
    for (const index of [0, 1, 9, 99]) {
      const url = new URL(albumPath('Ab3', index, '?fixture=x', '#pw=p'), 'https://files.gg');
      expect(parseAlbumPath(url.pathname, url.search)).toEqual({ vanity: 'Ab3', index });
      expect(url.hash).toBe('#pw=p');
    }
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
