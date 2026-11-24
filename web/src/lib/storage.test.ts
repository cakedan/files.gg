import { afterEach, describe, expect, it, vi } from 'vitest';

import { getItem, getLegacyString, removeItem, setItem, setLegacyString } from './storage';

afterEach(() => localStorage.clear());

describe('storage', () => {
  it('round-trips legacy JSON-encoded strings', () => {
    expect(setLegacyString('token', 'abc')).toBe(true);
    expect(localStorage.getItem('token')).toBe('"abc"');
    expect(getLegacyString('token')).toBe('abc');
  });

  it('treats numbers as strings and objects as absent', () => {
    localStorage.setItem('fingerprint', '12345');
    expect(getLegacyString('fingerprint')).toBe('12345');
    localStorage.setItem('fingerprint', '{"a":1}');
    expect(getLegacyString('fingerprint')).toBeNull();
  });

  it('never throws when storage is blocked', () => {
    const error = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(error);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(error);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(error);
    expect(getItem('token')).toBeNull();
    expect(setItem('token', 'x')).toBe(false);
    expect(() => removeItem('token')).not.toThrow();
  });
});
