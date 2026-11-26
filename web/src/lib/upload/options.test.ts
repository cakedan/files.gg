import { describe, expect, it } from 'vitest';

import {
  accessChoices,
  adultRegionBlocked,
  canMarkNsfw,
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

describe('the NSFW mark (milestone-4 §4.3)', () => {
  it('sends nsfw=true only for signed-in users allowed to mark', () => {
    const allowed = { anonymous: false, limits: { max_expiry: null, allow_no_expiry: true, nsfw_allowed: true } };
    const state = { ...defaultPickerState(allowed), nsfw: true };
    expect(resolvePickers(state, allowed).params.nsfw).toBe(true);
    expect(canMarkNsfw(allowed)).toBe(true);
    const restricted = { ...allowed, limits: { ...allowed.limits, nsfw_allowed: false } };
    expect(resolvePickers(state, restricted).params.nsfw).toBeUndefined();
    expect(canMarkNsfw({ anonymous: true, limits: null })).toBe(false);
    expect(resolvePickers({ ...defaultPickerState({ anonymous: true }), nsfw: true }, { anonymous: true }).params.nsfw).toBeUndefined();
  });
});

describe('regional rules (milestone-7 §11.4)', () => {
  const limits = { max_expiry: null, allow_no_expiry: true, nsfw_allowed: true };

  it('signed in, the limits say the region blocks adult content: nothing can be marked, even from the defaults', () => {
    const blocked: PickerContext = { anonymous: false, limits: { ...limits, nsfw_allowed: false, adult_region_blocked: true }, defaults: { expires_in: null, visibility: 'link', nsfw: true } };
    expect(adultRegionBlocked(blocked)).toBe(true);
    expect(canMarkNsfw(blocked)).toBe(false);
    expect(defaultPickerState(blocked).nsfw).toBe(false);
    expect(resolvePickers({ ...defaultPickerState(blocked), nsfw: true }, blocked).params.nsfw).toBeUndefined();
    // Even if nsfw_allowed were left true, the region wins.
    expect(canMarkNsfw({ anonymous: false, limits: { ...limits, adult_region_blocked: true } })).toBe(false);
    expect(adultRegionBlocked({ anonymous: false, limits: { ...limits, adult_region_blocked: false } })).toBe(false);
  });

  it('signed out, /auth/config says whether adult content is available; unknown is not blocked', () => {
    expect(adultRegionBlocked({ anonymous: true, limits: null, adultContentAvailable: false })).toBe(true);
    expect(adultRegionBlocked({ anonymous: true, limits: null, adultContentAvailable: true })).toBe(false);
    expect(adultRegionBlocked({ anonymous: true, limits: null })).toBe(false);
    // Signed in, only the limits count.
    expect(adultRegionBlocked({ anonymous: false, limits, adultContentAvailable: false })).toBe(false);
  });
});

describe('upload defaults (milestone-5 §21)', () => {
  const withDefaults = (defaults: PickerContext['defaults'], context: PickerContext = user): PickerContext => ({ ...context, limits: { ...context.limits!, nsfw_allowed: true }, defaults });

  it('signed in, the pickers start from them: a preset, "Password" generated, the adult mark', () => {
    const state = defaultPickerState(withDefaults({ expires_in: 7 * DAY, visibility: 'password', nsfw: true }));
    expect(state).toMatchObject({ expiry: 7 * DAY, expiryCustomAt: null, visibility: 'password', generatePassword: true, nsfw: true });
    expect(defaultPickerState(withDefaults({ expires_in: null, visibility: 'private', nsfw: false }))).toMatchObject({ expiry: 'never', visibility: 'private', generatePassword: false, nsfw: false });
  });

  it('an expiry that isn’t a preset is a custom date that far away', () => {
    const now = 1_800_000_000_000;
    expect(defaultPickerState(withDefaults({ expires_in: 3 * DAY, visibility: 'link', nsfw: false }), now)).toMatchObject({ expiry: 'custom', expiryCustomAt: now + 3 * DAY * 1000 });
  });

  it('falls back to the plain default for what the limits don’t allow, and ignores them signed out', () => {
    const capped: PickerContext = { anonymous: false, limits: { max_expiry: DAY, allow_no_expiry: false } };
    expect(defaultPickerState(withDefaults({ expires_in: 7 * DAY, visibility: 'link', nsfw: false }, capped)).expiry).toBe(DAY);
    expect(defaultPickerState(withDefaults({ expires_in: null, visibility: 'link', nsfw: false }, capped)).expiry).toBe(DAY);
    // the adult mark needs `nsfw_allowed`
    expect(defaultPickerState({ ...user, defaults: { expires_in: null, visibility: 'link', nsfw: true } }).nsfw).toBe(false);
    expect(defaultPickerState({ ...anon, defaults: { expires_in: 3600, visibility: 'private', nsfw: true } })).toMatchObject({ expiry: 21 * DAY, visibility: 'link', nsfw: false });
  });
});
