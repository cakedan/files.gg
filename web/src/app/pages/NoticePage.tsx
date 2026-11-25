import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';

import { errorMessage } from '../../lib/errors';
import { useNotices, useSignedIn } from '../../lib/queries';
import { RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { NoticeCard } from '../notices/NoticeCard';

/** How many recent notices are searched for one (the API has no single-notice read). */
const NOTICE_LOOKUP_LIMIT = 100;

/** One notice, linked from the Hidden, Removed and Blocked badges (milestone-4 §11.2). */
export default function NoticePage() {
  const { id = '' } = useParams();
  const notices = useNotices({ limit: NOTICE_LOOKUP_LIMIT }, useSignedIn());
  const now = useNow(RELATIVE_REFRESH_MS);
  const notice = notices.data?.items.find((each) => each.id === id);

  useEffect(() => {
    document.title = 'Notice · files.gg';
  }, []);

  return (
    <section className="flex flex-col gap-5">
      <Link to="/notices" className="inline-flex items-center gap-1 self-start text-sm text-muted hover:text-text">
        <ArrowLeft aria-hidden className="size-4" />
        Notices
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Notice</h1>
      {notices.isPending ? (
        <p role="status" className="text-sm text-muted">
          Loading notice…
        </p>
      ) : notices.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(notices.error)}
        </p>
      ) : notice ? (
        <NoticeCard notice={notice} now={now} />
      ) : (
        <p className="text-sm text-muted">This notice doesn’t exist, or it’s older than your latest {NOTICE_LOOKUP_LIMIT} notices.</p>
      )}
    </section>
  );
}
