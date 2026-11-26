/**
 * Upload page pickers (PLAN.md Phase 3 "Upload", "Password timing"; contract §6, §9).
 * Pure rules, so the UI can't offer a choice the API would reject.
 */

import type { MyLimitsResponse, UnlockTtl, UploadDefaults, UploadParams, ViewLimitAction, Visibility } from '../api';

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
  limits?: Pick<MyLimitsResponse, 'max_expiry' | 'allow_no_expiry' | 'nsfw_allowed' | 'adult_region_blocked'> | null;
  /** Milestone 7 §11.4: signed out, `/auth/config`'s `adult_content_available`; undefined while loading or unavailable. */
  adultContentAvailable?: boolean | undefined;
  /** Milestone 5 §21: the account's upload defaults (`user.settings.upload_defaults`), where the pickers start. */
  defaults?: UploadDefaults | null;
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

/** Seconds as a picker value: a preset, else a custom date that far from now. */
export function expiryPick(seconds: number | null, nowMs: number = Date.now()): Pick<PickerState, 'expiry' | 'expiryCustomAt'> {
  if (seconds === null) return { expiry: 'never', expiryCustomAt: null };
  if (EXPIRY_PRESETS.some((preset) => preset.value === seconds)) return { expiry: seconds, expiryCustomAt: null };
  return { expiry: 'custom', expiryCustomAt: nowMs + seconds * 1000 };
}

/** Whether an expiry (seconds, or null for never) is one these limits allow (§21: re-checked when used). */
export function expiryAllowed(seconds: number | null, context: PickerContext): boolean {
  if (seconds === null) return canNeverExpire(context);
  const max = maxExpiry(context);
  return seconds >= HOUR && (max === null || seconds <= max);
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
// View limits (milestone-6 §19.3, §19.7)
// ---------------------------------------------------------------------------

export const VIEW_LIMIT_MIN = 1;
export const VIEW_LIMIT_MAX = 1000;
export const VIEW_LIMIT_RANGE_ERROR = 'Use a whole number from 1 to 1,000.';
export const VIEW_LIMIT_HINT = 'Counts unique viewers. You never use up a view yourself.';
export const VIEW_LIMIT_PRIVATE_HINT = 'Sign in to make files private.';

/**
 * A view-limit input: '' (or spaces) is off (null); otherwise a whole number 1–1000, or
 * an error message.
 */
export function parseViewLimit(raw: string): { value: number | null } | { error: string } {
  const text = raw.trim();
  if (!text) return { value: null };
  if (!/^\d+$/.test(text)) return { error: VIEW_LIMIT_RANGE_ERROR };
  const value = Number(text);
  if (value < VIEW_LIMIT_MIN || value > VIEW_LIMIT_MAX) return { error: VIEW_LIMIT_RANGE_ERROR };
  return { value };
}

/** "When the limit is reached": expire (default), or private (signed in only). */
export function viewLimitActionChoices({ anonymous }: PickerContext): Array<Choice<ViewLimitAction>> {
  return [
    { value: 'expire', label: 'Expire the file' },
    { value: 'private', label: 'Make it private', disabled: anonymous, hint: anonymous ? VIEW_LIMIT_PRIVATE_HINT : undefined },
  ];
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
  /** Milestone 4 §4.3: "Adult content (NSFW)", signed in only. */
  nsfw: boolean;
  /** Milestone 6 §19.7: the "View limit" input; '' is off. */
  viewLimit: string;
  viewLimitAction: ViewLimitAction;
}

/**
 * Where the pickers start: signed in, the account's upload defaults (§21), each one the limits still allow
 * ("Password" is a generated one per file); otherwise link, and the longest expiry allowed.
 */
export function defaultPickerState(context: PickerContext, nowMs: number = Date.now()): PickerState {
  const defaults = context.anonymous ? null : (context.defaults ?? null);
  const expiry = defaults && expiryAllowed(defaults.expires_in, context) ? expiryPick(defaults.expires_in, nowMs) : { expiry: defaultExpiry(context), expiryCustomAt: null };
  const visibility = defaults?.visibility ?? 'link';
  return {
    ...expiry,
    visibility,
    password: '',
    generatePassword: visibility === 'password',
    unlockTtl: DEFAULT_UNLOCK_TTL,
    passwordExpiry: 'never',
    passwordExpiryCustomAt: null,
    nsfw: Boolean(defaults?.nsfw) && canMarkNsfw(context),
    viewLimit: '',
    viewLimitAction: 'expire',
  };
}

/** Adult content can be marked at upload by signed-in users who aren't restricted: `nsfw_allowed` (§4.3, §13). */
export const canMarkNsfw = (context: PickerContext) => !context.anonymous && context.limits?.nsfw_allowed === true && !adultRegionBlocked(context);

/** Milestone 7 §11.4: shown where adult content would be offered, when the visitor's country blocks it. */
export const ADULT_REGION_TEXT = "Adult content isn't available in your region.";

/**
 * Milestone 7 §11.4: adult content isn't available from the visitor's country. Signed in, the limits'
 * `adult_region_blocked`; signed out, `/auth/config`'s `adult_content_available` (or the anonymous limits').
 */
export const adultRegionBlocked = ({ anonymous, limits, adultContentAvailable }: PickerContext) =>
  limits?.adult_region_blocked === true || (anonymous && adultContentAvailable === false);

export type PickerErrors = Partial<Record<'expiry' | 'visibility' | 'password' | 'unlockTtl' | 'passwordExpiry' | 'viewLimit' | 'viewLimitAction', string>>;

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

  if (state.nsfw && canMarkNsfw(context)) params.nsfw = true;

  const limit = parseViewLimit(state.viewLimit);
  if ('error' in limit) errors.viewLimit = limit.error;
  else if (limit.value !== null) {
    if (state.viewLimitAction === 'private' && context.anonymous) errors.viewLimitAction = VIEW_LIMIT_PRIVATE_HINT;
    else {
      params.view_limit = limit.value;
      params.view_limit_action = state.viewLimitAction;
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
