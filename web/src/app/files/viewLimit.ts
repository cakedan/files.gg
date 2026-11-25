import type { OwnerFile } from '../../lib/api';

/** Milestone 6 §19.6–§19.7: the owner's view of a file's view limit. */

type Limited = Pick<OwnerFile, 'view_limit' | 'view_limit_action' | 'views_used' | 'visibility'>;

const count = (n: number) => n.toLocaleString('en');

/** The limit, or null when there is none. */
export const viewLimitOf = (file: Limited): number | null => (typeof file.view_limit === 'number' ? file.view_limit : null);

/** "3 of 10 views used", or null without a limit. */
export function viewsUsedLabel(file: Limited): string | null {
  const limit = viewLimitOf(file);
  if (limit === null) return null;
  return `${count(file.views_used ?? 0)} of ${count(limit)} ${limit === 1 ? 'view' : 'views'} used`;
}

/** What happens at the limit, as a sentence. */
export const viewLimitActionText = (file: Limited): string =>
  file.view_limit_action === 'private' ? 'It becomes private at the limit.' : 'It expires at the limit.';

/** The `private` action fired: the limit is used up and the file is private now (§19.4). */
export function privateActionFired(file: Limited): boolean {
  const limit = viewLimitOf(file);
  return limit !== null && file.view_limit_action === 'private' && file.visibility === 'private' && (file.views_used ?? 0) >= limit;
}

export const PRIVATE_FIRED_HINT = 'It reached its view limit and is private now. Raise the limit to share it again.';

/**
 * The `expire` action fired: the last viewer keeps the file for up to 1 h, so the owner
 * sees it expiring within the hour rather than gone (§19.4).
 */
export function expireActionFired(file: Limited): boolean {
  const limit = viewLimitOf(file);
  return limit !== null && file.view_limit_action !== 'private' && (file.views_used ?? 0) >= limit;
}

export const EXPIRE_FIRED_HINT = 'It reached its view limit and expires within the hour. Nobody else can open it.';
