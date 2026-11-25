import { useId, useState } from 'react';

import { Button } from '../../../components/Button';
import { fieldClass } from '../../access/fieldUtils';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/toastContext';
import { pluralize } from '../../files/fileLabels';
import { RULE_TEXT } from '../../safety/labels';
import type { ActionBody, ActionResult } from '../adminApi';
import { useAdminAction } from '../adminQueries';
import { adminError } from '../format';
import { isAdmin, type ActionOption } from '../permissions';
import { useStaff } from '../staffContext';
import { Section } from './bits';

const DAY = 86400;
const DURATIONS = [
  { value: DAY, label: '1 day' },
  { value: 7 * DAY, label: '7 days' },
  { value: 30 * DAY, label: '30 days' },
  { value: 90 * DAY, label: '90 days', adminOnly: true },
  { value: 0, label: 'Until lifted', adminOnly: true },
];
const DEFAULT_DURATION = 30 * DAY;

interface ActionPanelProps {
  target: ActionBody['target'];
  options: ActionOption[];
  caseId?: string;
  /** Shown when nothing applies (hash-matched content, for example). */
  emptyText?: string;
  onDone?: (result: ActionResult) => void;
}

/**
 * The action panel (milestone-4 §9.3, §11.3): an action, a rule (required where the
 * contract says so), a staff-only note, the owner's notice text, and the extras some
 * actions take. Destructive ones ask first.
 */
export function ActionPanel({ target, options, caseId, emptyText, onDone }: ActionPanelProps) {
  const id = useId();
  const staff = useStaff();
  const notify = useToast();
  const run = useAdminAction();
  const [actionName, setActionName] = useState(options[0]?.action ?? '');
  const [rule, setRule] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [sendNotice, setSendNotice] = useState(true);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [holdDays, setHoldDays] = useState(90);
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const option = options.find((each) => each.action === actionName) ?? options[0];
  if (!option) {
    return (
      <Section title="Actions">
        <p className="text-sm text-muted">{emptyText ?? 'No actions apply here.'}</p>
      </Section>
    );
  }
  const rules = Object.keys(RULE_TEXT).filter((code) => code !== 'csam' || staff.child_safety);
  const timed = option.action === 'restrict_uploads' || option.action === 'suspend_user';
  const durationsFor = (action: string) =>
    DURATIONS.filter((each) => (!each.adminOnly || isAdmin(staff)) && (each.value !== 0 || action === 'suspend_user'));
  const durations = durationsFor(option.action);
  // The duration shown is the one sent: a choice the current action doesn't offer
  // (`Until lifted` after switching from a suspension to an upload restriction) falls
  // back to the default instead of the select silently showing its first option.
  const shownDuration = durations.some((each) => each.value === duration)
    ? duration
    : (durations.find((each) => each.value === DEFAULT_DURATION) ?? durations[0])?.value ?? DEFAULT_DURATION;

  const body = (): ActionBody => ({
    action: option.action,
    target,
    ...(option.needsRule ? { rule } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
    ...(option.notifies ? { notify: sendNotice, ...(sendNotice && message.trim() ? { message: message.trim() } : {}) } : {}),
    ...(caseId ? { case_id: caseId } : {}),
    // `0` is `Until lifted` (suspensions only): no `duration` (milestone-4 §9.3).
    ...(timed && shownDuration > 0 ? { duration: shownDuration } : {}),
    ...(option.action === 'delete' ? { hold_days: holdDays, also_block_hash: alsoBlock } : {}),
  });

  const submit = () => {
    setConfirming(false);
    run.mutate(body(), {
      onSuccess: (result) => {
        setError(null);
        setNote('');
        setMessage('');
        notify(result.notice_ids.length ? `Done. Sent ${pluralize(result.notice_ids.length, 'notice')}.` : 'Done.');
        onDone?.(result);
      },
      onError: (failure) => setError(adminError(failure)),
    });
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (option.needsRule && !rule) {
      setError('Pick the rule this breaks.');
      document.getElementById(`${id}-rule`)?.focus();
      return;
    }
    setError(null);
    if (option.confirm) setConfirming(true);
    else submit();
  };

  return (
    <Section title="Actions" id={`${id}-title`}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-labelledby={`${id}-title`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-action`} className="text-sm font-medium">
              Action
            </label>
            <select
              id={`${id}-action`}
              value={option.action}
              onChange={(event) => {
                const next = event.target.value as typeof actionName;
                setActionName(next);
                // Keep the chosen length when the new action offers it, else start from the default.
                if (!durationsFor(next).some((each) => each.value === duration)) setDuration(DEFAULT_DURATION);
              }}
              className={fieldClass}
            >
              {options.map((each) => (
                <option key={each.action} value={each.action}>
                  {each.label}
                </option>
              ))}
            </select>
          </div>
          {option.needsRule && (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-rule`} className="text-sm font-medium">
                Rule
              </label>
              <select id={`${id}-rule`} value={rule} onChange={(event) => setRule(event.target.value)} aria-required="true" className={fieldClass}>
                <option value="">Pick a rule</option>
                {rules.map((code) => (
                  <option key={code} value={code}>
                    {RULE_TEXT[code]}
                  </option>
                ))}
              </select>
            </div>
          )}
          {timed && (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-duration`} className="text-sm font-medium">
                For
              </label>
              <select id={`${id}-duration`} value={shownDuration} onChange={(event) => setDuration(Number(event.target.value))} className={fieldClass}>
                {durations.map((each) => (
                  <option key={each.value} value={each.value}>
                    {each.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {option.action === 'delete' && (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-hold`} className="text-sm font-medium">
                Keep a copy for (days)
              </label>
              <input id={`${id}-hold`} type="number" min={1} max={365} value={holdDays} onChange={(event) => setHoldDays(Math.min(365, Math.max(1, Number(event.target.value) || 90)))} className={fieldClass} />
            </div>
          )}
        </div>
        {option.action === 'delete' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={alsoBlock} onChange={(event) => setAlsoBlock(event.target.checked)} className="accent-gg" />
            Also block the hash, so re-uploads are refused
          </label>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-note`} className="text-sm font-medium">
            Note for staff
          </label>
          <textarea id={`${id}-note`} value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000} className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm" />
          <p className="text-xs text-muted">Only staff see this. It goes in the audit log.</p>
        </div>
        {option.notifies && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sendNotice} onChange={(event) => setSendNotice(event.target.checked)} className="accent-gg" />
              Send the owner a notice
            </label>
            {sendNotice && (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-message`} className="text-sm font-medium">
                  Message in the notice (optional)
                </label>
                <textarea id={`${id}-message`} value={message} onChange={(event) => setMessage(event.target.value)} rows={2} maxLength={2000} className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm" />
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" variant={option.danger ? 'danger' : 'primary'} disabled={run.isPending}>
            {run.isPending ? 'Applying…' : option.label}
          </Button>
        </div>
      </form>
      {confirming && (
        <ConfirmDialog title={`${option.label}?`} confirmLabel={option.label} onConfirm={submit} onClose={() => setConfirming(false)}>
          <p>
            {option.action === 'confirm_csam'
              ? 'This blocks the hash for good, preserves evidence, suspends the uploader and opens a CyberTipline case. It can’t be undone.'
              : option.action === 'delete'
                ? 'The file or album is deleted for its owner. A copy is kept for the hold period. This can’t be undone.'
                : option.action === 'suspend_user'
                  ? 'The account can only read and appeal its notices until the suspension is lifted.'
                  : 'Every owner of this content gets a notice, and re-uploads are refused.'}
          </p>
        </ConfirmDialog>
      )}
    </Section>
  );
}
