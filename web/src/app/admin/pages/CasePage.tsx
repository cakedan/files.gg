import { ArrowLeft } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';

import { Button } from '../../../components/Button';
import { ApiError } from '../../../lib/api';
import { useMe } from '../../../lib/queries';
import { RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { fieldClass } from '../../access/fieldUtils';
import { useToast } from '../../components/toastContext';
import { noticeActionLabel, RULE_TEXT } from '../../safety/labels';
import { isAlbumDetail, isFileDetail, isUserDetail, type CaseDetail } from '../adminApi';
import { useCase, useClaim, useCloseCase, useCybertip, useDecideAppeal, useRelease, useSecondReview } from '../adminQueries';
import { CLOSE_MESSAGES } from '../canned';
import { adminError, flagLabel, KIND_LABELS } from '../format';
import { actionLabel, isAdmin } from '../permissions';
import { useStaff } from '../staffContext';
import { Failure, Loading, PriorityPill, Section, TargetLink, TargetState, When } from '../components/bits';
import { CaseReports } from '../components/CaseReports';
import { History } from '../components/History';
import { StaffMedia } from '../components/StaffMedia';
import { AlbumTarget, FileTarget, UserTarget } from '../components/TargetPanels';

/** A case (§9.2, §11.3): target preview, reports and flags, history, claim, actions, close, appeal, CyberTipline. */
export default function CasePage() {
  const { id = '' } = useParams();
  const detail = useCase(id);
  return (
    <div className="flex flex-col gap-4">
      <Link to="/admin/queue" className="inline-flex items-center gap-1 self-start text-sm text-muted hover:text-text">
        <ArrowLeft aria-hidden className="size-4" />
        Queue
      </Link>
      {detail.isPending ? (
        <Loading label="Loading case…" />
      ) : detail.isError ? (
        detail.error instanceof ApiError && detail.error.code === 'UNKNOWN_CASE' ? (
          <p className="text-sm text-muted">This case doesn’t exist, or you don’t have access to it.</p>
        ) : (
          <Failure error={detail.error} />
        )
      ) : (
        <Case detail={detail.data} />
      )}
    </div>
  );
}

function ClaimBar({ detail }: { detail: CaseDetail }) {
  const staff = useStaff();
  const me = useMe().data?.id ?? null;
  const claim = useClaim(detail.id);
  const release = useRelease(detail.id);
  const [error, setError] = useState<string | null>(null);
  const [claimedBy, setClaimedBy] = useState<string | null>(null);
  const mine = detail.assignee?.id === me;
  const onError = (failure: unknown) => {
    setError(adminError(failure));
    if (failure instanceof ApiError && failure.code === 'CASE_CLAIMED') setClaimedBy(String((failure.body as { assignee_id?: unknown })?.assignee_id ?? ''));
  };
  const take = (force: boolean) =>
    claim.mutate(force, {
      onSuccess: () => {
        setError(null);
        setClaimedBy(null);
      },
      onError,
    });

  if (detail.status === 'closed') return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">{detail.assignee ? (mine ? 'You claimed this case.' : `Claimed by ${detail.assignee.username}.`) : 'Nobody has claimed this case.'}</span>
      {mine ? (
        <Button onClick={() => release.mutate(undefined, { onError })} disabled={release.isPending}>
          Release
        </Button>
      ) : !detail.assignee ? (
        <Button variant="primary" onClick={() => take(false)} disabled={claim.isPending}>
          Claim
        </Button>
      ) : (
        isAdmin(staff) && (
          <Button onClick={() => take(true)} disabled={claim.isPending}>
            Take over
          </Button>
        )
      )}
      {error && (
        <span role="alert" className="text-danger">
          {error}
          {claimedBy && claimedBy !== detail.assignee?.id && ' Refresh to see who.'}
        </span>
      )}
    </div>
  );
}

