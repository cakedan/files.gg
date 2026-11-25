/**
 * Upload page pickers (PLAN.md Phase 3 "Upload", "Password timing"; contract §6, §9).
 * Pure rules, so the UI can't offer a choice the API would reject.
 */

import type { MyLimitsResponse, UnlockTtl, UploadParams, Visibility } from '../api';

const HOUR = 3600;
const DAY = 24 * HOUR;

export const ANONYMOUS_MAX_EXPIRY = 21 * DAY;
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;

export interface Choice<T> {
  value: T;
  label: string;
  disabled?: boolean;
  hint?: string;
}

export interface PickerContext {
  anonymous: boolean;
  /** From `/users/@me/limits`; null while loading or unavailable. */
  limits?: Pick<MyLimitsResponse, 'max_expiry' | 'allow_no_expiry'> | null;
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

export type ExpiryValue = 'never' | 'custom' | number;

const EXPIRY_PRESETS: Array<Choice<number>> = [
  { value: HOUR, label: '1 hour' },
  { value: DAY, label: '1 day' },
  { value: 7 * DAY, label: '7 days' },
  { value: 21 * DAY, label: '21 days' },
];

export const ANONYMOUS_EXPIRY_NOTE = 'Anonymous uploads are deleted after at most 21 days. Sign in to keep files.';

/** Longest expiry allowed, in seconds; null means "never" is allowed too. */
export function maxExpiry({ anonymous, limits }: PickerContext): number | null {
  if (anonymous) return Math.min(limits?.max_expiry ?? ANONYMOUS_MAX_EXPIRY, ANONYMOUS_MAX_EXPIRY);
  return limits?.max_expiry ?? null;
}

export function canNeverExpire(context: PickerContext): boolean {
  if (context.anonymous) return false;
  return (context.limits?.allow_no_expiry ?? true) && maxExpiry(context) === null;
}

/** Signed in: Never (default), presets, custom. Anonymous: presets up to 21 days. */
export function expiryChoices(context: PickerContext): Array<Choice<ExpiryValue>> {
  const max = maxExpiry(context);
  const presets = EXPIRY_PRESETS.filter((preset) => max === null || preset.value <= max);
  if (context.anonymous) return presets;
  return [
    ...(canNeverExpire(context) ? [{ value: 'never' as const, label: 'Never' }] : []),
    ...presets,
    { value: 'custom' as const, label: 'Custom…' },
  ];
}

export function defaultExpiry(context: PickerContext): ExpiryValue {
  if (canNeverExpire(context)) return 'never';
  const choices = expiryChoices(context).filter((choice): choice is Choice<number> => typeof choice.value === 'number');
  return choices.at(-1)?.value ?? HOUR;
}

/** Seconds for the selected expiry (custom: until the picked date), or null for never. */
export function expirySeconds(value: ExpiryValue, customAt: number | null, nowMs: number = Date.now()): number | null {
  if (value === 'never') return null;
  if (value === 'custom') return customAt === null ? Number.NaN : Math.round((customAt - nowMs) / 1000);
  return value;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function accessChoices({ anonymous }: PickerContext): Array<Choice<Visibility>> {
  return [
    { value: 'link', label: 'Anyone with the link' },
    { value: 'password', label: 'Password' },
    {
      value: 'private',
      label: 'Only me',
      disabled: anonymous,
      hint: anonymous ? 'Sign in to keep files private.' : undefined,
    },
  ];
}

export const UNLOCK_TTL_CHOICES: Array<Choice<UnlockTtl>> = [
  { value: 600, label: '10 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 86400, label: '1 day' },
  { value: 604800, label: '7 days' },
  { value: 2592000, label: '30 days' },
];
export const DEFAULT_UNLOCK_TTL: UnlockTtl = 3600;

/** "Stay unlocked for": can't outlast the file itself. */
export function unlockTtlChoices(expiresIn: number | null): Array<Choice<UnlockTtl>> {
  return UNLOCK_TTL_CHOICES.map((choice) =>
    expiresIn !== null && choice.value > expiresIn ? { ...choice, disabled: true, hint: 'Longer than the file lasts' } : choice,
  );
}

export type PasswordExpiryValue = 'never' | 'custom' | number;

/**
 * "Password works until": never (signed in only, the default), 1/7/30 days, custom.
 * Anonymous files expire anyway, so "never" becomes "when the file expires".
 * Choices past the file's own expiry are dropped.
 */
export function passwordExpiryChoices(context: PickerContext, expiresIn: number | null): Array<Choice<PasswordExpiryValue>> {
  const presets: Array<Choice<PasswordExpiryValue>> = [
    { value: DAY, label: '1 day' },
    { value: 7 * DAY, label: '7 days' },
    { value: 30 * DAY, label: '30 days' },
  ].filter((preset) => expiresIn === null || preset.value < expiresIn);
  const first: Choice<PasswordExpiryValue> = {
    value: 'never',
    label: context.anonymous || expiresIn !== null ? 'Until the file expires' : 'Never',
  };
  return [first, ...presets, { value: 'custom', label: 'Custom…' }];
}

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

// ---------------------------------------------------------------------------
// Turning the pickers into request fields
// ---------------------------------------------------------------------------

export interface PickerState {
  expiry: ExpiryValue;
  /** ms epoch, for a custom expiry. */
  expiryCustomAt: number | null;
  visibility: Visibility;
  password: string;
  generatePassword: boolean;
  unlockTtl: UnlockTtl;
  passwordExpiry: PasswordExpiryValue;
  passwordExpiryCustomAt: number | null;
}

export function defaultPickerState(context: PickerContext): PickerState {
  return {
    expiry: defaultExpiry(context),
    expiryCustomAt: null,
    visibility: 'link',
    password: '',
    generatePassword: false,
    unlockTtl: DEFAULT_UNLOCK_TTL,
    passwordExpiry: 'never',
    passwordExpiryCustomAt: null,
  };
}

export type PickerErrors = Partial<Record<'expiry' | 'visibility' | 'password' | 'unlockTtl' | 'passwordExpiry', string>>;

export interface ResolvedPickers {
  params: UploadParams;
  errors: PickerErrors;
}

/** Validates the pickers and builds the upload fields (without the Turnstile token). */
export function resolvePickers(state: PickerState, context: PickerContext, nowMs: number = Date.now()): ResolvedPickers {
  const errors: PickerErrors = {};
  const params: UploadParams = {};

  const expiresIn = expirySeconds(state.expiry, state.expiryCustomAt, nowMs);
  const max = maxExpiry(context);
  if (expiresIn === null) {
    if (!canNeverExpire(context)) errors.expiry = context.anonymous ? ANONYMOUS_EXPIRY_NOTE : 'Pick when the file expires.';
  } else if (!Number.isFinite(expiresIn) || expiresIn < 60) {
    errors.expiry = 'Pick a time in the future.';
  } else if (max !== null && expiresIn > max) {
    errors.expiry = `The longest you can keep a file is ${Math.floor(max / DAY)} days.`;
  } else {
    params.expires_in = expiresIn;
  }

  if (state.visibility === 'private' && context.anonymous) {
    errors.visibility = 'Sign in to keep files private.';
  } else if (state.visibility !== 'link') {
    params.visibility = state.visibility;
  }

  if (state.visibility === 'password') {
    if (state.generatePassword) {
      params.generate_password = true;
    } else {
      const problem = validatePassword(state.password);
      if (problem) errors.password = problem;
      else params.password = state.password;
    }
    const fileLife = expiresIn === null || !Number.isFinite(expiresIn) ? null : expiresIn;
    if (fileLife !== null && state.unlockTtl > fileLife) errors.unlockTtl = 'That’s longer than the file lasts.';
    else params.unlock_ttl = state.unlockTtl;

    const passwordIn = expirySeconds(state.passwordExpiry, state.passwordExpiryCustomAt, nowMs);
    if (passwordIn !== null) {
      if (!Number.isFinite(passwordIn) || passwordIn < 60) errors.passwordExpiry = 'Pick a time in the future.';
      else if (fileLife !== null && passwordIn >= fileLife) errors.passwordExpiry = 'The file expires before that.';
      else params.password_expires_in = passwordIn;
    }
  }

  return { params, errors };
}

/** datetime-local value ("2026-11-24T18:30") ↔ ms epoch, in the browser's time zone. */
export function parseLocalDateTime(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
