import { Clock, Eye, EyeOff, ExternalLink, Gauge, Globe, Images, Infinity as InfinityIcon, KeyRound, Link, Link2, Lock, MessageSquareWarning, Pencil, Trash2, Wand2 } from 'lucide-react';

import type { OwnerFile } from '../../lib/api';
import { sourceKindOf } from '../../lib/convertKinds';
import { ADULT_REGION_TEXT } from '../../lib/upload/options';
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
  /** Milestone 4 (§4.5): mark or unmark as sensitive. Signed in only. */
  setSensitive?: ((files: OwnerFile[], nsfw: boolean) => void) | undefined;
  /** Milestone 7 §11.4: adult content isn't available from the owner's country, so files can't be marked (unmarking still works). */
  adultRegionBlocked?: boolean | undefined;
  /** Ask for a review of an automatic NSFW mark. */
  askReview?: ((file: OwnerFile) => void) | undefined;
  /** Milestone 6 §10.9: copies `direct_url` (files whose payload has one). */
  copyDirectLink?: ((file: OwnerFile) => void) | undefined;
  /** Milestone 6 §13.4: an owner pass on the default serving custom domain. */
  openOnDomain?: { hostname: string; open: (file: OwnerFile) => void } | undefined;
  /** Milestone 6 §19.7: set, edit or remove the view limit. Signed in only (anonymous files set it at upload). */
  editViewLimit?: ((file: OwnerFile) => void) | undefined;
  /** Removes the limit at once (`PATCH { view_limit: null }`). */
  removeViewLimit?: ((file: OwnerFile) => void) | undefined;
  /** Milestone 5 §13.2: "Convert…", one file or a batch, on the Convert page. */
  convert?: ((files: OwnerFile[]) => void) | undefined;
}

/** A file the Convert page can take (§1.1): a kind with targets, and scanned. */
export const canConvert = (file: OwnerFile) => sourceKindOf(file) !== null && (file.safety?.state ?? 'ok') !== 'pending';

/** Why Unmark is disabled (§4.5, §11.2). */
export const NSFW_LOCKED_HINT = 'Marked by files.gg. Ask for a review instead.';

/** "Ask for review" is offered for files the classifier marked, once (§4.5). */
export const canAskReview = (file: OwnerFile) => file.safety?.nsfw_source === 'auto' && file.safety.nsfw_review === 'none';

/** Row actions (contract §8): Copy link, Open, Open as owner, Rename, Set expiry, Change access, Delete. */
export function fileMenuItems(file: OwnerFile, handlers: FileHandlers): MenuItem[] {
  return [
    { label: 'Copy link', icon: Link2, onSelect: () => handlers.copyLink(file) },
    { label: 'Copy direct link', icon: Link, onSelect: () => handlers.copyDirectLink?.(file), hidden: !handlers.copyDirectLink || !file.direct_url },
    { label: 'Open', icon: ExternalLink, onSelect: () => handlers.open(file) },
    { label: 'Open as owner', icon: KeyRound, onSelect: () => handlers.openAsOwner(file), hidden: file.visibility === 'link' },
    {
      label: `Open on ${handlers.openOnDomain?.hostname ?? 'your domain'}`,
      icon: Globe,
      onSelect: () => handlers.openOnDomain?.open(file),
      hidden: !handlers.openOnDomain,
    },
    { label: 'Rename', icon: Pencil, onSelect: () => handlers.rename?.(file), hidden: !handlers.rename },
    { label: 'Set expiry…', icon: Clock, onSelect: () => handlers.setExpiry([file]) },
    {
      label: 'Keep forever',
      icon: InfinityIcon,
      onSelect: () => handlers.keepForever?.([file]),
      hidden: !handlers.keepForever || file.expires_at === null,
    },
    { label: 'Change access…', icon: Lock, onSelect: () => handlers.changeAccess([file]) },
    { label: 'View limit…', icon: Gauge, onSelect: () => handlers.editViewLimit?.(file), hidden: !handlers.editViewLimit },
    { label: 'Add to album…', icon: Images, onSelect: () => handlers.addToAlbum([file]) },
    { label: 'Convert…', icon: Wand2, onSelect: () => handlers.convert?.([file]), hidden: !handlers.convert || !canConvert(file) },
    {
      label: 'Mark as sensitive',
      icon: EyeOff,
      onSelect: () => handlers.setSensitive?.([file], true),
      hidden: !handlers.setSensitive || Boolean(file.nsfw),
      disabled: Boolean(handlers.adultRegionBlocked),
      hint: handlers.adultRegionBlocked ? ADULT_REGION_TEXT : undefined,
    },
    {
      label: 'Unmark as sensitive',
      icon: Eye,
      onSelect: () => handlers.setSensitive?.([file], false),
      hidden: !handlers.setSensitive || !file.nsfw,
      disabled: Boolean(file.safety?.nsfw_locked),
      hint: file.safety?.nsfw_locked ? NSFW_LOCKED_HINT : undefined,
    },
    { label: 'Ask for review…', icon: MessageSquareWarning, onSelect: () => handlers.askReview?.(file), hidden: !handlers.askReview || !canAskReview(file) },
    { label: 'Delete', icon: Trash2, onSelect: () => handlers.remove([file]), danger: true },
  ];
}
