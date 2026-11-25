import { describe, expect, it } from 'vitest';

import { storageTone } from './storageTone';

describe('storageTone', () => {
  it.each([
    [0, 'ok'],
    [79, 'ok'],
    [80, 'warn'],
    [94, 'warn'],
    [95, 'danger'],
    [99, 'danger'],
    [100, 'full'],
    [120, 'full'],
  ])('%i%% is %s', (percent, tone) => {
    expect(storageTone(percent, 100)).toBe(tone);
  });
});
