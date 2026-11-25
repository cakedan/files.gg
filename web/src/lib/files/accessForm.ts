/**
 * "Change access…" for a file, a bulk selection or an album (contract §6; PLAN.md
 * Phase 3 "Files"). Pure rules shared with the upload pickers (lib/upload/options.ts).
 */

import { UNLOCK_TTLS, type AccessParams, type UnlockTtl, type Visibility } from '../api';
import {
  DEFAULT_UNLOCK_TTL,
  expirySeconds,
  validatePassword,
  type PasswordExpiryValue,
  type PickerErrors,
} from '../upload/options';

/** What a target has now. Files and albums share these fields. */
export interface AccessCurrent {
  visibility: Visibility;
  unlock_ttl: number;
  /** Epoch seconds, or null. */
  password_expires_at: number | null;
  show_name_when_locked: boolean;
  /** Epoch seconds, or null. Caps "Stay unlocked for" and "Password works until". */
  expires_at?: number | null | undefined;
}

export interface AccessFormState {
  visibility: Visibility;
  /** Typed password; empty keeps the current one when every target already has one. */
  password: string;
  generatePassword: boolean;
  unlockTtl: UnlockTtl;
  passwordExpiry: PasswordExpiryValue;
  passwordExpiryCustomAt: number | null;
  showName: boolean;
  /** Timing fields are only sent once changed, so saving never moves them by accident. */
  timingTouched: boolean;
}

export interface AccessFormContext {
  anonymous: boolean;
  currents: AccessCurrent[];
  /** Bulk access can't clear a password expiry (it only takes `password_expires_in`). */
  bulk: boolean;
}

const common = <T>(values: T[]): T | undefined => (values.length > 0 && values.every((v) => v === values[0]) ? values[0] : undefined);

export function initialAccessForm(currents: AccessCurrent[]): AccessFormState {
  const ttl = common(currents.map((c) => c.unlock_ttl));
  const pwExpiry = common(currents.map((c) => c.password_expires_at));
  return {
    visibility: common(currents.map((c) => c.visibility)) ?? 'link',
    password: '',
    generatePassword: false,
    unlockTtl: ttl !== undefined && (UNLOCK_TTLS as readonly number[]).includes(ttl) ? (ttl as UnlockTtl) : DEFAULT_UNLOCK_TTL,
    passwordExpiry: pwExpiry ? 'custom' : 'never',
    passwordExpiryCustomAt: pwExpiry ? pwExpiry * 1000 : null,
    showName: common(currents.map((c) => c.show_name_when_locked)) ?? false,
    timingTouched: false,
  };
}

/** Every target already has a password, so leaving the field empty keeps it. */
export const canKeepPassword = (currents: AccessCurrent[]) =>
  currents.length > 0 && currents.every((c) => c.visibility === 'password');

/** Seconds until the soonest-expiring target expires, or null when none expires. */
export function fileLifeSeconds(currents: AccessCurrent[], nowMs: number = Date.now()): number | null {
  const ends = currents.map((c) => c.expires_at).filter((e): e is number => typeof e === 'number');
  if (ends.length === 0) return null;
  return Math.max(0, Math.min(...ends) - Math.floor(nowMs / 1000));
}

/**
 * Changing the visibility away from password, or setting a new password, bumps
 * `access_version`: every `#pw=` link and unlock for those files stops working.
 */
export function breaksPasswordLinks(state: AccessFormState, currents: AccessCurrent[]): boolean {
  if (!currents.some((c) => c.visibility === 'password')) return false;
  return state.visibility !== 'password' || state.generatePassword || state.password !== '';
}

export interface ResolvedAccessForm {
  body: (AccessParams & { visibility: Visibility }) | null;
  errors: PickerErrors;
}

export function resolveAccessForm(state: AccessFormState, context: AccessFormContext, nowMs: number = Date.now()): ResolvedAccessForm {
  const errors: PickerErrors = {};
  const body: AccessParams & { visibility: Visibility } = { visibility: state.visibility };

  if (state.visibility === 'private' && context.anonymous) errors.visibility = 'Sign in to keep files private.';

  if (state.visibility === 'password') {
    if (state.generatePassword) body.generate_password = true;
    else if (state.password) {
      const problem = validatePassword(state.password);
      if (problem) errors.password = problem;
      else body.password = state.password;
    } else if (!canKeepPassword(context.currents)) {
      errors.password = 'Enter a password, or generate one.';
    }

    const newlyProtected = context.currents.some((c) => c.visibility !== 'password');
    const life = fileLifeSeconds(context.currents, nowMs);
    if (state.timingTouched || newlyProtected) {
      if (life !== null && state.unlockTtl > life) errors.unlockTtl = 'That’s longer than the file lasts.';
      else body.unlock_ttl = state.unlockTtl;

      const passwordIn = expirySeconds(state.passwordExpiry, state.passwordExpiryCustomAt, nowMs);
      if (passwordIn === null) {
        if (!context.bulk) body.password_expires_at = null;
      } else if (!Number.isFinite(passwordIn) || passwordIn < 60) errors.passwordExpiry = 'Pick a time in the future.';
      else if (life !== null && passwordIn >= life) errors.passwordExpiry = 'The file expires before that.';
      else body.password_expires_in = passwordIn;
    }
    body.show_name_when_locked = state.showName;
  }

  return { body: Object.keys(errors).length > 0 ? null : body, errors };
}

/** `https://files.gg/<vanity>#pw=<password>` (the viewer strips it on load). */
export const linkWithPassword = (url: string, password: string) => `${url.split('#')[0]}#pw=${encodeURIComponent(password)}`;
