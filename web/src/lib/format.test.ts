import { describe, expect, it } from 'vitest';

import { formatBytes, formatDimensions } from './format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [-1, '0 B'],
    [512, '512 B'],
    [999, '999 B'],
    // decimal units, as the API's limits are configured
    [1000, '1 KB'],
    [1024, '1 KB'],
    [1500, '1.5 KB'],
    [507_507, '507.5 KB'],
    [1_000_000, '1 MB'],
    [25_000_000, '25 MB'],
    [100_000_000, '100 MB'],
    [1_000_000_000, '1 GB'],
    [10_000_000_000, '10 GB'],
    [100_000_000_000, '100 GB'],
    [10 * 1024 ** 3, '10.7 GB'],
    // a value that rounds to 1000 rolls over to the next unit
    [999_949, '999.9 KB'],
    [999_950, '1 MB'],
    [999_999, '1 MB'],
    [999_950_000, '1 GB'],
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
