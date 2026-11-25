import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accessStorageKey,
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
  watchFragmentSecrets,
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

  it('strips and hands on secrets that arrive by a later hash change', () => {
    window.history.replaceState(null, '', '/abc123');
    const seen: unknown[] = [];
    const stop = watchFragmentSecrets((secrets) => seen.push(secrets));
    window.history.replaceState(null, '', '/abc123#pw=late-pass&page=2');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(seen).toEqual([{ password: 'late-pass', rest: '#page=2' }]);
    expect(window.location.hash).toBe('#page=2');

    window.history.replaceState(null, '', '/abc123#page=5');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(seen).toHaveLength(1); // no secrets, nothing to do

    stop();
    window.history.replaceState(null, '', '/abc123#pw=after-stop');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(seen).toHaveLength(1);
  });

  it('finds the target from the path', () => {
    expect(targetFromPath('/abc123')).toEqual({ kind: 'file', vanity: 'abc123' });
    expect(targetFromPath('/abc123.png')).toEqual({ kind: 'file', vanity: 'abc123' });
    expect(targetFromPath('/abcd/xyz.png')).toEqual({ kind: 'file', vanity: 'abcd/xyz' });
    expect(targetFromPath('/a/Ab3dE6gH/2')).toEqual({ kind: 'album', vanity: 'Ab3dE6gH' });
    expect(targetFromPath('/')).toBeNull();
  });
});
