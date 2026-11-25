import { describe, expect, it } from 'vitest';

import { hiddenNote } from './hiddenNote';

describe('hiddenNote', () => {
  it('explains why an item is hidden, by its visibility and the album’s', () => {
    expect(hiddenNote({ shown: true, visibility: 'password' }, { visibility: 'link' })).toBeNull();
    expect(hiddenNote({ shown: false, visibility: 'password' }, { visibility: 'link' })).toMatch(/^Hidden here: this file is password protected/);
    expect(hiddenNote({ shown: false, visibility: 'private' }, { visibility: 'link' })).toMatch(/^Hidden here: this file is private/);
    expect(hiddenNote({ shown: false, visibility: 'link' }, { visibility: 'password' })).toBe('Hidden here: this file has expired or was removed.');
  });
});
