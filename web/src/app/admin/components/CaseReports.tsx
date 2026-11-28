import { Send } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '../../../components/Button';
import { RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { fieldClass } from '../../access/fieldUtils';
import { reportReasonLabel } from '../../safety/labels';
import type { StaffReport } from '../adminApi';
import { useCaseMessage } from '../adminQueries';
import { CANNED_RESPONSES } from '../canned';
import { adminError } from '../format';
import { When } from './bits';

const DMCA_LABELS: Record<string, string> = {
  name: 'Name',
  address: 'Address',
  phone: 'Phone',
  email: 'Email',
  work: 'Work',
  urls: 'Links',
  good_faith: 'Good-faith statement',
  accurate_and_authorised: 'Accurate and authorised',
  signature: 'Signature',
};

function Reporter({ reporter }: { reporter: StaffReport['reporter'] }) {
  if (!reporter.signed_in) return <span>Anonymous reporter</span>;
  return (
    <span>
      Signed-in reporter
      {reporter.account_age_days !== undefined && ` · account ${reporter.account_age_days} ${reporter.account_age_days === 1 ? 'day' : 'days'} old`}
    </span>
  );
}

function Reply({ caseId, report }: { caseId: string; report: StaffReport }) {
  const id = useId();
  const send = useCaseMessage(caseId);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.trim()) {
          setError('Write a message first.');
          return;
        }
        send.mutate(
          { reportId: report.id, body: draft.trim() },
          {
            onSuccess: () => {
              setDraft('');
              setError(null);
              setSent(true);
            },
            onError: (failure) => setError(adminError(failure)),
          },
        );
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-canned`} className="text-xs text-muted">
            Canned response
          </label>
          <select
            id={`${id}-canned`}
            value=""
            onChange={(event) => {
              if (event.target.value) setDraft(event.target.value);
            }}
            className={fieldClass}
          >
            <option value="">Pick one to fill in the reply</option>
            {CANNED_RESPONSES.map((response) => (
              <option key={response.label} value={response.body}>
                {response.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor={`${id}-body`} className="text-sm font-medium">
        Reply to the reporter
      </label>
      <textarea
        id={`${id}-body`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSent(false);
        }}
        rows={2}
        maxLength={2000}
        className="w-full resize-y rounded-xl border border-line bg-bg px-3 py-2 text-[15px]"
      />
      <p className="text-xs text-muted">Reporters see replies from “files.gg staff”, never your name.</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={send.isPending}>
          <Send aria-hidden className="size-4" />
          {send.isPending ? 'Sending…' : 'Send reply'}
        </Button>
        <span role="status" className="text-xs text-muted">
          {sent ? 'Sent.' : ''}
        </span>
      </div>
    </form>
  );
}

/** A case's reports (§9.2): reason, part, details, the DMCA notice, the reporter, the thread and a reply box. */
export function CaseReports({ caseId, reports, escalated, readOnly = false }: { caseId: string; reports: StaffReport[]; escalated: boolean; readOnly?: boolean }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  if (reports.length === 0) return <p className="text-sm text-muted">No reports. This case came from the scanner or an appeal.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {reports.map((report) => (
        <li key={report.id} className="flex flex-col gap-2 rounded-xl border border-line bg-bg p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-semibold">{reportReasonLabel(report.reason)}</span>
            {report.album_part && report.album_part !== 'whole' && <span className="text-muted">· the album’s {report.album_part}</span>}
            {report.status && report.status !== 'open' && <span className="text-xs text-muted capitalize">· {report.status}</span>}
            <span className="ml-auto text-xs text-muted">
              <When at={report.created_at} now={now} />
            </span>
          </div>
          <p className="text-xs text-muted">
            <Reporter reporter={report.reporter} />
          </p>
          {report.details && <p className="text-sm break-words whitespace-pre-wrap">{report.details}</p>}
          {report.dmca && (
            <details className="rounded-xl border border-line px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium">Copyright notice</summary>
              <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                {Object.entries(report.dmca).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-muted">{DMCA_LABELS[key] ?? key}</dt>
                    <dd className="break-words">{Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          {report.messages && report.messages.length > 0 && (
            <ol className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
              {report.messages.map((message) => (
                <li key={message.id} className="text-sm">
                  <span className={`text-xs font-semibold ${message.author === 'staff' ? 'text-gg' : ''}`}>
                    {message.author === 'staff' ? `Staff${message.author_name ? ` (${message.author_name})` : ''}` : 'Reporter'}
                  </span>{' '}
                  <span className="text-xs text-muted">
                    <When at={message.created_at} now={now} />
                  </span>
                  <p className="break-words whitespace-pre-wrap">{message.body}</p>
                </li>
              ))}
            </ol>
          )}
          {/* §7.5: escalated (CSAM) reports get no details in their thread. */}
          {readOnly ? null : report.reporter.signed_in && !escalated && report.reason !== 'csam' ? (
            <Reply caseId={caseId} report={report} />
          ) : (
            <p className="text-xs text-muted">{report.reporter.signed_in ? 'Escalated reports get no replies in their thread.' : 'Anonymous reporters have no thread.'}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
