import { Check, FileWarning, Gavel, ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button';
import type { Notice } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useAcknowledgeNotices } from '../../lib/queries';
import { epochMs, formatFullDate, formatRelative } from '../../lib/time';
import { useToast } from '../components/toastContext';
import { noticeActionLabel } from '../safety/labels';
import { AppealDialog } from './AppealDialog';

function NoticeTarget({ notice }: { notice: Notice }) {
  const { target } = notice;
  if (target.kind === 'account') return <span>Your account</span>;
  if (target.kind === 'album') {
    return (
      <Link to={`/albums/${target.id}`} className="text-gg hover:underline">
        {target.name || 'Your album'}
      </Link>
    );
  }
  const name = target.name || target.vanity || 'Your file';
  return (
    <Link to={`/files?q=${encodeURIComponent(target.name ?? target.vanity ?? '')}`} className="text-gg hover:underline">
      {name}
    </Link>
  );
}

function AppealStatus({ notice, now }: { notice: Notice; now: number }) {
  const { appeal } = notice;
  if (appeal.state === 'none') {
    if (appeal.can_appeal) return null;
    return (
      <p className="text-xs text-muted">
        {notice.action === 'auto_hide' ? 'This is temporary while a report is reviewed, so it can’t be appealed.' : 'This notice can’t be appealed.'}
      </p>
    );
  }
  const heading = appeal.state === 'open' ? 'Appeal sent' : appeal.state === 'granted' ? 'Appeal granted' : 'Appeal denied';
  const at = appeal.state === 'open' ? appeal.appealed_at : appeal.decided_at;
  return (
    <div className={`flex flex-col gap-1 rounded-xl border px-3 py-2 text-sm ${appeal.state === 'granted' ? 'border-gg/40 bg-gg/5' : 'border-line bg-bg'}`}>
      <p className="font-medium">
        {heading}
        {at !== null && (
          <span className="font-normal text-muted" title={formatFullDate(epochMs(at))}>
            {' '}
            · {formatRelative(epochMs(at), now)}
          </span>
        )}
      </p>
      {appeal.state === 'open' && <p className="text-muted">A different member of the files.gg team is reviewing it.</p>}
      {appeal.message && (
        <p className="break-words whitespace-pre-wrap">
          <span className="text-muted">Reply from files.gg staff: </span>
          {appeal.message}
        </p>
      )}
    </div>
  );
}

/** One notice (milestone-4 §8.2, §11.2): action, rule, target, date, message, Acknowledge and Appeal. */
export function NoticeCard({ notice, now, headingLevel = 2 }: { notice: Notice; now: number; headingLevel?: 2 | 3 }) {
  const id = useId();
  const notify = useToast();
  const acknowledge = useAcknowledgeNotices();
  const [appealing, setAppealing] = useState(false);
  const unacknowledged = notice.acknowledged_at === null;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const account = notice.target.kind === 'account';
  const Icon = account ? ShieldAlert : notice.action === 'scan_block' ? FileWarning : Gavel;

  return (
    <article aria-labelledby={`${id}-title`} className={`flex flex-col gap-3 rounded-2xl border bg-surface p-4 ${unacknowledged ? 'border-warn/50' : 'border-line'}`}>
      <header className="flex items-start gap-3">
        <Icon aria-hidden className={`mt-0.5 size-5 shrink-0 ${account ? 'text-danger' : 'text-warn'}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Heading id={`${id}-title`} className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {noticeActionLabel(notice.action)}
            {unacknowledged && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-xs font-medium text-warn">New</span>}
          </Heading>
          {notice.rule_text && <p className="text-sm">{notice.rule_text}</p>}
          <p className="flex flex-wrap gap-x-3 text-xs text-muted">
            <NoticeTarget notice={notice} />
            <time dateTime={new Date(epochMs(notice.created_at)).toISOString()} title={formatFullDate(epochMs(notice.created_at))}>
              {formatRelative(epochMs(notice.created_at), now)}
            </time>
          </p>
        </div>
      </header>

      {notice.message && (
        <blockquote className="rounded-xl border border-line bg-bg px-3 py-2 text-sm break-words whitespace-pre-wrap">
          <span className="sr-only">Message from files.gg staff: </span>
          {notice.message}
        </blockquote>
      )}

      <AppealStatus notice={notice} now={now} />

      {(unacknowledged || notice.appeal.can_appeal) && (
        <div className="flex flex-wrap gap-2">
          {unacknowledged && (
            <Button
              onClick={() => acknowledge.mutate([notice.id], { onError: (error) => notify(errorMessage(error), 'error') })}
              disabled={acknowledge.isPending}
            >
              <Check aria-hidden className="size-4" />
              Acknowledge
            </Button>
          )}
          {notice.appeal.can_appeal && (
            <Button onClick={() => setAppealing(true)}>
              <Gavel aria-hidden className="size-4" />
              Appeal
            </Button>
          )}
        </div>
      )}

      {appealing && (
        <AppealDialog
          notice={notice}
          onClose={() => setAppealing(false)}
          onDone={() => {
            setAppealing(false);
            notify('Appeal sent.');
          }}
        />
      )}
    </article>
  );
}
