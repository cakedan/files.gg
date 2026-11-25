import { ArrowLeft, ExternalLink, RotateCcw, Send } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router';

import { Button } from '../../components/Button';
import { ApiError, type Report } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useMyReport, useReopenReport, useReportMessages, useSendReportMessage } from '../../lib/queries';
import { epochMs, formatFullDate, formatRelative, RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { useToast } from '../components/toastContext';
import { ReportStatusPill } from '../reports/reportParts';
import { reportTargetLabel } from '../reports/reportTarget';
import { reportReasonLabel } from '../safety/labels';

const MESSAGE_MAX = 2000;

function BackLink() {
  return (
    <Link to="/reports" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
      <ArrowLeft aria-hidden className="size-4" />
      My reports
    </Link>
  );
}

/** One report: target, status, the thread with "files.gg staff", reply and Reopen (milestone-4 §7.6). */
export default function ReportPage() {
  const { id = '' } = useParams();
  const report = useMyReport(id);

  useEffect(() => {
    document.title = 'Report · files.gg';
  }, []);

  if (report.isPending) {
    return (
      <p role="status" className="py-10 text-center text-sm text-muted">
        Loading report…
      </p>
    );
  }
  if (report.isError) {
    return (
      <section className="flex flex-col items-start gap-3">
        <BackLink />
        <h1 className="text-2xl font-semibold tracking-tight">Report</h1>
        <p className="text-sm text-danger" role="alert">
          {report.error instanceof ApiError && report.error.code === 'UNKNOWN_REPORT' ? 'This report doesn’t exist, or was deleted.' : errorMessage(report.error)}
        </p>
      </section>
    );
  }
  return <ReportDetail report={report.data} />;
}

function ReportDetail({ report }: { report: Report }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  const notify = useToast();
  const reopen = useReopenReport(report.id);

  return (
    <section className="flex flex-col gap-6">
      <BackLink />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{reportReasonLabel(report.reason)}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <ReportStatusPill report={report} />
          {report.target.url ? (
            <a href={report.target.url} target="_blank" rel="noopener" className="inline-flex min-w-0 items-center gap-1 text-gg hover:underline">
              <span className="truncate">{reportTargetLabel(report)}</span>
              <ExternalLink aria-hidden className="size-3.5 shrink-0" />
            </a>
          ) : (
            <span>{reportTargetLabel(report)}</span>
          )}
          <span title={formatFullDate(epochMs(report.created_at))}>Sent {formatRelative(epochMs(report.created_at), now)}</span>
          {report.resolved_at !== null && (
            <span title={formatFullDate(epochMs(report.resolved_at))}>
              {report.status === 'dismissed' ? 'Dismissed' : 'Resolved'} {formatRelative(epochMs(report.resolved_at), now)}
            </span>
          )}
        </div>
      </header>

      {report.escalated && (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          Thank you. This has been escalated. For these reports the files.gg team doesn’t share details of what happens next.
        </p>
      )}

      {report.can_reopen && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-muted">We didn’t act on this report. If you think we got it wrong, you can reopen it once, within 14 days.</p>
          <Button
            onClick={() =>
              reopen.mutate(undefined, {
                onSuccess: () => notify('Report reopened.'),
                onError: (error) => notify(errorMessage(error), 'error'),
              })
            }
            disabled={reopen.isPending}
          >
            <RotateCcw aria-hidden className="size-4" />
            Reopen
          </Button>
        </div>
      )}

      <Thread report={report} now={now} />
    </section>
  );
}

function Thread({ report, now }: { report: Report; now: number }) {
  const id = useId();
  const messages = useReportMessages(report.id);
  const send = useSendReportMessage(report.id);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) {
      setError('Write a message first.');
      return;
    }
    setError(null);
    send.mutate(body, {
      onSuccess: () => setDraft(''),
      onError: (failure) => setError(errorMessage(failure)),
    });
  };

  return (
    <section aria-labelledby={`${id}-thread`} className="flex flex-col gap-3">
      <h2 id={`${id}-thread`} className="text-lg font-semibold">
        Messages
      </h2>
      {messages.isPending ? (
        <p role="status" className="text-sm text-muted">
          Loading messages…
        </p>
      ) : messages.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(messages.error)}
        </p>
      ) : messages.data.items.length === 0 ? (
        <p className="text-sm text-muted">No messages yet. The files.gg team replies here when there’s news.</p>
      ) : (
        <ol className="flex flex-col gap-3" aria-live="polite">
          {messages.data.items.map((message) => {
            const staff = message.author === 'staff';
            return (
              <li key={message.id} className={`flex flex-col gap-1 rounded-lg border px-4 py-3 ${staff ? 'border-gg/30 bg-gg/5' : 'border-line bg-surface sm:ml-12'}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className={`font-semibold ${staff ? 'text-gg' : 'text-text'}`}>{staff ? 'files.gg staff' : 'You'}</span>
                  <time dateTime={new Date(epochMs(message.created_at)).toISOString()} title={formatFullDate(epochMs(message.created_at))} className="text-muted">
                    {formatRelative(epochMs(message.created_at), now)}
                  </time>
                </div>
                <p className="text-sm break-words whitespace-pre-wrap">{message.body}</p>
              </li>
            );
          })}
        </ol>
      )}

      {report.closed ? (
        <p className="text-sm text-muted">This report is closed, so you can’t reply any more.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor={`${id}-reply`} className="text-sm font-medium">
            Reply
          </label>
          <textarea
            id={`${id}-reply`}
            value={draft}
            maxLength={MESSAGE_MAX}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm"
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">
              {draft.length > MESSAGE_MAX - 200 ? `${draft.length}/${MESSAGE_MAX}` : ''}
            </span>
            <Button type="submit" variant="primary" disabled={send.isPending}>
              <Send aria-hidden className="size-4" />
              {send.isPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
