import { useId, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Button } from '../../../components/Button';
import { REPORT_REASONS } from '../../../lib/api';
import { fieldClass } from '../../access/fieldUtils';
import { useToast } from '../../components/toastContext';
import { useIsNarrow } from '../../components/useMediaQuery';
import { reportReasonLabel } from '../../safety/labels';
import type { CaseKind, CaseSummary, CasesParams, Priority } from '../adminApi';
import { useMe } from '../../../lib/queries';
import { useCases, useQueueClaim } from '../adminQueries';
import { adminError, FLAG_LABELS, formatAge, KIND_LABELS, reasonsText } from '../format';
import { isAdmin } from '../permissions';
import { useStaff } from '../staffContext';
import { Failure, Loading, PriorityPill, TargetLink, TargetState } from '../components/bits';

const KINDS: CaseKind[] = ['file', 'album', 'user', 'domain', 'hash', 'appeal', 'bug'];


/** Claim, Release, or (admins) Take over, straight from the queue (§9.2). */
function ClaimButton({ item }: { item: CaseSummary }) {
  const staff = useStaff();
  const me = useMe().data?.id ?? null;
  const notify = useToast();
  const claim = useQueueClaim();
  const run = (release: boolean, force = false) =>
    claim.mutate(
      { id: item.id, release, force },
      { onError: (error) => notify(adminError(error), 'error'), onSuccess: () => notify(release ? 'Released.' : 'Claimed.') },
    );
  if (!item.assignee) {
    return (
      <Button variant="ghost" onClick={() => run(false)} disabled={claim.isPending} aria-label={`Claim case ${item.id}`}>
        Claim
      </Button>
    );
  }
  const mine = item.assignee.id === me;
  return (
    <span className="flex items-center gap-1">
      <span className="truncate text-xs text-muted">{mine ? 'You' : item.assignee.username}</span>
      {mine ? (
        <Button variant="ghost" onClick={() => run(true)} disabled={claim.isPending} aria-label={`Release case ${item.id}`}>
          Release
        </Button>
      ) : (
        isAdmin(staff) && (
          <Button variant="ghost" onClick={() => run(false, true)} disabled={claim.isPending} aria-label={`Take over case ${item.id}`}>
            Take over
          </Button>
        )
      )}
    </span>
  );
}

