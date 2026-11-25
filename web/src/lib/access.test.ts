import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accessStorageKey,
  albumWithAccessToken,
  appendToken,
  clearAccess,
  loadAccess,
  readFragmentSecrets,
  readTokenClaims,
  refreshDelay,
  refreshExtended,
  REFRESH_LEAD_MS,
  saveAccess,
  takeFragmentSecrets,
  targetFromPath,
  urlSwapDelay,
  withAccessToken,
} from './access';

// Contract §1 test vector (secret `test-cdn-token-secret`).
const VECTOR =
  'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjB9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk';

afterEach(() => localStorage.clear());

describe('token storage', () => {
  const NOW = 1_795_600_000_000;

  it('stores per kind and vanity, and drops expired tokens', () => {
    saveAccess('file', 'abc', { token: 't1', expires_at: NOW / 1000 + 60 });
    expect(loadAccess('file', 'abc', NOW)).toEqual({ token: 't1', expires_at: NOW / 1000 + 60 });
    expect(loadAccess('album', 'abc', NOW)).toBeNull();
    expect(loadAccess('file', 'abc', NOW + 61_000)).toBeNull();
    expect(localStorage.getItem(accessStorageKey('file', 'abc'))).toBeNull();
  });

  it('ignores corrupt entries and clears on request', () => {
    localStorage.setItem(accessStorageKey('file', 'x'), '{nope');
    expect(loadAccess('file', 'x', NOW)).toBeNull();
    saveAccess('file', 'y', { token: 't', expires_at: NOW / 1000 + 600 });
    clearAccess('file', 'y');
    expect(loadAccess('file', 'y', NOW)).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => saveAccess('file', 'z', { token: 't', expires_at: 2e9 })).not.toThrow();
    expect(loadAccess('file', 'z')).toBeNull();
  });
});

describe('refresh timing', () => {
  const now = 1_000_000_000;

  it('refreshes 5 minutes before expiry', () => {
    const expiresAt = (now + 3600_000) / 1000;
    expect(refreshDelay(expiresAt, now)).toBe(3600_000 - REFRESH_LEAD_MS);
  });

  it('refreshes at half-life when less than 10 minutes are left', () => {
    expect(refreshDelay((now + 4 * 60_000) / 1000, now)).toBe(2 * 60_000);
  });

  it('refreshes immediately when already expired', () => {
    expect(refreshDelay(now / 1000 - 1, now)).toBe(0);
  });

  it('notices when the server stops extending (cap reached)', () => {
    expect(refreshExtended({ token: 'a', expires_at: 100 }, { token: 'b', expires_at: 200 })).toBe(true);
    expect(refreshExtended({ token: 'a', expires_at: 200 }, { token: 'b', expires_at: 200 })).toBe(false);
  });

  it('swaps media URLs to a new token only 2 minutes before theirs expires', () => {
    expect(urlSwapDelay((now + 10 * 60_000) / 1000, now)).toBe(8 * 60_000);
    expect(urlSwapDelay((now + 60_000) / 1000, now)).toBe(0);
  });
});

describe('claims', () => {
  it('reads the contract test vector without verifying it', () => {
    expect(readTokenClaims(VECTOR)).toEqual({ e: 1795603600, k: 'file', s: 'unlock', t: '1234567890123456789', u: 1795600000, v: 0 });
  });

  it('rejects things that are not tokens', () => {
    expect(readTokenClaims('nope')).toBeNull();
    expect(readTokenClaims('a.b.c')).toBeNull();
    expect(readTokenClaims('e30.sig')).toBeNull();
  });
});

