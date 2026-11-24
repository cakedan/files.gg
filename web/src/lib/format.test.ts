import { describe, expect, it } from 'vitest';

import { formatBytes, formatDimensions } from './format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [-1, '0 B'],
    [512, '512 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [507_507, '495.6 KB'],
    [10 * 1024 ** 3, '10 GB'],
  ])('%d -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('formatDimensions', () => {
  it('formats W×H and skips missing values', () => {
    expect(formatDimensions(1200, 630)).toBe('1200×630');
    expect(formatDimensions(undefined, 630)).toBeNull();
  });
});