function CloseForm({ detail }: { detail: CaseDetail }) {
  const id = useId();
  const notify = useToast();
  const close = useCloseCase(detail.id);
  const [outcome, setOutcome] = useState<'actioned' | 'dismissed'>('actioned');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const signedInReporters = detail.reports.some((report) => report.reporter.signed_in && report.reason !== 'csam');
  return (
    <Section title="Close the case">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          close.mutate(
            { outcome, reason: reason.trim(), ...(message.trim() ? { reporter_message: message.trim() } : {}) },
            { onSuccess: () => notify('Case closed.'), onError: (failure) => setError(adminError(failure)) },
          );
        }}
      >
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="mb-1 text-sm font-medium">Outcome</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${id}-outcome`} checked={outcome === 'actioned'} onChange={() => setOutcome('actioned')} className="accent-gg" />
            Actioned (reports are resolved)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${id}-outcome`} checked={outcome === 'dismissed'} onChange={() => setOutcome('dismissed')} className="accent-gg" />
            Dismissed (nothing to act on)
          </label>
        </fieldset>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-reason`} className="text-sm font-medium">
            Reason (staff only)
          </label>
          <input id={`${id}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} className={fieldClass} />
        </div>
        {signedInReporters && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-message`} className="text-sm font-medium">
              Message to reporters
            </label>
            <textarea
              id={`${id}-message`}
              value={message}
              placeholder={CLOSE_MESSAGES[outcome]}
              onChange={(event) => setMessage(event.target.value)}
              rows={2}
              maxLength={2000}
              className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted">Left empty, reporters get the text shown.</p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={close.isPending}>
            {close.isPending ? 'Closing…' : 'Close the case'}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function AppealDecision({ detail }: { detail: CaseDetail }) {
  const id = useId();
  const notify = useToast();
  const decide = useDecideAppeal(detail.id);
  const now = useNow(RELATIVE_REFRESH_MS);
  const [decision, setDecision] = useState<'grant' | 'deny'>('deny');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sameModerator, setSameModerator] = useState(false);
  const appeal = detail.appeal;
  if (!appeal) return null;
  const { notice } = appeal;
  const counter = appeal.counter_notice;
  return (
    <Section title="Appeal">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Notice</dt>
          <dd>
            {noticeActionLabel(notice.action)} · {notice.rule_text ?? RULE_TEXT[notice.rule] ?? notice.rule}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Original action</dt>
          <dd>
            {appeal.original_action ? (
              <>
                {actionLabel(appeal.original_action.action)} by {appeal.original_action.actor.kind === 'system' ? 'the system' : (appeal.original_action.actor.username ?? 'staff')},{' '}
                <When at={appeal.original_action.created_at} now={now} />
                {appeal.original_action.note && <span className="block text-xs text-muted">Note: {appeal.original_action.note}</span>}
              </>
            ) : (
              'Unknown'
            )}
          </dd>
        </div>
        {appeal.user && (
          <div>
            <dt className="text-xs text-muted">From</dt>
            <dd>
              <Link to={`/admin/users/${appeal.user.id}`} className="text-gg hover:underline">
                {appeal.user.username ?? appeal.user.id}
              </Link>
            </dd>
          </div>
        )}
        {notice.message && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Message in the notice</dt>
            <dd className="break-words whitespace-pre-wrap">{notice.message}</dd>
          </div>
        )}
        {appeal.message && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">The appeal</dt>
            <dd className="break-words whitespace-pre-wrap">{appeal.message}</dd>
          </div>
        )}
      </dl>
      {counter && (
        <details className="rounded-md border border-line px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">Counter-notice</summary>
          <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            {Object.entries(counter).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted">{key.replace(/_/g, ' ')}</dt>
                <dd className="break-words">{typeof value === 'boolean' ? (value ? 'Agreed' : 'No') : String(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-muted">Forwarding it to the complainant and restoring after the waiting period are manual steps.</p>
        </details>
      )}
      {detail.status === 'open' && notice.appeal.state === 'open' ? (
        sameModerator ? (
          <p role="alert" className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm">
            You took the original action, so another staff member has to decide this appeal. It stays in the queue under “Needs second review”.
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              decide.mutate(
                { decision, message: message.trim() },
                {
                  onSuccess: () => notify(decision === 'grant' ? 'Appeal granted.' : 'Appeal denied.'),
                  onError: (failure) => {
                    if (failure instanceof ApiError && failure.code === 'SAME_MODERATOR') setSameModerator(true);
                    else setError(adminError(failure));
                  },
                },
              );
            }}
          >
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="mb-1 text-sm font-medium">Decision</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${id}-decision`} checked={decision === 'grant'} onChange={() => setDecision('grant')} className="accent-gg" />
                Grant (reverses the action and removes the strike)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name={`${id}-decision`} checked={decision === 'deny'} onChange={() => setDecision('deny')} className="accent-gg" />
                Deny (keeps everything)
              </label>
            </fieldset>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-reply`} className="text-sm font-medium">
                Reply to the owner
              </label>
              <textarea id={`${id}-reply`} value={message} onChange={(event) => setMessage(event.target.value)} rows={3} maxLength={2000} className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm" />
              <p className="text-xs text-muted">The owner sees this with the decision.</p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={decide.isPending}>
                {decide.isPending ? 'Saving…' : 'Decide'}
              </Button>
            </div>
          </form>
        )
      ) : (
        <p className="text-sm text-muted">
          Appeal {notice.appeal.state}
          {notice.appeal.message ? `: ${notice.appeal.message}` : '.'}
        </p>
      )}
    </Section>
  );
}

function Cybertip({ detail }: { detail: CaseDetail }) {
  const id = useId();
  const notify = useToast();
  const record = useCybertip(detail.id);
  const now = useNow(RELATIVE_REFRESH_MS);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="CyberTipline report">
      {detail.cybertip_report_id ? (
        <p className="text-sm">
          Report {detail.cybertip_report_id} recorded{detail.cybertip_filed_at ? ' ' : '.'}
          {detail.cybertip_filed_at && <When at={detail.cybertip_filed_at} now={now} />}
        </p>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!value.trim()) {
              setError('Enter the report number NCMEC gave you.');
              return;
            }
            record.mutate(value.trim(), { onSuccess: () => notify('CyberTipline report recorded.'), onError: (failure) => setError(adminError(failure)) });
          }}
        >
          <p className="text-sm text-muted">File the report through NCMEC’s process outside files.gg, then record its number here.</p>
          <label htmlFor={`${id}-report`} className="text-sm font-medium">
            Report number
          </label>
          <div className="flex flex-wrap gap-2">
            <input id={`${id}-report`} value={value} onChange={(event) => setValue(event.target.value)} className={`${fieldClass} max-w-xs`} />
            <Button type="submit" disabled={record.isPending}>
              Record
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </Section>
  );
}

function Case({ detail }: { detail: CaseDetail }) {
  const staff = useStaff();
  const now = useNow(RELATIVE_REFRESH_MS);
  const secondReview = useSecondReview(detail.id);
  const target = detail.target_detail;
  const hashMatched = Boolean(detail.hash_matched);
  const open = detail.status === 'open';

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
          <PriorityPill priority={detail.priority} />
          {KIND_LABELS[detail.kind]} case
          {detail.child_safety && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-xs font-semibold text-danger">Child safety</span>}
          {detail.status === 'closed' && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">Closed{detail.outcome ? `: ${detail.outcome}` : ''}</span>}
        </h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span className="flex min-w-0 items-center gap-2">
            <TargetLink target={detail.target} /> <TargetState state={detail.target.state} />
          </span>
          <span>
            Opened <When at={detail.created_at} now={now} />
          </span>
          <span>
            {detail.distinct_reporters} distinct {detail.distinct_reporters === 1 ? 'reporter' : 'reporters'}
          </span>
        </div>
        <ClaimBar detail={detail} />
        {open && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={detail.needs_second_review}
              disabled={secondReview.isPending}
              onChange={(event) => secondReview.mutate(event.target.checked)}
              className="accent-gg"
            />
            Needs second review
          </label>
        )}
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {hashMatched && !isFileDetail(target) && (
            <Section title="Target">
              <StaffMedia kind="image" label="hash-matched content" urls={undefined} hashMatched />
            </Section>
          )}
          {isFileDetail(target) && <FileTarget detail={target} caseId={detail.id} childSafety={detail.child_safety} part="info" />}
          {isAlbumDetail(target) && <AlbumTarget detail={target} caseId={detail.id} childSafety={detail.child_safety} part="info" />}
          {isUserDetail(target) && detail.kind !== 'appeal' && <UserTarget detail={target} caseId={detail.id} part="info" />}

          {detail.kind === 'appeal' && <AppealDecision detail={detail} />}

          <Section title={detail.kind === 'bug' ? 'Bug report' : 'Reports'}>
            <CaseReports caseId={detail.id} reports={detail.reports} escalated={detail.child_safety} />
          </Section>

          {detail.flags.length > 0 && (
            <Section title="Flags">
              <ul className="flex flex-col gap-1 text-sm">
                {detail.flags.map((flag) => (
                  <li key={flag.id} className={flag.resolved_at ? 'text-muted line-through' : ''}>
                    {flagLabel(flag.reason)} <span className="text-xs text-muted">({flag.source})</span>{' '}
                    <span className="text-xs text-muted">
                      <When at={flag.created_at} now={now} />
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="History">
            <History entries={detail.actions} />
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {open && isFileDetail(target) && <FileTarget detail={target} caseId={detail.id} childSafety={detail.child_safety} part="actions" />}
          {open && isAlbumDetail(target) && <AlbumTarget detail={target} caseId={detail.id} childSafety={detail.child_safety} part="actions" />}
          {open && isUserDetail(target) && detail.kind !== 'appeal' && <UserTarget detail={target} caseId={detail.id} part="actions" />}
          {detail.child_safety && staff.child_safety && <Cybertip detail={detail} />}
          {open && detail.kind !== 'appeal' && <CloseForm detail={detail} />}
        </div>
      </div>
    </div>
  );
}
