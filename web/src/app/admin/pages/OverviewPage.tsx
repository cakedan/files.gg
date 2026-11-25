import { useId, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../../components/Button';
import { RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { useToast } from '../../components/toastContext';
import type { RescanBody } from '../adminApi';
import { useAdminSummary, useRescans, useStaffList } from '../adminQueries';
import { adminError } from '../format';
import { canRescan, isAdmin } from '../permissions';
import { useStaff } from '../staffContext';
import { Failure, Loading, Section, When } from '../components/bits';

function Stat({ label, value, to, tone }: { label: string; value: number; to?: string; tone?: 'danger' | 'warn' }) {
  const body = (
    <>
      <span className={`text-2xl font-semibold tabular-nums ${tone === 'danger' && value > 0 ? 'text-danger' : tone === 'warn' && value > 0 ? 'text-warn' : ''}`}>{value}</span>
      <span className="text-xs text-muted">{label}</span>
    </>
  );
  const className = 'flex flex-col gap-0.5 rounded-lg border border-line bg-surface px-4 py-3';
  return to ? (
    <Link to={to} className={`${className} hover:border-gg/50`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

const CHECKS: Array<{ value: RescanBody['checks'][number]; label: string }> = [
  { value: 'clamav', label: 'ClamAV' },
  { value: 'csam', label: 'CSAM matching' },
  { value: 'pdq', label: 'PDQ near-matches' },
  { value: 'web_risk', label: 'Web Risk' },
];

function Rescans() {
  const id = useId();
  const notify = useToast();
  const rescan = useRescans();
  const [checks, setChecks] = useState<Set<RescanBody['checks'][number]>>(new Set(['clamav']));
  const [after, setAfter] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Rescans">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (checks.size === 0) {
            setError('Pick at least one check.');
            return;
          }
          const uploadedAfter = after ? Math.floor(new Date(after).getTime() / 1000) : undefined;
          rescan.mutate(
            { checks: [...checks], ...(uploadedAfter ? { uploaded_after: uploadedAfter } : {}) },
            { onSuccess: ({ queued }) => notify(`Queued ${queued.toLocaleString('en')} rescans.`), onError: (failure) => setError(adminError(failure)) },
          );
        }}
      >
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="mb-1 text-sm font-medium">Checks</legend>
          {CHECKS.map((check) => (
            <label key={check.value} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={checks.has(check.value)}
                onChange={(event) =>
                  setChecks((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(check.value);
                    else next.delete(check.value);
                    return next;
                  })
                }
                className="accent-gg"
              />
              {check.label}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-after`} className="text-sm font-medium">
            Uploaded after (optional)
          </label>
          <input id={`${id}-after`} type="date" value={after} onChange={(event) => setAfter(event.target.value)} className="h-9 max-w-xs rounded-md border border-line bg-bg px-2 text-sm" />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={rescan.isPending}>
            Queue rescans
          </Button>
        </div>
      </form>
    </Section>
  );
}

function StaffList() {
  const staff = useStaffList(true);
  const now = useNow(RELATIVE_REFRESH_MS);
  return (
    <Section title="Staff">
      {staff.isPending ? (
        <Loading label="Loading staff…" />
      ) : staff.isError ? (
        <Failure error={staff.error} />
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {staff.data.items.map((member) => (
            <li key={member.user_id} className="flex flex-wrap items-center gap-x-2">
              <Link to={`/admin/users/${member.user_id}`} className="text-gg hover:underline">
                {member.username}
              </Link>
              <span className="text-muted">
                {member.role}
                {member.child_safety ? ', child safety' : ''}
              </span>
              <span className="ml-auto text-xs text-muted">
                since <When at={member.granted_at} now={now} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">Staff are granted on the server with python -m tools.staff.</p>
    </Section>
  );
}

/** `/app/admin` (§11.3): the summary counts, past-goal counts, stalled scans and unrecorded CyberTipline reports. */
export default function OverviewPage() {
  const staff = useStaff();
  const summary = useAdminSummary();
  if (summary.isPending) return <Loading label="Loading the summary…" />;
  if (summary.isError) return <Failure error={summary.error} />;
  const data = summary.data;
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Overview</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="P0 open" value={data.open.p0} to="/admin/queue?priority=0" tone="danger" />
        <Stat label="P1 open" value={data.open.p1} to="/admin/queue?priority=1" />
        <Stat label="P2 open" value={data.open.p2} to="/admin/queue?priority=2" />
        <Stat label="P3 open" value={data.open.p3} to="/admin/queue?priority=3" />
        <Stat label="Unassigned" value={data.unassigned} to="/admin/queue?assignee=none" />
        <Stat label="Mine" value={data.mine} to="/admin/queue?assignee=me" />
        <Stat label="Appeals" value={data.appeals} to="/admin/queue?kind=appeal" />
        <Stat label="Bugs" value={data.bugs} to="/admin/bugs" />
      </div>
      <h3 className="text-sm font-semibold text-muted">Past the goal</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="P0 older than 24 hours" value={data.past_goal.p0} tone="danger" />
        <Stat label="Others older than 7 days" value={data.past_goal.other} tone="warn" />
        <Stat label="Scans stalled over 10 minutes" value={data.scans_stalled} tone="warn" />
        {staff.child_safety && <Stat label="CyberTipline reports not recorded" value={data.cybertip_unrecorded} tone="danger" />}
      </div>
      {isAdmin(staff) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <StaffList />
          {canRescan(staff) && <Rescans />}
        </div>
      )}
    </div>
  );
}
