import { Link } from 'react-router';

import { reportReasonLabel } from '../../safety/labels';
import type { CaseSummary } from '../adminApi';
import { flagLabel, formatAge, KIND_LABELS } from '../format';
import { PriorityPill } from './bits';

/** A short list of cases, for target pages. */
export function CaseList({ cases }: { cases: CaseSummary[] }) {
  if (cases.length === 0) return <p className="text-sm text-muted">No cases.</p>;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {cases.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center gap-2">
          <PriorityPill priority={item.priority} />
          <Link to={`/admin/cases/${item.id}`} className="text-gg hover:underline">
            {KIND_LABELS[item.kind]} case
          </Link>
          <span className="text-muted">
            {[...Object.keys(item.reasons).map(reportReasonLabel), ...item.flags.map(flagLabel)].join(', ') || 'No open reports'}
          </span>
          <span className="ml-auto text-xs text-muted">
            {item.status === 'closed' ? 'Closed' : `Open ${formatAge(item.age_seconds)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
