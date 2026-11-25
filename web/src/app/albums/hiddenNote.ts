import type { OwnerAlbum, OwnerAlbumItem } from '../../lib/api';

/** Milestone 6 §19.6: opening an album can't count each item, so view-limited files stay out. */
export const VIEW_LIMITED_NOTE = "View-limited files aren't shown in albums.";

/**
 * Why an item with `shown: false` is hidden on the public album page (contract §4):
 * a link album only shows link files; anything else is expired or moderated.
 * Milestone 4 §6.2: items also stay off the page while they aren't `ok` or `flagged`.
 * Milestone 6 §19.6: view-limited files are never shown in albums.
 */
export function hiddenNote(
  item: Pick<OwnerAlbumItem, 'shown' | 'visibility' | 'safety' | 'view_limit' | 'hidden_reason'>,
  album: Pick<OwnerAlbum, 'visibility'>,
): string | null {
  if (item.shown) return null;
  switch (item.safety?.state) {
    case 'pending':
      return 'Not shown yet: this file is still being checked.';
    case 'hidden':
      return item.safety.reason === 'review' ? 'Hidden here: this file is hidden while it’s reviewed.' : 'Hidden here: the files.gg team hid this file.';
    case 'removed':
      return 'Hidden here: the files.gg team removed this file.';
    case 'blocked':
      return 'Hidden here: this file was blocked.';
  }
  if (item.hidden_reason === 'view_limit' || typeof item.view_limit === 'number') return VIEW_LIMITED_NOTE;
  if (album.visibility === 'link' && item.visibility === 'password') {
    return 'Hidden here: this file is password protected. Protect the album too, or make the file public, to show it.';
  }
  if (album.visibility === 'link' && item.visibility === 'private') {
    return 'Hidden here: this file is private. Protect the album too, or change the file’s access, to show it.';
  }
  return 'Hidden here: this file has expired or was removed.';
}
