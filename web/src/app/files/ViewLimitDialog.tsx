import { useId, useState } from 'react';

import { Button } from '../../components/Button';
import type { OwnerFile, ViewLimitAction } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useSetViewLimit } from '../../lib/queries';
import { parseViewLimit, VIEW_LIMIT_HINT, VIEW_LIMIT_MAX, viewLimitActionChoices } from '../../lib/upload/options';
import { Field } from '../access/AccessFields';
import { fieldClass } from '../access/fieldUtils';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/toastContext';
import { privateActionFired, PRIVATE_FIRED_HINT, viewLimitOf, viewsUsedLabel } from './viewLimit';

/**
 * "View limit…" (milestone-6 §19.3, §19.7): set, raise, lower or remove a file's limit.
 * A new limit must be above `views_used` (`VIEW_LIMIT_TOO_LOW`); changing it never
 * resets the count. When a `private` action already fired, it can also share the file
 * with the link again.
 */
export function ViewLimitDialog({ file, onClose }: { file: OwnerFile; onClose: () => void }) {
  const id = useId();
  const notify = useToast();
  const mutation = useSetViewLimit();
  const current = viewLimitOf(file);
  const used = file.views_used ?? 0;
  const fired = privateActionFired(file);
  const [value, setValue] = useState(current === null ? '' : String(current));
  const [action, setAction] = useState<ViewLimitAction>(file.view_limit_action ?? 'expire');
  const [reshare, setReshare] = useState(fired);
  const [submitted, setSubmitted] = useState(false);

  const parsed = parseViewLimit(value);
  let problem: string | null = null;
  if ('error' in parsed) problem = parsed.error;
  else if (parsed.value === null) problem = 'Enter a limit, or remove it.';
  else if (parsed.value <= used) problem = `Set a limit above ${used.toLocaleString('en')}, the views already used, or remove it.`;

  const done = (message: string) => {
    notify(message);
    onClose();
  };

  const save = () => {
    setSubmitted(true);
    if (problem || 'error' in parsed || parsed.value === null) return;
    mutation.mutate(
      { id: file.id, limit: parsed.value, action, ...(fired && reshare ? { visibility: 'link' as const } : {}) },
      { onSuccess: () => done(current === null ? 'View limit set.' : 'View limit updated.') },
    );
  };

  const remove = () => mutation.mutate({ id: file.id, limit: null }, { onSuccess: () => done('View limit removed.') });

  return (
    <Dialog
      title="View limit"
      description={file.filename}
      onClose={onClose}
      size="sm"
      footer={
        <>
          {current !== null && (
            <Button variant="danger" onClick={remove} disabled={mutation.isPending} className="mr-auto">
              Remove limit
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {current !== null && <p className="text-sm text-muted">{viewsUsedLabel(file)}. Changing the limit doesn’t reset this.</p>}
        {fired && <p className="text-sm text-warn">{PRIVATE_FIRED_HINT}</p>}
        <Field label="View limit" htmlFor={`${id}-limit`} error={submitted ? (problem ?? undefined) : undefined} hint={VIEW_LIMIT_HINT}>
          <input
            id={`${id}-limit`}
            type="number"
            inputMode="numeric"
            min={Math.max(1, used + 1)}
            max={VIEW_LIMIT_MAX}
            step={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className={fieldClass}
          />
        </Field>
        <Field label="When the limit is reached" htmlFor={`${id}-action`}>
          <select id={`${id}-action`} value={action} onChange={(event) => setAction(event.target.value as ViewLimitAction)} className={fieldClass}>
            {viewLimitActionChoices({ anonymous: false }).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>
        {fired && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={reshare} onChange={(event) => setReshare(event.target.checked)} className="mt-0.5 size-4 accent-gg" />
            Let anyone with the link open it again
          </label>
        )}
        {mutation.isError && (
          <p className="text-sm text-danger" role="alert">
            {errorMessage(mutation.error)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
