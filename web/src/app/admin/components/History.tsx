import { Mail } from 'lucide-react';
import { Link } from 'react-router';

import { RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { RULE_TEXT } from '../../safety/labels';
import type { AuditEntry } from '../adminApi';
import { actionLabel } from '../permissions';
import { targetHref } from '../format';
import { When } from './bits';

/** The audit rows for a case or target (§9.5): who, what, the rule, the note, and notices sent. */
export function History({ entries, showTarget = false, emptyText = 'Nothing yet.' }: { entries: AuditEntry[]; showTarget?: boolean; emptyText?: string }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  if (entries.length === 0) return <p className="text-sm text-muted">{emptyText}</p>;
  return (
    <ol className="flex flex-col divide-y divide-line">
      {entries.map((entry) => {
        const href = entry.target ? targetHref({ type: entry.target.type as 'file', id: entry.target.id }) : null;
        return (
          <li key={entry.id} className="flex flex-col gap-0.5 py-2 text-sm first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{actionLabel(entry.action)}</span>
              {entry.rule && <span className="text-muted">· {RULE_TEXT[entry.rule] ?? entry.rule}</span>}
              {entry.warning_id && (
                <span className="inline-flex items-center gap-1 text-xs text-gg">
                  <Mail aria-hidden className="size-3" />
                  Notice sent
                </span>
              )}
              <span className="ml-auto text-xs text-muted">
                <When at={entry.created_at} now={now} />
              </span>
            </div>
            <div className="flex flex-wrap gap-x-2 text-xs text-muted">
              <span>{entry.actor.kind === 'system' ? 'System' : entry.actor.kind === 'cli' ? 'Command line' : (entry.actor.username ?? 'Staff')}</span>
              {showTarget && entry.target && (href ? <Link to={href} className="text-gg hover:underline">{`${entry.target.type} ${entry.target.id}`}</Link> : <span>{`${entry.target.type} ${entry.target.id}`}</span>)}
              {showTarget && entry.case_id && (
                <Link to={`/admin/cases/${entry.case_id}`} className="text-gg hover:underline">
                  case {entry.case_id}
                </Link>
              )}
              {entry.reverses_action_id && <span>reverses {entry.reverses_action_id}</span>}
            </div>
            {entry.note && <p className="text-xs break-words whitespace-pre-wrap">{entry.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}
