import { describe, expect, it } from 'vitest';

import { EMPTY_SELECTION, pageSelectionState, pruneSelection, toggleAllOnPage, toggleSelection } from './selection';

const order = ['a', 'b', 'c', 'd', 'e', 'f'];
const ids = (selection: { ids: ReadonlySet<string> }) => [...selection.ids].sort();

describe('selection', () => {
  it('toggles one item and makes it the anchor', () => {
    const one = toggleSelection(EMPTY_SELECTION, order, 'b');
    expect(ids(one)).toEqual(['b']);
    expect(one.anchor).toBe('b');
    expect(ids(toggleSelection(one, order, 'b'))).toEqual([]);
  });

  it('shift-click selects the range from the anchor, in either direction', () => {
    const anchored = toggleSelection(EMPTY_SELECTION, order, 'b');
    expect(ids(toggleSelection(anchored, order, 'e', true))).toEqual(['b', 'c', 'd', 'e']);
    const backwards = toggleSelection(EMPTY_SELECTION, order, 'e');
    expect(ids(toggleSelection(backwards, order, 'b', true))).toEqual(['b', 'c', 'd', 'e']);
  });

  it('keeps the anchor, so a second shift-click adjusts the range', () => {
    let selection = toggleSelection(EMPTY_SELECTION, order, 'c');
    selection = toggleSelection(selection, order, 'f', true);
    expect(selection.anchor).toBe('c');
    selection = toggleSelection(selection, order, 'a', true);
    // c..a added; d..f stay (ranges add, like file managers)
    expect(ids(selection)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('a shift-click from an unselected anchor clears the range', () => {
    let selection = toggleAllOnPage(EMPTY_SELECTION, order);
    selection = toggleSelection(selection, order, 'b'); // deselect b, anchor b
    selection = toggleSelection(selection, order, 'd', true);
    expect(ids(selection)).toEqual(['a', 'e', 'f']);
  });

  it('shift-click without an anchor on the page is a plain toggle', () => {
    const stale = { ids: new Set<string>(), anchor: 'gone' };
    const next = toggleSelection(stale, order, 'c', true);
    expect(ids(next)).toEqual(['c']);
    expect(next.anchor).toBe('c');
  });

  it('select all on the page, and again to clear', () => {
    const some = toggleSelection(EMPTY_SELECTION, order, 'a');
    expect(pageSelectionState(some, order)).toBe('some');
    const all = toggleAllOnPage(some, order);
    expect(pageSelectionState(all, order)).toBe('all');
    expect(pageSelectionState(toggleAllOnPage(all, order), order)).toBe('none');
  });

  it('prunes ids that left the page, returning the same object when nothing changed', () => {
    const selection = toggleAllOnPage(EMPTY_SELECTION, order);
    expect(pruneSelection(selection, order)).toBe(selection);
    const pruned = pruneSelection({ ...selection, anchor: 'a' }, ['b', 'c']);
    expect(ids(pruned)).toEqual(['b', 'c']);
    expect(pruned.anchor).toBeNull();
  });
});
