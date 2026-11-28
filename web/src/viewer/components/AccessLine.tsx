import { EyeOff, Link2, Lock, type LucideIcon } from 'lucide-react';

import { ACCESS_LABELS, type Visibility } from './accessText';

const ICONS: Record<Visibility, LucideIcon> = { link: Link2, password: Lock, private: EyeOff };

/** One item for a footer or header meta row. Renders nothing when the payload has no `visibility`. */
export function AccessLine({ visibility }: { visibility: Visibility | undefined }) {
  if (!visibility) return null;
  const Icon = ICONS[visibility];
  return (
    <span className="inline-flex items-center gap-1">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {ACCESS_LABELS[visibility]}
    </span>
  );
}
