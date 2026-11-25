/** Milestone 6 §19.7 copy for view-limited files. Tiny, so the footer can use it. */

const count = (n: number) => n.toLocaleString('en');

export const VIEW_LIMIT_INTRO = 'This file has a view limit.';

/** The footer after opening: "3 views left", "1 view left", "No views left". */
export function viewsLeftLabel(remaining: number): string {
  if (remaining <= 0) return 'No views left';
  return `${count(remaining)} ${remaining === 1 ? 'view' : 'views'} left`;
}

/**
 * "Opening it uses one of its 3 remaining views." `remaining` is null when the shell
 * didn't say how many are left.
 */
export function viewLimitUse(verb: 'Opening' | 'Unlocking', remaining: number | null): string {
  const uses =
    remaining === null
      ? 'one of its remaining views'
      : remaining === 1
        ? 'its last remaining view'
        : `one of its ${count(remaining)} remaining views`;
  return `${verb} it uses ${uses}.`;
}

/** "This file has a view limit. Unlocking it uses one of its 3 remaining views." */
export const viewLimitLine = (verb: 'Opening' | 'Unlocking', remaining: number | null): string =>
  `${VIEW_LIMIT_INTRO} ${viewLimitUse(verb, remaining)}`;
