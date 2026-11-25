import { useParams } from 'react-router';

import { ApiError } from '../../../lib/api';
import { useAdminDomain } from '../adminQueries';
import { Failure, Loading, Section } from '../components/bits';
import { CaseList } from '../components/CaseList';
import { History } from '../components/History';
import { DomainTarget } from '../components/TargetPanels';

/** `/app/admin/domains/:id` (milestone-6 §10.12): the domain, its cases, history and actions. */
export default function DomainPage() {
  const { id = '' } = useParams();
  const domain = useAdminDomain(id);
  if (domain.isPending) return <Loading label="Loading domain…" />;
  if (domain.isError) {
    return domain.error instanceof ApiError && domain.error.status === 404 ? <p className="text-sm text-muted">This domain doesn’t exist.</p> : <Failure error={domain.error} />;
  }
  const detail = domain.data;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <DomainTarget detail={detail} part="info" />
        {detail.cases && (
          <Section title="Cases">
            <CaseList cases={detail.cases} />
          </Section>
        )}
        {detail.actions && (
          <Section title="History">
            <History entries={detail.actions} />
          </Section>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <DomainTarget detail={detail} part="actions" />
      </div>
    </div>
  );
}
