import { describe, expect, it } from 'vitest';

import { formatExpiry, formatRelative, formatUploaded } from './time';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe('formatRelative', () => {
  it.each([
    [0, 'just now'],
    [-44 * S, 'just now'],
    [44 * S, 'just now'],
    [-50 * S, '50 seconds ago'],
    [-59.6 * S, '1 minute ago'],
    [-5 * M, '5 minutes ago'],
    [-59.6 * M, '1 hour ago'],
    [-3 * H, '3 hours ago'],
    [-23.6 * H, '1 day ago'],
    [-3 * D, '3 days ago'],
    [-45 * D, '1 month ago'],
    [-400 * D, '1 year ago'],
    [-3 * 365 * D, '3 years ago'],
    [2 * H, 'in 2 hours'],
    [10 * D, 'in 10 days'],
  ])('%d ms from now -> %s', (offset, expected) => {
    expect(formatRelative(NOW + offset, NOW)).toBe(expected);
  });
});

describe('formatUploaded', () => {
  it('prefixes "Uploaded"', () => {
    expect(formatUploaded(NOW - 3 * D, NOW)).toBe('Uploaded 3 days ago');
  });

  it('clamps future timestamps (clock skew) to "just now"', () => {
    expect(formatUploaded(NOW + 5 * M, NOW)).toBe('Uploaded just now');
  });
});

describe('formatExpiry', () => {
  it('returns null when the file never expires', () => {
    expect(formatExpiry(null, NOW)).toBeNull();
    expect(formatExpiry(undefined, NOW)).toBeNull();
    expect(formatExpiry(Number.NaN, NOW)).toBeNull();
  });

  it('is amber "Expires in…" while in the future', () => {
    expect(formatExpiry(NOW + 5 * H, NOW)).toEqual({ label: 'Expires in 5 hours', tone: 'warn', expired: false });
    expect(formatExpiry(NOW + 21 * D, NOW)?.label).toBe('Expires in 21 days');
  });

  it('says "less than a minute" right before expiry', () => {
    expect(formatExpiry(NOW + 20 * S, NOW)?.label).toBe('Expires in less than a minute');
  });

  it('is red "Expired" at and after the expiry time', () => {
    expect(formatExpiry(NOW, NOW)).toEqual({ label: 'Expired', tone: 'danger', expired: true });
    expect(formatExpiry(NOW - D, NOW)?.tone).toBe('danger');
  });
});
