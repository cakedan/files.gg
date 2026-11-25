/**
 * Multi-select for the Files page: click toggles, shift-click selects (or clears) the
 * range from the last clicked item, and "select all" works on the current page.
 * Pure, so the rules are easy to test.
 */

export interface Selection {
  ids: ReadonlySet<string>;
  /** The last item clicked without shift: where a shift-click range starts. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

/**
 * `order` is the page's ids in display order. A shift-click applies the anchor's
 * state to every item between the anchor and `id`, inclusive (like file managers);
 * the anchor stays put so the range can be adjusted.
 */
export function toggleSelection(selection: Selection, order: readonly string[], id: string, shift = false): Selection {
  const ids = new Set(selection.ids);
  const anchorIndex = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const index = order.indexOf(id);
  if (shift && anchorIndex !== -1 && index !== -1) {
    const select = ids.has(selection.anchor!);
    const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
    for (const each of order.slice(from, to + 1)) {
      if (select) ids.add(each);
      else ids.delete(each);
    }
    return { ids, anchor: selection.anchor };
  }
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

export type PageSelectionState = 'none' | 'some' | 'all';

export function pageSelectionState(selection: Selection, order: readonly string[]): PageSelectionState {
  const count = order.filter((id) => selection.ids.has(id)).length;
  if (count === 0) return 'none';
  return count === order.length ? 'all' : 'some';
}

/** Selects every item on the page, or clears them all when they're already selected. */
export function toggleAllOnPage(selection: Selection, order: readonly string[]): Selection {
  const ids = new Set(selection.ids);
  const all = pageSelectionState(selection, order) === 'all';
  for (const id of order) {
    if (all) ids.delete(id);
    else ids.add(id);
  }
  return { ids, anchor: selection.anchor };
}

/** Drops ids that are no longer listed (deleted, filtered out). Same object when nothing changes. */
export function pruneSelection(selection: Selection, order: readonly string[]): Selection {
  const present = new Set(order);
  if ([...selection.ids].every((id) => present.has(id)) && (selection.anchor === null || present.has(selection.anchor))) return selection;
  return {
    ids: new Set([...selection.ids].filter((id) => present.has(id))),
    anchor: selection.anchor !== null && present.has(selection.anchor) ? selection.anchor : null,
  };
}
