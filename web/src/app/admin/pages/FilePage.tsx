import { useParams } from 'react-router';

import { ApiError } from '../../../lib/api';
import { useAdminFile } from '../adminQueries';
import { Failure, Loading, Section } from '../components/bits';
import { CaseList } from '../components/CaseList';
import { CaseReports } from '../components/CaseReports';
import { History } from '../components/History';
import { FileTarget } from '../components/TargetPanels';

/** `/app/admin/files/:id` (§9.6): the staff file detail with the action panel. */
export default function FilePage() {
  const { id = '' } = useParams();
  const file = useAdminFile(id);
  if (file.isPending) return <Loading label="Loading file…" />;
  if (file.isError) {
    return file.error instanceof ApiError && file.error.status === 404 ? <p className="text-sm text-muted">This file doesn’t exist, or you don’t have access to it.</p> : <Failure error={file.error} />;
  }
  const detail = file.data;
  const childSafety = detail.cases.some((each) => each.child_safety);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <FileTarget detail={detail} childSafety={childSafety} part="info" />
        <Section title="Cases">
          <CaseList cases={detail.cases} />
        </Section>
        {detail.reports.length > 0 && (
          <Section title="Reports">
            <CaseReports caseId="" reports={detail.reports} escalated readOnly />
          </Section>
        )}
        <Section title="History">
          <History entries={detail.actions} />
        </Section>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <FileTarget detail={detail} childSafety={childSafety} part="actions" />
      </div>
    </div>
  );
}
