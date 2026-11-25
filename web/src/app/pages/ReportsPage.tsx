import { Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Button } from '../../components/Button';
import { REPORT_STATUSES, type ReportStatus } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { pageCount, PAGE_SIZE } from '../../lib/files/urlState';
import { useMyReports, useSignedIn } from '../../lib/queries';
import { SignInLink } from '../components/SignInLink';
import { epochMs, formatFullDate, formatRelative, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { fieldClass } from '../access/fieldUtils';
import { Chip } from '../components/Chip';
import { useDebounced } from '../components/useDebounced';
import { pluralize } from '../files/fileLabels';
import { Pagination } from '../files/Pagination';
import { ReportStatusPill } from '../reports/reportParts';
import { reportTargetLabel } from '../reports/reportTarget';
import { CountBadge } from '../safety/SafetyBadge';
import { reportReasonLabel, REPORT_STATUS_LABELS } from '../safety/labels';

const asStatus = (value: string | null): ReportStatus | undefined => REPORT_STATUSES.find((status) => status === value);

/** My reports (milestone-4 §7.6, §11.2): status chips, search, 25 a page. */
export default function ReportsPage() {
  useEffect(() => {
    document.title = 'My reports · files.gg';
  }, []);
  const id = useId();
  const [params, setParams] = useSearchParams();
  const status = asStatus(params.get('status'));
  const urlQuery = params.get('q')?.trim() ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(urlQuery);
  const debounced = useDebounced(search.trim(), 300);
  const now = useNow(RELATIVE_REFRESH_MS);

  const update = (patch: { status?: ReportStatus | null; q?: string; page?: number }) => {
    const next = new URLSearchParams(params);
    const set = (key: string, value: string | null | undefined) => (value ? next.set(key, value) : next.delete(key));
    if ('status' in patch) set('status', patch.status ?? null);
    if ('q' in patch) set('q', patch.q);
    set('page', patch.page && patch.page > 1 ? String(patch.page) : null);
    setParams(next, { replace: 'q' in patch });
  };

  useEffect(() => {
    if (debounced !== urlQuery) update({ q: debounced });
    // Only the debounced text drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const signedIn = useSignedIn();
  const reports = useMyReports({ status, query: urlQuery || undefined, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }, signedIn);
  const data = reports.data;

  if (!signedIn) {
    return (
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">My reports</h1>
        <p className="text-muted">
          <SignInLink /> to follow the reports you send and read replies from the files.gg team.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">My reports</h1>
        <p className="text-sm text-muted">Reports you’ve sent and replies from the files.gg team.</p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
          <Chip pressed={!status} onClick={() => update({ status: null })}>
            All
          </Chip>
          {REPORT_STATUSES.map((value) => (
            <Chip key={value} pressed={status === value} onClick={() => update({ status: value })}>
              {REPORT_STATUS_LABELS[value]}
            </Chip>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:w-72">
          <label htmlFor={`${id}-search`} className="sr-only">
            Search reports
          </label>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
          <input
            id={`${id}-search`}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by link"
            className={`${fieldClass} pl-8`}
          />
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {data ? `${pluralize(data.count, 'report')}` : ''}
      </p>

      {reports.isPending ? (
        <p role="status" className="py-10 text-center text-sm text-muted">
          Loading reports…
        </p>
      ) : reports.isError ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-danger" role="alert">
            {errorMessage(reports.error)}
          </p>
          <Button onClick={() => void reports.refetch()}>Try again</Button>
        </div>
      ) : reports.data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line py-12 text-center text-sm text-muted">
          {status || urlQuery ? 'No reports match.' : 'You haven’t sent any reports. Use Report on a file or album page to send one.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {reports.data.items.map((report) => (
            <li key={report.id}>
              <Link
                to={`/reports/${report.id}`}
                className="flex flex-col gap-1 px-4 py-3 hover:bg-surface-2/60 sm:flex-row sm:items-center sm:gap-4"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`truncate text-sm ${report.unread > 0 ? 'font-semibold' : 'font-medium'}`}>{reportReasonLabel(report.reason)}</span>
                  <span className="truncate text-xs text-muted">{reportTargetLabel(report)}</span>
                </span>
                <span className="flex items-center gap-3 text-xs text-muted">
                  <ReportStatusPill report={report} />
                  <span title={formatFullDate(epochMs(report.created_at))}>{formatRelative(epochMs(report.created_at), now)}</span>
                  <CountBadge count={report.unread} label={report.unread === 1 ? 'unread update' : 'unread updates'} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Pagination page={page} pages={data ? pageCount(data.count) : 1} onPage={(next) => update({ page: next })} />
    </section>
  );
}
