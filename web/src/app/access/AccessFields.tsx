import { Eye, EyeOff, KeyRound, Link2, Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { UnlockTtl, Visibility } from '../../lib/api';
import { parseLocalDateTime, type Choice, type PasswordExpiryValue, type PickerErrors } from '../../lib/upload/options';
import { decodeChoice, encodeChoice, fieldClass, toLocalInput } from './fieldUtils';

/**
 * Access pickers shared by the upload page and "Change access…" (files, bulk and
 * albums): who can open it, and the password with its timing.
 */

const VISIBILITY_ICONS: Record<Visibility, ReactNode> = {
  link: <Link2 aria-hidden className="size-4" />,
  password: <KeyRound aria-hidden className="size-4" />,
  private: <Lock aria-hidden className="size-4" />,
};

export function Field({
  label,
  htmlFor,
  children,
  error,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  error?: string | undefined;
  hint?: string | undefined;
}) {
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

interface VisibilityFieldProps {
  name: string;
  value: Visibility;
  choices: Array<Choice<Visibility>>;
  onChange: (value: Visibility) => void;
  error?: string | undefined;
  legend?: string;
}

export function VisibilityField({ name, value, choices, onChange, error, legend = 'Who can open it' }: VisibilityFieldProps) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="flex flex-col gap-1" role="radiogroup">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
              value === choice.value ? 'border-gg/60 bg-surface-2' : 'border-line'
            } ${choice.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-2'}`}
            title={choice.hint}
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              disabled={choice.disabled}
              onChange={() => onChange(choice.value)}
              className="accent-gg"
            />
            {VISIBILITY_ICONS[choice.value]}
            <span>{choice.label}</span>
            {choice.hint && <span className="ml-auto text-xs text-muted">{choice.hint}</span>}
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </fieldset>
  );
}

export interface PasswordFieldsState {
  password: string;
  generatePassword: boolean;
  unlockTtl: UnlockTtl;
  passwordExpiry: PasswordExpiryValue;
  passwordExpiryCustomAt: number | null;
}

interface PasswordFieldsProps {
  idPrefix: string;
  state: PasswordFieldsState;
  onChange: (patch: Partial<PasswordFieldsState>) => void;
  /** Called for the two timing pickers only. */
  onTimingChange?: () => void;
  errors: PickerErrors;
  unlockChoices: Array<Choice<UnlockTtl>>;
  passwordExpiryChoices: Array<Choice<PasswordExpiryValue>>;
  /** Hint under the password while Generate is on. */
  generateHint: string;
  /** Hint while typing. */
  passwordHint?: string;
  placeholder?: string;
  /** "Stay unlocked for" and "Password works until"; off for conversion outputs (milestone-5 §10.3 takes neither). */
  timing?: boolean;
}

export function PasswordFields({
  idPrefix: id,
  state,
  onChange,
  onTimingChange,
  errors,
  unlockChoices,
  passwordExpiryChoices,
  generateHint,
  passwordHint = '6–128 characters.',
  placeholder = '',
  timing: showTiming = true,
}: PasswordFieldsProps) {
  const [reveal, setReveal] = useState(false);
  const timing = (patch: Partial<PasswordFieldsState>) => {
    onTimingChange?.();
    onChange(patch);
  };

  return (
    <div className={`grid gap-4 border-t border-line pt-4 ${showTiming ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      <Field label="Password" htmlFor={`${id}-password`} error={errors.password} hint={state.generatePassword ? generateHint : passwordHint}>
        <div className="flex gap-1">
          <input
            id={`${id}-password`}
            type={reveal ? 'text' : 'password'}
            autoComplete="new-password"
            value={state.generatePassword ? '' : state.password}
            placeholder={state.generatePassword ? 'Generated for you' : placeholder}
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
            className="flex w-9 items-center justify-center rounded-xl border border-line text-muted hover:text-text disabled:opacity-50"
          >
            {reveal ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          </button>
        </div>
        <button
          type="button"
          aria-pressed={state.generatePassword}
          onClick={() => onChange({ generatePassword: !state.generatePassword })}
          className="self-start rounded-xl border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-text aria-pressed:border-gg/60 aria-pressed:text-gg"
        >
          {state.generatePassword ? 'Type my own instead' : 'Generate'}
        </button>
      </Field>

      {showTiming && (
        <>
          <Field label="Stay unlocked for" htmlFor={`${id}-ttl`} error={errors.unlockTtl} hint="How long a visitor stays in after entering it.">
            <select
              id={`${id}-ttl`}
              value={String(state.unlockTtl)}
              onChange={(event) => timing({ unlockTtl: Number(event.target.value) as UnlockTtl })}
              className={fieldClass}
            >
              {unlockChoices.map((choice) => (
                <option key={choice.value} value={String(choice.value)} disabled={choice.disabled}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Password works until" htmlFor={`${id}-pwexp`} error={errors.passwordExpiry} hint="The file stays; only the password stops working.">
            <select
              id={`${id}-pwexp`}
              value={encodeChoice(state.passwordExpiry)}
              onChange={(event) => timing({ passwordExpiry: decodeChoice(event.target.value) })}
              className={fieldClass}
            >
              {passwordExpiryChoices.map((choice) => (
                <option key={encodeChoice(choice.value)} value={encodeChoice(choice.value)}>
                  {choice.label}
                </option>
              ))}
            </select>
            {state.passwordExpiry === 'custom' && (
              <input
                type="datetime-local"
                aria-label="Password expiry date and time"
                value={toLocalInput(state.passwordExpiryCustomAt)}
                onChange={(event) => timing({ passwordExpiryCustomAt: parseLocalDateTime(event.target.value) })}
                className={fieldClass}
              />
            )}
          </Field>
        </>
      )}
    </div>
  );
}
