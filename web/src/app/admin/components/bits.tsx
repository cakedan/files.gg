import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { epochMs, formatFullDate, formatRelative } from '../../../lib/time';
import type { CaseTarget } from '../adminApi';
import { adminError, targetHref } from '../format';

const PRIORITY_STYLES = ['bg-danger text-white', 'bg-warn/20 text-warn', 'bg-surface-2 text-text', 'bg-surface-2 text-muted'] as const;

export function PriorityPill({ priority }: { priority: number }) {
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-bold tabular-nums ${PRIORITY_STYLES[priority] ?? PRIORITY_STYLES[3]}`} title={`Priority ${priority}`}>
      P{priority}
    </span>
  );
}

const STATE_STYLES: Record<string, string> = {
  ok: 'text-muted',
  flagged: 'text-warn',
  pending: 'text-muted',
  hidden: 'text-warn',
  removed: 'text-danger',
  blocked: 'text-danger',
  deleted: 'text-danger',
  suspended: 'text-danger',
  restricted: 'text-warn',
};

export function TargetState({ state }: { state: string }) {
  return <span className={`text-xs font-medium capitalize ${STATE_STYLES[state] ?? 'text-muted'}`}>{state === 'ok' ? 'Visible' : state}</span>;
}

export function TargetLink({ target }: { target: CaseTarget }) {
  const label = target.type === 'bug' ? 'Bug report' : target.name || target.vanity || target.id;
  const href = targetHref(target);
  return href ? (
    <Link to={href} className="min-w-0 truncate text-gg hover:underline">
      {label}
    </Link>
  ) : (
    <span className="min-w-0 truncate">{label}</span>
  );
}

export function When({ at, now }: { at: number; now: number }) {
  return (
    <time dateTime={new Date(epochMs(at)).toISOString()} title={formatFullDate(epochMs(at))} className="whitespace-nowrap">
      {formatRelative(epochMs(at), now)}
    </time>
  );
}

export function Section({ title, children, actions, id }: { title: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="py-8 text-center text-sm text-muted">
      {label}
    </p>
  );
}

export function Failure({ error }: { error: unknown }) {
  return (
    <p role="alert" className="py-8 text-center text-sm text-danger">
      {adminError(error)}
    </p>
  );
}
