import { Clock, ExternalLink, Images, Infinity as InfinityIcon, KeyRound, Link2, Lock, Pencil, Trash2 } from 'lucide-react';

import type { OwnerFile } from '../../lib/api';
import type { MenuItem } from '../components/Menu';

export interface FileHandlers {
  copyLink: (file: OwnerFile) => void;
  open: (file: OwnerFile) => void;
  openAsOwner: (file: OwnerFile) => void;
  rename?: (file: OwnerFile) => void;
  setExpiry: (files: OwnerFile[]) => void;
  keepForever?: ((files: OwnerFile[]) => void) | undefined;
  changeAccess: (files: OwnerFile[]) => void;
  addToAlbum: (files: OwnerFile[]) => void;
  remove: (files: OwnerFile[]) => void;
}

/** Row actions (contract §8): Copy link, Open, Open as owner, Rename, Set expiry, Change access, Delete. */
export function fileMenuItems(file: OwnerFile, handlers: FileHandlers): MenuItem[] {
  return [
    { label: 'Copy link', icon: Link2, onSelect: () => handlers.copyLink(file) },
    { label: 'Open', icon: ExternalLink, onSelect: () => handlers.open(file) },
    { label: 'Open as owner', icon: KeyRound, onSelect: () => handlers.openAsOwner(file), hidden: file.visibility === 'link' },
    { label: 'Rename', icon: Pencil, onSelect: () => handlers.rename?.(file), hidden: !handlers.rename },
    { label: 'Set expiry…', icon: Clock, onSelect: () => handlers.setExpiry([file]) },
    {
      label: 'Keep forever',
      icon: InfinityIcon,
      onSelect: () => handlers.keepForever?.([file]),
      hidden: !handlers.keepForever || file.expires_at === null,
    },
    { label: 'Change access…', icon: Lock, onSelect: () => handlers.changeAccess([file]) },
    { label: 'Add to album…', icon: Images, onSelect: () => handlers.addToAlbum([file]) },
    { label: 'Delete', icon: Trash2, onSelect: () => handlers.remove([file]), danger: true },
  ];
}
