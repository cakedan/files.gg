import { Eye } from 'lucide-react';

import type { OwnerFile } from '../../lib/api';
import { expireActionFired, privateActionFired, viewsUsedLabel } from './viewLimit';

/** Rows and tiles: "3 of 10 views used" for a view-limited file (milestone-6 §19.7). */
export function ViewLimitBadge({ file }: { file: OwnerFile }) {
  const label = viewsUsedLabel(file);
  if (!label) return null;
  const used = privateActionFired(file) || expireActionFired(file);
  return (
    <span className={`inline-flex max-w-full min-w-0 items-center gap-1 text-xs ${used ? 'text-warn' : 'text-muted'}`} title={used ? `${label} (limit reached)` : label}>
      <Eye aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
