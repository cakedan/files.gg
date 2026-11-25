/**
 * The dashboard sidebar's dot on **Changelog** (milestone-5 §19.2): shown while the newest entry is
 * newer than the newest one this browser has opened. `localStorage` only, a convenience: storage
 * that's blocked or cleared just shows the dot.
 */

import { useState } from 'react';

import { updated as newestEntry } from '../../../CHANGELOG.md?meta';
import { getItem, setItem } from './storage';

export const CHANGELOG_SEEN_KEY = 'filesgg.changelog.seen';
/** The newest entry's date (`YYYY-MM-DD`, also its anchor). */
export const LATEST_CHANGELOG_ENTRY = newestEntry;

/** Dates compare as text (`YYYY-MM-DD`). */
export function changelogUnread(seen: string | null, latest: string | null = LATEST_CHANGELOG_ENTRY): boolean {
  return latest !== null && (seen === null || seen < latest);
}

/** The changelog page calls this when it opens. */
export function markChangelogSeen(latest: string | null = LATEST_CHANGELOG_ENTRY): void {
  if (latest && changelogUnread(getItem(CHANGELOG_SEEN_KEY), latest)) setItem(CHANGELOG_SEEN_KEY, latest);
}

export function useChangelogUnread(): boolean {
  const [unread] = useState(() => changelogUnread(getItem(CHANGELOG_SEEN_KEY)));
  return unread;
}
