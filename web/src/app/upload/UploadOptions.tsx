import { useId } from 'react';

import {
  accessChoices,
  ADULT_REGION_TEXT,
  adultRegionBlocked,
  ANONYMOUS_EXPIRY_NOTE,
  canMarkNsfw,
  expiryChoices,
  passwordExpiryChoices,
  unlockTtlChoices,
  expirySeconds,
  VIEW_LIMIT_HINT,
  VIEW_LIMIT_MAX,
  viewLimitActionChoices,
  parseLocalDateTime,
  type ExpiryValue,
  type PickerContext,
  type PickerErrors,
  type PickerState,
} from '../../lib/upload/options';
import type { ViewLimitAction } from '../../lib/api';
import { Field, PasswordFields, VisibilityField } from '../access/AccessFields';
import { decodeChoice, encodeChoice, fieldClass, toLocalInput } from '../access/fieldUtils';

const decode = (value: string): ExpiryValue => decodeChoice(value);

interface UploadOptionsProps {
  state: PickerState;
  onChange: (patch: Partial<PickerState>) => void;
  context: PickerContext;
  errors: PickerErrors;
  /**
   * A conversion's output (milestone-5 §10.3, §21) instead of an upload: no password timing (the API
   * takes none), no adult-content mark (outputs follow their source's), and no view limit for guests.
   */
  conversion?: boolean;
}

/**
 * Expiry, the view limit (milestone-6 §19.7), access, "Stay unlocked for" and "Password
 * works until" (PLAN.md Phase 3 "Upload"). The Convert page shows them for the new file.
 */
export function UploadOptions({ state, onChange, context, errors, conversion = false }: UploadOptionsProps) {
  const id = useId();
  const expiresIn = expirySeconds(state.expiry, state.expiryCustomAt);
  const fileLife = expiresIn !== null && Number.isFinite(expiresIn) ? expiresIn : null;

  return (
    <section aria-label={conversion ? 'Output options' : 'Upload options'} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
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

          {!(conversion && context.anonymous) && <ViewLimitFields idPrefix={id} state={state} onChange={onChange} context={context} errors={errors} />}
        </div>

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
          generateHint={conversion ? 'A password is generated for you and shown once.' : 'Each file gets its own generated password, shown once.'}
          timing={!conversion}
        />
      )}

      {conversion ? null : adultRegionBlocked(context) ? (
        <p className="text-xs text-muted">{ADULT_REGION_TEXT}</p>
      ) : canMarkNsfw(context) ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={state.nsfw} onChange={(event) => onChange({ nsfw: event.target.checked })} className="mt-0.5 size-4 accent-gg" />
          <span className="flex flex-col">
            Adult content (NSFW)
            <span className="text-xs text-muted">Visitors see a warning before it opens. Adult content must always be marked, and you must be 18 or older.</span>
          </span>
        </label>
      ) : (
        context.anonymous && <p className="text-xs text-muted">Sign in to upload sensitive media.</p>
      )}
    </section>
  );
}

/** "View limit" (off, or 1–1000 unique viewers) and "When the limit is reached" (§19.7). */
function ViewLimitFields({
  idPrefix,
  state,
  onChange,
  context,
  errors,
}: {
  idPrefix: string;
  state: PickerState;
  onChange: (patch: Partial<PickerState>) => void;
  context: PickerContext;
  errors: PickerErrors;
}) {
  const on = state.viewLimit.trim() !== '';
  return (
    <>
      <Field label="View limit" htmlFor={`${idPrefix}-view-limit`} error={errors.viewLimit} hint={on ? VIEW_LIMIT_HINT : 'Off. Enter a number to stop the link after that many viewers.'}>
        <input
          id={`${idPrefix}-view-limit`}
          type="number"
          inputMode="numeric"
          min={1}
          max={VIEW_LIMIT_MAX}
          step={1}
          placeholder="Off"
          value={state.viewLimit}
          onChange={(event) => onChange({ viewLimit: event.target.value })}
          aria-invalid={errors.viewLimit ? true : undefined}
          className={fieldClass}
        />
      </Field>
      {on && (
        <Field label="When the limit is reached" htmlFor={`${idPrefix}-view-limit-action`} error={errors.viewLimitAction} hint={context.anonymous ? 'Sign in to make files private instead.' : undefined}>
          <select
            id={`${idPrefix}-view-limit-action`}
            value={state.viewLimitAction}
            onChange={(event) => onChange({ viewLimitAction: event.target.value as ViewLimitAction })}
            className={fieldClass}
          >
            {viewLimitActionChoices(context).map((choice) => (
              <option key={choice.value} value={choice.value} disabled={choice.disabled}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>
      )}
    </>
  );
}
