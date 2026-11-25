import { KeyRound, Link2, Lock } from 'lucide-react';

import type { Visibility } from '../../lib/api';
import { SHORT_VISIBILITY_LABELS, VISIBILITY_LABELS } from './fileLabels';

const ICONS = { link: Link2, password: KeyRound, private: Lock } as const;

/** The access column: an icon for link, password or private, with a label. */
export function AccessBadge({ visibility, compact = false }: { visibility: Visibility; compact?: boolean }) {
  const Icon = ICONS[visibility];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${visibility === 'link' ? 'text-muted' : 'text-text'}`}
      title={VISIBILITY_LABELS[visibility]}
    >
      <Icon aria-hidden className={`size-3.5 ${visibility === 'password' ? 'text-warn' : visibility === 'private' ? 'text-gg' : ''}`} />
      {compact ? <span className="sr-only">{VISIBILITY_LABELS[visibility]}</span> : SHORT_VISIBILITY_LABELS[visibility]}
    </span>
  );
}