describe('URL tokens', () => {
  it('appends t, keeping other parameters', () => {
    expect(appendToken('https://cdn.files.gg/files/a.png', 'tok')).toBe('https://cdn.files.gg/files/a.png?t=tok');
    expect(appendToken('https://cdn.files.gg/files/a.png?download=true', 'tok')).toBe(
      'https://cdn.files.gg/files/a.png?download=true&t=tok',
    );
    expect(appendToken('https://cdn.files.gg/files/a.png?t=old', 'new')).toBe('https://cdn.files.gg/files/a.png?t=new');
  });

  const file = {
    cdnUrl: 'https://cdn.files.gg/files/a.pdf',
    url: 'https://files.gg/a.pdf',
    thumbnail: { url: 'https://cdn.files.gg/files/a/thumb.webp', type: 'thumb' },
    hover_url: 'https://cdn.files.gg/files/a/hover.mp4',
  };

  it('signs every media URL of a protected file, never the share link', () => {
    const signed = withAccessToken({ ...file, visibility: 'password' as const }, 'tok');
    expect(signed.cdnUrl).toBe('https://cdn.files.gg/files/a.pdf?t=tok');
    expect(signed.thumbnail.url).toBe('https://cdn.files.gg/files/a/thumb.webp?t=tok');
    expect(signed.hover_url).toBe('https://cdn.files.gg/files/a/hover.mp4?t=tok');
    expect(signed.url).toBe('https://files.gg/a.pdf');
  });

  it('adds no ?t= to `link` files', () => {
    const linkFile = { ...file, visibility: 'link' as const };
    expect(withAccessToken(linkFile, 'tok')).toBe(linkFile);
  });

  it('signs album covers and protected items, and keeps the token for Download all', () => {
    const album = {
      cover: { url: 'https://cdn.files.gg/c.webp' },
      items: [
        { cdnUrl: 'https://cdn.files.gg/1.png', visibility: 'password' as const },
        { cdnUrl: 'https://cdn.files.gg/2.png', visibility: 'link' as const },
      ],
    };
    const signed = albumWithAccessToken(album, 'tok');
    expect(signed.cover?.url).toBe('https://cdn.files.gg/c.webp?t=tok');
    expect(signed.items.map((i) => i.cdnUrl)).toEqual(['https://cdn.files.gg/1.png?t=tok', 'https://cdn.files.gg/2.png']);
    expect((signed as { accessToken?: string }).accessToken).toBe('tok');
  });
});

describe('fragments', () => {
  it('reads #pw= and #t=, keeping other fragment params', () => {
    expect(readFragmentSecrets('#pw=amber-tunnel')).toEqual({ password: 'amber-tunnel', rest: '' });
    expect(readFragmentSecrets('#t=abc.def&page=3')).toEqual({ ownerPass: 'abc.def', rest: '#page=3' });
    expect(readFragmentSecrets('#pw=a%20b%23c')).toMatchObject({ password: 'a b#c' });
    expect(readFragmentSecrets('#page=2')).toEqual({ rest: '#page=2' });
  });

  it('strips secrets from the address bar with replaceState', () => {
    window.history.replaceState(null, '', '/abc123.png?x=1#pw=secret-pass&page=2');
    const secrets = takeFragmentSecrets();
    expect(secrets.password).toBe('secret-pass');
    expect(window.location.href).toBe(`${window.location.origin}/abc123.png?x=1#page=2`);
    expect(window.location.hash).not.toContain('secret');
  });

  it('leaves the URL alone without secrets', () => {
    window.history.replaceState(null, '', '/abc#page=4');
    const replace = vi.spyOn(window.history, 'replaceState');
    takeFragmentSecrets();
    expect(replace).not.toHaveBeenCalled();
  });

  it('finds the target from the path', () => {
    expect(targetFromPath('/abc123')).toEqual({ kind: 'file', vanity: 'abc123' });
    expect(targetFromPath('/abc123.png')).toEqual({ kind: 'file', vanity: 'abc123' });
    expect(targetFromPath('/abcd/xyz.png')).toEqual({ kind: 'file', vanity: 'abcd/xyz' });
    expect(targetFromPath('/a/Ab3dE6gH/2')).toEqual({ kind: 'album', vanity: 'Ab3dE6gH' });
    expect(targetFromPath('/')).toBeNull();
  });
});
