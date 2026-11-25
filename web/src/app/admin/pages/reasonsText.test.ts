import { describe, expect, it } from 'vitest';

import { reasonsText } from '../format';

describe('reasonsText', () => {
  it('shows a scanner flag once, in words, not its raw code', () => {
    expect(reasonsText({ kind: 'hash', reasons: { unwanted_software: 0 }, flags: ['unwanted_software'] })).toBe('Unwanted software');
  });

  it('lists report reasons with counts, then flags', () => {
    expect(reasonsText({ kind: 'file', reasons: { spam: 3, malware: 1 }, flags: ['pdq_near_match'] })).toBe(
      'Spam ×3, Malware or phishing, Near-match of blocked content',
    );
  });

  it('says why a case is open when there is nothing to list', () => {
    expect(reasonsText({ kind: 'appeal', reasons: {}, flags: [] })).toBe('Waiting for a decision');
    expect(reasonsText({ kind: 'file', reasons: {}, flags: [] })).toBe('No open reports');
  });
});
