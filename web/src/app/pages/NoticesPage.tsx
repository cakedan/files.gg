import { CheckCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../../components/Button';
import { api, hasToken } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { pageCount, PAGE_SIZE } from '../../lib/files/urlState';
import { useAcknowledgeNotices, useNotices } from '../../lib/queries';
import { RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { useToast } from '../components/toastContext';
import { pluralize } from '../files/fileLabels';
import { Pagination } from '../files/Pagination';
import { NoticeCard } from '../notices/NoticeCard';

/** Notices (milestone-4 §8.2, §11.2): newest first, Acknowledge, Acknowledge all, Appeal. */
export default function NoticesPage() {
  useEffect(() => {
    document.title = 'Notices · files.gg';
  }, []);
  const signedIn = hasToken();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const notices = useNotices({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }, signedIn);
  const acknowledge = useAcknowledgeNotices();
  const notify = useToast();
  const now = useNow(RELATIVE_REFRESH_MS);
  const [collecting, setCollecting] = useState(false);
  const data = notices.data;

  const acknowledgeAll = async () => {
    setCollecting(true);
    try {
      // Every unacknowledged notice, not only this page's (the API takes ids).
      const ids: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const batch = await api.notices({ unacknowledged: true, offset, limit: 100 });
        ids.push(...batch.items.map((notice) => notice.id));
        if (batch.items.length < 100) break;
      }
      for (let i = 0; i < ids.length; i += 100) await acknowledge.mutateAsync(ids.slice(i, i + 100));
      notify(`Acknowledged ${pluralize(ids.length, 'notice')}.`);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setCollecting(false);
    }
  };

  if (!signedIn) {
    return (
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Notices</h1>
        <p className="text-muted">Sign in to see moderation notices about your files or account.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Notices</h1>
          <p className="text-sm text-muted">Moderation notices about your files or account.</p>
        </div>
        {data && data.unacknowledged > 0 && (
          <Button onClick={() => void acknowledgeAll()} disabled={collecting}>
            <CheckCheck aria-hidden className="size-4" />
            Acknowledge all
          </Button>
        )}
      </header>

      {notices.isPending ? (
        <p role="status" className="py-10 text-center text-sm text-muted">
          Loading notices…
        </p>
      ) : notices.isError ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-danger" role="alert">
            {errorMessage(notices.error)}
          </p>
          <Button onClick={() => void notices.refetch()}>Try again</Button>
        </div>
      ) : notices.data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line py-12 text-center text-sm text-muted">No notices. When the files.gg team acts on your files or account, it shows up here.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {notices.data.items.map((notice) => (
            <li key={notice.id}>
              <NoticeCard notice={notice} now={now} />
            </li>
          ))}
        </ul>
      )}

      <Pagination
        page={page}
        pages={data ? pageCount(data.count) : 1}
        onPage={(next) => setParams(next > 1 ? { page: String(next) } : {})}
      />
    </section>
  );
}
