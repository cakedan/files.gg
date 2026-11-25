import { describe, expect, it } from 'vitest';

import { DEFAULT_FILES_STATE, filesSearchParams, pageCount, parseFilesState, patchFilesState, toApiParams } from './urlState';

describe('files URL state', () => {
  it('parses defaults from an empty URL, and ignores invalid values', () => {
    expect(parseFilesState(new URLSearchParams())).toEqual(DEFAULT_FILES_STATE);
    expect(parseFilesState(new URLSearchParams('sort=bogus&type=zip&access=public&page=-3&view=cards'))).toEqual(DEFAULT_FILES_STATE);
  });

  it('round-trips every field, leaving defaults out of the URL', () => {
    const state = { query: 'cat', sort: '-size', type: 'video', access: 'password', temporary: true, page: 3, view: 'grid' } as const;
    const params = filesSearchParams(state);
    expect(params.toString()).toBe('q=cat&sort=-size&type=video&access=password&temporary=1&page=3&view=grid');
    expect(parseFilesState(params)).toEqual(state);
    expect(filesSearchParams(DEFAULT_FILES_STATE).toString()).toBe('');
  });

  it('goes back to page 1 when the result set changes, but not for the page or the view', () => {
    const on3 = { ...DEFAULT_FILES_STATE, page: 3 };
    expect(patchFilesState(on3, { query: 'x' }).page).toBe(1);
    expect(patchFilesState(on3, { type: 'audio' }).page).toBe(1);
    expect(patchFilesState(on3, { view: 'grid' }).page).toBe(3);
    expect(patchFilesState(on3, { page: 4 }).page).toBe(4);
    // Setting a filter to its current value isn't a change.
    expect(patchFilesState(on3, { temporary: false }).page).toBe(3);
  });

  it('maps to API params, 25 per page', () => {
    expect(toApiParams({ ...DEFAULT_FILES_STATE, page: 2, type: 'other', access: 'private', temporary: true, query: 'a b' })).toEqual({
      query: 'a b',
      sort_by: '-created',
      type: 'other',
      visibility: 'private',
      temporary: true,
      offset: 25,
      limit: 25,
    });
    expect(pageCount(0)).toBe(1);
    expect(pageCount(26)).toBe(2);
  });
});
