import { afterEach, describe, expect, it, vi } from 'vitest';

import { getItem, getSessionItem, removeItem, removeSessionItem, setItem, setSessionItem } from './storage';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('storage', () => {
  it('round-trips plain strings', () => {
    expect(setItem('filesgg.guest', 'abc')).toBe(true);
    expect(localStorage.getItem('filesgg.guest')).toBe('abc');
    expect(getItem('filesgg.guest')).toBe('abc');
    removeItem('filesgg.guest');
    expect(getItem('filesgg.guest')).toBeNull();
  });

  it('round-trips sessionStorage too', () => {
    expect(setSessionItem('filesgg.oauth', '{}')).toBe(true);
    expect(sessionStorage.getItem('filesgg.oauth')).toBe('{}');
    expect(getSessionItem('filesgg.oauth')).toBe('{}');
    removeSessionItem('filesgg.oauth');
    expect(getSessionItem('filesgg.oauth')).toBeNull();
  });

  it('never throws when storage is blocked', () => {
    const error = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(error);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(error);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(error);
    expect(getItem('filesgg.guest')).toBeNull();
    expect(setItem('filesgg.guest', 'x')).toBe(false);
    expect(() => removeItem('filesgg.guest')).not.toThrow();
    expect(getSessionItem('filesgg.oauth')).toBeNull();
    expect(setSessionItem('filesgg.oauth', 'x')).toBe(false);
    expect(() => removeSessionItem('filesgg.oauth')).not.toThrow();
  });
});
