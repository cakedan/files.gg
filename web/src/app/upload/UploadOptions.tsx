import { useId } from 'react';

import {
  accessChoices,
  ANONYMOUS_EXPIRY_NOTE,
  canMarkNsfw,
  expiryChoices,
  passwordExpiryChoices,
  unlockTtlChoices,
  expirySeconds,
  parseLocalDateTime,
  type ExpiryValue,
  type PickerContext,
  type PickerErrors,
  type PickerState,
} from '../../lib/upload/options';
import { Field, PasswordFields, VisibilityField } from '../access/AccessFields';
import { decodeChoice, encodeChoice, fieldClass, toLocalInput } from '../access/fieldUtils';

const decode = (value: string): ExpiryValue => decodeChoice(value);

interface UploadOptionsProps {
  state: PickerState;
  onChange: (patch: Partial<PickerState>) => void;
  context: PickerContext;
  errors: PickerErrors;
}

/** Expiry, access, "Stay unlocked for" and "Password works until" (PLAN.md Phase 3 "Upload"). */
export function UploadOptions({ state, onChange, context, errors }: UploadOptionsProps) {
  const id = useId();
  const expiresIn = expirySeconds(state.expiry, state.expiryCustomAt);
  const fileLife = expiresIn !== null && Number.isFinite(expiresIn) ? expiresIn : null;

  return (
    <section aria-label="Upload options" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Expires" htmlFor={`${id}-expiry`} error={errors.expiry} hint={context.anonymous ? ANONYMOUS_EXPIRY_NOTE : undefined}>
          <select
            id={`${id}-expiry`}
            value={encodeChoice(state.expiry)}
            onChange={(event) => onChange({ expiry: decode(event.target.value) })}
            className={fieldClass}
          >
            {expiryChoices(context).map((choice) => (
              <option key={encodeChoice(choice.value)} value={encodeChoice(choice.value)}>
                {choice.label}
              </option>
            ))}
          </select>
          {state.expiry === 'custom' && (
            <input
              type="datetime-local"
              aria-label="Expiry date and time"
              value={toLocalInput(state.expiryCustomAt)}
              onChange={(event) => onChange({ expiryCustomAt: parseLocalDateTime(event.target.value) })}
              className={fieldClass}
            />
          )}
        </Field>

        <VisibilityField
          name={`${id}-access`}
          value={state.visibility}
          choices={accessChoices(context)}
          onChange={(visibility) => onChange({ visibility })}
          error={errors.visibility}
        />
      </div>

      {state.visibility === 'password' && (
        <PasswordFields
          idPrefix={id}
          state={state}
          onChange={onChange}
          errors={errors}
          unlockChoices={unlockTtlChoices(fileLife)}
          passwordExpiryChoices={passwordExpiryChoices(context, fileLife)}
          generateHint="Each file gets its own generated password, shown once."
        />
      )}

      {canMarkNsfw(context) ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={state.nsfw} onChange={(event) => onChange({ nsfw: event.target.checked })} className="mt-0.5 size-4 accent-gg" />
          <span className="flex flex-col">
            Adult content (NSFW)
            <span className="text-xs text-muted">Visitors see a warning before it opens. Adult content must always be marked.</span>
          </span>
        </label>
      ) : (
        context.anonymous && <p className="text-xs text-muted">Sign in to upload sensitive media.</p>
      )}
    </section>
  );
}
