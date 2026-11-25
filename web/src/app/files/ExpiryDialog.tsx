import { useId, useState } from 'react';

import { Button } from '../../components/Button';
import type { OwnerFile } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useSetExpiry } from '../../lib/queries';
import {
  ANONYMOUS_EXPIRY_NOTE,
  expiryChoices,
  expirySeconds,
  maxExpiry,
  parseLocalDateTime,
  type ExpiryValue,
  type PickerContext,
} from '../../lib/upload/options';
import { Field } from '../access/AccessFields';
import { encodeChoice, fieldClass, toLocalInput } from '../access/fieldUtils';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/toastContext';
import { pluralize } from './fileLabels';

const DAY = 86400;

/** "Set expiry…": 1 hour, 1 day, 7 days, 21 days, custom, or never (signed in). */
export function ExpiryDialog({ files, context, onClose }: { files: OwnerFile[]; context: PickerContext; onClose: () => void }) {
  const id = useId();
  const notify = useToast();
  const mutation = useSetExpiry();
  const choices = expiryChoices(context);
  const [value, setValue] = useState<ExpiryValue>(() => choices.find((c) => c.value === DAY)?.value ?? choices[0]?.value ?? 3600);
  const [customAt, setCustomAt] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const seconds = expirySeconds(value, customAt);
  const max = maxExpiry(context);
  let problem: string | null = null;
  if (seconds !== null && (!Number.isFinite(seconds) || seconds < 60)) problem = 'Pick a time in the future.';
  else if (seconds !== null && max !== null && seconds > max) problem = `The longest you can keep a file is ${Math.floor(max / DAY)} days.`;

  const save = () => {
    setSubmitted(true);
    if (problem) return;
    mutation.mutate(
      { ids: files.map((file) => file.id), expiresIn: seconds },
      {
        onSuccess: () => {
          notify(seconds === null ? `${pluralize(files.length, 'file')} kept forever.` : `Expiry set for ${pluralize(files.length, 'file')}.`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      title="Set expiry"
      description={files.length === 1 ? files[0]!.filename : pluralize(files.length, 'file')}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Expires" htmlFor={`${id}-expiry`} error={submitted ? (problem ?? undefined) : undefined} hint={context.anonymous ? ANONYMOUS_EXPIRY_NOTE : undefined}>
          <select
            id={`${id}-expiry`}
            value={encodeChoice(value)}
            onChange={(event) => {
              const raw = event.target.value;
              setValue(raw === 'never' || raw === 'custom' ? raw : Number(raw));
            }}
            className={fieldClass}
          >
            {choices.map((choice) => (
              <option key={encodeChoice(choice.value)} value={encodeChoice(choice.value)}>
                {choice.value === 'never' ? 'Never (keep forever)' : choice.value === 'custom' ? 'Custom…' : `In ${choice.label}`}
              </option>
            ))}
          </select>
          {value === 'custom' && (
            <input
              type="datetime-local"
              aria-label="Expiry date and time"
              value={toLocalInput(customAt)}
              onChange={(event) => setCustomAt(parseLocalDateTime(event.target.value))}
              className={fieldClass}
            />
          )}
        </Field>
        {mutation.isError && (
          <p className="text-sm text-danger" role="alert">
            {errorMessage(mutation.error)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
