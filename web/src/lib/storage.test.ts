import { afterEach, describe, expect, it, vi } from 'vitest';

import { getItem, removeItem, setItem } from './storage';

afterEach(() => localStorage.clear());

describe('storage', () => {
  it('round-trips plain strings', () => {
    expect(setItem('filesgg.token', 'abc')).toBe(true);
    expect(localStorage.getItem('filesgg.token')).toBe('abc');
    expect(getItem('filesgg.token')).toBe('abc');
    removeItem('filesgg.token');
    expect(getItem('filesgg.token')).toBeNull();
  });

  it('never throws when storage is blocked', () => {
    const error = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(error);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(error);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(error);
    expect(getItem('filesgg.token')).toBeNull();
    expect(setItem('filesgg.token', 'x')).toBe(false);
    expect(() => removeItem('filesgg.token')).not.toThrow();
  });
});
