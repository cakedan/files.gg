import type { OwnerAlbum, OwnerAlbumItem } from '../../lib/api';

/**
 * Why an item with `shown: false` is hidden on the public album page (contract §4):
 * a link album only shows link files; anything else is expired or moderated.
 */
export function hiddenNote(item: Pick<OwnerAlbumItem, 'shown' | 'visibility'>, album: Pick<OwnerAlbum, 'visibility'>): string | null {
  if (item.shown) return null;
  if (album.visibility === 'link' && item.visibility === 'password') {
    return 'Hidden here: this file is password protected. Protect the album too, or make the file public, to show it.';
  }
  if (album.visibility === 'link' && item.visibility === 'private') {
    return 'Hidden here: this file is private. Protect the album too, or change the file’s access, to show it.';
  }
  return 'Hidden here: this file has expired or was removed.';
}
