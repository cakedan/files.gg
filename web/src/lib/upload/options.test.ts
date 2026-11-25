import { describe, expect, it } from 'vitest';

import {
  accessChoices,
  canNeverExpire,
  defaultExpiry,
  defaultPickerState,
  expiryChoices,
  passwordExpiryChoices,
  resolvePickers,
  unlockTtlChoices,
  validatePassword,
  type PickerContext,
} from './options';

const DAY = 86400;
const anon: PickerContext = { anonymous: true, limits: { max_expiry: 21 * DAY, allow_no_expiry: false } };
const user: PickerContext = { anonymous: false, limits: { max_expiry: null, allow_no_expiry: true } };

describe('expiry picker', () => {
  it('anonymous: 1 h / 1 d / 7 d / 21 d, default 21 days, never "never"', () => {
    expect(expiryChoices(anon).map((c) => c.value)).toEqual([3600, DAY, 7 * DAY, 21 * DAY]);
    expect(defaultExpiry(anon)).toBe(21 * DAY);
    expect(canNeverExpire(anon)).toBe(false);
    // Even if limits wrongly allowed it, anonymous can't pick never.
    expect(canNeverExpire({ anonymous: true, limits: { max_expiry: null, allow_no_expiry: true } })).toBe(false);
  });

  it('signed in: never (default), presets, custom', () => {
    expect(expiryChoices(user).map((c) => c.value)).toEqual(['never', 3600, DAY, 7 * DAY, 21 * DAY, 'custom']);
    expect(defaultExpiry(user)).toBe('never');
  });

  it('signed in with a plan cap: no never, presets within the cap', () => {
    const capped: PickerContext = { anonymous: false, limits: { max_expiry: 7 * DAY, allow_no_expiry: false } };
    expect(expiryChoices(capped).map((c) => c.value)).toEqual([3600, DAY, 7 * DAY, 'custom']);
    expect(defaultExpiry(capped)).toBe(7 * DAY);
  });
});

describe('access picker', () => {
  it('anonymous users cannot pick "Only me"', () => {
    expect(accessChoices(anon).find((c) => c.value === 'private')).toMatchObject({ disabled: true });
    expect(accessChoices(user).find((c) => c.value === 'private')?.disabled).toBe(false);
  });

  it('rejects private for anonymous even if forced', () => {
    const { errors, params } = resolvePickers({ ...defaultPickerState(anon), visibility: 'private' }, anon);
    expect(errors.visibility).toMatch(/sign in/i);
    expect(params.visibility).toBeUndefined();
  });

  it('rejects "never" for anonymous even if forced', () => {
    const { errors } = resolvePickers({ ...defaultPickerState(anon), expiry: 'never' }, anon);
    expect(errors.expiry).toMatch(/21 days/);
  });
});

describe('password settings', () => {
  it('validates length', () => {
    expect(validatePassword('short')).toMatch(/6/);
    expect(validatePassword('x'.repeat(129))).toMatch(/128/);
    expect(validatePassword('long enough')).toBeNull();
  });

  it('builds password params with unlock_ttl and password expiry', () => {
    const state = { ...defaultPickerState(user), visibility: 'password' as const, password: 'hunter22', passwordExpiry: 7 * DAY };
    expect(resolvePickers(state, user)).toEqual({
      errors: {},
      params: { visibility: 'password', password: 'hunter22', unlock_ttl: 3600, password_expires_in: 7 * DAY },
    });
  });

  it('generated passwords send generate_password and no password', () => {
    const state = { ...defaultPickerState(user), visibility: 'password' as const, generatePassword: true };
    expect(resolvePickers(state, user).params).toEqual({ visibility: 'password', generate_password: true, unlock_ttl: 3600 });
  });

  it('"Stay unlocked for" cannot outlast the file', () => {
    expect(unlockTtlChoices(DAY).filter((c) => c.disabled).map((c) => c.value)).toEqual([604800, 2592000]);
    const state = { ...defaultPickerState(anon), expiry: DAY, visibility: 'password' as const, password: 'hunter22', unlockTtl: 604800 as const };
    expect(resolvePickers(state, anon).errors.unlockTtl).toBeDefined();
  });

  it('"Password works until": no "Never" label for anonymous, and nothing past the file', () => {
    const choices = passwordExpiryChoices(anon, 7 * DAY);
    expect(choices[0]).toMatchObject({ value: 'never', label: 'Until the file expires' });
    expect(choices.map((c) => c.value)).toEqual(['never', DAY, 'custom']);
    expect(passwordExpiryChoices(user, null)[0]?.label).toBe('Never');
  });

  it('anonymous defaults produce a valid 21-day upload', () => {
    expect(resolvePickers(defaultPickerState(anon), anon)).toEqual({ errors: {}, params: { expires_in: 21 * DAY } });
  });

  it('custom expiry must be in the future', () => {
    const now = Date.UTC(2026, 10, 24);
    const past = resolvePickers({ ...defaultPickerState(user), expiry: 'custom', expiryCustomAt: now - 1000 }, user, now);
    expect(past.errors.expiry).toBeDefined();
    const later = resolvePickers({ ...defaultPickerState(user), expiry: 'custom', expiryCustomAt: now + 2 * DAY * 1000 }, user, now);
    expect(later.params.expires_in).toBe(2 * DAY);
  });
});
