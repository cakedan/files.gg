import { useParams } from 'react-router';

import { ApiError } from '../../../lib/api';
import { useAdminAlbum } from '../adminQueries';
import { Failure, Loading, Section } from '../components/bits';
import { CaseList } from '../components/CaseList';
import { CaseReports } from '../components/CaseReports';
import { History } from '../components/History';
import { AlbumTarget } from '../components/TargetPanels';

/** `/app/admin/albums/:id` (§9.6): every item blurred, facts and the action panel. */
export default function AlbumPage() {
  const { id = '' } = useParams();
  const album = useAdminAlbum(id);
  if (album.isPending) return <Loading label="Loading album…" />;
  if (album.isError) {
    return album.error instanceof ApiError && album.error.status === 404 ? <p className="text-sm text-muted">This album doesn’t exist.</p> : <Failure error={album.error} />;
  }
  const detail = album.data;
  const childSafety = detail.cases.some((each) => each.child_safety);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <AlbumTarget detail={detail} childSafety={childSafety} part="info" />
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
        <AlbumTarget detail={detail} childSafety={childSafety} part="actions" />
      </div>
    </div>
  );
}
