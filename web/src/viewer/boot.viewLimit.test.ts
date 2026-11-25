import { describe, expect, it } from 'vitest';

import { parseBoot, parseFileData } from './boot';

/** Milestone 6 §19.5–§19.6: the `limited` shell and `view_limit` on payloads. */

const file = (value: unknown) => JSON.stringify(value);

describe('boot: view limits', () => {
  it('data-state="limited" with { vanity, view_limited, views_remaining } is the limited page', () => {
    expect(parseBoot({ page: 'file', state: 'limited', fileJson: file({ vanity: 'abc', view_limited: true, views_remaining: 3 }) })).toEqual({
      page: 'limited',
      target: { vanity: 'abc', remaining: 3 },
    });
  });

  it('keeps the page when views_remaining is missing or malformed, without a count', () => {
    for (const views_remaining of [undefined, -1, 1.5, '3']) {
      expect(parseBoot({ state: 'limited', fileJson: file({ vanity: 'abc', view_limited: true, views_remaining }) })).toEqual({
        page: 'limited',
        target: { vanity: 'abc', remaining: null },
      });
    }
  });

  it('is missing without a vanity or view_limited, and for albums', () => {
    expect(parseBoot({ state: 'limited', fileJson: file({ view_limited: true, views_remaining: 3 }) })).toEqual({ page: 'missing' });
    expect(parseBoot({ state: 'limited', fileJson: file({ vanity: 'abc' }) })).toEqual({ page: 'missing' });
    expect(parseBoot({ state: 'limited', fileJson: 'not json' })).toEqual({ page: 'missing' });
    expect(parseBoot({ page: 'album', state: 'limited', albumJson: file({ vanity: 'abc', view_limited: true }) })).toEqual({ page: 'missing' });
  });

  it('a view-limited password file is the lock screen with the limit, from either shell', () => {
    const target = { kind: 'file', vanity: 'abc', name: 'notes.pdf', passwordExpired: false, viewLimit: { remaining: 2 } };
    expect(
      parseBoot({ state: 'locked', fileJson: file({ vanity: 'abc', protected: 'password', filename: 'notes.pdf', view_limited: true, views_remaining: 2 }) }),
    ).toEqual({ page: 'locked', target });
    expect(
      parseBoot({ state: 'limited', fileJson: file({ vanity: 'abc', protected: 'password', filename: 'notes.pdf', view_limited: true, views_remaining: 2 }) }),
    ).toEqual({ page: 'locked', target });
    // A plain lock screen has no limit.
    expect(parseBoot({ state: 'locked', fileJson: file({ vanity: 'abc', protected: 'password' }) })).toEqual({
      page: 'locked',
      target: { kind: 'file', vanity: 'abc', name: undefined, passwordExpired: false },
    });
  });

  it('reads view_limit.remaining on a payload, and drops anything else', () => {
    const base = { filename: 'a.png', cdn_url: 'https://cdn.files.gg/files/a.png' };
    expect(parseFileData({ ...base, view_limit: { remaining: 4 } })?.view_limit).toEqual({ remaining: 4 });
    expect(parseFileData({ ...base, view_limit: { remaining: 0 } })?.view_limit).toEqual({ remaining: 0 });
    expect(parseFileData({ ...base, view_limit: { remaining: -1 } })?.view_limit).toBeUndefined();
    expect(parseFileData({ ...base, view_limit: 4 })?.view_limit).toBeUndefined();
    expect(parseFileData(base)?.view_limit).toBeUndefined();
  });
});
