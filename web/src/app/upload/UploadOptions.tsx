import { Eye, EyeOff, KeyRound, Link2, Lock } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import type { UnlockTtl, Visibility } from '../../lib/api';
import {
  accessChoices,
  ANONYMOUS_EXPIRY_NOTE,
  expiryChoices,
  passwordExpiryChoices,
  unlockTtlChoices,
  expirySeconds,
  parseLocalDateTime,
  type ExpiryValue,
  type PasswordExpiryValue,
  type PickerContext,
  type PickerErrors,
  type PickerState,
} from '../../lib/upload/options';

const ICONS: Record<Visibility, ReactNode> = {
  link: <Link2 aria-hidden className="size-4" />,
  password: <KeyRound aria-hidden className="size-4" />,
  private: <Lock aria-hidden className="size-4" />,
};

const fieldClass = 'h-9 rounded-md border border-line bg-bg px-2 text-sm text-text disabled:opacity-50';

/** <select> values are strings; expiry values are 'never' | 'custom' | seconds. */
const encode = (value: ExpiryValue | PasswordExpiryValue) => String(value);
const decode = (value: string): ExpiryValue => (value === 'never' || value === 'custom' ? value : Number(value));

function toLocalInput(ms: number | null): string {
  if (ms === null) return '';
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function Field({ label, htmlFor, children, error, hint }: { label: string; htmlFor: string; children: ReactNode; error?: string | undefined; hint?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface UploadOptionsProps {
  state: PickerState;
  onChange: (patch: Partial<PickerState>) => void;
  context: PickerContext;
  errors: PickerErrors;
}

/** Expiry, access, "Stay unlocked for" and "Password works until" (PLAN.md Phase 3 "Upload"). */
export function UploadOptions({ state, onChange, context, errors }: UploadOptionsProps) {
  const id = useId();
  const [reveal, setReveal] = useState(false);
  const expiresIn = expirySeconds(state.expiry, state.expiryCustomAt);
  const fileLife = expiresIn !== null && Number.isFinite(expiresIn) ? expiresIn : null;

  return (
    <section aria-label="Upload options" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Expires" htmlFor={`${id}-expiry`} error={errors.expiry} hint={context.anonymous ? ANONYMOUS_EXPIRY_NOTE : undefined}>
          <select
            id={`${id}-expiry`}
            value={encode(state.expiry)}
            onChange={(event) => onChange({ expiry: decode(event.target.value) })}
            className={fieldClass}
          >
            {expiryChoices(context).map((choice) => (
              <option key={encode(choice.value)} value={encode(choice.value)}>
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

        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">Who can open it</legend>
          <div className="flex flex-col gap-1" role="radiogroup">
            {accessChoices(context).map((choice) => (
              <label
                key={choice.value}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  state.visibility === choice.value ? 'border-gg/60 bg-surface-2' : 'border-line'
                } ${choice.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-2'}`}
                title={choice.hint}
              >
                <input
                  type="radio"
                  name={`${id}-access`}
                  value={choice.value}
                  checked={state.visibility === choice.value}
                  disabled={choice.disabled}
                  onChange={() => onChange({ visibility: choice.value })}
                  className="accent-gg"
                />
                {ICONS[choice.value]}
                <span>{choice.label}</span>
                {choice.hint && <span className="ml-auto text-xs text-muted">{choice.hint}</span>}
              </label>
            ))}
          </div>
          {errors.visibility && <p className="text-xs text-danger">{errors.visibility}</p>}
        </fieldset>
      </div>

      {state.visibility === 'password' && (
        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
          <Field
            label="Password"
            htmlFor={`${id}-password`}
            error={errors.password}
            hint={state.generatePassword ? 'Each file gets its own generated password, shown once.' : '6–128 characters.'}
          >
            <div className="flex gap-1">
              <input
                id={`${id}-password`}
                type={reveal ? 'text' : 'password'}
                autoComplete="new-password"
                value={state.generatePassword ? '' : state.password}
                placeholder={state.generatePassword ? 'Generated for you' : ''}
                disabled={state.generatePassword}
                onChange={(event) => onChange({ password: event.target.value })}
                className={`${fieldClass} min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={() => setReveal(!reveal)}
                aria-label={reveal ? 'Hide password' : 'Show password'}
                aria-pressed={reveal}
                disabled={state.generatePassword}
                className="flex w-9 items-center justify-center rounded-md border border-line text-muted hover:text-text disabled:opacity-50"
              >
                {reveal ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
              </button>
            </div>
            <button
              type="button"
              aria-pressed={state.generatePassword}
              onClick={() => onChange({ generatePassword: !state.generatePassword })}
              className="self-start rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-text aria-pressed:border-gg/60 aria-pressed:text-gg"
            >
              {state.generatePassword ? 'Type my own instead' : 'Generate'}
            </button>
          </Field>

          <Field label="Stay unlocked for" htmlFor={`${id}-ttl`} error={errors.unlockTtl} hint="How long a visitor stays in after entering it.">
            <select
              id={`${id}-ttl`}
              value={String(state.unlockTtl)}
              onChange={(event) => onChange({ unlockTtl: Number(event.target.value) as UnlockTtl })}
              className={fieldClass}
            >
              {unlockTtlChoices(fileLife).map((choice) => (
                <option key={choice.value} value={String(choice.value)} disabled={choice.disabled}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Password works until" htmlFor={`${id}-pwexp`} error={errors.passwordExpiry} hint="The file stays; only the password stops working.">
            <select
              id={`${id}-pwexp`}
              value={encode(state.passwordExpiry)}
              onChange={(event) => onChange({ passwordExpiry: decode(event.target.value) })}
              className={fieldClass}
            >
              {passwordExpiryChoices(context, fileLife).map((choice) => (
                <option key={encode(choice.value)} value={encode(choice.value)}>
                  {choice.label}
                </option>
              ))}
            </select>
            {state.passwordExpiry === 'custom' && (
              <input
                type="datetime-local"
                aria-label="Password expiry date and time"
                value={toLocalInput(state.passwordExpiryCustomAt)}
                onChange={(event) => onChange({ passwordExpiryCustomAt: parseLocalDateTime(event.target.value) })}
                className={fieldClass}
              />
            )}
          </Field>
        </div>
      )}
    </section>
  );
}
