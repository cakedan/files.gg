import { Ban, EyeOff, Loader2, Trash2 } from 'lucide-react';
import { Link } from 'react-router';

import type { OwnerSafety } from '../../lib/api';
import { SAFETY_BADGES } from './labels';

const STYLES = {
  pending: { icon: Loader2, className: 'bg-surface-2 text-muted', spin: true },
  hidden: { icon: EyeOff, className: 'bg-warn/15 text-warn', spin: false },
  removed: { icon: Trash2, className: 'bg-danger/15 text-danger', spin: false },
  blocked: { icon: Ban, className: 'bg-danger/15 text-danger', spin: false },
} as const;

/**
 * "Checking…", "Hidden", "Removed" or "Blocked" (milestone-4 §11.2), linking to the
 * notice that explains it. `ok` and `flagged` show nothing.
 */
export function SafetyBadge({ safety, compact = false }: { safety: OwnerSafety | undefined; compact?: boolean }) {
  if (!safety) return null;
  const state = safety.state;
  if (state !== 'pending' && state !== 'hidden' && state !== 'removed' && state !== 'blocked') return null;
  const { icon: Icon, className, spin } = STYLES[state];
  const label = SAFETY_BADGES[state]!;
  const body = (
    <>
      <Icon aria-hidden className={`size-3 shrink-0 ${spin ? 'animate-spin' : ''}`} />
      <span className={compact ? 'sr-only sm:not-sr-only' : ''}>{label}</span>
    </>
  );
  const classes = `inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${className}`;
  if (safety.notice_id) {
    return (
      <Link to={`/notices/${safety.notice_id}`} className={`${classes} hover:underline`} title={`${label}: see the notice`} onClick={(event) => event.stopPropagation()}>
        {body}
      </Link>
    );
  }
  return (
    <span className={classes} title={label} data-testid="safety-badge">
      {body}
    </span>
  );
}

/** A count pill for the sidebar and tabs. Red marks urgent counts (P0 cases). */
export function CountBadge({ count, urgent = false, label }: { count: number; urgent?: boolean; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`ml-auto inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums ${
        urgent ? 'bg-danger-fill text-white' : 'bg-gg text-gg-ink'
      }`}
    >
      <span aria-hidden>{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{`, ${count} ${label}`}</span>
    </span>
  );
}