/** The case queue (§9.2, §11.3): by priority then age, with filters in the URL. */
export default function QueuePage({ bugs = false }: { bugs?: boolean }) {
  const id = useId();
  const narrow = useIsNarrow();
  const [params, setParams] = useSearchParams();
  const filters: CasesParams = useMemo(() => {
    const priority = params.get('priority');
    return {
      status: (['open', 'closed', 'all'].includes(params.get('status') ?? '') ? params.get('status') : 'open') as CasesParams['status'],
      priority: priority !== null && /^[0-3]$/.test(priority) ? (Number(priority) as Priority) : undefined,
      reason: params.get('reason') || undefined,
      kind: bugs ? 'bug' : (KINDS.find((kind) => kind === params.get('kind')) ?? undefined),
      assignee: params.get('assignee') || undefined,
      needs_second_review: params.get('second') === '1' ? true : undefined,
      limit: 50,
    };
  }, [params, bugs]);
  const cases = useCases(filters);
  const items = cases.data?.pages.flatMap((page) => page.items) ?? [];

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const select = (key: string, label: string, value: string, options: Array<[string, string]>) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${key}`} className="text-xs text-muted">
        {label}
      </label>
      <select id={`${id}-${key}`} value={value} onChange={(event) => set(key, event.target.value || null)} className={fieldClass}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{bugs ? 'Bug reports' : 'Case queue'}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {select('status', 'Status', params.get('status') ?? 'open', [
          ['open', 'Open'],
          ['closed', 'Closed'],
          ['all', 'All'],
        ])}
        {select('priority', 'Priority', params.get('priority') ?? '', [
          ['', 'Any'],
          ['0', 'P0'],
          ['1', 'P1'],
          ['2', 'P2'],
          ['3', 'P3'],
        ])}
        {!bugs &&
          select('reason', 'Reason', params.get('reason') ?? '', [
            ['', 'Any'],
            ...REPORT_REASONS.filter((reason) => reason !== 'bug').map((reason): [string, string] => [reason, reportReasonLabel(reason)]),
            ...Object.entries(FLAG_LABELS),
          ])}
        {!bugs &&
          select('kind', 'Kind', params.get('kind') ?? '', [
            ['', 'Any'],
            ...KINDS.filter((kind) => kind !== 'bug').map((kind): [string, string] => [kind, KIND_LABELS[kind]]),
          ])}
        {select('assignee', 'Assignee', params.get('assignee') ?? '', [
          ['', 'Anyone'],
          ['me', 'Me'],
          ['none', 'Unassigned'],
        ])}
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={params.get('second') === '1'} onChange={(event) => set('second', event.target.checked ? '1' : null)} className="accent-gg" />
          Needs second review
        </label>
      </div>

      <p className="sr-only" aria-live="polite" role="status">
        {cases.data ? `${items.length}${cases.hasNextPage ? ' or more' : ''} ${items.length === 1 ? 'case' : 'cases'}` : ''}
      </p>

      {cases.isPending ? (
        <Loading label="Loading cases…" />
      ) : cases.isError ? (
        <Failure error={cases.error} />
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line py-10 text-center text-sm text-muted">No cases match.</p>
      ) : narrow ? (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-1.5 rounded-2xl border border-line bg-surface p-3">
              <div className="flex items-center gap-2">
                <PriorityPill priority={item.priority} />
                <Link to={`/admin/cases/${item.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-gg">
                  {KIND_LABELS[item.kind]} · {reasonsText(item)}
                </Link>
                <span className="text-xs text-muted">{formatAge(item.age_seconds)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <TargetLink target={item.target} />
                <TargetState state={item.target.state} />
                <span className="text-muted">
                  {item.distinct_reporters} {item.distinct_reporters === 1 ? 'reporter' : 'reporters'}
                </span>
                {item.child_safety && <span className="font-semibold text-danger">Child safety</span>}
                {item.needs_second_review && <span className="text-warn">Second review</span>}
              </div>
              <ClaimButton item={item} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Priority</th>
                <th scope="col" className="px-3 py-2 font-medium">Age</th>
                <th scope="col" className="px-3 py-2 font-medium">Reasons</th>
                <th scope="col" className="px-3 py-2 font-medium">Target</th>
                <th scope="col" className="px-3 py-2 font-medium">Reporters</th>
                <th scope="col" className="px-3 py-2 font-medium">Target state</th>
                <th scope="col" className="px-3 py-2 font-medium">Assignee</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                  <td className="px-3 py-2">
                    <PriorityPill priority={item.priority} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{formatAge(item.age_seconds)}</td>
                  <td className="px-3 py-2">
                    <Link to={`/admin/cases/${item.id}`} className="font-medium hover:text-gg hover:underline">
                      {KIND_LABELS[item.kind]}: {reasonsText(item)}
                    </Link>
                    <span className="flex gap-2 text-xs">
                      {item.child_safety && <span className="font-semibold text-danger">Child safety</span>}
                      {item.needs_second_review && <span className="text-warn">Second review</span>}
                      {item.status === 'closed' && <span className="text-muted">Closed</span>}
                    </span>
                  </td>
                  <td className="max-w-56 px-3 py-2">
                    <span className="flex">
                      <TargetLink target={item.target} />
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {item.distinct_reporters}
                    {item.report_count > item.distinct_reporters && <span className="text-muted"> ({item.report_count} reports)</span>}
                  </td>
                  <td className="px-3 py-2">
                    <TargetState state={item.target.state} />
                  </td>
                  <td className="px-3 py-2">
                    <ClaimButton item={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cases.hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => void cases.fetchNextPage()} disabled={cases.isFetchingNextPage}>
            {cases.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
