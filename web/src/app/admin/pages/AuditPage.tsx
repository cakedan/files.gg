import { useId, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../../../components/Button';
import { fieldClass } from '../../access/fieldUtils';
import type { AuditParams } from '../adminApi';
import { useAudit } from '../adminQueries';
import { canSeeWholeAudit } from '../permissions';
import { useStaff } from '../staffContext';
import { Failure, Loading, Section } from '../components/bits';
import { History } from '../components/History';

const FILTERS: Array<{ key: keyof AuditParams; label: string }> = [
  { key: 'action', label: 'Action' },
  { key: 'actor_id', label: 'Staff user id' },
  { key: 'case_id', label: 'Case id' },
  { key: 'file_id', label: 'File id' },
  { key: 'album_id', label: 'Album id' },
  { key: 'user_id', label: 'User id' },
];

/** `/app/admin/audit` (§9.5): the whole log, for admins. Moderators see history through cases. */
export default function AuditPage() {
  const id = useId();
  const staff = useStaff();
  const allowed = canSeeWholeAudit(staff);
  const [params, setParams] = useSearchParams();
  const filters: AuditParams = useMemo(() => Object.fromEntries(FILTERS.map(({ key }) => [key, params.get(key) || undefined])), [params]);
  const audit = useAudit({ ...filters, limit: 50 }, allowed);
  const entries = audit.data?.pages.flatMap((page) => page.items) ?? [];

  if (!allowed) {
    return <p className="text-sm text-muted">Only admins can see the whole audit log. A case or target page shows its own history.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Audit log</h2>
      <form
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const next = new URLSearchParams();
          for (const { key } of FILTERS) {
            const value = String(data.get(key) ?? '').trim();
            if (value) next.set(key, value);
          }
          setParams(next);
        }}
      >
        {FILTERS.map(({ key, label }) => (
          <div key={key} className="flex flex-col gap-1">
            <label htmlFor={`${id}-${key}`} className="text-xs text-muted">
              {label}
            </label>
            <input id={`${id}-${key}`} name={key} defaultValue={params.get(key) ?? ''} className={fieldClass} />
          </div>
        ))}
        <div className="col-span-full">
          <Button type="submit">Filter</Button>
        </div>
      </form>
      <Section title="Entries">
        {audit.isPending ? <Loading label="Loading the log…" /> : audit.isError ? <Failure error={audit.error} /> : <History entries={entries} showTarget emptyText="No entries match." />}
      </Section>
      {audit.hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
