import { useParams } from 'react-router';

import { ApiError } from '../../../lib/api';
import { RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { noticeActionLabel, RULE_TEXT } from '../../safety/labels';
import { useAdminUser } from '../adminQueries';
import { Failure, Loading, Section, When } from '../components/bits';
import { CaseList } from '../components/CaseList';
import { History } from '../components/History';
import { UserTarget } from '../components/TargetPanels';

/** `/app/admin/users/:id` (§9.6): the account, its notices and strikes, and the account actions. */
export default function UserPage() {
  const { id = '' } = useParams();
  const user = useAdminUser(id);
  const now = useNow(RELATIVE_REFRESH_MS);
  if (user.isPending) return <Loading label="Loading account…" />;
  if (user.isError) {
    return user.error instanceof ApiError && user.error.status === 404 ? <p className="text-sm text-muted">This account doesn’t exist.</p> : <Failure error={user.error} />;
  }
  const detail = user.data;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <UserTarget detail={detail} part="info" />
        {detail.warnings.items && detail.warnings.items.length > 0 && (
          <Section title="Notices">
            <ul className="flex flex-col gap-1 text-sm">
              {detail.warnings.items.map((notice) => (
                <li key={notice.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{noticeActionLabel(notice.action)}</span>
                  <span className="text-muted">{notice.rule_text ?? RULE_TEXT[notice.rule] ?? notice.rule}</span>
                  {notice.appeal.state !== 'none' && <span className="text-xs text-muted">appeal {notice.appeal.state}</span>}
                  <span className="ml-auto text-xs text-muted">
                    <When at={notice.created_at} now={now} />
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
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
        <UserTarget detail={detail} part="actions" />
      </div>
    </div>
  );
}
